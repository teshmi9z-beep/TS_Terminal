import type { IndicatorConfig } from '../types';
import type { IndicatorDef, Plot, PlotBox, PlotMarker } from '../indicators/types';
import { inputOf, stringInput } from '../indicators/helpers';
import { Features, toBars } from './features';
import { FILTERS, SIGNALS, STOPS } from './catalog';
import { simulate } from './engine';

// A robot of the lab shown on the chart: its signals recomputed on the chart's own
// bars, the entries (3 per signal), where each group closed with its total in R, and
// the stops / targets of the group still open. Settings use readable names, so any
// robot can also be put together by hand from the indicator's settings.

const DIRS = ['Achat et vente', 'Achat seulement', 'Vente seulement'];
const UP = '#089981', DOWN = '#f23645', BLUE = '#2962ff', GREY = '#787b86';

export const ROBOT_DEFAULTS = { signal: SIGNALS[0].label, filter: FILTERS[0].label, stop: STOPS[0].label, dir: DIRS[0], tpR: 1.5, trailK: 2, cost: 0.05 };

export function robotInputs(r: { signal: string; filter: string; stop: string; dir: number; tpR: number; trailK: number; cost: number }) {
  return {
    signal: SIGNALS.find((s) => s.id === r.signal)?.label ?? r.signal,
    filter: FILTERS.find((f) => f.id === r.filter)?.label ?? r.filter,
    stop: STOPS.find((s) => s.id === r.stop)?.label ?? r.stop,
    dir: DIRS[r.dir === 1 ? 1 : r.dir === -1 ? 2 : 0],
    tpR: r.tpR, trailK: r.trailK, cost: Math.round(r.cost * 100 * 10000) / 10000,
  };
}

// the lab's signal, filter, stop, side, exits and costs behind the indicator's settings
export function robotSpec(cfg: IndicatorConfig) {
  const str = (k: string) => stringInput(cfg, ROBOT, k);
  const num = (k: string) => inputOf(cfg, ROBOT, k);
  const dirIdx = DIRS.indexOf(str('dir'));
  return {
    signal: SIGNALS.find((s) => s.label === str('signal')) ?? SIGNALS[0],
    filter: FILTERS.find((f) => f.label === str('filter')) ?? FILTERS[0],
    stop: STOPS.find((s) => s.label === str('stop')) ?? STOPS[0],
    dir: (dirIdx === 1 ? 1 : dirIdx === 2 ? -1 : 0) as 0 | 1 | -1,
    legs: { tpR: num('tpR'), trailK: num('trailK') },
    cost: num('cost') / 100,
  };
}

// same bars and settings -> same result (the chart recomputes indicators on every tick)
let memo: { key: string; plots: Plot[] } | null = null;

export const ROBOT: IndicatorDef = {
  type: 'ROBOT',
  label: 'Robot (3 entrées par signal)',
  short: 'Robot',
  category: 'Personnalises',
  overlay: true,
  description: 'Robot du labo : signal, filtre de tendance, stop, et 3 sorties (fixe, suiveur, paliers 1-2-3 R avec break-even)',
  defaults: { period: 0, color: BLUE },
  inputs: [
    { key: 'signal', label: 'Signal d’entrée', default: ROBOT_DEFAULTS.signal, kind: 'string', options: SIGNALS.filter((s) => !s.hidden).map((s) => s.label) },
    { key: 'filter', label: 'Filtre (tendance / range)', default: ROBOT_DEFAULTS.filter, kind: 'string', options: FILTERS.map((f) => f.label) },
    { key: 'stop', label: 'Stop', default: ROBOT_DEFAULTS.stop, kind: 'string', options: STOPS.map((s) => s.label) },
    { key: 'dir', label: 'Sens', default: ROBOT_DEFAULTS.dir, kind: 'string', options: DIRS },
    { key: 'tpR', label: 'Objectif de l’entrée fixe (R)', default: ROBOT_DEFAULTS.tpR, min: 0.5, max: 10, step: 0.5 },
    { key: 'trailK', label: 'Stop suiveur (× ATR)', default: ROBOT_DEFAULTS.trailK, min: 0.5, max: 10, step: 0.5 },
    { key: 'cost', label: 'Frais par côté (% du prix)', default: ROBOT_DEFAULTS.cost, min: 0, max: 1, step: 0.001 },
  ],
  styles: [],
  params(cfg) {
    return `${stringInput(cfg, ROBOT, 'signal').split(' · ')[0]} · ${stringInput(cfg, ROBOT, 'filter')}`;
  },
  compute(candles, cfg: IndicatorConfig) {
    if (candles.length < 60) return [];
    const num = (k: string) => inputOf(cfg, ROBOT, k);
    const last = candles[candles.length - 1];
    const key = JSON.stringify([cfg.inputs, candles.length, candles[0].time, last.time, last.close, last.high, last.low]);
    if (memo?.key === key) return memo.plots;

    const sp = robotSpec(cfg);
    const b = toBars(candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]));
    const f = new Features(b);
    const allow = sp.filter.make(f), stop = sp.stop.make(f, sp.signal.id);
    const trades = simulate(b, {
      sig: sp.signal.make(f), allowLong: allow.long, allowShort: allow.short, stopLong: stop.long, stopShort: stop.short,
      dir: sp.dir, legs: sp.legs, cost: sp.cost, atr: f.atr(14),
      warmup: Math.min(250, Math.floor(b.n / 4)),
    });

    const markers: PlotMarker[] = [];
    const boxes: PlotBox[] = [];
    for (let k = 0; k < trades.length;) {
      const g = trades[k].group;
      const legs = [];
      for (; k < trades.length && trades[k].group === g; k++) legs.push(trades[k]);
      const t0 = legs[0];
      const long = t0.side > 0;
      markers.push({ time: b.t[t0.entryIdx], position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? UP : DOWN, text: long ? 'Robot ▲×3' : 'Robot ▼×3' });
      const open = legs.some((l) => l.reason === 'end');
      if (!open) {
        const end = legs.reduce((a, l) => (l.exitIdx > a.exitIdx ? l : a), t0);
        const total = legs.reduce((a, l) => a + l.r, 0);
        markers.push({ time: b.t[end.exitIdx], position: long ? 'aboveBar' : 'belowBar', shape: 'circle', color: total >= 0 ? UP : DOWN, text: `${total >= 0 ? '+' : ''}${total.toFixed(1)} R`, size: 0.6 });
        continue;
      }
      // the group still open: entry, the stop of each open leg and the targets left
      const left = b.t[t0.entryIdx], right = b.t[b.n - 1], R = t0.stopDist, e = t0.entry, s = t0.side;
      const line = (price: number, color: string, dashed = false): PlotBox => ({ left, right, rightBars: 8, top: price, bottom: price, fill: 'rgba(0,0,0,0)', border: color, borderWidth: 1, borderStyle: dashed ? 'dashed' : 'solid' });
      boxes.push(line(e, GREY));
      for (const l of legs) if (l.reason === 'end') boxes.push(line(l.stop, DOWN, l.leg !== 0));
      if (legs[0].reason === 'end') boxes.push(line(e + s * num('tpR') * R, UP));
      if (legs[2].reason === 'end') for (const m of [1, 2, 3]) if ((last.close - (e + s * m * R)) * s < 0) boxes.push(line(e + s * m * R, UP, true));
    }
    const plots: Plot[] = [
      { key: 'marks', name: 'Signaux et résultats', color: BLUE, kind: 'markers', data: [], markers },
      { key: 'levels', name: 'Stops et objectifs en cours', color: GREY, kind: 'boxes', data: [], boxes },
    ];
    memo = { key, plots };
    return plots;
  },
};
