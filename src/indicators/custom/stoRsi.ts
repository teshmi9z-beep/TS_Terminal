import type { IndicatorDef, Plot, PlotPoint } from '../types';
import { rsi } from '../math';
import { boolInput, inputOf, smaNa, stoch, stringInput, toPoints } from '../helpers';

// Pine v5 palette: color.lime, color.red, color.green, color.black
const LIME = '#00E676';
const RED = '#FF5252';
const GREEN = '#4CAF50';
const BLACK = '#363A45';

// Port of the Pine Script v5 indicator "Sto+RSI": slow stochastic (K 200 / D 200,
// D colored by its direction) and RSI in the same pane.
export const STO_RSI: IndicatorDef = {
  type: 'STO_RSI',
  label: 'Sto+RSI',
  short: 'Sto+RSI',
  category: 'Personnalises',
  overlay: false,
  description: 'Stochastique lent (K / D 200, D vert ou rouge selon sa pente) et RSI dans le même panneau',
  defaults: { period: 0, color: '#2196F3' },
  inputs: [
    // group / inline as in the script
    { key: 'voirSto', label: 'Stochastic', default: true, kind: 'bool', group: 'STO', inline: 'st' },
    { key: 'lengthK', label: 'K Length', default: 200, min: 1, max: 5000, group: 'STO', inline: 'st1' },
    { key: 'colorK', label: '', default: '#2196F3', kind: 'color', group: 'STO', inline: 'st1' },
    { key: 'kWidth', label: 'Ep', default: 1, min: 1, max: 4, group: 'STO', inline: 'st1' },
    { key: 'lengthD', label: 'D Smoothing', default: 200, min: 1, max: 5000, group: 'STO', inline: 'st2' },
    { key: 'dWidth', label: 'Ep', default: 1, min: 1, max: 4, group: 'STO', inline: 'st2' },
    { key: 'smoothK', label: 'Smooth K', default: 3, min: 1, max: 500, group: 'STO', inline: 'st3' },
    { key: 'voirLine', label: 'Level', default: true, kind: 'bool', group: 'STO', inline: 'st4' },
    { key: 'upper', label: 'Up', default: 80, min: 50, max: 100, group: 'STO', inline: 'st4' },
    { key: 'lower', label: 'Low', default: 20, min: 0, max: 50, group: 'STO', inline: 'st4' },
    { key: 'voirRsi', label: 'RSI', default: true, kind: 'bool', group: 'RSI', inline: '0' },
    { key: 'colorRsi', label: '', default: BLACK, kind: 'color', group: 'RSI', inline: '1' },
    { key: 'rsiLength', label: 'Period', default: 14, min: 1, max: 500, group: 'RSI', inline: '1' },
    { key: 'rsiWidth', label: 'Ep', default: 1, min: 1, max: 4, group: 'RSI', inline: '1' },
    { key: 'voirLineRsi', label: 'Level', default: true, kind: 'bool', group: 'RSI', inline: '2' },
    { key: 'upperRsi', label: '', default: 70, min: 50, max: 100, group: 'RSI', inline: '2' },
    { key: 'lowerRsi', label: '', default: 30, min: 0, max: 50, group: 'RSI', inline: '2' },
  ],
  styles: [],
  range: [0, 100],
  params(cfg) {
    const v = (key: string) => inputOf(cfg, STO_RSI, key);
    return `${v('lengthK')} ${v('smoothK')} ${v('lengthD')} ${v('rsiLength')}`;
  },
  compute(candles, cfg) {
    const num = (key: string) => inputOf(cfg, STO_RSI, key);
    const int = (key: string) => Math.max(1, Math.round(num(key)));
    const on = (key: string) => boolInput(cfg, STO_RSI, key);

    const k = smaNa(stoch(candles, int('lengthK')), int('smoothK'));
    const d = smaNa(k, int('lengthD'));
    // d_direction > 0 ? lime : red (a flat or na previous value counts as red)
    const dPoints: PlotPoint[] = toPoints(candles, d).map((p, i, arr) => ({
      ...p, color: i > 0 && p.value > arr[i - 1].value ? LIME : RED,
    }));

    // hidden plots stay (empty) so the pane and its levels keep their place, like Pine's plot(na)
    const plots: Plot[] = [
      { key: 'k', name: 'K', color: stringInput(cfg, STO_RSI, 'colorK'), kind: 'line', width: int('kWidth'), data: on('voirSto') ? toPoints(candles, k) : [] },
      { key: 'd', name: 'D', color: LIME, kind: 'line', width: int('dWidth'), data: on('voirSto') ? dPoints : [] },
      { key: 'rsi', name: 'RSI', color: stringInput(cfg, STO_RSI, 'colorRsi'), kind: 'line', width: int('rsiWidth'), data: on('voirRsi') ? rsi(candles, int('rsiLength')) : [] },
    ];
    const hline = (key: string, name: string, price: number, color: string): Plot => ({ key, name, color, kind: 'hline', price, dashed: true, data: [] });
    if (on('voirLine')) plots.push(hline('ob', 'Overbought', num('upper'), RED), hline('os', 'Oversold', num('lower'), GREEN));
    if (on('voirLineRsi')) plots.push(hline('rob', 'RSI Overbought', num('upperRsi'), BLACK), hline('ros', 'RSI Oversold', num('lowerRsi'), BLACK));
    return plots;
  },
};
