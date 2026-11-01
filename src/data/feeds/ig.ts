import type { Candle } from '../../types';
import { useBroker } from '../../store/broker';
import { nowSec, type FeedSession, type MarketMeta } from './types';

// IG's own prices for the IG symbols (US Tech 100 Cash...: Symbol.ig, the market's epic), through the
// IG relay of the account picked in the "Trader" menu (the demo one otherwise): IG's bars, kept on
// disk by the relay (IG sends 10 000 a week), then IG's live price, read every 10 s for all the
// IG markets shown at once (IG allows few requests a minute).

export type IgQuote = { epic: string; bid: number | null; offer: number | null; status: string; high: number | null; low: number | null; change: number | null };

const relay = () => (useBroker.getState().active === 'ig-live' ? '/api/broker-live/' : '/api/broker/');

async function igGet<T>(path: string, retry = true): Promise<T> {
  const r = await fetch(relay() + path);
  const data = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) {
    // the relay signs in again with the saved login when asked its status (after a restart)
    if (retry && /Pas connecté/.test(data.error ?? '')) {
      await fetch(`${relay()}status`).catch(() => undefined);
      return igGet(path, false);
    }
    throw new Error(data.error === 'Pas connecté à IG' ? 'IG n’est pas connecté : menu Trader › IG démo' : data.error ?? `IG : HTTP ${r.status}`);
  }
  return data;
}

export const igMid = (q: Pick<IgQuote, 'bid' | 'offer'>) => (q.bid != null && q.offer != null ? (q.bid + q.offer) / 2 : null);

// ---------- live prices: one request every 10 s for every IG market listened to ----------

const listeners = new Map<string, Set<(q: IgQuote) => void>>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll() {
  timer = undefined;
  const epics = [...listeners.keys()];
  if (!epics.length) return;
  let ok = true;
  try {
    const quotes = await igGet<IgQuote[]>(`quotes?epics=${encodeURIComponent(epics.join(','))}`);
    // the ticket, the chart's lines and the IG panel read the same prices
    useBroker.setState((s) => {
      const igMarkets = { ...s.igMarkets };
      for (const q of quotes) {
        const m = igMarkets[q.epic];
        igMarkets[q.epic] = m
          ? { ...m, bid: q.bid, offer: q.offer, status: q.status }
          : { epic: q.epic, name: '', bid: q.bid, offer: q.offer, status: q.status, scale: 1, decimals: 2, delay: 0, currency: '', contractSize: 1, minSize: null, minStop: null, partial: true };
      }
      return { igMarkets };
    });
    for (const q of quotes) for (const f of listeners.get(q.epic) ?? []) f(q);
  } catch { ok = false; }
  // IG allows about 30 requests a minute to an account, shared with the positions and orders read
  // every few seconds: 6 a minute here
  if (listeners.size && !timer) timer = setTimeout(poll, ok ? 10_000 : 30_000);
}

// IG's price of a market as it moves; the first one at once
export function listenIg(epic: string, f: (q: IgQuote) => void): () => void {
  let set = listeners.get(epic);
  if (!set) listeners.set(epic, (set = new Set()));
  set.add(f);
  clearTimeout(timer);
  timer = setTimeout(poll, 50);
  return () => {
    set.delete(f);
    if (!set.size) listeners.delete(epic);
  };
}

// ---------- bars ----------

const STEP: Record<string, number> = {
  MINUTE: 60, MINUTE_2: 120, MINUTE_3: 180, MINUTE_5: 300, MINUTE_10: 600, MINUTE_15: 900, MINUTE_30: 1800,
  HOUR: 3600, HOUR_2: 7200, HOUR_3: 10800, HOUR_4: 14400, DAY: 86400, WEEK: 604800, MONTH: 2_592_000,
};
// the bars asked the first time a market is charted in a unit (then only the newer ones)
const FIRST = 300;

export class IgSession implements FeedSession {
  readonly source = 'ig' as const;
  label = 'IG';
  readonly realtime = true;
  // IG's older bars cost its weekly quota: the chart has those kept by the relay
  hasMore = false;
  private epic: string;
  private res: string;
  private step: number;
  private newest: Candle | null = null;

  constructor(epic: string, res: string) {
    const step = STEP[res];
    if (!step) throw new Error(`IG : unité ${res} non supportée`);
    this.epic = epic;
    this.res = res;
    this.step = step;
  }

  async load(): Promise<Candle[]> {
    const r = await igGet<{ candles: Candle[]; error?: string }>(`prices?epic=${encodeURIComponent(this.epic)}&res=${this.res}&max=${FIRST}`);
    if (r.error) this.label = `IG (${r.error})`;
    this.newest = r.candles[r.candles.length - 1] ?? null;
    return r.candles;
  }

  loadOlder(): Promise<Candle[]> {
    return Promise.resolve([]);
  }

  // IG's live price moves the forming bar, or opens the next one (from the last bar's time, so the
  // daily and weekly bars keep IG's own start)
  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    let forming: Candle | null = this.newest ? { ...this.newest } : null;
    return listenIg(this.epic, (q) => {
      const price = igMid(q);
      if (price == null) return;
      onMeta?.({
        last: price, dayHigh: q.high ?? undefined, dayLow: q.low ?? undefined,
        prevClose: q.change != null ? price - q.change : undefined, exchange: 'IG',
      });
      if (q.status !== 'TRADEABLE' || !forming) return;
      const start = forming.time + Math.floor((nowSec() - forming.time) / this.step) * this.step;
      forming = start > forming.time
        ? { time: start, open: price, high: price, low: price, close: price, volume: 0 }
        : { ...forming, high: Math.max(forming.high, price), low: Math.min(forming.low, price), close: price };
      onBar({ ...forming });
    });
  }
}
