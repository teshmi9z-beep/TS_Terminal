import type { AvwapBand, AvwapOperand, AvwapSettings, Candle, Drawing } from '../types';
import { LOCALE } from '../i18n/lang';

// TradingView's "VWAP ancré" drawing: one click on a bar, then the volume-weighted average
// price from that bar to the last one, with bands at N standard deviations (volume-weighted,
// like Pine's ta.vwap) or at N % of the VWAP. The anchor is a time, so it stays on the same
// moment across timeframes (on a higher one it falls in the bar that holds it). Without volume
// in the data (forex, CFDs, indices from some feeds) every bar weighs the same (a TWAP).

export const AVWAP_SOURCES: [AvwapSettings['source'], string][] = [
  ['open', 'Ouverture'], ['high', 'Plus haut'], ['low', 'Plus bas'], ['close', 'Clôture'],
  ['hl2', '(H + L)/2'], ['hlc3', '(H + L + C)/3'], ['ohlc4', '(O + H + L + C)/4'], ['hlcc4', '(H + L + C + C)/4'],
];

// TradingView's defaults: band 1 on at 1, bands 2 and 3 at 2 and 3, fills at 95 % transparency
const band = (on: boolean, mult: number, color: string): AvwapBand => ({ on, mult, upColor: color, loColor: color, fill: true, fillColor: `${color}0d` });
export function defaultAvwap(): AvwapSettings {
  return { mode: 'stdev', source: 'hlc3', bands: [band(true, 1, '#4caf50'), band(false, 2, '#808000'), band(false, 3, '#00897b')] };
}
export const AVWAP_LINE = { color: '#2962ff', lineWidth: 1 };

export function avwapOf(d: Drawing): AvwapSettings {
  const base = defaultAvwap();
  const s = d.avwap ?? {};
  return { ...base, ...s, bands: base.bands.map((b, i) => ({ ...b, ...s.bands?.[i] })) };
}

export function sourcePrice(c: Candle, src: AvwapSettings['source']): number {
  switch (src) {
    case 'open': return c.open;
    case 'high': return c.high;
    case 'low': return c.low;
    case 'close': return c.close;
    case 'hl2': return (c.high + c.low) / 2;
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
    case 'hlcc4': return (c.high + c.low + 2 * c.close) / 4;
    default: return (c.high + c.low + c.close) / 3;
  }
}

// from bar `start` of the chart's bars: the VWAP and its weighted standard deviation at each one
export type AvwapSeries = { start: number; vwap: Float64Array; dev: Float64Array };

const cache = new Map<string, AvwapSeries | null>();

// the bar holding time t (the last one opening at or before it), -1 before the first
function barAt(candles: Candle[], t: number): number {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// null when the anchor is after the last bar or before the bars loaded (the chart then pages
// older history in: from the first bar loaded the values would be wrong)
export function avwapSeries(candles: Candle[], anchor: number | undefined, src: AvwapSettings['source']): AvwapSeries | null {
  const n = candles.length;
  if (!n || anchor == null || anchor < candles[0].time) return null;
  const last = candles[n - 1];
  const key = `${anchor}|${src}|${n}|${candles[0].time}|${last.time}|${last.close}|${last.volume}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const start = barAt(candles, anchor);
  let out: AvwapSeries | null = null;
  if (start >= 0) {
    const len = n - start;
    const vwap = new Float64Array(len), dev = new Float64Array(len);
    let hasVolume = false;
    for (let i = start; i < n; i++) if (candles[i].volume > 0) { hasVolume = true; break; }
    // West's incremental weighted variance: steadier than sum(w·p²)/sum(w) − vwap² on big prices
    let sw = 0, mean = 0, m2 = 0;
    for (let i = start; i < n; i++) {
      const p = sourcePrice(candles[i], src);
      const w = hasVolume ? Math.max(0, candles[i].volume || 0) : 1;
      if (w > 0 && Number.isFinite(p)) {
        sw += w;
        const delta = p - mean;
        mean += (w / sw) * delta;
        m2 += w * delta * (p - mean);
      }
      // (no weight yet: the bar's own price)
      vwap[i - start] = sw > 0 ? mean : p;
      dev[i - start] = sw > 0 ? Math.sqrt(Math.max(0, m2 / sw)) : 0;
    }
    out = { start, vwap, dev };
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, out);
  return out;
}

// the offset of band `b` around the VWAP at bar k of the series
export const bandOffset = (s: AvwapSettings, ser: AvwapSeries, k: number, b: AvwapBand) =>
  s.mode === 'percent' ? (ser.vwap[k] * b.mult) / 100 : ser.dev[k] * b.mult;

// ---------- alerts on an anchored VWAP (alerts/evaluate.ts, alerts/runner.ts)

// the operand of an alert on one of the drawing's lines, with the drawing's settings now
export function avwapOperand(d: Drawing, line: AvwapOperand['line'], band = 0): AvwapOperand {
  const s = avwapOf(d);
  return { kind: 'avwap', drawing: d.id, anchor: d.points[0]?.time ?? 0, source: s.source, mode: s.mode, line, band, mult: s.bands[band]?.mult ?? 1 };
}

// the operand following its drawing while it exists (anchor moved, bands changed)
export function followDrawing(op: AvwapOperand, drawings: Drawing[]): AvwapOperand {
  const d = drawings.find((x) => x.id === op.drawing && x.tool === 'anchored_vwap');
  return d ? avwapOperand(d, op.line, op.band) : op;
}

// its value at bar i of these bars (NaN before the anchor, or when the bars do not reach it)
export function avwapValueAt(candles: Candle[], op: AvwapOperand, i: number): number {
  const ser = avwapSeries(candles, op.anchor, op.source);
  const k = ser ? i - ser.start : -1;
  if (!ser || k < 0 || k >= ser.vwap.length) return NaN;
  if (op.line === 'vwap') return ser.vwap[k];
  const off = op.mode === 'percent' ? (ser.vwap[k] * op.mult) / 100 : ser.dev[k] * op.mult;
  return op.line === 'up' ? ser.vwap[k] + off : ser.vwap[k] - off;
}

// "VWAP ancré (12 nov. 15:15)", "VWAP ancré (12 nov. 15:15) · bande haute #1"
export function avwapLabel(op: AvwapOperand): string {
  const at = op.anchor > 0 ? ` (${new Date(op.anchor * 1000).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})` : '';
  const n = op.band + 1;
  return op.line === 'vwap' ? `VWAP ancré${at}` : op.line === 'up' ? `VWAP ancré${at} · bande haute #${n}` : `VWAP ancré${at} · bande basse #${n}`;
}
