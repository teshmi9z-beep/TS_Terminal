import type { AlertCondition, AlertOp, AlertOperand, Candle, IndicatorConfig, TechAlert } from '../types';
import type { Plot } from '../indicators/types';
import { getIndicatorDef, sourcePlots } from '../indicators/registry';
import { sourceRef } from '../indicators/derived';
import { DEC } from '../i18n/lang';

// The conditions of an alert on indicators, checked on one bar (TradingView's operators).

export const OPS: { id: AlertOp; label: string; channel?: boolean; pct?: boolean }[] = [
  { id: 'cross', label: 'Croise' },
  { id: 'cross_up', label: 'Croise à la hausse' },
  { id: 'cross_down', label: 'Croise à la baisse' },
  { id: 'above', label: 'Supérieur à' },
  { id: 'below', label: 'Inférieur à' },
  { id: 'enter', label: 'Entre dans le canal', channel: true },
  { id: 'exit', label: 'Sort du canal', channel: true },
  { id: 'inside', label: 'Dans le canal', channel: true },
  { id: 'outside', label: 'Hors du canal', channel: true },
  { id: 'up_pct', label: 'Monte de (%)', pct: true },
  { id: 'down_pct', label: 'Baisse de (%)', pct: true },
];

// the value of an operand at bar i (NaN where an indicator has none yet)
export type ValueOf = (op: AlertOperand, i: number) => number;

export function valueReader(candles: Candle[], plots: Map<string, Plot[]>): ValueOf {
  const maps = new Map<string, Map<number, number>>();
  return (op, i) => {
    const c = candles[i];
    if (!c) return NaN;
    if (op.kind === 'price') return c.close;
    if (op.kind === 'value') return op.value;
    const key = `${op.id}:${op.plot}`;
    let m = maps.get(key);
    if (!m) {
      m = new Map((plots.get(op.id)?.find((p) => p.key === op.plot)?.data ?? []).map((p) => [p.time, p.value]));
      maps.set(key, m);
    }
    return m.get(c.time) ?? NaN;
  };
}

const within = (x: number, a: number, b: number) => x >= Math.min(a, b) && x <= Math.max(a, b);
const known = (...v: number[]) => v.every(Number.isFinite);

// a cross compares this bar with the previous one, like Pine's ta.crossover / ta.crossunder;
// any value still missing (an indicator not started yet) makes the condition false
export function conditionMet(c: AlertCondition, i: number, v: ValueOf): boolean {
  const a = v(c.left, i), a0 = v(c.left, i - 1);
  const b = v(c.right, i), b0 = v(c.right, i - 1);
  switch (c.op) {
    case 'cross_up': return a0 <= b0 && a > b;
    case 'cross_down': return a0 >= b0 && a < b;
    case 'cross': return (a0 <= b0 && a > b) || (a0 >= b0 && a < b);
    case 'above': return a > b;
    case 'below': return a < b;
    case 'up_pct':
    case 'down_pct': {
      const base = v(c.left, i - Math.max(1, c.bars ?? 1));
      if (!known(a, base, b) || base === 0) return false;
      const pct = ((a - base) / Math.abs(base)) * 100;
      return c.op === 'up_pct' ? pct >= b : pct <= -b;
    }
    default: {
      const r2 = c.right2 ?? c.right;
      const d = v(r2, i), d0 = v(r2, i - 1);
      const now = known(a, b, d) && within(a, b, d);
      const before = known(a0, b0, d0) && within(a0, b0, d0);
      if (c.op === 'inside') return now;
      if (c.op === 'outside') return known(a, b, d) && !now;
      if (c.op === 'enter') return known(a0, b0, d0) && !before && now;
      return before && known(a, b, d) && !now;
    }
  }
}

export function alertMet(a: Pick<TechAlert, 'conditions' | 'match'>, i: number, v: ValueOf): boolean {
  if (!a.conditions.length) return false;
  return a.match === 'all' ? a.conditions.every((c) => conditionMet(c, i, v)) : a.conditions.some((c) => conditionMet(c, i, v));
}

// "RSI 14", "MACD 12 26 9 (Signal)", "SMA 9 sur RSI 14"
export function indicatorLabel(id: string, plotKey: string | null, indicators: IndicatorConfig[], depth = 0): string {
  const cfg = indicators.find((i) => i.id === id);
  const def = cfg && getIndicatorDef(cfg);
  if (!cfg || !def) return '?';
  const p = def.params(cfg);
  let out = p ? `${def.short} ${p}` : def.short;
  const plots = plotKey ? sourcePlots(cfg, def) : [];
  const plot = plots.length > 1 ? plots.find((x) => x.key === plotKey) : undefined;
  if (plot) out += ` (${plot.name})`;
  const ref = sourceRef(cfg);
  if (ref && depth < 2 && indicators.some((i) => i.id === ref.id)) out += ` sur ${indicatorLabel(ref.id, ref.plot, indicators, depth + 1)}`;
  return out;
}

export function operandLabel(op: AlertOperand, indicators: IndicatorConfig[]): string {
  if (op.kind === 'price') return 'Prix';
  if (op.kind === 'value') return String(op.value).replace('.', DEC);
  return indicatorLabel(op.id, op.plot, indicators);
}

export function conditionText(c: AlertCondition, indicators: IndicatorConfig[]): string {
  const op = OPS.find((o) => o.id === c.op) ?? OPS[0];
  const l = operandLabel(c.left, indicators);
  const r = operandLabel(c.right, indicators);
  if (op.channel) return `${l} ${op.label.toLowerCase()} ${r} – ${operandLabel(c.right2 ?? c.right, indicators)}`;
  if (op.pct) return `${l} ${c.op === 'up_pct' ? 'monte' : 'baisse'} de ${r} % en ${c.bars ?? 1} barre${(c.bars ?? 1) > 1 ? 's' : ''}`;
  return `${l} ${op.label.toLowerCase()} ${r}`;
}

export const alertSummary = (a: Pick<TechAlert, 'conditions' | 'match' | 'indicators'>) =>
  a.conditions.map((c) => conditionText(c, a.indicators)).join(a.match === 'all' ? ' ET ' : ' OU ');

// bars to load so the indicators settle: their longest setting, chained ones adding up
export function barsNeeded(a: Pick<TechAlert, 'indicators' | 'conditions'>): number {
  let sum = 0;
  for (const c of a.indicators) {
    let p = 0;
    for (const v of [c.period, c.slowPeriod, c.signalPeriod, c.dPeriod, ...Object.values(c.inputs ?? {})]) {
      if (typeof v === 'number' && Number.isFinite(v) && v < 5000) p = Math.max(p, v);
    }
    sum += p;
  }
  const bars = Math.max(0, ...a.conditions.map((c) => c.bars ?? 0));
  return Math.min(5000, Math.max(500, sum * 5 + bars + 100));
}
