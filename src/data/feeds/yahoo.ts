import type { Candle } from '../../types';
import { nowSec, type FeedSession, type MarketMeta } from './types';
import { AggregatedSession } from './aggregate';

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

// (Yahoo's oldest daily bars are the S&P 500's, December 1927)
const ALL_BACK = 150 * 365 * DAY;

// keyed by Yahoo's native interval names
const CONF: Record<string, YConf> = {
  '1m': { step: 60, span: 5 * DAY, maxBack: 29 * DAY, liveRange: '1d', poll: 4000, daily: false },
  '2m': { step: 120, span: 10 * DAY, maxBack: 59 * DAY, liveRange: '1d', poll: 4000, daily: false },
  '5m': { step: 300, span: 20 * DAY, maxBack: 59 * DAY, liveRange: '1d', poll: 5000, daily: false },
  '15m': { step: 900, span: 40 * DAY, maxBack: 59 * DAY, liveRange: '2d', poll: 5000, daily: false },
  '30m': { step: 1800, span: 59 * DAY, maxBack: 59 * DAY, liveRange: '5d', poll: 6000, daily: false },
  '60m': { step: 3600, span: 180 * DAY, maxBack: 729 * DAY, liveRange: '5d', poll: 8000, daily: false },
  '90m': { step: 5400, span: 59 * DAY, maxBack: 59 * DAY, liveRange: '5d', poll: 8000, daily: false },
  // days and longer: all Yahoo has (the S&P 500 since 1927), down to its first trading day
  '1d': { step: DAY, span: 6 * 365 * DAY, maxBack: ALL_BACK, liveRange: '5d', poll: 15000, daily: true },
  '1wk': { step: 7 * DAY, span: 30 * 365 * DAY, maxBack: ALL_BACK, liveRange: '1mo', poll: 20000, daily: true },
  '1mo': { step: 30 * DAY, span: 80 * 365 * DAY, maxBack: ALL_BACK, liveRange: '6mo', poll: 30000, daily: true },
  '3mo': { step: 91 * DAY, span: 80 * 365 * DAY, maxBack: ALL_BACK, liveRange: '1y', poll: 30000, daily: true },
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

// A US share's pre-market and after-hours bars from Yahoo carry stray trades far off the market,
// nearly every day right after the close: NVDA's 17:00 New York bar of 2026-09-22 opened and closed
// at 228 with a 268 high and a 198 low (TradingView, which drops such trades, shows a small bar).
// Outside the regular session, a wick reaching past the bodies of its bar and of both neighbours by
// more than STRAY_K times the usual range of the bars around it is cut back to the body.
// (4 catches the strays of 2026 on NVDA, AAPL and TSLA, the same prices coming back day after day,
// and keeps the after-hours move of NVDA's results on 2026-08-26)
const STRAY_K = 4;
const STRAY_SPAN = 12;

// (twice: the strays widen the usual range they are measured against, the second pass sees it without them)
function trimStrayWicks(bars: Candle[], regular: (c: Candle) => boolean) {
  for (let pass = 0; pass < 2; pass++) trimPass(bars, regular);
}

function trimPass(bars: Candle[], regular: (c: Candle) => boolean) {
  const span = bars.map((c) => c.high - c.low);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (regular(c)) continue;
    const around: number[] = [];
    for (let k = Math.max(0, i - STRAY_SPAN); k <= Math.min(bars.length - 1, i + STRAY_SPAN); k++) if (k !== i) around.push(span[k]);
    if (around.length < 6) continue;
    around.sort((a, b) => a - b);
    const limit = STRAY_K * around[around.length >> 1];
    if (!(limit > 0)) continue;
    const near = [bars[i - 1], c, bars[i + 1]].filter(Boolean);
    const top = Math.max(...near.map((b) => Math.max(b.open, b.close)));
    const bottom = Math.min(...near.map((b) => Math.min(b.open, b.close)));
    if (c.high - top > limit) c.high = Math.max(c.open, c.close);
    if (bottom - c.low > limit) c.low = Math.min(c.open, c.close);
  }
}

// the regular session of each day in the answer; without it, Yahoo's extended bars are the ones
// without volume
function regularOf(meta: any): (c: Candle) => boolean {
  const reg = meta?.tradingPeriods?.regular;
  const periods: { start: number; end: number }[] = Array.isArray(reg) ? reg.flat().filter((p: any) => p && p.end > p.start) : [];
  if (!periods.length) return (c) => c.volume > 0;
  return (c) => periods.some((p) => c.time >= p.start && c.time < p.end);
}

function parseChart(json: any, conf: YConf, extended = false): { candles: Candle[]; meta: any } {
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
  if (extended && !conf.daily) trimStrayWicks(out, regularOf(r.meta));
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
  // with the pre-market and after-hours bars (US shares, intraday), like TradingView's extended hours
  private prePost: boolean;

  constructor(id: string, interval: string, prePost = false) {
    this.id = id;
    const conf = CONF[interval];
    if (!conf) throw new Error(`Yahoo: intervalle ${interval} non supporté`);
    this.conf = conf;
    this.interval = interval;
    this.prePost = prePost;
  }

  // the exchange's offset from UTC, in seconds (its local dates key the daily bars)
  gmt = 0;

  private async range(p1: number, p2: number) {
    const path = `/v8/finance/chart/${encodeURIComponent(this.id)}?interval=${this.interval}&period1=${p1}&period2=${p2}&includePrePost=${this.prePost}`;
    const parsed = parseChart(await yfFetch(path), this.conf, this.prePost);
    this.gmt = parsed.meta?.gmtoffset ?? this.gmt;
    return parsed;
  }

  // Yahoo's months stop in January 1985 for its oldest indices (S&P 500, Nikkei, Nasdaq...)
  // while its days go further back: the months it lacks between the window's start and its
  // first month are built from its days
  private async monthsBefore(p1: number, end: number, candles: Candle[]): Promise<Candle[]> {
    if (this.interval !== '1mo' || !this.firstTrade) return candles;
    const from = Math.max(p1, this.firstTrade - 7 * DAY);
    const until = candles[0]?.time ?? end;
    if (until - from < 62 * DAY) return candles;
    const path = `/v8/finance/chart/${encodeURIComponent(this.id)}?interval=1d&period1=${from}&period2=${until - 1}`;
    const days = await yfFetch(path).then((j) => parseChart(j, CONF['1d']).candles).catch((): Candle[] => []);
    const months: Candle[] = [];
    for (const c of days) {
      const d = new Date(c.time * 1000);
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
      const last = months[months.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        last.volume += c.volume;
      } else months.push({ ...c, time: t });
    }
    return [...months.filter((m) => m.time < until), ...candles];
  }

  // how long after the first page's start (or the first trading day, when later) its first bar
  // comes: months when Yahoo has lost the series (ROKU's days in November 2026: the last five)
  missingAtStart = 0;

  async load(): Promise<Candle[]> {
    const now = nowSec();
    const floor = now - this.conf.maxBack + 3600;
    const p1 = Math.max(now - this.conf.span, floor);
    const got = await this.range(p1, now + 3600);
    const meta = got.meta;
    this.firstTrade = meta?.firstTradeDate ?? 0;
    this.missingAtStart = got.candles.length ? got.candles[0].time - Math.max(p1, this.firstTrade) : 0;
    const candles = await this.monthsBefore(p1, now, got.candles);
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
    // never a window wholly before the first trading day: Yahoo answers it with an error
    const p1 = Math.max(p2 - this.conf.span, floor, this.firstTrade ? this.firstTrade - 7 * DAY : -Infinity);
    if (p1 >= p2 - this.conf.step) { this.hasMore = false; return []; }
    const { candles } = await this.range(p1, p2);
    const kept = await this.monthsBefore(p1, p2, candles.filter((c) => c.time < p2));
    // (a day's bar is keyed at 00:00 but stamped later by Yahoo: the next page must end before
    // that key, or it brings the same day again)
    this.cursor = Math.min(p1, kept[0]?.time ?? p1);
    if (p1 <= floor || (this.firstTrade && p1 <= this.firstTrade)) this.hasMore = false;
    // (no first trading day given, as for some Chinese indices: years without a bar end the history)
    if (this.conf.daily && !this.firstTrade && !candles.length) this.hasMore = false;
    return kept;
  }

  // Yahoo has no public streaming API; poll the short live range instead
  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const json = await yfFetch(`/v8/finance/chart/${encodeURIComponent(this.id)}?interval=${this.interval}&range=${this.conf.liveRange}&includePrePost=${this.prePost}`);
        if (stopped) return;
        const { candles, meta } = parseChart(json, this.conf, this.prePost);
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

// ---- daily bars rebuilt from hourly ones, keyed like Yahoo's own (the exchange's local date), for
// the markets whose daily series Yahoo has lost while their hourly history is intact (CETH.PA and
// BITC.PA in October 2026: one daily bar, today's, against two years of hourly bars)
class HourlyDays implements FeedSession {
  readonly source = 'yahoo' as const;
  readonly label = 'Yahoo Finance';
  readonly realtime = false;
  private hours: YahooSession;
  private base: Candle[] = [];

  constructor(id: string) { this.hours = new YahooSession(id, '60m'); }

  get hasMore() { return this.hours.hasMore; }
  set hasMore(v: boolean) { this.hours.hasMore = v; }

  private dayOf(t: number) { return Math.floor((t + this.hours.gmt) / DAY) * DAY; }

  private days(bars: Candle[]): Candle[] {
    const out: Candle[] = [];
    for (const c of bars) {
      const t = this.dayOf(c.time);
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        last.volume += c.volume;
      } else out.push({ ...c, time: t });
    }
    return out;
  }

  async load(): Promise<Candle[]> {
    this.base = await this.hours.load();
    return this.days(this.base);
  }

  async loadOlder(): Promise<Candle[]> {
    const firstDay = this.days(this.base)[0]?.time ?? Infinity;
    const older = await this.hours.loadOlder();
    const first = this.base[0]?.time ?? Infinity;
    this.base = [...older.filter((c) => c.time < first), ...this.base];
    return this.days(this.base).filter((d) => d.time < firstDay);
  }

  // the hourly bar in progress makes the day in progress
  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    return this.hours.subscribe((b) => {
      const i = this.base.findIndex((c) => c.time >= b.time);
      if (i < 0) this.base.push(b);
      else if (this.base[i].time === b.time) this.base[i] = b;
      else this.base.splice(i, 0, b);
      const day = this.dayOf(b.time);
      const today = this.days(this.base.filter((c) => this.dayOf(c.time) === day))[0];
      if (today) onBar(today);
    }, onMeta);
  }
}

// Yahoo's daily or weekly bars; rebuilt from the hourly ones when Yahoo has fewer than two, or
// has lost all but the last ones (its first page then starts months after the first trading day)
const LOST_AFTER = 45 * DAY;
export class YahooDailySession implements FeedSession {
  readonly source = 'yahoo' as const;
  readonly label = 'Yahoo Finance';
  readonly realtime = false;
  private id: string;
  private interval: '1d' | '1wk';
  private inner: FeedSession;

  constructor(id: string, interval: '1d' | '1wk') {
    this.id = id;
    this.interval = interval;
    this.inner = new YahooSession(id, interval);
  }

  get hasMore() { return this.inner.hasMore; }
  set hasMore(v: boolean) { this.inner.hasMore = v; }

  async load(): Promise<Candle[]> {
    const yahoo = this.inner as YahooSession;
    const bars = await yahoo.load().catch((): Candle[] => []);
    if (bars.length >= 2 && yahoo.missingAtStart < LOST_AFTER) return bars;
    const days = new HourlyDays(this.id);
    // weeks from Monday (1970-01-01 was a Thursday)
    this.inner = this.interval === '1wk' ? new AggregatedSession(days, 7 * DAY, false, 4 * DAY) : days;
    return this.inner.load();
  }

  loadOlder(): Promise<Candle[]> { return this.inner.loadOlder(); }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void { return this.inner.subscribe(onBar, onMeta); }
}

// ---- a US share's pre-market / after-hours price, from its chart with the extended hours (the
// spark has none): null during the session, or when the last trade is not in those hours
export type ExtendedPrice = { price: number; session: 'pre' | 'post'; time: number; regular: number };
export async function yahooExtended(id: string): Promise<ExtendedPrice | null> {
  const json = await yfFetch<any>(`/v8/finance/chart/${encodeURIComponent(id)}?range=1d&interval=1m&includePrePost=true`);
  const r = json?.chart?.result?.[0];
  const ts: number[] = r?.timestamp ?? [];
  const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
  let k = ts.length - 1;
  while (k >= 0 && closes[k] == null) k--;
  const period = r?.meta?.currentTradingPeriod, regular = r?.meta?.regularMarketPrice;
  if (k < 0 || typeof regular !== 'number') return null;
  const t = ts[k];
  const within = (p?: { start: number; end: number }) => !!p && t >= p.start && t < p.end;
  const session = within(period?.pre) ? 'pre' : within(period?.post) ? 'post' : null;
  return session ? { price: closes[k]!, session, time: t, regular } : null;
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
