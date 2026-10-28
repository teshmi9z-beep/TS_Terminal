import type { Candle, IndicatorConfig } from '../types';
import type { IndicatorDef, PlotPoint } from './types';

// Pine-style building blocks. Series are plain number arrays aligned with the
// candles; NaN plays the role of Pine's `na` and propagates like it does.

export function inputOf(cfg: IndicatorConfig, def: Pick<IndicatorDef, 'inputs'>, key: string): number {
  const v = cfg.inputs?.[key];
  if (typeof v === 'number' && !isNaN(v)) return v;
  return Number(def.inputs?.find((i) => i.key === key)?.default ?? NaN);
}

export function plotColor(cfg: IndicatorConfig, def: Pick<IndicatorDef, 'styles'>, key: string): string {
  return cfg.plotColors?.[key] ?? def.styles?.find((s) => s.key === key)?.color ?? cfg.color;
}

// ta.highest / ta.lowest: na until `len` bars exist (monotonic deque, O(n))
function rollingExtreme(src: number[], len: number, isMax: boolean): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < src.length; i++) {
    while (dq.length && dq[0] <= i - len) dq.shift();
    while (dq.length && (isMax ? src[dq[dq.length - 1]] <= src[i] : src[dq[dq.length - 1]] >= src[i])) dq.pop();
    dq.push(i);
    if (i >= len - 1) out[i] = src[dq[0]];
  }
  return out;
}
export const highest = (src: number[], len: number) => rollingExtreme(src, len, true);
export const lowest = (src: number[], len: number) => rollingExtreme(src, len, false);

// ta.sma: na while the window is incomplete or contains an na
export function smaNa(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let sum = 0, nans = 0;
  for (let i = 0; i < src.length; i++) {
    if (isNaN(src[i])) nans++; else sum += src[i];
    if (i >= len) {
      if (isNaN(src[i - len])) nans--; else sum -= src[i - len];
    }
    if (i >= len - 1 && nans === 0) out[i] = sum / len;
  }
  return out;
}

// ta.linreg(src, len, 0): least-squares line over the last `len` values, taken at the newest bar
export function linreg(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  if (len < 1) return out;
  const sumX = (len * (len - 1)) / 2;
  const sumXX = ((len - 1) * len * (2 * len - 1)) / 6;
  const denom = len * sumXX - sumX * sumX;
  for (let i = len - 1; i < src.length; i++) {
    let sumY = 0, sumXY = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const y = src[i - len + 1 + j];
      if (isNaN(y)) { ok = false; break; }
      sumY += y;
      sumXY += j * y;
    }
    if (!ok) continue;
    const slope = denom === 0 ? 0 : (len * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / len;
    out[i] = intercept + slope * (len - 1);
  }
  return out;
}

// ta.stoch(close, high, low, len); x / 0 is na in Pine
export function stoch(k: Candle[], len: number): number[] {
  const hh = highest(highs(k), len);
  const ll = lowest(lows(k), len);
  return k.map((c, i) => (hh[i] === ll[i] ? NaN : (100 * (c.close - ll[i])) / (hh[i] - ll[i])));
}

// color.new(color, transp): transparency 0 (opaque) .. 100 (invisible) as a #rrggbbaa color
export function withTransparency(color: string, transp: number): string {
  const a = Math.round(((100 - Math.min(100, Math.max(0, transp))) / 100) * 255);
  return color.slice(0, 7) + a.toString(16).padStart(2, '0');
}

export function stringInput(cfg: IndicatorConfig, def: Pick<IndicatorDef, 'inputs'>, key: string): string {
  const v = cfg.inputs?.[key];
  return typeof v === 'string' ? v : String(def.inputs?.find((i) => i.key === key)?.default ?? '');
}

export function boolInput(cfg: IndicatorConfig, def: Pick<IndicatorDef, 'inputs'>, key: string): boolean {
  const v = cfg.inputs?.[key];
  return typeof v === 'boolean' ? v : def.inputs?.find((i) => i.key === key)?.default === true;
}

export const highs = (k: Candle[]) => k.map((c) => c.high);
export const lows = (k: Candle[]) => k.map((c) => c.low);
export const closes = (k: Candle[]) => k.map((c) => c.close);

// series -> plot points, dropping na bars (like Pine, nothing is drawn there)
export function toPoints(candles: Candle[], values: number[]): PlotPoint[] {
  const out: PlotPoint[] = [];
  for (let i = 0; i < candles.length; i++) if (Number.isFinite(values[i])) out.push({ time: candles[i].time, value: values[i] });
  return out;
}
