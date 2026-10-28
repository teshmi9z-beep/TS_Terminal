import type { Candle, IndicatorConfig } from '../types';
import { getIndicatorDef, indicatorTitle } from '../indicators/registry';
import { atr } from '../indicators/math';
import { Broker } from './broker';
import type { BrokerSettings, QtyMode, Side } from './types';

// ProRealTime-style "création assistée": conditions built from the chart's
// indicators (crosses above / below, is greater / lower...), entries, exits,
// stops / targets and money management, without writing code.

export type PriceField = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export type Operand =
  | { kind: 'price'; field: PriceField }
  | { kind: 'value'; value: number }
  // any indicator of the registry (built-in, ported or Pine script), one of its plots
  | { kind: 'indicator'; cfg: IndicatorConfig; plot: string };

export type Operator = 'crosses_above' | 'crosses_below' | 'greater' | 'less' | 'rising' | 'falling';

export const OPERATORS: { id: Operator; label: string; unary?: boolean }[] = [
  { id: 'crosses_above', label: 'croise à la hausse' },
  { id: 'crosses_below', label: 'croise à la baisse' },
  { id: 'greater', label: 'est supérieur à' },
  { id: 'less', label: 'est inférieur à' },
  { id: 'rising', label: 'est en hausse', unary: true },
  { id: 'falling', label: 'est en baisse', unary: true },
];

export type Condition = { id: string; left: Operand; op: Operator; right: Operand };

export type ConditionGroup = { join: 'and' | 'or'; conditions: Condition[] };

export type StopRule =
  | { kind: 'none' }
  // below the lowest low (long) / above the highest high (short) of the last N bars
  | { kind: 'swing'; bars: number }
  | { kind: 'percent'; value: number }
  | { kind: 'points'; value: number }
  | { kind: 'atr'; length: number; mult: number };

export type TargetRule =
  | { kind: 'none' }
  // reward = ratio x risk (needs a stop)
  | { kind: 'rr'; ratio: number }
  | { kind: 'percent'; value: number }
  | { kind: 'points'; value: number };

export type RulesStrategy = {
  // "Acheter" / "Vendre" (exit long) / "Vendre à découvert" / "Racheter" (exit short)
  longEntry: ConditionGroup;
  longExit: ConditionGroup;
  shortEntry: ConditionGroup;
  shortExit: ConditionGroup;
  longEnabled: boolean;
  shortEnabled: boolean;
  // an opposite signal turns the position around (else it must be closed first)
  reverse: boolean;
  stop: StopRule;
  target: TargetRule;
  sizing: { mode: QtyMode; value: number };
  initialCapital: number;
  commissionPct: number;
  fillOnClose: boolean;
};

export const PRICE_LABELS: Record<PriceField, string> = {
  close: 'Clôture', open: 'Ouverture', high: 'Plus haut', low: 'Plus bas', hl2: '(H+B)/2', hlc3: '(H+B+C)/3', ohlc4: '(O+H+B+C)/4',
};

let condSeq = 1;
export const newConditionId = () => `c${Date.now().toString(36)}${(condSeq++).toString(36)}`;

export const smaOperand = (period: number): Operand => ({
  kind: 'indicator', plot: 'v',
  cfg: { id: `sma${period}`, type: 'SMA', period, color: period <= 20 ? '#f0b90b' : '#2962ff', overlay: true, visible: true },
});

// the first test: SMA 10 / SMA 50 crossover, stop under the lowest low of the
// last 3 bars, target 1 x the risk, 1 % of the capital risked per trade
export function defaultRules(): RulesStrategy {
  return {
    longEntry: { join: 'and', conditions: [{ id: newConditionId(), left: smaOperand(10), op: 'crosses_above', right: smaOperand(50) }] },
    longExit: { join: 'or', conditions: [] },
    shortEntry: { join: 'and', conditions: [{ id: newConditionId(), left: smaOperand(10), op: 'crosses_below', right: smaOperand(50) }] },
    shortExit: { join: 'or', conditions: [] },
    longEnabled: true,
    shortEnabled: true,
    reverse: true,
    stop: { kind: 'swing', bars: 3 },
    target: { kind: 'rr', ratio: 1 },
    sizing: { mode: 'risk', value: 1 },
    initialCapital: 100000,
    commissionPct: 0,
    fillOnClose: false,
  };
}

// ---------------------------------------------------------------- labels

export function operandLabel(o: Operand): string {
  if (o.kind === 'price') return PRICE_LABELS[o.field];
  if (o.kind === 'value') return String(o.value);
  const def = getIndicatorDef(o.cfg);
  const title = indicatorTitle(o.cfg);
  const plots = def?.compute([], o.cfg) ?? [];
  const lines = plots.filter((p) => p.kind === 'line' || p.kind === 'histogram' || p.kind === 'candles');
  const plot = lines.find((p) => p.key === o.plot);
  return lines.length > 1 && plot ? `${title} · ${plot.name}` : title;
}

// plots of an indicator a condition can use
export function operandPlots(cfg: IndicatorConfig): { key: string; name: string }[] {
  const def = getIndicatorDef(cfg);
  if (!def) return [];
  return def.compute([], cfg)
    .filter((p) => p.kind === 'line' || p.kind === 'histogram' || p.kind === 'candles')
    .map((p) => ({ key: p.key, name: p.name }));
}

// ---------------------------------------------------------------- evaluation

function priceSeries(k: Candle[], f: PriceField): number[] {
  switch (f) {
    case 'open': return k.map((c) => c.open);
    case 'high': return k.map((c) => c.high);
    case 'low': return k.map((c) => c.low);
    case 'hl2': return k.map((c) => (c.high + c.low) / 2);
    case 'hlc3': return k.map((c) => (c.high + c.low + c.close) / 3);
    case 'ohlc4': return k.map((c) => (c.open + c.high + c.low + c.close) / 4);
    default: return k.map((c) => c.close);
  }
}

function operandSeries(k: Candle[], o: Operand, cache: Map<string, number[]>): number[] {
  const key = JSON.stringify(o);
  const hit = cache.get(key);
  if (hit) return hit;
  let out: number[];
  if (o.kind === 'price') out = priceSeries(k, o.field);
  else if (o.kind === 'value') out = k.map(() => o.value);
  else {
    out = new Array<number>(k.length).fill(NaN);
    const def = getIndicatorDef(o.cfg);
    const plot = def?.compute(k, o.cfg).find((p) => p.key === o.plot);
    if (plot) {
      const byTime = new Map(plot.data.map((p) => [p.time, p.value]));
      for (let i = 0; i < k.length; i++) out[i] = byTime.get(k[i].time) ?? NaN;
    }
  }
  cache.set(key, out);
  return out;
}

function test(c: Condition, i: number, a: number[], b: number[]): boolean {
  if (i < 1) return false;
  const x = a[i], y = b[i], px = a[i - 1], py = b[i - 1];
  switch (c.op) {
    case 'crosses_above': return x > y && px <= py;
    case 'crosses_below': return x < y && px >= py;
    case 'greater': return x > y;
    case 'less': return x < y;
    case 'rising': return x > px;
    case 'falling': return x < px;
  }
}

// per bar: does the group hold (an empty group never does)
function groupSignal(k: Candle[], g: ConditionGroup, cache: Map<string, number[]>): boolean[] {
  const out = new Array<boolean>(k.length).fill(false);
  if (!g.conditions.length) return out;
  const series = g.conditions.map((c) => [operandSeries(k, c.left, cache), operandSeries(k, c.right, cache)] as const);
  for (let i = 0; i < k.length; i++) {
    const hits = g.conditions.map((c, j) => test(c, i, series[j][0], series[j][1]));
    out[i] = g.join === 'and' ? hits.every(Boolean) : hits.some(Boolean);
  }
  return out;
}

function rolling(src: number[], len: number, max: boolean, i: number): number {
  if (i < len - 1) return NaN;
  let v = src[i];
  for (let j = i - len + 1; j < i; j++) v = max ? Math.max(v, src[j]) : Math.min(v, src[j]);
  return v;
}

// stop price, target price and size decided on the signal bar's close (as the generated Pine code does)
function bracket(r: RulesStrategy, k: Candle[], i: number, side: Side, atrSeries: number[] | null) {
  const close = k[i].close;
  const dir = side === 'long' ? 1 : -1;
  let stop: number | undefined;
  switch (r.stop.kind) {
    case 'swing': {
      const n = Math.max(1, Math.round(r.stop.bars));
      stop = side === 'long' ? rolling(k.map((c) => c.low), n, false, i) : rolling(k.map((c) => c.high), n, true, i);
      break;
    }
    case 'percent': stop = close * (1 - (dir * r.stop.value) / 100); break;
    case 'points': stop = close - dir * r.stop.value; break;
    case 'atr': stop = atrSeries ? close - dir * atrSeries[i] * r.stop.mult : undefined; break;
    default: break;
  }
  if (stop != null && !Number.isFinite(stop)) stop = undefined;
  let limit: number | undefined;
  switch (r.target.kind) {
    case 'rr': if (stop != null) limit = close + dir * r.target.ratio * Math.abs(close - stop); break;
    case 'percent': limit = close * (1 + (dir * r.target.value) / 100); break;
    case 'points': limit = close + dir * r.target.value; break;
    default: break;
  }
  return { stop, limit };
}

export function brokerSettingsOf(r: RulesStrategy): BrokerSettings {
  return {
    initialCapital: r.initialCapital, qtyMode: 'fixed', qtyValue: 1,
    commissionType: 'percent', commissionValue: r.commissionPct, fillOnClose: r.fillOnClose,
  };
}

// runs the assisted strategy on the bars through the shared broker
export function runRules(r: RulesStrategy, k: Candle[]): Broker {
  const broker = new Broker(k, brokerSettingsOf(r));
  const cache = new Map<string, number[]>();
  const longIn = r.longEnabled ? groupSignal(k, r.longEntry, cache) : null;
  const longOut = r.longEnabled ? groupSignal(k, r.longExit, cache) : null;
  const shortIn = r.shortEnabled ? groupSignal(k, r.shortEntry, cache) : null;
  const shortOut = r.shortEnabled ? groupSignal(k, r.shortExit, cache) : null;
  const atrSeries = r.stop.kind === 'atr' ? (() => {
    const pts = atr(k, Math.max(1, Math.round((r.stop as { length: number }).length)));
    const byTime = new Map(pts.map((p) => [p.time, p.value]));
    return k.map((c) => byTime.get(c.time) ?? NaN);
  })() : null;
  if (r.sizing.mode === 'risk' && r.stop.kind === 'none') broker.warnings.add('Risque par trade sans stop : taille de 1 unité utilisée.');

  const enter = (i: number, side: Side) => {
    const { stop, limit } = bracket(r, k, i, side, atrSeries);
    const close = k[i].close;
    const equity = broker.equityNow;
    let qty: number;
    switch (r.sizing.mode) {
      case 'percent': qty = (equity * r.sizing.value) / 100 / close; break;
      case 'cash': qty = r.sizing.value / close; break;
      case 'risk': qty = stop != null && Math.abs(close - stop) > 0 ? (equity * r.sizing.value) / 100 / Math.abs(close - stop) : 1; break;
      default: qty = r.sizing.value;
    }
    const id = side === 'long' ? 'Achat' : 'Vente';
    broker.entry({ id, side, qty });
    broker.exit({ id: `Sortie ${id.toLowerCase()}`, fromEntry: id, stop, limit });
  };

  for (let i = 0; i < k.length; i++) {
    broker.beginBar(i);
    const side = broker.positionSide;
    if (side === 'long' && longOut?.[i]) broker.close('Achat', 'Vente');
    if (side === 'short' && shortOut?.[i]) broker.close('Vente', 'Rachat');
    const goLong = !!longIn?.[i], goShort = !!shortIn?.[i];
    // both at once is ambiguous: no trade
    if (goLong !== goShort) {
      const want: Side = goLong ? 'long' : 'short';
      const ok = side == null || (side !== want && r.reverse);
      if (ok) enter(i, want);
    }
    broker.endBar(i);
  }
  return broker;
}
