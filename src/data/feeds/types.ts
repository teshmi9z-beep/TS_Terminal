import type { Candle } from '../../types';

// local: bars saved on this computer (offline); ib: Interactive Brokers through the local IB Gateway
export type FeedSource = 'binance' | 'yahoo' | 'ib' | 'sim' | 'local';

// market: Binance spot (default) or USDⓈ-M futures
export type FeedRef = { source: FeedSource; id: string; market?: 'spot' | 'futures' };

// extra market info some feeds provide alongside bars (used by the watchlist details panel)
export type MarketMeta = {
  last?: number;
  prevClose?: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  name?: string;
  exchange?: string;
  currency?: string;
  // `last` is the real-time estimate of a delayed index future (futuresEstimate.ts)
  estimated?: boolean;
};

// one live connection for a (symbol, timeframe). Stateful so paging back
// through history and live updates stay consistent with each other.
export interface FeedSession {
  readonly source: FeedSource;
  readonly label: string;
  readonly realtime: boolean;
  // prices of another instrument that follows the symbol (a perpetual future):
  // shown on the chart but not reported as the symbol's quote
  readonly proxy?: boolean;
  // the newest bars are estimated in real time from proxies (delayed index futures)
  readonly estimated?: boolean;
  // set by the chart: called when bars already drawn must go (estimated bars past the close)
  onReset?: () => void;
  hasMore: boolean;
  load(): Promise<Candle[]>;
  loadOlder(): Promise<Candle[]>;
  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
