import type { Candle } from '../../types';
import type { IndicatorDef, PlotBox, PlotFillPoint, PlotMarker } from '../types';
import { inputOf, stringInput, withTransparency } from '../helpers';
import { parisOffset } from '../../robots/features';
import { hrExpiry } from '../../robots/catalog';

// Port of the user's Pine Script v5 indicator "XAUUSD 19h - 1H Closed Ref": the candle
// of one hour makes a range; its high and low are drawn from the next bar until the
// end of the day, and the first close above the high (below the low) sets the bias
// (triangle, range band in green / red), again at each change of side.
// Differences with TradingView: the hour is read in Paris time (summer time included)
// or UTC, not in the chart's time zone; the day ends at 23:00 Paris (the gold / forex
// trading day; a range ending after 22:00 lasts until the next day's); the target
// hour's candles are boxed instead of recolored, and the bias colors the range band
// instead of the whole background. Timeframes up to 1 hour.

const STYLES = ['Solid', 'Dashed', 'Dotted'];
const TZ = ['Paris (UTC+1, UTC+2 l’été)', 'UTC'];
const styleOf = (s: string): PlotBox['borderStyle'] => (s === 'Dashed' ? 'dashed' : s === 'Dotted' ? 'dotted' : 'solid');

function barSeconds(candles: Candle[]): number {
  const n = candles.length, d: number[] = [];
  for (let i = Math.max(1, n - 50); i < n; i++) d.push(candles[i].time - candles[i - 1].time);
  d.sort((a, b) => a - b);
  return d[d.length >> 1] ?? 0;
}

export const HOUR_RANGE: IndicatorDef = {
  type: 'HOUR_RANGE',
  label: 'Range horaire (bougie 1H de référence)',
  short: 'Range 1H',
  category: 'Personnalises',
  overlay: true,
  description: 'Plus haut / plus bas de la bougie d’une heure (heure de Paris) et cassure en clôture au-dessus ou en dessous (unités jusqu’à 1 heure)',
  defaults: { period: 0, color: '#ff6803' },
  inputs: [
    { key: 'targetHour', label: 'Heure de la bougie (ex: 18 pour 18h-19h)', default: 18, min: 0, max: 23, step: 1 },
    { key: 'tz', label: 'Heure lue en', default: TZ[0], kind: 'string', options: TZ },
    { key: 'candleColor', label: 'Couleur Bougie cible', default: '#ff680380', kind: 'color' },
    { key: 'highColor', label: 'Couleur High', default: '#4caf50', kind: 'color', group: 'Style High' },
    { key: 'highStyle', label: 'Style High', default: 'Solid', kind: 'string', options: STYLES, group: 'Style High' },
    { key: 'lowColor', label: 'Couleur Low', default: '#f23645', kind: 'color', group: 'Style Low' },
    { key: 'lowStyle', label: 'Style Low', default: 'Solid', kind: 'string', options: STYLES, group: 'Style Low' },
    { key: 'lineWidth', label: 'Épaisseur', default: 2, min: 1, max: 10, step: 1 },
  ],
  styles: [],
  params: (cfg) => `${inputOf(cfg, HOUR_RANGE, 'targetHour')} h`,
  compute(candles, cfg) {
    const step = barSeconds(candles);
    if (!step || step > 3600) return [];
    const H = Math.round(inputOf(cfg, HOUR_RANGE, 'targetHour'));
    const paris = stringInput(cfg, HOUR_RANGE, 'tz') === TZ[0];
    const hiColor = stringInput(cfg, HOUR_RANGE, 'highColor'), loColor = stringInput(cfg, HOUR_RANGE, 'lowColor');
    const hiStyle = styleOf(stringInput(cfg, HOUR_RANGE, 'highStyle')), loStyle = styleOf(stringInput(cfg, HOUR_RANGE, 'lowStyle'));
    const width = inputOf(cfg, HOUR_RANGE, 'lineWidth');
    const target = stringInput(cfg, HOUR_RANGE, 'candleColor');
    const S = H * 3600, L = 3600;

    const boxes: PlotBox[] = [], markers: PlotMarker[] = [], fill: PlotFillPoint[] = [];
    type Ref = { hi: number; lo: number; exp: number; lineH?: PlotBox; lineL?: PlotBox };
    // the target hour being built, then the day's range once it closed
    let cur = NaN, cHi = -Infinity, cLo = Infinity, cFirst = 0, cLast = 0;
    let ref: Ref | null = null;
    let bias = 0;
    // the target hour closed: its box, and the range it leaves
    const closeHour = (): Ref => {
      boxes.push({ left: cFirst, right: cLast, top: cHi, bottom: cLo, fill: target, border: target, borderWidth: 1 });
      const r = { hi: cHi, lo: cLo, exp: hrExpiry(cur + L, 'd') };
      cur = NaN; cHi = -Infinity; cLo = Infinity;
      return r;
    };
    for (const c of candles) {
      const p = c.time + (paris ? parisOffset(c.time) : 0);
      const rs = Math.floor((p - S) / 86400) * 86400 + S;
      const inside = p - rs < L;
      if (!Number.isNaN(cur) && (!inside || rs !== cur)) { ref = closeHour(); bias = 0; }
      if (inside) {
        if (Number.isNaN(cur)) {
          // a new day's candle: yesterday's range is over
          if (ref) fill.push({ time: c.time, a: NaN, b: NaN, color: '' });
          ref = null; cur = rs; cFirst = c.time;
        }
        cHi = Math.max(cHi, c.high); cLo = Math.min(cLo, c.low); cLast = c.time;
        continue;
      }
      const r = ref;
      if (!r) continue;
      if (p >= r.exp) {
        fill.push({ time: c.time, a: NaN, b: NaN, color: '' });
        ref = null;
        continue;
      }
      r.lineH ??= boxes[boxes.push({ left: c.time, right: c.time, top: r.hi, bottom: r.hi, fill: 'rgba(0,0,0,0)', border: hiColor, borderWidth: width, borderStyle: hiStyle }) - 1];
      r.lineL ??= boxes[boxes.push({ left: c.time, right: c.time, top: r.lo, bottom: r.lo, fill: 'rgba(0,0,0,0)', border: loColor, borderWidth: width, borderStyle: loStyle }) - 1];
      r.lineH.right = c.time; r.lineL.right = c.time;
      const was = bias;
      if (c.close > r.hi) bias = 1;
      else if (c.close < r.lo) bias = -1;
      if (bias !== was) {
        markers.push(bias === 1
          ? { time: c.time, position: 'belowBar', shape: 'arrowUp', color: hiColor, text: 'Cassure haut', size: 0.8 }
          : { time: c.time, position: 'aboveBar', shape: 'arrowDown', color: loColor, text: 'Cassure bas', size: 0.8 });
      }
      fill.push({ time: c.time, a: r.hi, b: r.lo, color: bias === 1 ? withTransparency(hiColor, 85) : bias === -1 ? withTransparency(loColor, 85) : 'rgba(0,0,0,0)' });
    }
    if (!Number.isNaN(cur)) closeHour();
    return [
      { key: 'fill', name: 'Biais', color: hiColor, kind: 'fill', data: [], fill },
      { key: 'boxes', name: 'Bougie cible et range', color: target, kind: 'boxes', data: [], boxes: boxes.slice(-1500) },
      { key: 'marks', name: 'Cassures', color: hiColor, kind: 'markers', data: [], markers },
    ];
  },
};
