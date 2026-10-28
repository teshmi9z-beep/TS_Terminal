import type { Candle } from '../../types';
import type { IndicatorDef, Plot, PlotFillPoint, PlotLabel, PlotMarker, PlotPoint } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';

// Port of the Pine Script v5 indicator "Tsh_Arrow" (© PresentTrading, MPL 2.0):
// a SuperTrend built on a volume-weighted average, classified bullish / bearish
// by a weighted k-nearest-neighbours vote (k = 3 among the last 12 values), with
// trend start / signal shapes and DEMA-MACD arrows. Series use NaN for Pine's na.

// Pine v5 palette
const LIME = '#00E676';
const RED = '#FF5252';
const BLUE = '#2196F3';

const K = 3;
const N = Math.max(3, 12);
const KNN_PRICE_LEN = 20;
const KNN_ST_LEN = 80;
const FACTOR = 4;
// Pine's default max_labels_count
const MAX_LABELS = 50;
const MA_SOURCES = ['SMA', 'EMA', 'WMA', 'RMA', 'VWMA'];

// ---------------------------------------------------------------- Pine building blocks

function sma(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += src[j];
    out[i] = s / len;
  }
  return out;
}

function wma(src: number[], len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  const norm = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    for (let j = 0; j < len; j++) s += src[i - len + 1 + j] * (j + 1);
    out[i] = s / norm;
  }
  return out;
}

// ta.rma / ta.ema: recursive, seeded with the SMA of the first `len` values
function smoothed(src: number[], len: number, alpha: number): number[] {
  const seed = sma(src, len);
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = 0; i < src.length; i++) {
    const prev = i > 0 ? out[i - 1] : NaN;
    out[i] = isNaN(prev) ? seed[i] : alpha * src[i] + (1 - alpha) * prev;
  }
  return out;
}
const rma = (src: number[], len: number) => smoothed(src, len, 1 / len);
const ema = (src: number[], len: number) => smoothed(src, len, 2 / (len + 1));
const mul = (a: number[], b: number[]) => a.map((v, i) => v * b[i]);
// x / 0 is na in Pine
const div = (a: number[], b: number[]) => a.map((v, i) => (b[i] === 0 ? NaN : v / b[i]));
const vwmaOf = (src: number[], vol: number[], len: number) => div(sma(mul(src, vol), len), sma(vol, len));

function trueRange(k: Candle[]): number[] {
  return k.map((c, i) => (i === 0 ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - k[i - 1].close), Math.abs(c.low - k[i - 1].close))));
}

function dema(src: number[], len: number): number[] {
  const e1 = ema(src, len);
  const e2 = ema(e1, len);
  return e1.map((v, i) => 2 * v - e2[i]);
}

const nz = (v: number | undefined) => (v === undefined || isNaN(v) ? 0 : v);

// ---------------------------------------------------------------- indicator

type Cat = 'up' | 'dn' | 'ne';

export const TSH_ARROW: IndicatorDef = {
  type: 'TSH_ARROW',
  label: 'Tsh_Arrow',
  short: 'Tsh_Arrow',
  category: 'Personnalises',
  overlay: true,
  description: 'SuperTrend pondéré par le volume + classement KNN, départs de tendance et flèches DEMA MACD',
  defaults: { period: 0, color: LIME },
  inputs: [
    { key: 'aisignals', label: 'Trend Signals', default: true, kind: 'bool', group: 'Super Trend Settings', inline: 'signal' },
    { key: 'voirFleche', label: 'Arrow', default: true, kind: 'bool', group: 'Super Trend Settings', inline: 'signal' },
    { key: 'bullishCol', label: '', default: LIME, kind: 'color', group: 'Super Trend Settings', inline: 'signal' },
    { key: 'bearishCol', label: '', default: RED, kind: 'color', group: 'Super Trend Settings', inline: 'signal' },
    { key: 'maSrc', label: 'Moving Average Source', default: 'WMA', kind: 'string', options: MA_SOURCES },
    { key: 'len', label: 'Length', default: 20, min: 1, max: 500, inline: 'SuperTrend' },
    // color.new(color.lime / red / blue, 80)
    { key: 'upCol', label: 'Up', default: withTransparency(LIME, 80), kind: 'color', inline: 'col' },
    { key: 'dnCol', label: 'Down', default: withTransparency(RED, 80), kind: 'color', inline: 'col' },
    { key: 'neCol', label: 'Neutral', default: withTransparency(BLUE, 80), kind: 'color', inline: 'col' },
  ],
  styles: [],
  params(cfg) {
    return `${stringInput(cfg, TSH_ARROW, 'maSrc')} ${inputOf(cfg, TSH_ARROW, 'len')}`;
  },
  compute(k, cfg) {
    const len = Math.max(1, Math.round(inputOf(cfg, TSH_ARROW, 'len')));
    const maSrc = stringInput(cfg, TSH_ARROW, 'maSrc');
    const aisignals = boolInput(cfg, TSH_ARROW, 'aisignals');
    const voirFleche = boolInput(cfg, TSH_ARROW, 'voirFleche');
    const bullCol = stringInput(cfg, TSH_ARROW, 'bullishCol');
    const bearCol = stringInput(cfg, TSH_ARROW, 'bearishCol');
    const colOf: Record<Cat, string> = {
      up: stringInput(cfg, TSH_ARROW, 'upCol'), dn: stringInput(cfg, TSH_ARROW, 'dnCol'), ne: stringInput(cfg, TSH_ARROW, 'neCol'),
    };
    const n = k.length;
    const close = k.map((c) => c.close);
    const vol = k.map((c) => c.volume);
    const cv = mul(close, vol);

    // ~~ volume-weighted average chosen by the user
    let vwma: number[];
    switch (maSrc) {
      case 'SMA': vwma = div(sma(cv, len), sma(vol, len)); break;
      case 'EMA': vwma = div(ema(cv, len), ema(vol, len)); break;
      case 'RMA': vwma = div(rma(cv, len), rma(vol, len)); break;
      case 'VWMA': vwma = div(vwmaOf(cv, vol, len), vwmaOf(vol, vol, len)); break;
      default: vwma = div(wma(cv, len), wma(vol, len));
    }
    const atr = rma(trueRange(k), len);

    // ~~ SuperTrend (bands only move in the trend's favour)
    const upper = new Array<number>(n).fill(NaN);
    const lower = new Array<number>(n).fill(NaN);
    const direction = new Array<number>(n).fill(NaN);
    const st = new Array<number>(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let ub = vwma[i] + FACTOR * atr[i];
      let lb = vwma[i] - FACTOR * atr[i];
      const prevLB = nz(lower[i - 1]), prevUB = nz(upper[i - 1]);
      const c1 = i > 0 ? close[i - 1] : NaN;
      lb = lb > prevLB || c1 < prevLB ? lb : prevLB;
      ub = ub < prevUB || c1 > prevUB ? ub : prevUB;
      lower[i] = lb;
      upper[i] = ub;
      let dir: number;
      if (i === 0 || isNaN(atr[i - 1])) dir = 1;
      else if (st[i - 1] === prevUB) dir = close[i] > ub ? -1 : 1;
      else dir = close[i] < lb ? 1 : -1;
      direction[i] = dir;
      st[i] = dir === -1 ? lb : ub;
    }

    // ~~ weighted KNN: label of the 3 values of the last 12 closest to the current one
    const price = wma(close, KNN_PRICE_LEN);
    const sT = wma(st, KNN_ST_LEN);
    const cat: Cat[] = new Array(n);
    const label = new Array<number>(n).fill(NaN);
    const dist = new Array<number>(N), idx = new Array<number>(N), labels = new Array<number>(N);
    for (let i = 0; i < n; i++) {
      const x = st[i];
      for (let j = 0; j < N; j++) {
        const b = i - j;
        const data = b >= 0 ? st[b] : NaN;
        labels[j] = b >= 0 && price[b] > sT[b] ? 1 : 0;
        dist[j] = Math.abs(x - data);
        idx[j] = j;
      }
      // bubble sort, as in the script (na comparisons are false, like in Pine)
      for (let a = 0; a < N - 1; a++) {
        for (let b = 0; b < N - a - 1; b++) {
          if (dist[b] > dist[b + 1]) {
            [dist[b], dist[b + 1]] = [dist[b + 1], dist[b]];
            [idx[b], idx[b + 1]] = [idx[b + 1], idx[b]];
          }
        }
      }
      let ws = 0, tw = 0;
      for (let a = 0; a < K; a++) {
        const w = 1 / (dist[a] + 1e-6);
        ws += w * labels[idx[a]];
        tw += w;
      }
      label[i] = ws / tw;
      cat[i] = label[i] === 1 ? 'up' : label[i] === 0 ? 'dn' : 'ne';
    }

    // ~~ plots
    const stLine: PlotPoint[] = [];
    const upLine: PlotPoint[] = [];
    const dnLine: PlotPoint[] = [];
    const fillUp: PlotFillPoint[] = [];
    const fillDn: PlotFillPoint[] = [];
    const startUp: PlotMarker[] = [], startDn: PlotMarker[] = [], sigUp: PlotMarker[] = [], sigDn: PlotMarker[] = [];
    for (let i = 0; i < n; i++) {
      const t = k[i].time;
      const col = colOf[cat[i]];
      const fillCol = withTransparency(col, 95);
      const mid = (k[i].open + k[i].close) / 2;
      const up = st[i] === lower[i] ? st[i] : NaN;
      const dn = st[i] === upper[i] ? st[i] : NaN;
      if (Number.isFinite(st[i])) stLine.push({ time: t, value: st[i], color: col });
      upLine.push({ time: t, value: up, color: col });
      dnLine.push({ time: t, value: dn, color: col });
      fillUp.push({ time: t, a: mid, b: up, color: fillCol });
      fillDn.push({ time: t, a: mid, b: dn, color: fillCol });
      if (!aisignals || !Number.isFinite(st[i])) continue;
      const prev = i > 0 ? cat[i - 1] : undefined;
      const at = (color: string, shape: PlotMarker['shape']): PlotMarker => ({ time: t, position: 'atPriceMiddle', price: st[i], shape, color, size: 0.6 });
      if (cat[i] === 'up' && prev !== 'up') startUp.push(at(bullCol, 'circle'));
      if (cat[i] === 'dn' && prev !== 'dn') startDn.push(at(bearCol, 'circle'));
      if (i > 0 && direction[i] === -1 && direction[i - 1] === 1 && label[i] === 1) sigUp.push(at(bullCol, 'arrowUp'));
      if (i > 0 && direction[i] === 1 && direction[i - 1] === -1 && label[i] === 0) sigDn.push(at(bearCol, 'arrowDown'));
    }

    // ~~ DEMA MACD arrows, in the trend's direction only
    const z2 = dema(close, 26);
    const e = dema(close, 12).map((v, i) => v - z2[i]);
    const f = dema(e, 9);
    const arrows: PlotLabel[] = [];
    if (voirFleche) {
      for (let i = 1; i < n; i++) {
        const crossUp = e[i] > f[i] && e[i - 1] <= f[i - 1];
        const crossDn = e[i] < f[i] && e[i - 1] >= f[i - 1];
        if (crossUp && e[i] < 0 && f[i] < 0 && cat[i] === 'up') arrows.push({ time: k[i].time, price: k[i].low, text: '▲', color: bullCol, style: 'up', size: 14 });
        if (crossDn && e[i] > 0 && f[i] > 0 && cat[i] === 'dn') arrows.push({ time: k[i].time, price: k[i].high, text: '▼', color: bearCol, style: 'down', size: 14 });
      }
    }

    const base = colOf.up;
    const plots: Plot[] = [
      { key: 'st', name: 'Volume Super Trend AI', color: base, kind: 'line', width: 1, data: stLine },
      { key: 'up', name: 'Up Volume Super Trend AI', color: base, kind: 'line', width: 1, data: upLine },
      { key: 'dn', name: 'Down Volume Super Trend AI', color: colOf.dn, kind: 'line', width: 1, data: dnLine },
      { key: 'fillUp', name: 'Remplissage haussier', color: base, kind: 'fill', data: [], fill: fillUp },
      { key: 'fillDn', name: 'Remplissage baissier', color: colOf.dn, kind: 'fill', data: [], fill: fillDn },
      { key: 'startUp', name: 'AI Bullish Trend Start', color: bullCol, kind: 'markers', data: [], markers: startUp },
      { key: 'startDn', name: 'AI Bearish Trend Start', color: bearCol, kind: 'markers', data: [], markers: startDn },
      { key: 'sigUp', name: 'AI Bullish Trend Signal', color: bullCol, kind: 'markers', data: [], markers: sigUp },
      { key: 'sigDn', name: 'AI Bearish Trend Signal', color: bearCol, kind: 'markers', data: [], markers: sigDn },
      // label.new keeps only the newest max_labels_count (50) labels
      { key: 'arrows', name: 'Flèches DEMA MACD', color: bullCol, kind: 'labels', data: [], labels: arrows.slice(-MAX_LABELS) },
    ];
    return plots;
  },
};
