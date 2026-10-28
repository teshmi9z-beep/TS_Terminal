import type { Candle } from '../../types';
import { nowSec, type FeedSession, type MarketMeta } from './types';

// Interactive Brokers, through the IB Gateway running on this computer and relayed by the Vite
// server (scripts/ib-relay.ts). Without a market data subscription the prices are delayed
// (15 minutes for the index CFDs); the relay says when they are real-time.

const DAY = 86400;

type IbConf = {
  step: number;
  // IBKR duration of the first page and of each older page
  span: string;
  spanSec: number;
  // duration polled for the live bars
  liveDur: string;
  daily: boolean;
};

// keyed by the relay's bar names
const CONF: Record<string, IbConf> = {
  '1m': { step: 60, span: '3 D', spanSec: 3 * DAY, liveDur: '1800 S', daily: false },
  '2m': { step: 120, span: '1 W', spanSec: 7 * DAY, liveDur: '3600 S', daily: false },
  '3m': { step: 180, span: '1 W', spanSec: 7 * DAY, liveDur: '3600 S', daily: false },
  '5m': { step: 300, span: '2 W', spanSec: 14 * DAY, liveDur: '7200 S', daily: false },
  '10m': { step: 600, span: '1 M', spanSec: 30 * DAY, liveDur: '14400 S', daily: false },
  '15m': { step: 900, span: '1 M', spanSec: 30 * DAY, liveDur: '14400 S', daily: false },
  '20m': { step: 1200, span: '2 M', spanSec: 60 * DAY, liveDur: '1 D', daily: false },
  '30m': { step: 1800, span: '2 M', spanSec: 60 * DAY, liveDur: '1 D', daily: false },
  '1h': { step: 3600, span: '6 M', spanSec: 182 * DAY, liveDur: '2 D', daily: false },
  '2h': { step: 7200, span: '1 Y', spanSec: 365 * DAY, liveDur: '3 D', daily: false },
  '3h': { step: 10800, span: '1 Y', spanSec: 365 * DAY, liveDur: '3 D', daily: false },
  '4h': { step: 14400, span: '1 Y', spanSec: 365 * DAY, liveDur: '5 D', daily: false },
  '8h': { step: 28800, span: '2 Y', spanSec: 730 * DAY, liveDur: '5 D', daily: false },
  '1d': { step: DAY, span: '5 Y', spanSec: 5 * 365 * DAY, liveDur: '5 D', daily: true },
  '1w': { step: 7 * DAY, span: '20 Y', spanSec: 20 * 365 * DAY, liveDur: '1 M', daily: true },
  '1M': { step: 30 * DAY, span: '20 Y', spanSec: 20 * 365 * DAY, liveDur: '1 Y', daily: true },
};

export const IB_INTERVALS: [string, number][] = Object.entries(CONF)
  .filter(([k]) => !['1w', '1M'].includes(k))
  .map(([k, c]) => [k, c.step]);

type BarsReply = { candles: Candle[] };

async function ibGet<T>(path: string): Promise<T> {
  const r = await fetch(`/api/ib${path}`);
  let j: any = null;
  try { j = await r.json(); } catch { /* not json: the dev server has no relay */ }
  if (!r.ok || !j) throw new Error(j?.error ?? `Interactive Brokers indisponible (HTTP ${r.status})`);
  return j as T;
}

export type IbQuote = { last?: number; bid?: number; ask?: number; prevClose?: number; live: boolean };
export const ibQuotes = (ids: string[]) => ibGet<Record<string, IbQuote>>(`/quotes?ids=${encodeURIComponent(ids.join(','))}`);

// one page of bars: `bar` is a relay bar name (1m ... 1M), `dur` an IBKR duration ("1800 S", "3 D")
export const ibBars = (id: string, bar: string, dur: string, end?: number) =>
  ibGet<BarsReply>(`/bars?id=${encodeURIComponent(id)}&bar=${bar}&dur=${encodeURIComponent(dur)}${end ? `&end=${end}` : ''}`).then((r) => r.candles);

export class IbSession implements FeedSession {
  readonly source = 'ib' as const;
  readonly label = 'Interactive Brokers';
  // delayed until the account subscribes to the market's data: the gateway says which
  // with the first quotes (read in load)
  realtime = false;
  hasMore = true;
  private conf: IbConf;
  private id: string;
  private bar: string;
  private oldest = 0;
  // the newest bar loaded, which the real-time quotes move until the next bars poll
  private newest: Candle | null = null;

  constructor(id: string, bar: string) {
    const conf = CONF[bar];
    if (!conf) throw new Error(`Interactive Brokers : unité ${bar} non supportée`);
    this.id = id;
    this.bar = bar;
    this.conf = conf;
  }

  private page(dur: string, end?: number): Promise<Candle[]> {
    return ibBars(this.id, this.bar, dur, end);
  }

  async load(): Promise<Candle[]> {
    // the quote starts streaming now; by the time the history is in, the gateway has said
    // whether its prices are real time
    ibQuotes([this.id]).catch(() => {});
    const candles = await this.page(this.conf.span);
    this.realtime = !!(await ibQuotes([this.id]).catch(() => null))?.[this.id]?.live;
    this.oldest = candles[0]?.time ?? nowSec() - this.conf.spanSec;
    this.newest = candles[candles.length - 1] ?? null;
    // IBKR's own continuous future can't be asked for an older page
    this.hasMore = candles.length > 0 && !this.id.startsWith('CONTFUT:');
    return candles;
  }

  async loadOlder(): Promise<Candle[]> {
    if (!this.hasMore) return [];
    const end = this.oldest;
    const older = (await this.page(this.conf.span, end)).filter((c) => c.time < end);
    // IBKR keeps index CFDs since 2012: an empty page is the start of the history
    if (!older.length) { this.hasMore = false; return []; }
    this.oldest = older[0].time;
    return older;
  }

  // the last bars are polled (IBKR refuses identical historical requests less than 15 s
  // apart) and the quote every 5 s; with real-time data (a market data subscription) the quote
  // is read every second and moves the forming bar, or opens the next one, in between
  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    let stopped = false;
    let barTimer: ReturnType<typeof setTimeout> | undefined;
    let quoteTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let forming: Candle | null = this.newest ? { ...this.newest } : null;
    const bars = async () => {
      try {
        const candles = await this.page(this.conf.liveDur);
        if (stopped) return;
        for (const c of candles.slice(-2)) onBar(c);
        const last = candles[candles.length - 1];
        if (last && (!forming || last.time >= forming.time)) forming = { ...last };
        failures = 0;
      } catch {
        failures++;
      }
      if (!stopped) barTimer = setTimeout(bars, 20_000 * Math.min(6, 1 + failures));
    };
    const tick = (price: number) => {
      if (!forming) return;
      const start = this.conf.daily ? forming.time : Math.floor(nowSec() / this.conf.step) * this.conf.step;
      forming = start > forming.time
        ? { time: start, open: price, high: price, low: price, close: price, volume: 0 }
        : { ...forming, high: Math.max(forming.high, price), low: Math.min(forming.low, price), close: price };
      onBar(forming);
    };
    const quote = async () => {
      try {
        const q = (await ibQuotes([this.id]))[this.id];
        if (!stopped && q?.last) {
          this.realtime = q.live;
          onMeta?.({ last: q.last, prevClose: q.prevClose, exchange: 'Interactive Brokers' });
          if (q.live) tick(q.last);
        }
      } catch { /* the bars loop reports the outage */ }
      if (!stopped) quoteTimer = setTimeout(quote, this.realtime ? 1000 : 5000);
    };
    barTimer = setTimeout(bars, 20_000);
    quoteTimer = setTimeout(quote, 500);
    return () => { stopped = true; clearTimeout(barTimer); clearTimeout(quoteTimer); };
  }
}
