import type { IndicatorConfig } from '../types';
import type { IndicatorDef, Plot } from '../indicators/types';
import { isSeriesPlot } from '../indicators/types';
import { useStore } from '../store/store';
import { compilePine } from '../pine/compile';
import type { Operand } from './rules';

// A strategy shown on the chart, like TradingView: the indicators its conditions
// use (e.g. the two moving averages) are drawn on the price, its trades are
// marked by the chart (see ChartContainer), and it has its own legend row.

// the settings that make two indicator configurations the same curve
const sameCurve = (a: IndicatorConfig) => JSON.stringify([a.type, a.scriptId, a.period, a.inputs ?? {}, a.dPeriod, a.slowPeriod, a.signalPeriod, a.stdDev]);

export function strategyChartDef(
  cfg: Pick<IndicatorConfig, 'strategyId'>,
  getDef: (c: IndicatorConfig) => IndicatorDef | undefined,
  title: (c: IndicatorConfig) => string,
): IndicatorDef | undefined {
  const st = useStore.getState();
  const doc = st.strategies.find((d) => d.id === cfg.strategyId);
  if (!doc) return undefined;
  const base = {
    type: 'STRATEGY' as const,
    label: doc.name,
    short: doc.name,
    category: 'Personnalises' as const,
    overlay: true,
    description: 'Stratégie du testeur : ses indicateurs et ses trades sur le graphique',
    defaults: { period: 0, color: '#2962ff' },
    styles: [],
    params: () => '',
  };

  if (doc.mode === 'code') {
    const compiled = compilePine({ id: `strategy:${doc.id}`, name: doc.name, source: doc.code }, () => ({
      timeframe: useStore.getState().timeframe, ticker: useStore.getState().symbol.ticker,
    }));
    const def = compiled.def;
    return {
      ...base,
      compute: (candles, c) => {
        // a strategy declared overlay=false plots on its own scale: not on the price
        if (!def || !compiled.meta.overlay) return [];
        return def.compute(candles, { ...c, type: 'PINE', inputs: { ...(doc.inputs ?? {}) } });
      },
    };
  }

  // assisted strategy: the price-scale indicators of its conditions, once each
  const r = doc.rules;
  const groups = [
    ...(r.longEnabled ? [r.longEntry, r.longExit] : []),
    ...(r.shortEnabled ? [r.shortEntry, r.shortExit] : []),
  ];
  const operands = groups.flatMap((g) => g.conditions.flatMap((c) => [c.left, c.right]))
    .filter((o): o is Extract<Operand, { kind: 'indicator' }> => o.kind === 'indicator');
  const unique = new Map<string, IndicatorConfig>();
  for (const o of operands) unique.set(sameCurve(o.cfg), o.cfg);

  return {
    ...base,
    compute: (candles) => {
      // curves already on the chart as indicators are not drawn twice
      const onChart = new Set(useStore.getState().indicators.filter((i) => i.type !== 'STRATEGY' && i.visible).map(sameCurve));
      const plots: Plot[] = [];
      let n = 0;
      for (const [key, opCfg] of unique) {
        const def = getDef(opCfg);
        if (!def?.overlay || onChart.has(key)) continue;
        const lines = def.compute(candles, opCfg).filter(isSeriesPlot);
        n++;
        for (const p of lines) {
          plots.push({ ...p, key: `${n}_${p.key}`, name: lines.length > 1 ? `${title(opCfg)} ${p.name}` : title(opCfg), width: p.width ?? 1 });
        }
      }
      return plots;
    },
  };
}
