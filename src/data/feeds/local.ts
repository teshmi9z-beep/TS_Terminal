import type { Candle, Symbol, Timeframe } from '../../types';
import { readBefore, readLatest, saveBars, seriesOf, type SeriesInfo, type SeriesMeta } from '../offline/db';
import { isTickTf, parseTf, tfSeconds } from '../timeframes';
import { AggregatedSession } from './aggregate';
import type { FeedRef, FeedSession, MarketMeta } from './types';

const PAGE_BARS = 1500;
// live bars are written in batches
const FLUSH_MS = 10_000;

// bars before `before` from another saved series of the same symbol and timeframe
// (history imported from files, or saved from another source), once a series has none left
async function olderElsewhere(ticker: string, tf: Timeframe, exceptKey: string, before: number): Promise<Candle[]> {
  const other = (await seriesOf(ticker))
    .filter((m) => m.tf === tf && m.key !== exceptKey && m.first < before)
    .sort((a, b) => b.last - a.last)[0];
  return other ? readBefore(other.key, tf, before, PAGE_BARS) : [];
}

export function seriesInfo(sym: Symbol, tf: Timeframe, ref: FeedRef, label: string): SeriesInfo {
  const feed = `${ref.source}${ref.market === 'futures' ? '-futures' : ''}:${ref.id}`;
  return { key: `${sym.ticker}|${tf}|${feed}`, ticker: sym.ticker, tf, feed, label, symbol: sym };
}

// A network session that also writes every bar it gets (history, older pages and
// live) to the local store. With `localHistory`, once the source has no older
// bars left, paging back continues with the bars saved on earlier days, e.g. more
// than Yahoo's 30 days of 1-minute bars.
export class CachingSession implements FeedSession {
  readonly source: FeedSession['source'];
  readonly label: string;
  // read from the source each time: IBKR tells only once connected whether it is real time
  get realtime() { return this.inner.realtime; }
  readonly proxy?: boolean;
  private inner: FeedSession;
  private info: SeriesInfo;
  private localHistory: boolean;
  private localDone = false;
  private first = Infinity;

  constructor(inner: FeedSession, info: SeriesInfo, localHistory: boolean) {
    this.inner = inner;
    this.info = info;
    this.localHistory = localHistory;
    this.source = inner.source;
    this.label = inner.label;
    this.proxy = inner.proxy;
  }

  get hasMore() { return this.inner.hasMore || (this.localHistory && !this.localDone); }
  set hasMore(v: boolean) { this.inner.hasMore = v; if (!v) this.localDone = true; }

  private save(bars: Candle[]) {
    if (bars.length) this.first = Math.min(this.first, bars[0].time);
    saveBars(this.info, bars).catch((e) => console.warn('[offline] enregistrement:', e));
  }

  async load(): Promise<Candle[]> {
    const bars = await this.inner.load();
    this.save(bars);
    return bars;
  }

  async loadOlder(): Promise<Candle[]> {
    if (this.inner.hasMore) {
      const older = await this.inner.loadOlder();
      if (older.length || this.inner.hasMore) { this.save(older); return older; }
    }
    if (!this.localHistory || this.localDone || !Number.isFinite(this.first)) return [];
    let older = await readBefore(this.info.key, this.info.tf, this.first, PAGE_BARS);
    if (!older.length) older = await olderElsewhere(this.info.ticker, this.info.tf, this.info.key, this.first);
    if (!older.length) { this.localDone = true; return []; }
    this.first = older[0].time;
    return older;
  }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    const pending = new Map<number, Candle>();
    const flush = () => {
      if (!pending.size) return;
      const bars = [...pending.values()].sort((a, b) => a.time - b.time);
      pending.clear();
      saveBars(this.info, bars).catch(() => { /* keep going live */ });
    };
    const timer = setInterval(flush, FLUSH_MS);
    const off = this.inner.subscribe((c) => { pending.set(c.time, c); onBar(c); }, onMeta);
    return () => { clearInterval(timer); flush(); off(); };
  }
}

// bars saved on this computer, for when no source answers (offline)
export class LocalSession implements FeedSession {
  readonly source = 'local' as const;
  readonly label: string;
  readonly realtime = false;
  hasMore = true;
  readonly meta: SeriesMeta;
  private first = Infinity;

  constructor(meta: SeriesMeta) {
    this.meta = meta;
    this.label = `Données locales · ${meta.label}`;
  }

  async load(): Promise<Candle[]> {
    const bars = await readLatest(this.meta.key, PAGE_BARS);
    this.first = bars[0]?.time ?? Infinity;
    // older bars may also come from another saved series (olderElsewhere)
    this.hasMore = bars.length > 0;
    return bars;
  }

  async loadOlder(): Promise<Candle[]> {
    if (!this.hasMore || !Number.isFinite(this.first)) return [];
    let older = await readBefore(this.meta.key, this.meta.tf, this.first, PAGE_BARS);
    if (!older.length) older = await olderElsewhere(this.meta.ticker, this.meta.tf, this.meta.key, this.first);
    if (!older.length) { this.hasMore = false; return []; }
    this.first = older[0].time;
    return older;
  }

  subscribe(): () => void {
    return () => {};
  }
}

// The saved series of a symbol for a timeframe: the one with the newest bars, or
// else one in a finer timeframe that divides it (5m from 1m, 4H from 1H...)
export async function openLocal(sym: Symbol, tf: Timeframe): Promise<{ session: FeedSession; newest: number } | null> {
  const all = (await seriesOf(sym.ticker)).filter((m) => m.count >= 2).sort((a, b) => b.last - a.last);
  const exact = all.find((m) => m.tf === tf);
  if (exact) return { session: new LocalSession(exact), newest: exact.last };
  const step = tfSeconds(tf);
  // months have no fixed length; weeks are built from days only (Monday to Sunday)
  if (!step || isTickTf(tf) || /M$/.test(tf)) return null;
  const weekly = parseTf(tf).unit === 'W';
  const finer = all
    .filter((m) => { const s = tfSeconds(m.tf); return !isTickTf(m.tf) && !!s && s < step && step % s === 0 && (!weekly || parseTf(m.tf).unit === 'D'); })
    .sort((a, b) => (tfSeconds(b.tf) ?? 0) - (tfSeconds(a.tf) ?? 0) || b.last - a.last)[0];
  if (!finer) return null;
  const intraday = parseTf(finer.tf).unit !== 'D';
  const monday = 4 * 86400;
  return { session: new AggregatedSession(new LocalSession(finer), step, intraday && sym.category === 'Actions', weekly ? monday : 0), newest: finer.last };
}
