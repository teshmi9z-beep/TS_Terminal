import type { Candle } from '../../types';
import type { FeedSession, MarketMeta } from './types';

// public market-data endpoints, no API key needed, CORS enabled.
// data-api / data-stream.binance.vision are Binance's market-data-only mirrors,
// used as a fallback when the main domain is unreachable or geo-blocked.
const REST = ['https://api.binance.com', 'https://data-api.binance.vision'];
const WS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];
// USDⓈ-M futures, which also list "TradFi" perpetuals on gold, oil and US stocks
export const FAPI_REST = ['https://fapi.binance.com'];
// since October 2026 the futures streams answer only under /market (trades, klines, tickers)
// and /public (order book, best bid / ask); the old /ws root stays silent
export const FAPI_WS = ['wss://fstream.binance.com/market'];
export const FAPI_BOOK_WS = ['wss://fstream.binance.com/public'];

export class BadSymbolError extends Error {}

const preferred = new Map<string[], number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// tries every host; on rate limiting (429 / 418) waits and retries once more
export async function bnFetch<T = any>(path: string, hosts: string[] = REST): Promise<T> {
  let lastErr: unknown;
  const start = preferred.get(hosts) ?? 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let k = 0; k < hosts.length; k++) {
      const i = (start + k) % hosts.length;
      try {
        const r = await fetch(hosts[i] + path);
        if (r.status === 400) throw new BadSymbolError(`Binance: symbole invalide (${path})`);
        if (r.status === 429 || r.status === 418) {
          const wait = parseInt(r.headers.get('retry-after') ?? '1', 10);
          await sleep(Math.min(5, Math.max(1, wait)) * 1000);
          throw new Error('Binance: trop de requêtes');
        }
        if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
        preferred.set(hosts, i);
        return await r.json();
      } catch (e) {
        if (e instanceof BadSymbolError) throw e;
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

// websocket with automatic reconnect (exponential backoff, alternating hosts)
export function bnStream(path: string, onMsg: (data: any) => void, hosts: string[] = WS): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    const sock = new WebSocket(`${hosts[attempt % hosts.length]}${path}`);
    ws = sock;
    sock.onmessage = (ev) => {
      attempt = 0;
      try { onMsg(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    };
    sock.onerror = () => sock.close();
    sock.onclose = () => {
      if (closed) return;
      attempt++;
      timer = setTimeout(connect, Math.min(15000, 500 * 2 ** Math.min(attempt, 5)));
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    if (ws) { ws.onclose = null; ws.close(); }
  };
}

function parseKline(k: any[]): Candle {
  return { time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
}

export class BinanceKlineSession implements FeedSession {
  readonly source = 'binance' as const;
  readonly label = 'Binance';
  readonly realtime = true;
  hasMore = true;
  private oldest = 0;
  private interval: string;
  private id: string;

  // `interval` is a native Binance kline interval (1s, 1m, 3m ... 1w, 1M)
  constructor(id: string, interval: string) {
    this.id = id;
    this.interval = interval;
  }

  async load(): Promise<Candle[]> {
    const rows = await bnFetch<any[]>(`/api/v3/klines?symbol=${this.id}&interval=${this.interval}&limit=1000`);
    const candles = rows.map(parseKline);
    this.oldest = candles[0]?.time ?? 0;
    this.hasMore = candles.length >= 1000;
    return candles;
  }

  async loadOlder(): Promise<Candle[]> {
    if (!this.hasMore || !this.oldest) return [];
    const rows = await bnFetch<any[]>(`/api/v3/klines?symbol=${this.id}&interval=${this.interval}&limit=1000&endTime=${this.oldest * 1000 - 1}`);
    const candles = rows.map(parseKline).filter((c) => c.time < this.oldest);
    if (candles.length === 0) { this.hasMore = false; return []; }
    this.oldest = candles[0].time;
    return candles;
  }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    const s = this.id.toLowerCase();
    const offKline = bnStream(`/ws/${s}@kline_${this.interval}`, (m) => {
      const k = m?.k;
      if (!k) return;
      onBar({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
    });
    const offTicker = onMeta ? bnStream(`/ws/${s}@miniTicker`, (m) => {
      onMeta({ last: +m.c, prevClose: +m.o, dayHigh: +m.h, dayLow: +m.l, volume: +m.v, exchange: 'Binance' });
    }) : null;
    return () => { offKline(); offTicker?.(); };
  }
}

type AggTrade = { a: number; p: string; q: string; T: number };

// Request weight spent on trade pages over the last minute, per market. Binance
// allows 6000 per minute and IP on spot and 2400 on futures, answers 429 past
// that and bans the IP (418) when requests keep coming. The 429 answers carry no
// CORS header, so the page can't read them: it keeps well under the limit instead,
// leaving room for quotes, klines and other tabs, and pauses after a failure.
class WeightBudget {
  private spent: { at: number; w: number }[] = [];
  private pausedUntil = 0;
  private perMinute: number;
  constructor(perMinute: number) { this.perMinute = perMinute; }

  // how many requests of weight `w` fit right now (up to `want`), reserved at once.
  // Paging back leaves `keep` unused so a chart opening next still gets its bars.
  take(w: number, want: number, keep = 0): number {
    const now = Date.now();
    if (now < this.pausedUntil) return 0;
    this.spent = this.spent.filter((x) => now - x.at < 60_000);
    const used = this.spent.reduce((a, x) => a + x.w, 0);
    const n = Math.max(0, Math.min(want, Math.floor((this.perMinute - keep - used) / w)));
    if (n) this.spent.push({ at: now, w: n * w });
    return n;
  }

  pause(ms: number) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
}

// aggTrades cost 4 weight on spot but 20 on futures, so futures charts page back
// in smaller steps. `queue` runs one paging at a time per market: a chart and the
// strategy tester opening together then share pages instead of both fetching them.
const TICK_MARKETS = {
  spot: { rest: REST, ws: WS, path: '/api/v3/aggTrades', weight: 4, budget: new WeightBudget(2400), keep: 1000, parallel: 50, firstPages: 100, olderPages: 100, queue: Promise.resolve() },
  futures: { rest: FAPI_REST, ws: FAPI_WS, path: '/fapi/v1/aggTrades', weight: 20, budget: new WeightBudget(1200), keep: 500, parallel: 10, firstPages: 40, olderPages: 20, queue: Promise.resolve() },
};
export type TickMarket = keyof typeof TICK_MARKETS;

// bars wanted from the first load and from each older page
const FIRST_BARS = 150;
const OLDER_BARS = 500;

// Trades are fetched in pages of 1000 aligned on the trade id (page n holds ids
// n*1000 .. n*1000+999), so every tick chart of a symbol, whatever its tick count,
// and the strategy tester share them. Full pages never change and are kept as
// flat [id, price, qty, time] arrays (32 KB each).
const PAGE = 1000;
const MAX_CACHED_PAGES = 400;
const pageCache = new Map<string, Float64Array>();

function packTrades(rows: AggTrade[]): Float64Array {
  const out = new Float64Array(rows.length * 4);
  rows.forEach((t, i) => { out[i * 4] = t.a; out[i * 4 + 1] = +t.p; out[i * 4 + 2] = +t.q; out[i * 4 + 3] = t.T; });
  return out;
}

function cachePage(key: string, page: Float64Array) {
  pageCache.delete(key);
  pageCache.set(key, page);
  if (pageCache.size > MAX_CACHED_PAGES) pageCache.delete(pageCache.keys().next().value!);
}

// Bar times are the first trade's time in milliseconds. Bars opening in the same
// millisecond are spread 1 ms apart, which keeps times strictly increasing without
// drifting away from the real clock (whole seconds did: 25 bars a second on BTC).
const MS = 0.001;

type TickBar = { bucket: number; c: Candle };

// tick charts: bars of N aggregated trades. Bucketing by trade id (floor(id / N))
// keeps bar boundaries identical between the history load, older pages and live.
export class BinanceTickSession implements FeedSession {
  readonly source = 'binance' as const;
  readonly label: string;
  readonly realtime = true;
  readonly proxy: boolean;
  hasMore = true;
  private lastId = 0;
  private bars: TickBar[] = [];
  private id: string;
  private ticksPerBar: number;
  private market: (typeof TICK_MARKETS)[TickMarket];

  constructor(id: string, ticksPerBar: number, market: TickMarket = 'spot') {
    this.id = id;
    this.ticksPerBar = ticksPerBar;
    this.market = TICK_MARKETS[market];
    this.label = market === 'spot' ? 'Binance (ticks)' : `Perpétuel Binance ${id} (ticks)`;
    this.proxy = market === 'futures';
  }

  private pagesFor(bars: number, min: number, max: number) {
    return Math.min(max, Math.max(min, Math.ceil((this.ticksPerBar * bars) / PAGE)));
  }

  // one page of trades, a single attempt (null on failure)
  private async page(no: number): Promise<Float64Array | null> {
    const { rest, path } = this.market;
    try {
      const r = await fetch(`${rest[preferred.get(rest) ?? 0]}${path}?symbol=${this.id}&fromId=${no * PAGE}&limit=${PAGE}`);
      // 400: older than what the API serves (futures keep two days)
      if (r.status === 400) return new Float64Array(0);
      if (!r.ok) return null;
      const page = packTrades(await r.json());
      if (page.length === PAGE * 4) cachePage(`${path}|${this.id}|${no}`, page);
      return page;
    } catch {
      return null;
    }
  }

  // up to `pages` pages of trades before `firstId`, oldest first, fetched many at a
  // time within the weight budget; null when nothing could be fetched (budget used
  // up or rate limited). A missing page would leave a hole in the trade ids, so
  // only the unbroken run that ends at `firstId` is kept.
  private pagesBefore(firstId: number, pages: number, keep: number): Promise<Float64Array[] | null> {
    const m = this.market;
    const run = m.queue.then(() => this.fetchPagesBefore(firstId, pages, keep));
    m.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fetchPagesBefore(firstId: number, pages: number, keep: number): Promise<Float64Array[] | null> {
    const { weight, budget, parallel, path } = this.market;
    const nos: number[] = [];
    for (let no = Math.floor((firstId - 1) / PAGE); no >= 0 && nos.length < pages; no--) nos.push(no);
    const got = new Map<number, Float64Array>();
    const missing = nos.filter((no) => {
      const hit = pageCache.get(`${path}|${this.id}|${no}`);
      if (hit) got.set(no, hit);
      return !hit;
    });
    for (let b = 0; b < missing.length;) {
      const n = budget.take(weight, Math.min(parallel, missing.length - b), keep);
      if (!n) break;
      const batch = missing.slice(b, b + n);
      b += n;
      const res = await Promise.all(batch.map((no) => this.page(no)));
      batch.forEach((no, j) => { if (res[j]) got.set(no, res[j]!); });
      // most likely rate limited: stop paging for a while
      if (res.some((r) => r === null)) { budget.pause(30_000); break; }
    }
    if (nos.length && !got.has(nos[0])) return null;
    const run: Float64Array[] = [];
    for (const no of nos) {
      const page = got.get(no);
      if (!page?.length) break;
      run.unshift(page);
    }
    return run;
  }

  // aggregate trades (pages oldest first) into bars, ignoring ids from `below` on
  private aggregate(pages: Float64Array[], below: number): TickBar[] {
    const out: TickBar[] = [];
    let prevA = -1;
    let firstA = -1;
    for (const pg of pages) {
      for (let i = 0; i < pg.length; i += 4) {
        const a = pg[i];
        if (a <= prevA || a >= below) continue;
        if (firstA < 0) firstA = a;
        prevA = a;
        const bucket = Math.floor(a / this.ticksPerBar);
        const price = pg[i + 1], qty = pg[i + 2];
        const last = out[out.length - 1];
        if (last && last.bucket === bucket) {
          last.c.high = Math.max(last.c.high, price);
          last.c.low = Math.min(last.c.low, price);
          last.c.close = price;
          last.c.volume += qty;
        } else {
          out.push({ bucket, c: { time: pg[i + 3] / 1000, open: price, high: price, low: price, close: price, volume: qty } });
        }
      }
    }
    // the oldest bar misses the trades before the first page
    if (out.length && firstA % this.ticksPerBar !== 0) out.shift();
    return out;
  }

  // walking back from the newest bar, a bar opening in the same millisecond as the
  // next one (or after it) is moved 1 ms before it
  private fixTimes(bars: TickBar[], ceiling: number) {
    let next = ceiling;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].c.time >= next) bars[i].c.time = next - MS;
      next = bars[i].c.time;
    }
  }

  async load(): Promise<Candle[]> {
    const { rest, path, weight, budget, firstPages } = this.market;
    budget.take(weight, 1);
    const latest = await bnFetch<AggTrade[]>(`${path}?symbol=${this.id}&limit=${PAGE}`, rest);
    if (!latest.length) return [];
    const older = await this.pagesBefore(latest[0].a, this.pagesFor(FIRST_BARS, 4, firstPages) - 1, 0);
    this.bars = this.aggregate([...(older ?? []), packTrades(latest)], Infinity);
    this.fixTimes(this.bars, Number.MAX_SAFE_INTEGER);
    this.lastId = latest[latest.length - 1].a;
    return this.bars.map((b) => b.c);
  }

  async loadOlder(): Promise<Candle[]> {
    if (!this.hasMore || !this.bars.length) return [];
    const firstBucketStart = this.bars[0].bucket * this.ticksPerBar;
    const pages = await this.pagesBefore(firstBucketStart, this.pagesFor(OLDER_BARS, 1, this.market.olderPages), this.market.keep);
    // null: over budget or rate limited, the next scroll tries again
    if (!pages) return [];
    const older = this.aggregate(pages, firstBucketStart);
    if (!older.length) { this.hasMore = false; return []; }
    this.fixTimes(older, this.bars[0].c.time);
    this.bars = [...older, ...this.bars];
    return older.map((b) => b.c);
  }

  subscribe(onBar: (c: Candle) => void): () => void {
    return bnStream(`/ws/${this.id.toLowerCase()}@aggTrade`, (t) => {
      if (!t || typeof t.a !== 'number' || t.a <= this.lastId) return;
      this.lastId = t.a;
      const bucket = Math.floor(t.a / this.ticksPerBar);
      const price = +t.p, qty = +t.q;
      const last = this.bars[this.bars.length - 1];
      if (last && last.bucket === bucket) {
        last.c = { ...last.c, high: Math.max(last.c.high, price), low: Math.min(last.c.low, price), close: price, volume: last.c.volume + qty };
        onBar(last.c);
      } else {
        const time = Math.max(t.T / 1000, (last?.c.time ?? 0) + MS);
        const bar = { bucket, c: { time, open: price, high: price, low: price, close: price, volume: qty } };
        this.bars.push(bar);
        onBar(bar.c);
      }
    }, this.market.ws);
  }
}

// ---- symbol search helper: list of USDT spot pairs, fetched once
let usdtPairs: Promise<string[]> | null = null;
export function binanceUsdtBases(): Promise<string[]> {
  if (!usdtPairs) {
    usdtPairs = bnFetch<{ symbol: string }[]>('/api/v3/ticker/price')
      .then((rows) => rows.map((r) => r.symbol).filter((s) => s.endsWith('USDT')).map((s) => s.slice(0, -4)))
      .catch(() => { usdtPairs = null; return []; });
  }
  return usdtPairs;
}
