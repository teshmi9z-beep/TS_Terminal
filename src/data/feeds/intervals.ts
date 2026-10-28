import type { Timeframe } from '../../types';
import { parseTf, tfSeconds } from '../timeframes';
import { IB_INTERVALS } from './ib';

// how a feed serves a timeframe: one of its native intervals, optionally
// aggregated up to the requested bar size (e.g. 45m built from 15m bars)
export type IntervalPlan = { native: string; aggregateTo?: number };

function plan(natives: [string, number][], tf: Timeframe): IntervalPlan | null {
  const step = tfSeconds(tf);
  if (!step) return null;
  const exact = natives.find(([, s]) => s === step);
  if (exact) return { native: exact[0] };
  // largest native interval that divides the target, never above one day
  const base = [...natives].reverse().find(([, s]) => s < step && s <= 86400 && step % s === 0);
  return base ? { native: base[0], aggregateTo: step } : null;
}

const BINANCE: [string, number][] = [
  ['1s', 1], ['1m', 60], ['3m', 180], ['5m', 300], ['15m', 900], ['30m', 1800],
  ['1h', 3600], ['2h', 7200], ['4h', 14400], ['6h', 21600], ['8h', 28800], ['12h', 43200],
  ['1d', 86400], ['3d', 259200], ['1w', 604800],
];

export function binancePlan(tf: Timeframe): IntervalPlan | null {
  const { n, unit } = parseTf(tf);
  if (unit === 'T') return null;
  if (unit === 'M') return n === 1 ? { native: '1M' } : null;
  if (unit === 'W' && n > 1) return null;
  return plan(BINANCE, tf);
}

const YAHOO: [string, number][] = [
  ['1m', 60], ['2m', 120], ['5m', 300], ['15m', 900], ['30m', 1800], ['60m', 3600], ['90m', 5400], ['1d', 86400],
];

export function yahooPlan(tf: Timeframe): IntervalPlan | null {
  const { n, unit } = parseTf(tf);
  // no tick or sub-minute data on Yahoo
  if (unit === 'T' || unit === 's') return null;
  if (unit === 'W') return n === 1 ? { native: '1wk' } : null;
  if (unit === 'M') return n === 1 ? { native: '1mo' } : n === 3 ? { native: '3mo' } : null;
  return plan(YAHOO, tf);
}

export function ibPlan(tf: Timeframe): IntervalPlan | null {
  const { n, unit } = parseTf(tf);
  if (unit === 'T' || unit === 's') return null;
  if (unit === 'W') return n === 1 ? { native: '1w' } : null;
  if (unit === 'M') return n === 1 ? { native: '1M' } : null;
  return plan(IB_INTERVALS, tf);
}
