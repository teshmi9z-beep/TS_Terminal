import type { Candle, Symbol } from '../../types';
import { SYMBOLS } from '../symbols';
import { zoneOffsetSec } from '../timeZone';
import { bnFetch, bnStream, FAPI_BOOK_WS, FAPI_REST, FAPI_WS } from './binance';
import { ibBars, ibQuotes } from './ib';
import { ibId, yahooId } from './resolve';
import { yfFetch } from './yahoo';
import { nowSec, type FeedSession, type MarketMeta } from './types';

// Real-time estimate of the index futures while their free prices come late (Yahoo or IBKR
// without a futures subscription: CME 10 minutes, Eurex and HKFE 15). Perpetual futures on the
// same indices trade in real time on Binance, MEXC and BingX: the estimate is the last delayed
// minute moved by these perpetuals since that minute. Measured on 14 days of 1-minute bars in
// October 2026, median / 90th percentile of the gap to the real price, in points, against the
// delay alone: ES 0.5 / 1.2 (2.3 / 7.5), NQ 2 / 5 (15 / 46), YM 2.7 / 6.9 (16 / 51), RTY 0.25 /
// 0.6 (1.1 / 3.4), NIY 11 / 27 (55 / 155), DAX 10 / 21 (18 / 46, on the cash index), HSI 3.7 / 10
// (20 / 61, cash index). Once IBKR sends a market in real time its estimate stops by itself.

type Venue = 'binance' | 'mexc' | 'bingx';
// `fallback`: only used while none of the others has a price
type Proxy = { venue: Venue; id: string; weight: number; fallback?: boolean };
type Market = 'cme' | 'eurex' | 'hkfe';
// tick: the future's price step
type Conf = { market: Market; tick: number; proxies: Proxy[] };

const CONF: Record<string, Conf> = {
  US500: { market: 'cme', tick: 0.25, proxies: [{ venue: 'binance', id: 'SPYUSDT', weight: 0.5 }, { venue: 'mexc', id: 'SPX500_USDT', weight: 0.5 }] },
  US100: { market: 'cme', tick: 0.25, proxies: [{ venue: 'binance', id: 'QQQUSDT', weight: 1 }] },
  US30: { market: 'cme', tick: 1, proxies: [{ venue: 'bingx', id: 'NCSIDOWJONES2USD-USDT', weight: 0.5 }, { venue: 'mexc', id: 'US30_USDT', weight: 0.5 }] },
  US2000: { market: 'cme', tick: 0.1, proxies: [{ venue: 'bingx', id: 'NCSIRUSSELL20002USD-USDT', weight: 1 }, { venue: 'binance', id: 'IWMUSDT', weight: 1, fallback: true }] },
  J225: { market: 'cme', tick: 5, proxies: [{ venue: 'bingx', id: 'NCSINIKKEI2252USD-USDT', weight: 1 }, { venue: 'mexc', id: 'JP225_USDT', weight: 1, fallback: true }] },
  DE40: { market: 'eurex', tick: 1, proxies: [{ venue: 'bingx', id: 'NCSIGER2USD-USDT', weight: 1 }] },
  HK50: { market: 'hkfe', tick: 1, proxies: [{ venue: 'mexc', id: 'HK50_USDT', weight: 1 }] },
};

// local weekday (0 = Sunday) and minute of the day in a time zone
function localTime(zone: string, t: number) {
  const local = t + zoneOffsetSec(zone, t);
  return { weekday: (Math.floor(local / 86400) + 4) % 7, min: Math.floor((local % 86400) / 60) };
}
const hm = (h: number, m = 0) => h * 60 + m;

// when each market trades, and how far behind its delayed feed may run (a few minutes more than
// its delay: further behind, the market is closed or its data stalled, and nothing is
// estimated). Holidays aren't listed: the delayed feed stops, which ends the estimate.
const MARKETS: Record<Market, { open: (t: number) => boolean; maxLag: number }> = {
  // CME Globex: Sunday 18:00 to Friday 17:00 New York, halted from 17:00 to 18:00 every evening
  cme: {
    maxLag: 16 * 60,
    open: (t) => {
      const { weekday, min } = localTime('America/New_York', t);
      if (weekday === 6) return false;
      if (weekday === 0) return min >= hm(18);
      if (weekday === 5) return min < hm(17);
      return min < hm(17) || min >= hm(18);
    },
  },
  // Eurex DAX futures: 01:10 to 22:00 Frankfurt, Monday to Friday
  eurex: {
    maxLag: 22 * 60,
    open: (t) => {
      const { weekday, min } = localTime('Europe/Berlin', t);
      return weekday >= 1 && weekday <= 5 && min >= hm(1, 10) && min < hm(22);
    },
  },
  // HKFE Hang Seng futures: 09:15-12:00 and 13:00-16:30, then the night session 17:15-03:00
  hkfe: {
    maxLag: 22 * 60,
    open: (t) => {
      const { weekday, min } = localTime('Asia/Hong_Kong', t);
      // the night session of Monday to Friday ends on Tuesday to Saturday
      if (min < hm(3)) return weekday >= 2 && weekday <= 6;
      if (weekday < 1 || weekday > 5) return false;
      return (min >= hm(9, 15) && min < hm(12)) || (min >= hm(13) && min < hm(16, 30)) || min >= hm(17, 15);
    },
  },
};

// a perpetual's last price counts this long after its last trade or quote
const MAX_CARRY = 3 * 60;
// perpetual minutes kept
const KEEP = 3 * 3600;
// streams stay open this long after the last chart or list using them is gone
const IDLE_STOP = 60_000;

// a websocket that reconnects (exponential backoff). `open` subscribes and may return what to
// stop when the connection closes (a ping timer)
function liveSocket(url: string, open: (s: WebSocket) => (() => void) | void, message: (s: WebSocket, data: any) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopOpen: (() => void) | void;
  const connect = () => {
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => { stopOpen = open(sock); };
    sock.onmessage = (ev) => { attempt = 0; message(sock, ev.data); };
    sock.onerror = () => sock.close();
    sock.onclose = () => {
      stopOpen?.();
      if (closed) return;
      attempt++;
      timer = setTimeout(connect, Math.min(15000, 500 * 2 ** Math.min(attempt, 5)));
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    stopOpen?.();
    if (ws) { ws.onclose = null; ws.close(); }
  };
}

// MEXC futures: the REST API sends no CORS header (it goes through the Vite server's /mexc relay)
// but the websocket works from the browser. Pushes the 1-minute bars of one contract.
function mexcStream(id: string, onBar: (d: any, at: number) => void): () => void {
  return liveSocket('wss://contract.mexc.com/edge', (sock) => {
    sock.send(JSON.stringify({ method: 'sub.kline', param: { symbol: id, interval: 'Min1' } }));
    // the server drops a connection that sends no ping for a minute
    const ping = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send('{"method":"ping"}'); }, 15_000);
    return () => clearInterval(ping);
  }, (_sock, data) => {
    try {
      const m = JSON.parse(data);
      if (m.channel === 'push.kline' && m.data) onBar(m.data, m.ts ?? Date.now());
    } catch { /* ignore malformed frame */ }
  });
}

// BingX futures: same (REST through /bingx); its frames are gzip-compressed and its pings
// ("Ping") want a "Pong"
function bingxStream(id: string, onBar: (d: any) => void): () => void {
  return liveSocket('wss://open-api-swap.bingx.com/swap-market', (sock) => {
    sock.binaryType = 'arraybuffer';
    sock.send(JSON.stringify({ id: `kline-${id}`, reqType: 'sub', dataType: `${id}@kline_1m` }));
  }, async (sock, data) => {
    try {
      const text = typeof data === 'string' ? data : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      if (text === 'Ping') { sock.send('Pong'); return; }
      const m = JSON.parse(text);
      if (m.dataType === `${id}@kline_1m`) for (const d of m.data ?? []) onBar(d);
    } catch { /* ignore malformed frame */ }
  });
}

// one perpetual's 1-minute bars: the last hours, then live
class ProxyFeed {
  readonly p: Proxy;
  private bars = new Map<number, Candle>();
  // the last best bid / ask midpoint (Binance), newer than the last trade between two trades
  private mid: { price: number; at: number } | null = null;
  private stops: (() => void)[] = [];
  private changed: () => void;

  constructor(p: Proxy, changed: () => void) {
    this.p = p;
    this.changed = changed;
  }

  start() {
    this.history().catch(() => { /* the stream fills in */ });
    const { venue, id } = this.p;
    if (venue === 'binance') {
      const s = id.toLowerCase();
      this.stops.push(bnStream(`/ws/${s}@kline_1m`, (m) => {
        const k = m?.k;
        if (k) this.put({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }, m.E ?? Date.now());
      }, FAPI_WS));
      this.stops.push(bnStream(`/ws/${s}@bookTicker`, (m) => {
        if (m?.b && m?.a) this.quote((+m.b + +m.a) / 2, m.E ?? Date.now());
      }, FAPI_BOOK_WS));
    } else if (venue === 'mexc') {
      this.stops.push(mexcStream(id, (d, at) => this.put({ time: d.t, open: +d.o, high: +d.h, low: +d.l, close: +d.c, volume: +d.q || 0 }, at)));
    } else {
      this.stops.push(bingxStream(id, (d) => this.put({ time: Math.floor(d.T / 1000), open: +d.o, high: +d.h, low: +d.l, close: +d.c, volume: +d.v || 0 }, Date.now())));
    }
  }

  stop() {
    for (const f of this.stops) f();
    this.stops = [];
  }

  private async history() {
    const now = nowSec();
    const { venue, id } = this.p;
    let rows: Candle[];
    if (venue === 'binance') {
      const k = await bnFetch<any[]>(`/fapi/v1/klines?symbol=${id}&interval=1m&limit=180`, FAPI_REST);
      rows = k.map((b) => ({ time: b[0] / 1000, open: +b[1], high: +b[2], low: +b[3], close: +b[4], volume: +b[5] }));
    } else if (venue === 'mexc') {
      const r = await fetch(`/mexc/api/v1/contract/kline/${id}?interval=Min1&start=${now - KEEP}&end=${now}`);
      const d = (await r.json())?.data;
      rows = (d?.time ?? []).map((t: number, i: number) => ({ time: t, open: +d.open[i], high: +d.high[i], low: +d.low[i], close: +d.close[i], volume: +d.vol[i] || 0 }));
    } else {
      const r = await fetch(`/bingx/openApi/swap/v3/quote/klines?symbol=${id}&interval=1m&limit=180`);
      const d: any[] = (await r.json())?.data ?? [];
      rows = d.map((b) => ({ time: Math.floor(b.time / 1000), open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0 }));
    }
    // the stream may already hold newer values of the last minutes
    for (const c of rows) if (!this.bars.has(c.time)) this.bars.set(c.time, c);
    this.changed();
  }

  // a bar from the stream; `at` is when it was sent (ms)
  private put(c: Candle, at: number) {
    const mid = this.mid;
    if (mid && mid.at > at && Math.floor(mid.at / 60000) * 60 === c.time) {
      c = { ...c, high: Math.max(c.high, mid.price), low: Math.min(c.low, mid.price), close: mid.price };
    }
    this.bars.set(c.time, c);
    if (this.bars.size > KEEP / 60 + 60) for (const t of this.bars.keys()) if (t < c.time - KEEP) this.bars.delete(t);
    this.changed();
  }

  // the best bid / ask between two trades moves the current minute
  private quote(price: number, at: number) {
    this.mid = { price, at };
    const m = Math.floor(at / 60000) * 60;
    const b = this.bars.get(m);
    this.bars.set(m, b
      ? { ...b, high: Math.max(b.high, price), low: Math.min(b.low, price), close: price }
      : { time: m, open: price, high: price, low: price, close: price, volume: 0 });
    this.changed();
  }

  // the bar of minute m, or a flat one at the last price when nothing traded in it
  barAt(m: number): Candle | null {
    const b = this.bars.get(m);
    if (b) return b;
    for (let t = m - 60; t >= m - MAX_CARRY; t -= 60) {
      const c = this.bars.get(t);
      if (c) return { time: m, open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 };
    }
    return null;
  }

  closeAt(m: number): number | null {
    return this.barAt(m)?.close ?? null;
  }
}

async function yahoo1m(id: string): Promise<Candle[]> {
  const now = nowSec();
  const j = await yfFetch(`/v8/finance/chart/${encodeURIComponent(id)}?interval=1m&period1=${now - 2700}&period2=${now + 60}`);
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const out: Candle[] = [];
  (r?.timestamp ?? []).forEach((t: number, i: number) => {
    if (q.open[i] == null || q.close[i] == null) return;
    const c = { time: Math.floor(t / 60) * 60, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0 };
    // Yahoo may end with the latest price stamped inside the last minute
    if (out.length && out[out.length - 1].time === c.time) out[out.length - 1] = c; else out.push(c);
  });
  return out;
}

const VENUE_NAMES: Record<Venue, string> = { binance: 'Binance', mexc: 'MEXC', bingx: 'BingX' };

// after a failed IBKR request (gateway closed) the estimators read Yahoo for a minute
let ibDownUntil = 0;

export class FuturesEstimator {
  readonly ticker: string;
  // where the perpetuals trade: 'BingX / MEXC'
  readonly venues: string;
  // IBKR sends this future in real time (a futures subscription): nothing to estimate
  live = false;
  private sym: Symbol;
  private conf: Conf;
  private proxies: ProxyFeed[];
  // the delayed 1-minute bars of the future (IBKR, else Yahoo), the last half hour
  private real: Candle[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(sym: Symbol, conf: Conf) {
    this.ticker = sym.ticker;
    this.sym = sym;
    this.conf = conf;
    this.proxies = conf.proxies.map((p) => new ProxyFeed(p, () => this.notify()));
    this.venues = [...new Set(conf.proxies.filter((p) => !p.fallback).map((p) => VENUE_NAMES[p.venue]))].join(' / ');
  }

  // runs while someone listens (charts, the watchlist); called a few times a second at most
  listen(f: () => void): () => void {
    this.listeners.add(f);
    clearTimeout(this.stopTimer);
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(f);
      if (!this.listeners.size) this.stopTimer = setTimeout(() => this.stop(), IDLE_STOP);
    };
  }

  // resolves once estimating, or after `ms`
  whenReady(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let off = () => {};
      const done = () => { clearTimeout(timer); off(); resolve(); };
      const timer = setTimeout(done, ms);
      off = this.listen(() => { if (this.active) done(); });
      if (this.active) done();
    });
  }

  // the newest complete delayed minute (the last one is still forming)
  private anchor(): Candle | null {
    return this.real.length >= 2 ? this.real[this.real.length - 2] : null;
  }

  get active(): boolean {
    const a = this.anchor();
    if (!this.running || this.live || !a) return false;
    const now = nowSec();
    return now - a.time <= MARKETS[this.conf.market].maxLag && this.estimate(a, Math.floor(now / 60) * 60) != null;
  }

  // the delayed real minutes from `from` to the anchor, then the estimated ones up to now
  minutes(from: number): Candle[] {
    const a = this.anchor();
    if (!a || !this.active) return [];
    const out = this.real.filter((c) => c.time >= from && c.time <= a.time);
    const open = MARKETS[this.conf.market].open;
    const now = Math.floor(nowSec() / 60) * 60;
    for (let m = Math.max(a.time + 60, Math.ceil(from / 60) * 60); m <= now; m += 60) {
      if (!open(m)) continue;
      const e = this.estimate(a, m);
      if (e) out.push(e);
    }
    return out;
  }

  // the estimated price now
  last(): number | null {
    const a = this.anchor();
    const m = a ? this.minutes(a.time) : [];
    return m.length ? m[m.length - 1].close : null;
  }

  // minute m estimated: the anchor's close times the perpetuals' move since the anchor (the
  // fallback perpetuals only when no other has a price)
  private estimate(a: Candle, m: number): Candle | null {
    let w = 0, o = 0, h = 0, l = 0, c = 0;
    for (const fallback of [false, true]) {
      for (const p of this.proxies) {
        if (!!p.p.fallback !== fallback) continue;
        const base = p.closeAt(a.time);
        const bar = p.barAt(m);
        if (!base || !bar) continue;
        const k = p.p.weight / base;
        w += p.p.weight;
        o += k * bar.open; h += k * bar.high; l += k * bar.low; c += k * bar.close;
      }
      if (w) break;
    }
    if (!w) return null;
    const tick = this.conf.tick;
    const px = (x: number) => +(Math.round((a.close * x) / w / tick) * tick).toFixed(2);
    const open = px(o), close = px(c);
    return { time: m, open, high: Math.max(open, close, px(h)), low: Math.min(open, close, px(l)), close, volume: 0, est: true };
  }

  private notify() {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      for (const f of [...this.listeners]) f();
    }, 300);
  }

  private start() {
    this.running = true;
    for (const p of this.proxies) p.start();
    void this.poll();
  }

  private stop() {
    this.running = false;
    for (const p of this.proxies) p.stop();
    clearTimeout(this.pollTimer);
  }

  // the delayed minutes: from IBKR when the gateway runs (same source as the chart), else Yahoo
  private poll = async () => {
    const ib = ibId(this.sym);
    const y = yahooId(this.sym);
    let bars: Candle[] | null = null;
    if (ib && Date.now() > ibDownUntil) {
      try {
        // the relay answers an identical bars request from its cache for 15 s (a 1-minute chart asks the same)
        const [b, q] = await Promise.all([ibBars(ib, '1m', '1800 S'), ibQuotes([ib])]);
        bars = b;
        this.live = !!q[ib]?.live;
      } catch {
        this.live = false;
        ibDownUntil = Date.now() + 60_000;
      }
    }
    if (!bars?.length && y) {
      try { bars = await yahoo1m(y); } catch { /* keep the last bars */ }
    }
    if (bars?.length) this.real = bars;
    this.notify();
    if (this.running) this.pollTimer = setTimeout(this.poll, 15_000);
  };
}

const estimators = new Map<string, FuturesEstimator>();

// the estimator of an index future (US30, US500, US100, US2000, J225, DE40, HK50), null for
// any other symbol
export function estimatorFor(ticker: string): FuturesEstimator | null {
  const conf = CONF[ticker];
  if (!conf) return null;
  let e = estimators.get(ticker);
  if (!e) {
    const sym = SYMBOLS.find((s) => s.ticker === ticker);
    if (!sym) return null;
    e = new FuturesEstimator(sym, conf);
    estimators.set(ticker, e);
  }
  return e;
}

// a chart's bars, the newest followed by the estimated minutes while the future's prices are
// delayed; the delayed feed's real bars replace them as they come. Only charts use it: robots,
// alerts and the history saved on this computer see the real bars alone.
export class EstimatedSession implements FeedSession {
  readonly source: FeedSession['source'];
  onReset?: () => void;
  private inner: FeedSession;
  private est: FuturesEstimator;
  private step: number;
  private daily: boolean;
  // the newest real bar, and what was last sent for each recent bar time
  private newest: Candle | null = null;
  private sent = new Map<number, string>();
  // the newest bar sent with estimated minutes in it
  private estUntil = 0;

  // `step`: the chart's bar duration in seconds
  constructor(inner: FeedSession, est: FuturesEstimator, step: number, daily: boolean) {
    this.inner = inner;
    this.est = est;
    this.step = step;
    this.daily = daily;
    this.source = inner.source;
  }

  get estimated() { return !this.inner.realtime && this.est.active; }
  get realtime() { return this.inner.realtime || this.estimated; }
  get label() { return this.estimated ? `${this.inner.label} + ${this.est.venues}` : this.inner.label; }
  get hasMore() { return this.inner.hasMore; }
  set hasMore(v: boolean) { this.inner.hasMore = v; }

  async load(): Promise<Candle[]> {
    const candles = await this.inner.load();
    this.newest = candles[candles.length - 1] ?? null;
    await this.est.whenReady(5000);
    const over = this.overlay();
    return over.length ? [...candles.slice(0, -1), ...over] : candles;
  }

  loadOlder(): Promise<Candle[]> {
    return this.inner.loadOlder();
  }

  // the newest real bar and the bars after it, with the estimator's minutes merged in
  private overlay(): Candle[] {
    const r = this.newest;
    if (!r || !this.estimated) return [];
    const mins = this.est.minutes(r.time);
    if (!mins.length) return [];
    const out: Candle[] = [{ ...r }];
    for (const m of mins) {
      const t = this.daily ? r.time : r.time + Math.floor((m.time - r.time) / this.step) * this.step;
      const b = out[out.length - 1];
      if (t === b.time) {
        b.high = Math.max(b.high, m.high);
        b.low = Math.min(b.low, m.low);
        b.close = m.close;
        // the real bar already counts the real minutes' volume
        if (t !== r.time) b.volume += m.volume;
        if (m.est) b.est = true;
      } else {
        out.push({ ...m, time: t });
      }
    }
    return out;
  }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (b: Candle) => {
      const key = `${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}|${b.est ? 1 : 0}`;
      if (this.sent.get(b.time) === key) return;
      this.sent.set(b.time, key);
      if (this.sent.size > 300) this.sent.delete(this.sent.keys().next().value!);
      if (b.est) this.estUntil = Math.max(this.estUntil, b.time);
      onBar(b);
    };
    const refresh = () => {
      const bars = this.overlay();
      for (const b of bars) send(b);
      if (bars.length) for (const t of this.sent.keys()) if (t < bars[0].time - 5 * this.step) this.sent.delete(t);
    };
    const offInner = this.inner.subscribe((c) => {
      if (!this.newest || c.time >= this.newest.time) this.newest = c;
      if (c.time === this.newest.time && this.estimated) refresh(); else send(c);
    }, onMeta && ((m) => onMeta(this.estimated ? { ...m, last: undefined } : m)));
    const offEst = this.est.listen(() => {
      if (this.estimated) {
        clearTimeout(resetTimer);
        resetTimer = undefined;
        refresh();
        return;
      }
      // estimated bars left past the real ones once the estimate stops (a market closing early
      // before a holiday): the chart reloads after half a minute
      if (!resetTimer && this.estUntil > (this.newest?.time ?? 0)) {
        resetTimer = setTimeout(() => { if (!this.estimated) this.onReset?.(); }, 30_000);
      }
    });
    return () => { offInner(); offEst(); clearTimeout(resetTimer); };
  }
}
