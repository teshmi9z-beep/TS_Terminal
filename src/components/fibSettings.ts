import { useStore } from '../store/store';
import type { Drawing, FibLevel, FibSettings } from '../types';

// TradingView's list of fib levels and their colours; the ones shown by default
// are this platform's usual ones (retracement 0 → 1, extension up to 2.618)
const LEVELS: [number, string][] = [
  [0, '#787b86'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'], [0.618, '#089981'], [0.65, '#089981'],
  [0.786, '#00bcd4'], [1, '#787b86'], [1.272, '#2962ff'], [1.414, '#9c27b0'], [1.618, '#2962ff'], [2, '#e91e63'],
  [2.272, '#ff9800'], [2.414, '#4caf50'], [2.618, '#f23645'], [3, '#9c27b0'], [3.272, '#00bcd4'], [3.618, '#9c27b0'],
  [4, '#787b86'], [4.236, '#e91e63'],
];
// the retracement as the user set it (2026-09-29): 0.88 in place of 1.272, the levels 0, 0.382,
// 0.5, 0.618, 0.786, 0.88 and 1, one blue colour, 1 px dashed lines, no background, the levels'
// values on the left and no prices
const RETR_LEVELS: [number, string][] = LEVELS.map(([v, c]) => (v === 1.272 ? [0.88, c] : [v, c]));
const RETR_ORDER = [0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.786, 1, 0.88];
const ON_RETR = [0, 0.382, 0.5, 0.618, 0.786, 0.88, 1];
const ON_EXT = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618];
// the retracement's lines, for a new drawing without a preset
export const FIB_RETR_LINE = { color: '#2962ff', lineWidth: 1, lineStyle: 'dashed' as const };

export type FibTool = 'fib_retracement' | 'fib_extension';

export function builtinFib(tool: FibTool): FibSettings {
  if (tool === 'fib_retracement') {
    // TradingView's order in the settings: 0.88 comes right after 1
    const levels = [...RETR_LEVELS].sort((a, b) => {
      const ia = RETR_ORDER.indexOf(a[0]), ib = RETR_ORDER.indexOf(b[0]);
      return (ia < 0 ? 100 + a[0] : ia) - (ib < 0 ? 100 + b[0] : ib);
    });
    return {
      levels: levels.map(([value, color]) => ({ value, color, on: ON_RETR.includes(value) })),
      oneColor: true, trendLine: true, background: false, bgTransparency: 85,
      extendLeft: false, extendRight: false, reverse: false,
      showPrices: false, showLevels: true, levelsAs: 'values', labelsAt: 'left', fontSize: 11,
    };
  }
  return {
    levels: LEVELS.map(([value, color]) => ({ value, color, on: ON_EXT.includes(value) })),
    oneColor: false, trendLine: true, background: true, bgTransparency: 85,
    extendLeft: false, extendRight: false, reverse: false,
    showPrices: true, showLevels: true, levelsAs: 'values', labelsAt: 'left', fontSize: 11,
  };
}

// a new drawing: the settings saved with "Enregistrer par défaut", else the built-in ones
export function defaultFib(tool: FibTool): FibSettings {
  return structuredClone(useStore.getState().fibDefaults[tool] ?? builtinFib(tool));
}

// drawings from before the settings dialog: their levels, labels and lines kept as they were
export function fibOf(d: Drawing): FibSettings {
  if (d.fib) return d.fib;
  const tool: FibTool = d.tool === 'fib_extension' ? 'fib_extension' : 'fib_retracement';
  const base = builtinFib(tool);
  const wanted = d.fibLevels ?? (tool === 'fib_retracement' ? ON_RETR : ON_EXT);
  const levels: FibLevel[] = base.levels.map((l) => ({ ...l, on: wanted.includes(l.value) }));
  for (const v of wanted) if (!levels.some((l) => l.value === v)) levels.push({ value: v, color: '#787b86', on: true });
  levels.sort((a, b) => a.value - b.value);
  return {
    ...base, levels, background: false, extendRight: true,
    showPrices: d.showPrice ?? true, showLevels: d.showPercent ?? true, levelsAs: 'percent',
  };
}
