import type { Candle } from '../types';

export type Side = 'long' | 'short';

// why a position was closed
export type ExitReason = 'signal' | 'stop' | 'target' | 'reverse' | 'end';

export type Trade = {
  id: number;
  side: Side;
  qty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  entryLabel: string;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  exitLabel: string;
  exitReason: ExitReason;
  // net of both commissions, in the symbol's currency
  pnl: number;
  // price move in % in the trade's direction (ProRealTime's "Perf relat")
  pricePct: number;
  // price move per unit in the trade's direction ("Gain unitaire")
  unitGain: number;
  bars: number;
  // best / worst open profit reached during the trade (MFE >= 0, MAE <= 0)
  mfe: number;
  mae: number;
  commission: number;
};

// position sizing: contracts, % of equity, a cash amount, or the % of equity lost if the stop is hit
export type QtyMode = 'fixed' | 'percent' | 'cash' | 'risk';

export type CommissionType = 'percent' | 'per_order' | 'per_contract';

export type BrokerSettings = {
  initialCapital: number;
  // default size of the orders that give none (Pine strategy.entry without qty)
  qtyMode: Exclude<QtyMode, 'risk'>;
  qtyValue: number;
  commissionType: CommissionType;
  commissionValue: number;
  // Pine's process_orders_on_close: fill at the signal bar's close instead of the next open
  fillOnClose: boolean;
};

export type BacktestResult = {
  strategyId: string;
  strategyName: string;
  ticker: string;
  timeframe: string;
  source: string;
  currency: string;
  // decimals of the symbol's prices
  precision: number;
  candles: Candle[];
  trades: Trade[];
  // still open at the last bar (valued at its close), not counted in the statistics
  openTrade: Trade | null;
  // per bar: equity valued at the close, signed position size
  equity: number[];
  position: number[];
  initialCapital: number;
  warnings: string[];
  ranAt: number;
};
