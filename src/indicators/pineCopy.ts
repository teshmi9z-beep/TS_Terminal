import type { IndicatorConfig, IndicatorType } from '../types';
import type { IndicatorDef } from './registry';

// "Modifier le code" of a built-in indicator: its editable Pine copy takes its place on the chart
// (same id, so its pane, alerts and indicators built on it stay) with the settings that have an
// equivalent in the script: inputs of the same name, the classic lengths in the order of the
// script's number inputs, the colors / widths / styles / hidden state of plots of the same name.

// the classic settings after the length, in the order of the Pine versions' inputs (sources.ts)
const CLASSIC: Partial<Record<IndicatorType, (c: IndicatorConfig) => (number | undefined)[]>> = {
  STOCH: (c) => [c.dPeriod],
  MACD: (c) => [c.slowPeriod, c.signalPeriod],
  BOLLINGER: (c) => [c.stdDev],
};
const BAND: Record<string, 'upper' | 'mid' | 'lower'> = { up: 'upper', mid: 'mid', low: 'lower' };

export function pineCopyConfig(old: IndicatorConfig, oldDef: IndicatorDef, pine: IndicatorDef, scriptId: string): IndicatorConfig {
  const pineInputs = pine.inputs ?? [];
  const inputs: Record<string, number | boolean | string> = {};
  for (const inp of oldDef.inputs ?? []) {
    const v = old.inputs?.[inp.key];
    const to = pineInputs.find((p) => p.label === inp.label);
    if (v !== undefined && to) inputs[to.key] = v;
  }
  const classic = [oldDef.defaults.period > 0 ? old.period : undefined, ...(CLASSIC[old.type]?.(old) ?? [])];
  const nums = pineInputs.filter((p) => p.kind === 'number');
  classic.forEach((v, k) => { if (v != null && nums[k] && inputs[nums[k].key] === undefined) inputs[nums[k].key] = v; });
  const src = pineInputs.find((p) => p.kind === 'source');
  if (src && old.source && !old.source.startsWith('ind:') && inputs[src.key] === undefined) inputs[src.key] = old.source;

  // the built-in's plots by name, matched to the script's plots (their key is their title)
  let plots: { key: string; name: string; kind: string }[] = [];
  try {
    const full = old.type === 'BOLLINGER' ? { ...old, bandVisible: { upper: true, mid: true, lower: true } } : old;
    plots = oldDef.compute([], full).map((p) => ({ key: p.key, name: p.name, kind: p.kind }));
  } catch { /* no plot to carry over */ }
  const pineKeys = new Set((pine.styles ?? []).map((s) => s.key));
  const keyOf = (oldKey: string) => { const n = plots.find((p) => p.key === oldKey)?.name; return n && pineKeys.has(n) ? n : undefined; };
  function carry<T>(rec: Record<string, T> | undefined): Record<string, T> | undefined {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec ?? {})) { const to = keyOf(k); if (to) out[to] = v; }
    return Object.keys(out).length ? out : undefined;
  }
  const plotColors = carry(old.plotColors) ?? {};
  const plotHidden = carry(old.plotHidden) ?? {};
  const lines = plots.filter((p) => p.kind === 'line' || p.kind === 'histogram');
  // a one-line indicator colored by its own color setting
  if (lines.length === 1 && oldDef.styles === undefined && old.type !== 'VOLUME' && old.color !== oldDef.defaults.color) {
    const to = keyOf(lines[0].key);
    if (to && !plotColors[to]) plotColors[to] = old.color;
  }
  if (old.type === 'BOLLINGER') {
    for (const p of plots) {
      const band = BAND[p.key], to = keyOf(p.key);
      if (!band || !to) continue;
      const c = old.bandColors?.[band];
      if (c) plotColors[to] = c;
      if (old.bandVisible && !old.bandVisible[band]) plotHidden[to] = true;
    }
  }

  return {
    id: old.id, type: 'PINE', scriptId, overlay: pine.overlay, period: 0, color: pine.defaults.color, visible: old.visible,
    inputs: Object.keys(inputs).length ? inputs : undefined,
    plotColors: Object.keys(plotColors).length ? plotColors : undefined,
    plotWidths: carry(old.plotWidths), plotStyles: carry(old.plotStyles),
    plotHidden: Object.keys(plotHidden).length ? plotHidden : undefined,
    collapsed: old.collapsed, paneStretch: old.paneStretch, tfVisibility: old.tfVisibility,
    levels: old.levels, levelColor: old.levelColor,
    axisLabels: old.axisLabels, legendValues: old.legendValues, legendInputs: old.legendInputs,
  };
}
