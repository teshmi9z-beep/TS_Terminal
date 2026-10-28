import type { Candle, Symbol, Timeframe } from '../../types';
import { isTickTf, parseTf, tfSeconds } from '../timeframes';
import { labTf, platformTicker } from '../labSymbols';
import type { FeedSession, MarketMeta } from './types';

// The robot lab's history on this computer (robots/data, served by the dev server
// under /api/data/lab): years of 1-minute bars from Binance and HistData. Charts
// page back into it once their network source has nothing older (HistData's forex
// minutes since 2000 behind Yahoo's last 30 days), or right away when it holds the
// very same bars (Binance: read from the disk instead of asked again, page by page).

type LabFile = { id: string; symbol: string; platform?: string; source: string; tf: string; bars: number; from: number; to: number; derived?: boolean };

// a lab file serving a timeframe, its bars grouped by `ratio` when it is finer
export type LabSource = { file: LabFile; step: number; ratio: number; anchor: number };

const PAGE_BARS = 1500;
const INDEX_TTL = 10 * 60_000;
const LAB_STEPS: [string, number][] = [['1d', 86400], ['4h', 14400], ['1h', 3600], ['30m', 1800], ['15m', 900], ['5m', 300], ['1m', 60]];

let index: { at: number; files: Promise<LabFile[]> } | null = null;
function labFiles(): Promise<LabFile[]> {
  if (!index || Date.now() - index.at > INDEX_TTL) {
    const files = fetch('/api/data/lab')
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      // the perpetual futures only follow their market (and trade on weekends): not its history
      .then((j: { entries: LabFile[] }) => j.entries.filter((e) => !e.derived && e.bars >= 2 && !e.id.startsWith('bnfut_')))
      .catch(() => []);
    index = { at: Date.now(), files };
  }
  return index.files;
}

// every lab file able to serve a symbol and timeframe: those of the timeframe itself,
// the one reaching furthest back first, then the finer ones that divide it, coarsest
// first (2H from 1H, weeks from days)
export async function labSources(sym: Symbol, tf: Timeframe): Promise<LabSource[]> {
  const step = tfSeconds(tf);
  const { unit } = parseTf(tf);
  if (!step || isTickTf(tf) || unit === 'M') return [];
  // (a file downloaded from the Data tab names its platform ticker itself)
  const mine = (await labFiles()).filter((f) => (f.platform ?? platformTicker(f.symbol)) === sym.ticker);
  const of = (name: string) => mine.filter((f) => f.tf === name).sort((a, b) => a.from - b.from || b.to - a.to);
  const out: LabSource[] = of(labTf(tf)).map((file) => ({ file, step, ratio: 1, anchor: 0 }));
  for (const [name, s] of LAB_STEPS) {
    if (s >= step || step % s || (unit === 'W' && name !== '1d')) continue;
    // weeks start on Monday (1970-01-01 was a Thursday)
    for (const file of of(name)) out.push({ file, step, ratio: step / s, anchor: unit === 'W' ? 4 * 86400 : 0 });
  }
  return out;
}

// the one holding the most recent bars, for charts without network
export const latestSource = (srcs: LabSource[]): LabSource | null =>
  srcs.reduce<LabSource | null>((a, s) => (!a || s.file.to > a.file.to ? s : a), null);

async function fetchPage(id: string, before: number, limit: number): Promise<Candle[]> {
  const r = await fetch(`/api/data/lab/page?id=${encodeURIComponent(id)}&before=${Number.isFinite(before) ? before : ''}&limit=${limit}`);
  if (!r.ok) throw new Error(`historique local indisponible (${r.status})`);
  const rows = new Float64Array(await r.arrayBuffer());
  const out: Candle[] = new Array(rows.length / 6);
  for (let i = 0; i < out.length; i++) {
    const k = i * 6;
    out[i] = { time: rows[k], open: rows[k + 1], high: rows[k + 2], low: rows[k + 3], close: rows[k + 4], volume: rows[k + 5] };
  }
  return out;
}

function group(base: Candle[], step: number, anchor: number): Candle[] {
  const out: Candle[] = [];
  for (const c of base) {
    const t = Math.floor((c.time - anchor) / step) * step + anchor;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: t });
    }
  }
  return out;
}

// the bars of a lab source, page after page back in time from `before`
class LabPager {
  done = false;
  private src: LabSource;
  private cursor: number;

  constructor(src: LabSource, before: number) {
    this.src = src;
    this.cursor = before;
  }

  async page(): Promise<Candle[]> {
    if (this.done) return [];
    const { file, step, ratio, anchor } = this.src;
    const limit = PAGE_BARS * ratio;
    const base = await fetchPage(file.id, this.cursor, limit);
    if (base.length < limit) this.done = true;
    if (!base.length) return [];
    const out = ratio === 1 ? base : group(base, step, anchor);
    // the oldest group may miss its first bars: it comes whole with the next page
    if (ratio > 1 && !this.done && out.length > 1) out.shift();
    this.cursor = out[0].time;
    return out;
  }
}

// A network session whose older pages continue with the lab's history: once the
// network has none left, or at once when a file holds the very bars of the network
// source (`sameBars`, Binance) and reaches the oldest bar loaded. A file only continues
// the chart when it reaches the oldest bar loaded, less than a few days apart (week-end,
// holidays): a history that stopped years earlier would glue two far apart periods.
export class LabBackedSession implements FeedSession {
  readonly source: FeedSession['source'];
  readonly label: string;
  // read from the source each time: IBKR tells only once connected whether it is real time
  get realtime() { return this.inner.realtime; }
  readonly proxy?: boolean;
  private inner: FeedSession;
  private srcs: LabSource[];
  private sameBars: (id: string) => boolean;
  private pager: LabPager | null = null;
  private first = Infinity;

  constructor(inner: FeedSession, srcs: LabSource[], sameBars: (id: string) => boolean) {
    this.inner = inner;
    this.srcs = srcs;
    this.sameBars = sameBars;
    this.source = inner.source;
    this.label = inner.label;
    this.proxy = inner.proxy;
  }

  private reaching(): LabSource | undefined {
    return this.srcs.find((s) => s.file.from < this.first && s.file.to >= this.first - Math.max(6 * 86400, 3 * s.step));
  }
  private labHasOlder() { return this.pager ? !this.pager.done : !!this.reaching(); }
  get hasMore() { return (!this.pager && this.inner.hasMore) || this.labHasOlder(); }
  set hasMore(v: boolean) { this.inner.hasMore = v; if (!v && this.pager) this.pager.done = true; }

  async load(): Promise<Candle[]> {
    const bars = await this.inner.load();
    this.first = bars[0]?.time ?? Infinity;
    return bars;
  }

  async loadOlder(): Promise<Candle[]> {
    if (!this.pager) {
      const same = this.srcs.find((s) => this.sameBars(s.file.id) && s.file.from < this.first && s.file.to >= this.first - s.step);
      if (!same && this.inner.hasMore) {
        const older = await this.inner.loadOlder();
        if (older.length) { this.first = Math.min(this.first, older[0].time); return older; }
        if (this.inner.hasMore) return older;
      }
      const src = same ?? this.reaching();
      if (!src) return [];
      this.pager = new LabPager(src, this.first);
    }
    const older = await this.pager.page();
    if (older.length) this.first = older[0].time;
    return older;
  }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    return this.inner.subscribe(onBar, onMeta);
  }
}

// the lab's history alone, when no network source answers
export class LabSession implements FeedSession {
  readonly source = 'local' as const;
  readonly label: string;
  readonly realtime = false;
  readonly newest: number;
  private pager: LabPager;

  constructor(src: LabSource) {
    this.pager = new LabPager(src, Infinity);
    this.newest = src.file.to;
    this.label = `Historique local · ${src.file.source}`;
  }

  get hasMore() { return !this.pager.done; }
  set hasMore(v: boolean) { if (!v) this.pager.done = true; }

  load(): Promise<Candle[]> { return this.pager.page(); }
  loadOlder(): Promise<Candle[]> { return this.pager.page(); }
  subscribe(): () => void { return () => {}; }
}
