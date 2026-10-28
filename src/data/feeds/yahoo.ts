import type { Candle } from '../../types';
import { nowSec, type FeedSession, type MarketMeta } from './types';

// relayed by the Vite dev server (see vite.config.ts) because Yahoo has no CORS
const BASE = '/yf';
const DAY = 86400;

type YConf = {
  // seconds per bar of the Yahoo interval
  step: number;
  // seconds of history fetched per request
  span: number;
  // how far back Yahoo serves this interval at all
  maxBack: number;
  liveRange: string;
  poll: number;
  daily: boolean;
};

// keyed by Yahoo's native interval names
const CONF: Record<string, YConf> = {
  '1m': { step: 60, span: 5 * DAY, maxBack: 29 * DAY, liveRange: '1d', poll: 4000, daily: false },
  '2m': { step: 120, span: 10 * DAY, maxBack: 59 * DAY, liveRange: '1d', poll: 4000, daily: false },
  '5m': { step: 300, span: 20 * DAY, maxBack: 59 * DAY, liveRange: '1d', poll: 5000, daily: false },
  '15m': { step: 900, span: 40 * DAY, maxBack: 59 * DAY, liveRange: '2d', poll: 5000, daily: false },
  '30m': { step: 1800, span: 59 * DAY, maxBack: 59 * DAY, liveRange: '5d', poll: 6000, daily: false },
  '60m': { step: 3600, span: 180 * DAY, maxBack: 729 * DAY, liveRange: '5d', poll: 8000, daily: false },
  '90m': { step: 5400, span: 59 * DAY, maxBack: 59 * DAY, liveRange: '5d', poll: 8000, daily: false },
  '1d': { step: DAY, span: 6 * 365 * DAY, maxBack: 80 * 365 * DAY, liveRange: '5d', poll: 15000, daily: true },
  '1wk': { step: 7 * DAY, span: 30 * 365 * DAY, maxBack: 80 * 365 * DAY, liveRange: '1mo', poll: 20000, daily: true },
  '1mo': { step: 30 * DAY, span: 80 * 365 * DAY, maxBack: 80 * 365 * DAY, liveRange: '6mo', poll: 30000, daily: true },
  '3mo': { step: 91 * DAY, span: 80 * 365 * DAY, maxBack: 80 * 365 * DAY, liveRange: '1y', poll: 30000, daily: true },
};

export async function yfFetch<T = any>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) {
    let msg = `Yahoo HTTP ${r.status}`;
    try { const j = await r.json(); msg = j?.chart?.error?.description ?? j?.finance?.error?.description ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}

// chartPreviousClose is the close before the requested range, so it only means
// "previous session close" when the range is a single day
function metaOf(meta: any, oneDayRange: boolean): MarketMeta {
  return {
    last: meta?.regularMarketPrice,
    prevClose: meta?.previousClose ?? (oneDayRange ? meta?.chartPreviousClose : undefined),
    dayHigh: meta?.regularMarketDayHigh,
    dayLow: meta?.regularMarketDayLow,
    volume: meta?.regularMarketVolume,
    name: meta?.longName ?? meta?.shortName,
    exchange: meta?.fullExchangeName ?? meta?.exchangeName,
    currency: meta?.currency,
  };
}

function parseChart(json: any, conf: YConf): { candles: Candle[]; meta: any } {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description ?? 'Yahoo: pas de donnees');
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const gmt: number = r.meta?.gmtoffset ?? 0;
  const out: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    const v = q.volume?.[i] ?? 0;
    // daily+ bars are keyed by their exchange-local date; intraday bars keep
    // Yahoo's session-aligned times (US 1H bars open at :30)
    const t = conf.daily ? Math.floor((ts[i] + gmt) / DAY) * DAY : ts[i];
    const last = out[out.length - 1];
    // the final intraday point is the live quote stamped with its own time:
    // it belongs to the bar in progress
    const liveTick = !conf.daily && i === ts.length - 1 && !!last && t - last.time < conf.step;
    if (last && (last.time === t || liveTick)) {
      last.high = Math.max(last.high, h);
      last.low = Math.min(last.low, l);
      last.close = c;
      if (!liveTick) last.volume += v;
    } else if (!last || t > last.time) {
      out.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
    }
  }
  return { candles: out, meta: r.meta };
}

export class YahooSession implements FeedSession {
  readonly source = 'yahoo' as const;
  readonly label = 'Yahoo Finance';
  readonly realtime = false;
  hasMore = true;
  private conf: YConf;
  private cursor = 0;
  private firstTrade = 0;
  private id: string;
  private interval: string;

  constructor(id: string, interval: string) {
    this.id = id;
    const conf = CONF[interval];
    if (!conf) throw new Error(`Yahoo: intervalle ${interval} non supporté`);
    this.conf = conf;
    this.interval = interval;
  }

  private async range(p1: number, p2: number) {
    const path = `/v8/finance/chart/${encodeURIComponent(this.id)}?interval=${this.interval}&period1=${p1}&period2=${p2}&includePrePost=false`;
    return parseChart(await yfFetch(path), this.conf);
  }

  async load(): Promise<Candle[]> {
    const now = nowSec();
    const floor = now - this.conf.maxBack + 3600;
    const p1 = Math.max(now - this.conf.span, floor);
    const { candles, meta } = await this.range(p1, now + 3600);
    this.firstTrade = meta?.firstTradeDate ?? 0;
    this.cursor = Math.min(p1, candles[0]?.time ?? p1);
    this.hasMore = p1 > floor && (this.firstTrade === 0 || this.cursor > this.firstTrade);
    // thin intraday history (holidays, illiquid symbols): pull one more page up front
    if (candles.length < 200 && this.hasMore) {
      const older = await this.loadOlder().catch(() => []);
      return [...older, ...candles];
    }
    return candles;
  }

  async loadOlder(): Promise<Candle[]> {
    if (!this.hasMore) return [];
    const floor = nowSec() - this.conf.maxBack + 3600;
    const p2 = this.cursor - 1;
    const p1 = Math.max(p2 - this.conf.span, floor);
    if (p1 >= p2 - this.conf.step) { this.hasMore = false; return []; }
    const { candles } = await this.range(p1, p2);
    this.cursor = p1;
    if (p1 <= floor || (this.firstTrade && p1 <= this.firstTrade)) this.hasMore = false;
    return candles.filter((c) => c.time < p2);
  }

  // Yahoo has no public streaming API; poll the short live range instead
  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const json = await yfFetch(`/v8/finance/chart/${encodeURIComponent(this.id)}?interval=${this.interval}&range=${this.conf.liveRange}&includePrePost=false`);
        if (stopped) return;
        const { candles, meta } = parseChart(json, this.conf);
        for (const c of candles.slice(-2)) onBar(c);
        onMeta?.(metaOf(meta, this.conf.liveRange === '1d'));
        failures = 0;
      } catch {
        failures++;
      }
      if (!stopped) timer = setTimeout(tick, this.conf.poll * Math.min(8, 1 + failures));
    };
    timer = setTimeout(tick, 500);
    return () => { stopped = true; clearTimeout(timer); };
  }
}

// ---- quotes for the watchlist: one request for many symbols
export type SparkQuote = { last: number; prevClose?: number };
export async function yahooSpark(ids: string[]): Promise<Record<string, SparkQuote>> {
  const out: Record<string, SparkQuote> = {};
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const json = await yfFetch<Record<string, any>>(`/v8/finance/spark?symbols=${encodeURIComponent(batch.join(','))}&range=1d&interval=5m`);
    for (const [id, v] of Object.entries(json ?? {})) {
      const closes: (number | null)[] = v?.close ?? [];
      let last: number | null = null;
      for (let k = closes.length - 1; k >= 0; k--) if (closes[k] != null) { last = closes[k]; break; }
      if (last != null) out[id] = { last, prevClose: v?.chartPreviousClose ?? v?.previousClose ?? undefined };
      // futures between sessions (weekends): no bar today, only the last session's price and change
      else if (typeof v?.fulldayPrice === 'number') {
        out[id] = { last: v.fulldayPrice, prevClose: typeof v.fulldayChange === 'number' ? v.fulldayPrice - v.fulldayChange : v?.previousClose ?? undefined };
      }
    }
  }
  return out;
}

export type YahooSearchHit = { symbol: string; name: string; type: string; exchange: string };
export async function yahooSearch(q: string): Promise<YahooSearchHit[]> {
  const json = await yfFetch<any>(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=25&newsCount=0&listsCount=0&enableFuzzyQuery=false`);
  return (json?.quotes ?? [])
    .filter((x: any) => x.symbol && x.quoteType)
    .map((x: any) => ({ symbol: x.symbol, name: x.longname ?? x.shortname ?? x.symbol, type: x.quoteType, exchange: x.exchDisp ?? x.exchange ?? '' }));
}
