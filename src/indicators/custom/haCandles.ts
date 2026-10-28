import type { IndicatorDef, PlotCandle } from '../types';
import { heikinAshi } from '../math';
import { inputOf, linreg, plotColor, stringInput } from '../helpers';

const TYPES = ['Candlesticks', 'Heikin Ashi', 'Linear Regression'];

// Port of the Pine Script v6 indicator "HA" (© teshmi9z): alternative candles
// (Heikin Ashi or linear regression) drawn over the chart, cyan up / red down.
export const HA_CANDLES: IndicatorDef = {
  type: 'HA_CANDLES',
  label: 'HA (bougies alternatives)',
  short: 'HA',
  category: 'Personnalises',
  overlay: true,
  description: 'Bougies Heikin Ashi ou régression linéaire par-dessus le graphique',
  defaults: { period: 0, color: '#00FFFF' },
  inputs: [
    { key: 'candleType', label: 'Candle Type', default: 'Linear Regression', kind: 'string', options: TYPES, group: 'Candlestick Settings', tooltip: 'Choose the type of candles to display. This does not impact signal calculations.' },
    { key: 'lrcLength', label: 'Linear Regression Length', default: 6, min: 1, max: 500, group: 'Candlestick Settings', tooltip: 'Length for Linear Regression calculations. Lower values are more responsive but noisier.' },
  ],
  // Pine: customBuyColor / customSellColor
  styles: [
    { key: 'buy', name: 'Haussière', color: '#00FFFF' },
    { key: 'sell', name: 'Baissière', color: '#FF0000' },
  ],
  params(cfg) {
    const type = stringInput(cfg, HA_CANDLES, 'candleType');
    return type === 'Linear Regression' ? `LinReg ${inputOf(cfg, HA_CANDLES, 'lrcLength')}` : type;
  },
  compute(candles, cfg) {
    const type = stringInput(cfg, HA_CANDLES, 'candleType');
    const buy = plotColor(cfg, HA_CANDLES, 'buy');
    const sell = plotColor(cfg, HA_CANDLES, 'sell');
    const n = candles.length;
    let o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
    if (type === 'Heikin Ashi') {
      const ha = heikinAshi(candles);
      o = ha.map((b) => b.open); h = ha.map((b) => b.high); l = ha.map((b) => b.low); c = ha.map((b) => b.close);
    } else if (type === 'Linear Regression') {
      const len = Math.max(1, Math.round(inputOf(cfg, HA_CANDLES, 'lrcLength')));
      o = linreg(candles.map((b) => b.open), len);
      h = linreg(candles.map((b) => b.high), len);
      l = linreg(candles.map((b) => b.low), len);
      c = linreg(candles.map((b) => b.close), len);
    }
    // 'Candlesticks': Pine plots na, nothing is drawn over the chart's own candles
    const out: PlotCandle[] = [];
    if (type !== 'Candlesticks') {
      for (let i = 0; i < n; i++) {
        if (![o[i], h[i], l[i], c[i]].every(Number.isFinite)) continue;
        out.push({ time: candles[i].time, open: o[i], high: h[i], low: l[i], close: c[i], color: c[i] > o[i] ? buy : sell });
      }
    }
    return [{
      key: 'c', name: 'Bougies', color: buy, kind: 'candles', candles: out,
      data: out.map((b) => ({ time: b.time, value: b.close, color: b.color })),
    }];
  },
};
