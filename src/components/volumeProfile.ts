import type { Candle, Drawing, DrawTool, VpSettings } from '../types';
import { indexAtOrBefore } from './chartUtils';

// Volume profile drawings, like TradingView's: "Gamme fixe" (fixed range: two
// clicks, the bars between them) and "Profil ancré" (anchored: one click, the
// bars from there to the last one). The volume of the range is split into price
// rows, buying (up bars) and selling (down bars) volume side by side; the POC is
// the row with the most volume, the value area the rows around it holding 70 %.
//
// The chart only has its own bars, so each bar's volume is spread evenly over its
// high - low range (TradingView reads lower timeframe bars). Without volume
// (forex and indices from some sources), each bar counts 1: the time spent at a price.

export const isVolumeProfile = (t: DrawTool) => t === 'fixed_range' || t === 'anchored_vp';

export function defaultVp(): VpSettings {
  return {
    rows: 24,
    valueArea: 70,
    width: 30,
    placement: 'left',
    split: true,
    upColor: '#26c6da',
    downColor: '#f06292',
    showPoc: true,
    pocColor: '#9598a1',
    extendPoc: true,
    showVaLines: false,
    background: true,
    bgColor: '#2962ff',
  };
}

export const vpOf = (d: Drawing): VpSettings => ({ ...defaultVp(), ...d.vp });

export type Profile = {
  lo: number;
  hi: number;
  step: number;
  up: number[];
  down: number[];
  // largest row total
  max: number;
  poc: number;
  // value area rows (inclusive)
  vaLo: number;
  vaHi: number;
  // no volume in the data: bars counted instead
  counted: boolean;
};

// the time range a profile covers (s)
export function vpRange(d: Drawing, candles: Candle[]): { t0: number; t1: number } | null {
  const a = d.points[0];
  if (!a) return null;
  if (d.tool === 'anchored_vp') {
    const last = candles[candles.length - 1]?.time;
    return last == null ? null : { t0: a.time, t1: Math.max(a.time, last) };
  }
  const b = d.points[1] ?? a;
  return { t0: Math.min(a.time, b.time), t1: Math.max(a.time, b.time) };
}

const cache = new Map<string, Profile | null>();

export function computeProfile(candles: Candle[], t0: number, t1: number, s: VpSettings): Profile | null {
  if (!candles.length) return null;
  const n = candles.length;
  const last = candles[n - 1];
  const key = `${t0}|${t1}|${s.rows}|${s.valueArea}|${n}|${candles[0].time}|${last.time}|${last.close}|${last.volume}`;
  if (cache.has(key)) return cache.get(key)!;
  // the bars inside the range: from the one containing t0 to the last one opening by t1
  let i0 = indexAtOrBefore(candles, t0);
  if (i0 < 0) i0 = 0;
  const i1 = indexAtOrBefore(candles, t1);
  let out: Profile | null = null;
  if (i1 >= i0) {
    let lo = Infinity, hi = -Infinity, vol = 0;
    for (let i = i0; i <= i1; i++) { lo = Math.min(lo, candles[i].low); hi = Math.max(hi, candles[i].high); vol += candles[i].volume || 0; }
    const counted = !(vol > 0);
    const rows = Math.max(1, Math.min(500, Math.round(s.rows)));
    const step = hi > lo ? (hi - lo) / rows : 1;
    const up = new Array<number>(rows).fill(0), down = new Array<number>(rows).fill(0);
    const rowOf = (p: number) => Math.max(0, Math.min(rows - 1, Math.floor((p - lo) / step)));
    for (let i = i0; i <= i1; i++) {
      const b = candles[i];
      const v = counted ? 1 : b.volume || 0;
      if (!v) continue;
      const side = b.close >= b.open ? up : down;
      const range = b.high - b.low;
      if (range <= 0) { side[rowOf(b.close)] += v; continue; }
      for (let r = rowOf(b.low); r <= rowOf(b.high); r++) {
        const bottom = lo + r * step, top = bottom + step;
        const overlap = Math.min(b.high, top) - Math.max(b.low, bottom);
        if (overlap > 0) side[r] += (v * overlap) / range;
      }
    }
    const tot = up.map((u, r) => u + down[r]);
    let poc = 0;
    for (let r = 1; r < rows; r++) if (tot[r] > tot[poc]) poc = r;
    // the value area grows from the POC toward the busier neighbouring row
    const all = tot.reduce((a, b) => a + b, 0);
    let vaLo = poc, vaHi = poc, inVa = tot[poc];
    while (inVa < (all * s.valueArea) / 100 && (vaLo > 0 || vaHi < rows - 1)) {
      const below = vaLo > 0 ? tot[vaLo - 1] : -1, above = vaHi < rows - 1 ? tot[vaHi + 1] : -1;
      if (above >= below) inVa += tot[++vaHi]; else inVa += tot[--vaLo];
    }
    out = { lo, hi, step, up, down, max: Math.max(...tot), poc, vaLo, vaHi, counted };
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, out);
  return out;
}

export function hexAlpha(hex: string, alpha: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}
