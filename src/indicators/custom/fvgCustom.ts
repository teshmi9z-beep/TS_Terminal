import type { IndicatorDef, PlotBox } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';

// Pine's max_boxes_count (500) is TradingView's limit, not the script's: kept, it hid every gap
// older than the 500th from the end (on a 15m chart, about the last two months). Here every gap
// of the loaded history shows; the cap only guards against a runaway history.
const MAX_BOXES = 20000;

// Port of the Pine Script v5 indicator "Imbalance Personnalisé" (© teshmi9z):
// standard fair value gaps, one box from bar[2] to the current bar.
export const FVG_CUSTOM: IndicatorDef = {
  type: 'FVG_CUSTOM',
  label: 'Imbalance Personnalisé',
  short: 'Imbalance Perso',
  category: 'Personnalises',
  overlay: true,
  description: 'Fair value gaps haussiers / baissiers en boîtes (bas > haut d’il y a 2 bougies, et inversement)',
  defaults: { period: 0, color: '#4CAF50' },
  // Pine: color.new(color.green, 80), color.green, color.new(color.red, 80), color.red
  inputs: [
    { key: 'bullColor', label: 'Couleur Fond', default: '#4CAF5033', kind: 'color', group: 'Déséquilibre Haussier (Bullish)' },
    { key: 'bullBorder', label: 'Couleur Bordure', default: '#4CAF50', kind: 'color', group: 'Déséquilibre Haussier (Bullish)' },
    { key: 'bearColor', label: 'Couleur Fond', default: '#FF525233', kind: 'color', group: 'Déséquilibre Baissier (Bearish)' },
    { key: 'bearBorder', label: 'Couleur Bordure', default: '#FF5252', kind: 'color', group: 'Déséquilibre Baissier (Bearish)' },
    { key: 'borderWidth', label: 'Épaisseur Bordure', default: 1, min: 0, max: 10, group: 'Style des Boîtes' },
    { key: 'showBorder', label: 'Afficher la bordure', default: true, kind: 'bool', group: 'Style des Boîtes' },
  ],
  styles: [],
  params: () => '',
  compute(candles, cfg) {
    const str = (key: string) => stringInput(cfg, FVG_CUSTOM, key);
    const borderWidth = Math.max(0, Math.round(inputOf(cfg, FVG_CUSTOM, 'borderWidth')));
    const showBorder = boolInput(cfg, FVG_CUSTOM, 'showBorder');
    // a hidden border is the border color at 100 % transparency
    const bullBorder = showBorder ? str('bullBorder') : withTransparency(str('bullBorder'), 100);
    const bearBorder = showBorder ? str('bearBorder') : withTransparency(str('bearBorder'), 100);

    const boxes: PlotBox[] = [];
    for (let i = 2; i < candles.length; i++) {
      const c = candles[i], c2 = candles[i - 2];
      if (c.low > c2.high) {
        boxes.push({
          left: c2.time, right: c.time, top: c.low, bottom: c2.high,
          fill: str('bullColor'), border: bullBorder, borderWidth,
        });
      }
      if (c.high < c2.low) {
        boxes.push({
          left: c2.time, right: c.time, top: c2.low, bottom: c.high,
          fill: str('bearColor'), border: bearBorder, borderWidth,
        });
      }
    }
    return [{ key: 'boxes', name: 'Imbalance', color: str('bullBorder'), kind: 'boxes', data: [], boxes: boxes.slice(-MAX_BOXES) }];
  },
};
