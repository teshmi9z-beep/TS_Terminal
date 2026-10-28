import type { IndicatorDef, PlotBox } from '../types';
import { boolInput, inputOf, withTransparency } from '../helpers';

// Pine's max_boxes_count (500) is TradingView's limit, not the script's: kept, it hid every gap
// older than the 500th from the end (on a 15m chart, about the last two months). Here every gap
// of the loaded history shows; the cap only guards against a runaway history.
const MAX_BOXES = 20000;
// Pine's color.yellow
const YELLOW = '#FFEB3B';
// half a candle body: the block is as wide as the candle it hangs from
const HALF = 0.4;

// Port of the Pine Script v5 indicator "Imbalance" (© teshmi9z): the gap left by a
// large middle candle, painted as a one-bar-wide yellow block. Every fair value gap
// counts, as in "Imbalance Personnalisé" and the fvg_retest robot; the script's first
// rule (the middle candle's body across the whole gap) missed gaps at the open and
// middle candles of the other colour, and stays as an option.
export const IMBALANCE: IndicatorDef = {
  type: 'IMBALANCE',
  label: 'Imbalance',
  short: 'Imbalance',
  category: 'Personnalises',
  overlay: true,
  description: 'Déséquilibres de la bougie du milieu, en blocs jaunes',
  defaults: { period: 0, color: YELLOW },
  inputs: [
    { key: 'transparency', label: 'FVG', default: 0, min: 0, max: 100, step: 10, tooltip: 'Transparence des blocs (0 = opaque)' },
    { key: 'strict', label: 'Seulement si le corps de la bougie du milieu couvre tout le trou (règle d’origine)', default: false, kind: 'bool' },
  ],
  styles: [],
  params: (cfg) => `${inputOf(cfg, IMBALANCE, 'transparency')}`,
  compute(candles, cfg) {
    const color = withTransparency(YELLOW, inputOf(cfg, IMBALANCE, 'transparency'));
    const strict = boolInput(cfg, IMBALANCE, 'strict');
    const boxes: PlotBox[] = [];
    for (let i = 2; i < candles.length; i++) {
      const c0 = candles[i], c1 = candles[i - 1], c2 = candles[i - 2];
      // down move: under bar[2]'s candle, between low[2] and high[0] (Pine: bar[2] to bar[2] + 1)
      if ((!strict || (c2.low <= c1.open && c0.high >= c1.close)) && c2.low - c0.high > 0) {
        boxes.push({ left: c2.time, leftBars: -HALF, right: c2.time, rightBars: HALF, top: c2.low, bottom: c0.high, fill: color, borderWidth: 0 });
      }
      // up move: under the current candle, between low[0] and high[2] (Pine: bar[0] to bar[0] + 1)
      if ((!strict || (c2.high >= c1.open && c0.low <= c1.close)) && c0.low - c2.high > 0) {
        boxes.push({ left: c0.time, leftBars: -HALF, right: c0.time, rightBars: HALF, top: c0.low, bottom: c2.high, fill: color, borderWidth: 0 });
      }
    }
    return [{ key: 'boxes', name: 'Imbalance', color: YELLOW, kind: 'boxes', data: [], boxes: boxes.slice(-MAX_BOXES) }];
  },
};
