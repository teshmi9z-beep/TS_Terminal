import type { IndicatorConfig } from '../types';
import type { Plot } from './types';

// "Style" tab of the indicator settings, applied on top of what an indicator computes:
// a chosen color (with its transparency) replaces the plot's own colors, and a chosen
// line width replaces its width. Hidden plots keep their series (see plotShown).
export function styledPlots(cfg: IndicatorConfig, plots: Plot[]): Plot[] {
  if (!cfg.plotColors && !cfg.plotWidths) return plots;
  return plots.map((p) => {
    const color = cfg.plotColors?.[p.key];
    const width = cfg.plotWidths?.[p.key];
    if (!color && !width) return p;
    const out: Plot = { ...p };
    if (width) out.width = width;
    if (color) {
      out.color = color;
      if (p.kind === 'line' || p.kind === 'histogram') out.data = p.data.map(({ time, value }) => ({ time, value }));
      if (p.kind === 'markers') out.markers = p.markers?.map((m) => ({ ...m, color }));
    }
    return out;
  });
}

export const plotShown = (cfg: Pick<IndicatorConfig, 'plotHidden'>, key: string) => !cfg.plotHidden?.[key];
