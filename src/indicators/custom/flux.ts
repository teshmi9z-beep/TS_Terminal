import type { Candle } from '../../types';
import type { IndicatorDef, Plot, PlotFillPoint, PlotPoint } from '../types';
import { inputOf, stringInput, withTransparency } from '../helpers';

// "Indicateur de flux" (the idea shown by Romain Bayeul): the 20 and 50 moving averages
// of the 1-hour chart, the cloud between them green while the fast one is above, red below.
// On a lower chart the higher bar still in progress counts with the chart bar's close: the
// lines move bar by bar, never look ahead, and equal the higher chart's averages at each of
// its closes. On a chart at or above the chosen timeframe the averages use the chart's bars.

const TFS: [string, number][] = [['Celle du graphique', 0], ['15 minutes', 900], ['1 heure', 3600], ['4 heures', 14400], ['Journalier', 86400]];
const TF_SHORT: Record<string, string> = { '15 minutes': '15m', '1 heure': 'H1', '4 heures': 'H4', Journalier: 'J' };

// the average at each chart bar, of the chart's bars (seconds 0) or of higher bars (also
// used by the lab, scripts/robots/flux-lib.ts)
export function fluxAverage(time: ArrayLike<number>, close: ArrayLike<number>, len: number, kind: string, seconds: number): number[] {
  const out = new Array<number>(time.length).fill(NaN);
  const alpha = 2 / (len + 1);
  // closes of the finished higher bars, the sum of the last len - 1 of them, and their
  // EMA (ta.ema: seeded with the SMA of the first len values)
  const done: number[] = [];
  let doneSum = 0, doneEma = NaN;
  let bucket = NaN, last = NaN;
  for (let i = 0; i < time.length; i++) {
    const bk = seconds ? Math.floor(time[i] / seconds) : i;
    if (i > 0 && bk !== bucket) {
      done.push(last);
      doneSum += last;
      if (done.length > len - 1) doneSum -= done[done.length - len];
      if (!isNaN(doneEma)) doneEma = alpha * last + (1 - alpha) * doneEma;
      else if (done.length >= len) doneEma = (doneSum + done[done.length - len]) / len;
    }
    bucket = bk;
    last = close[i];
    if (done.length < len - 1) continue;
    out[i] = kind === 'EMA' && !isNaN(doneEma) ? alpha * close[i] + (1 - alpha) * doneEma : (doneSum + close[i]) / len;
  }
  return out;
}

// the chart's bar spacing (median of the first gaps)
function chartStep(candles: Candle[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 200); i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] || 60;
}

export const FLUX: IndicatorDef = {
  type: 'FLUX',
  label: 'Flux MM20 / MM50 (H1)',
  short: 'Flux',
  category: 'Personnalises',
  overlay: true,
  description: 'MM20 et MM50 en 1 heure, nuage vert quand la MM20 est au-dessus de la MM50, rouge en dessous',
  defaults: { period: 0, color: '#4caf50' },
  inputs: [
    { key: 'fast', label: 'MM rapide', default: 20, min: 1, max: 1000, inline: 'mm' },
    { key: 'slow', label: 'MM lente', default: 50, min: 1, max: 1000, inline: 'mm' },
    { key: 'kind', label: 'Type de moyenne', default: 'SMA', kind: 'string', options: ['SMA', 'EMA'] },
    { key: 'tf', label: 'Unité de temps', default: '1 heure', kind: 'string', options: TFS.map(([l]) => l),
      tooltip: 'Sur un graphique plus court, la bougie de cette unité encore en cours compte avec la dernière clôture : la ligne avance à chaque bougie et retombe sur la vraie moyenne à chaque clôture.' },
    { key: 'transp', label: 'Transparence du nuage', default: 75, min: 0, max: 100, step: 1, group: 'Couleurs' },
    { key: 'upColor', label: 'Haussier', default: '#4caf50', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'downColor', label: 'Baissier', default: '#f23645', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params(cfg) {
    const tf = stringInput(cfg, FLUX, 'tf');
    return `${inputOf(cfg, FLUX, 'fast')} ${inputOf(cfg, FLUX, 'slow')}${TF_SHORT[tf] ? ` ${TF_SHORT[tf]}` : ''}`;
  },
  compute(k, cfg) {
    const fastLen = Math.max(1, Math.round(inputOf(cfg, FLUX, 'fast')));
    const slowLen = Math.max(1, Math.round(inputOf(cfg, FLUX, 'slow')));
    const kind = stringInput(cfg, FLUX, 'kind');
    const tfSec = TFS.find(([l]) => l === stringInput(cfg, FLUX, 'tf'))?.[1] ?? 0;
    const seconds = tfSec > chartStep(k) ? tfSec : 0;
    const time = k.map((c) => c.time), close = k.map((c) => c.close);
    const fast = fluxAverage(time, close, fastLen, kind, seconds);
    const slow = fluxAverage(time, close, slowLen, kind, seconds);

    const up = stringInput(cfg, FLUX, 'upColor'), down = stringInput(cfg, FLUX, 'downColor');
    const transp = inputOf(cfg, FLUX, 'transp');
    const fillUp = withTransparency(up, transp), fillDown = withTransparency(down, transp);
    const fastLine: PlotPoint[] = [], slowLine: PlotPoint[] = [], cloud: PlotFillPoint[] = [];
    for (let i = 0; i < k.length; i++) {
      const t = k[i].time, bull = fast[i] >= slow[i];
      if (Number.isFinite(fast[i])) fastLine.push({ time: t, value: fast[i], color: Number.isFinite(slow[i]) ? (bull ? up : down) : up });
      if (Number.isFinite(slow[i])) slowLine.push({ time: t, value: slow[i], color: bull ? up : down });
      cloud.push({ time: t, a: fast[i], b: slow[i], color: bull ? fillUp : fillDown });
    }
    const plots: Plot[] = [
      { key: 'cloud', name: 'Nuage', color: up, kind: 'fill', data: [], fill: cloud },
      { key: 'fast', name: `MM${fastLen}`, color: up, kind: 'line', width: 1, data: fastLine },
      { key: 'slow', name: `MM${slowLen}`, color: down, kind: 'line', width: 1, data: slowLine },
    ];
    return plots;
  },
};
