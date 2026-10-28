import type { BuiltinIndicatorType, IndicatorConfig } from '../types';
import { useStore } from '../store/store';
import { compilePine } from '../pine/compile';
import {
  sma, ema, zlema, wma, bollinger, rsi, stochastic, macd, atr, cci, momentum,
  vwap, donchian, obv, williamsR, adx, type LinePoint,
} from './math';
import type { IndicatorDef, Plot, PlotPoint } from './types';
import { sourceRef } from './derived';
import { STOCH_PRICE_ENVELOPE } from './custom/stochPriceEnvelope';
import { strategyChartDef } from '../strategy/chartDef';
import { FVG_CUSTOM } from './custom/fvgCustom';
import { IMBALANCE } from './custom/imbalance';
import { HA_CANDLES } from './custom/haCandles';
import { SESSIONS_IND } from './custom/sessions';
import { HOUR_RANGE } from './custom/hourRange';
import { STO_RSI } from './custom/stoRsi';
import { TSH_ARROW } from './custom/tshArrow';
import { DOW_STRUCTURE } from './custom/dowStructure';
import { INDEX_REGIME } from './custom/indexRegime';
import { PIVOT_POINTS } from './custom/pivotPoints';
import { BASIS } from './custom/basis';
import { GAP_OPEN } from './custom/gapOpen';
import { EXPECTED_MOVE } from './custom/expectedMove';
import { ROBOT } from '../robots/robotIndicator';

export type { IndicatorCategory, IndicatorDef, InputDef, Plot, PlotPoint, StyleDef } from './types';

const line = (key: string, name: string, color: string, data: LinePoint[], width = 2): Plot => ({ key, name, color, kind: 'line', width, data });

const BB_DEFAULT_COLORS = { upper: '#2962ff', mid: '#ff6d00', lower: '#2962ff' };

export const INDICATORS: Record<BuiltinIndicatorType, IndicatorDef> = {
  SMA: {
    type: 'SMA', label: 'Moyenne mobile simple', short: 'SMA', category: 'Tendance', overlay: true, source: 'close',
    description: 'Moyenne arithmétique des N dernières clôtures',
    defaults: { period: 20, color: '#f0b90b' },
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'SMA', c.color, sma(k, c.period))],
  },
  EMA: {
    type: 'EMA', label: 'Moyenne mobile exponentielle', short: 'EMA', category: 'Tendance', overlay: true, source: 'close',
    description: 'Moyenne pondérée exponentiellement vers les cours récents',
    defaults: { period: 20, color: '#2962ff' },
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'EMA', c.color, ema(k, c.period))],
  },
  WMA: {
    type: 'WMA', label: 'Moyenne mobile pondérée', short: 'WMA', category: 'Tendance', overlay: true, source: 'close',
    description: 'Moyenne à poids linéairement décroissants',
    defaults: { period: 20, color: '#66bb6a' },
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'WMA', c.color, wma(k, c.period))],
  },
  ZLEMA: {
    type: 'ZLEMA', label: 'Zero-lag EMA', short: 'ZLEMA', category: 'Tendance', overlay: true, source: 'close',
    description: 'EMA corrigée du retard',
    defaults: { period: 20, color: '#00bcd4' },
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'ZLEMA', c.color, zlema(k, c.period))],
  },
  VWAP: {
    type: 'VWAP', label: 'VWAP (session)', short: 'VWAP', category: 'Volume', overlay: true,
    description: 'Prix moyen pondéré par le volume, remis à zéro chaque jour',
    defaults: { period: 0, color: '#2962ff' },
    params: () => 'Session',
    compute: (k, c) => [line('v', 'VWAP', c.color, vwap(k))],
  },
  BOLLINGER: {
    type: 'BOLLINGER', label: 'Bandes de Bollinger', short: 'BB', category: 'Volatilite', overlay: true, source: 'close',
    description: 'Moyenne mobile ± N écarts-types',
    defaults: {
      period: 20, color: '#ff6d00', stdDev: 2,
      bandColors: BB_DEFAULT_COLORS, bandVisible: { upper: true, mid: true, lower: true },
    },
    params: (c) => `${c.period} ${c.stdDev ?? 2}`,
    compute: (k, c) => {
      const { basis, upper, lower } = bollinger(k, c.period, c.stdDev ?? 2);
      const col = c.bandColors ?? { ...BB_DEFAULT_COLORS, mid: c.color };
      const vis = c.bandVisible ?? { upper: true, mid: true, lower: true };
      const out: Plot[] = [];
      if (vis.mid) out.push(line('mid', 'Base', col.mid, basis, 1));
      if (vis.upper) out.push(line('up', 'Haut', col.upper, upper, 1));
      if (vis.lower) out.push(line('low', 'Bas', col.lower, lower, 1));
      return out;
    },
  },
  DONCHIAN: {
    type: 'DONCHIAN', label: 'Canaux de Donchian', short: 'DC', category: 'Volatilite', overlay: true,
    description: 'Plus haut / plus bas des N dernières barres',
    defaults: { period: 20, color: '#2962ff' },
    params: (c) => `${c.period}`,
    compute: (k, c) => {
      const { upper, lower, basis } = donchian(k, c.period);
      return [line('up', 'Haut', c.color, upper, 1), line('mid', 'Base', '#ff6d00', basis, 1), line('low', 'Bas', c.color, lower, 1)];
    },
  },
  VOLUME: {
    type: 'VOLUME', label: 'Volume', short: 'Vol', category: 'Volume', overlay: false,
    description: 'Volume échangé par barre',
    defaults: { period: 0, color: '#26a69a', volUpColor: '#26a69a', volDownColor: '#ef5350' },
    stretch: 0.22, volumeFormat: true,
    params: () => '',
    compute: (k, c) => {
      const up = (c.volUpColor ?? '#26a69a') + '99';
      const down = (c.volDownColor ?? '#ef5350') + '99';
      return [{
        key: 'v', name: 'Volume', color: c.volUpColor ?? '#26a69a', kind: 'histogram',
        data: k.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? up : down })),
      }];
    },
  },
  RSI: {
    type: 'RSI', label: 'Relative Strength Index', short: 'RSI', category: 'Oscillateurs', overlay: false, source: 'close',
    description: 'Force relative des hausses vs baisses (0-100)',
    defaults: { period: 14, color: '#7e57c2' },
    range: [0, 100], levels: [70, 50, 30],
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'RSI', c.color, rsi(k, c.period))],
  },
  STOCH: {
    type: 'STOCH', label: 'Stochastique', short: 'Stoch', category: 'Oscillateurs', overlay: false,
    description: 'Position de la clôture dans le range récent',
    defaults: { period: 14, color: '#2962ff', dPeriod: 3 },
    range: [0, 100], levels: [80, 50, 20],
    params: (c) => `${c.period} ${c.dPeriod ?? 3}`,
    compute: (k, c) => {
      const { kLine, dLine } = stochastic(k, c.period, c.dPeriod ?? 3);
      return [line('k', '%K', c.color, kLine), line('d', '%D', '#ff6d00', dLine, 1)];
    },
  },
  MACD: {
    type: 'MACD', label: 'MACD', short: 'MACD', category: 'Oscillateurs', overlay: false, source: 'close',
    description: 'Écart entre deux EMA et sa ligne de signal',
    defaults: { period: 12, color: '#2962ff', slowPeriod: 26, signalPeriod: 9 },
    levels: [0],
    params: (c) => `${c.period} ${c.slowPeriod ?? 26} ${c.signalPeriod ?? 9}`,
    compute: (k, c) => {
      const { macdLine, signal, histogram } = macd(k, c.period, c.slowPeriod ?? 26, c.signalPeriod ?? 9);
      const hist: Plot = {
        key: 'h', name: 'Histo', color: '#26a69a', kind: 'histogram',
        data: histogram.map((p, i) => {
          const prev = i > 0 ? histogram[i - 1].value : p.value;
          const color = p.value >= 0 ? (p.value >= prev ? '#26a69a' : '#b2dfdb') : (p.value <= prev ? '#ef5350' : '#ffcdd2');
          return { ...p, color };
        }),
      };
      return [hist, line('m', 'MACD', c.color, macdLine), line('s', 'Signal', '#ff6d00', signal, 1)];
    },
  },
  ATR: {
    type: 'ATR', label: 'Average True Range', short: 'ATR', category: 'Volatilite', overlay: false,
    description: 'Amplitude moyenne des barres',
    defaults: { period: 14, color: '#ff6d00' },
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'ATR', c.color, atr(k, c.period))],
  },
  CCI: {
    type: 'CCI', label: 'Commodity Channel Index', short: 'CCI', category: 'Oscillateurs', overlay: false, source: 'hlc3',
    description: 'Écart du prix typique à sa moyenne',
    defaults: { period: 20, color: '#26c6da' },
    levels: [100, 0, -100],
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'CCI', c.color, cci(k, c.period))],
  },
  MOMENTUM: {
    type: 'MOMENTUM', label: 'Momentum', short: 'Mom', category: 'Oscillateurs', overlay: false, source: 'close',
    description: 'Variation du prix sur N barres',
    defaults: { period: 10, color: '#ec407a' },
    levels: [0],
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', 'Mom', c.color, momentum(k, c.period))],
  },
  WILLR: {
    type: 'WILLR', label: 'Williams %R', short: '%R', category: 'Oscillateurs', overlay: false,
    description: 'Position de la clôture dans le range (-100 à 0)',
    defaults: { period: 14, color: '#7e57c2' },
    range: [-100, 0], levels: [-20, -50, -80],
    params: (c) => `${c.period}`,
    compute: (k, c) => [line('v', '%R', c.color, williamsR(k, c.period))],
  },
  ADX: {
    type: 'ADX', label: 'ADX / DMI', short: 'ADX', category: 'Tendance', overlay: false,
    description: 'Force de la tendance et indicateurs directionnels',
    defaults: { period: 14, color: '#ff6d00' },
    levels: [25],
    params: (c) => `${c.period}`,
    compute: (k, c) => {
      const { adxLine, plusDI, minusDI } = adx(k, c.period);
      return [line('adx', 'ADX', c.color, adxLine), line('p', '+DI', '#26a69a', plusDI, 1), line('m', '-DI', '#ef5350', minusDI, 1)];
    },
  },
  OBV: {
    type: 'OBV', label: 'On Balance Volume', short: 'OBV', category: 'Volume', overlay: false,
    description: 'Volume cumulé signé par la direction du prix',
    defaults: { period: 0, color: '#2962ff' },
    volumeFormat: true,
    params: () => '',
    compute: (k, c) => [line('v', 'OBV', c.color, obv(k))],
  },
  // user indicators ported from Pine Script (src/indicators/custom)
  STOCH_ENV: STOCH_PRICE_ENVELOPE,
  FVG_CUSTOM,
  IMBALANCE,
  HA_CANDLES,
  SESSIONS: SESSIONS_IND,
  STO_RSI,
  TSH_ARROW,
  HOUR_RANGE,
  DOW_STRUCTURE,
  INDEX_REGIME,
  PIVOT_POINTS,
  BASIS,
  GAP_OPEN,
  EXPECTED_MOVE,
  ROBOT,
};

export const INDICATOR_LIST: IndicatorDef[] = Object.values(INDICATORS);

// built-in definition, or the compiled user Pine script of a 'PINE' indicator
export function getIndicatorDef(cfg: Pick<IndicatorConfig, 'type' | 'scriptId' | 'strategyId'>): IndicatorDef | undefined {
  if (cfg.type === 'STRATEGY') return strategyChartDef(cfg, getIndicatorDef, indicatorTitle);
  if (cfg.type !== 'PINE') return INDICATORS[cfg.type];
  const st = useStore.getState();
  const script = st.pineScripts.find((s) => s.id === cfg.scriptId);
  if (!script) return undefined;
  return compilePine(script, () => ({ timeframe: useStore.getState().timeframe, ticker: useStore.getState().symbol.ticker })).def ?? undefined;
}

export function indicatorTitle(cfg: IndicatorConfig, depth = 0): string {
  const def = getIndicatorDef(cfg);
  if (!def) return cfg.type;
  const p = def.params(cfg);
  const base = p ? `${def.short} ${p}` : def.short;
  if (!def.source) return base;
  // "SMA 9 · RSI 14", "BB 20 2 · MACD 12 26 9 (Signal)", "SMA 20 hl2"
  const ref = sourceRef(cfg);
  if (!ref) return cfg.source && cfg.source !== def.source ? `${base} ${cfg.source}` : base;
  const src = depth < 3 ? useStore.getState().indicators.find((i) => i.id === ref.id) : undefined;
  if (!src) return base;
  const srcDef = getIndicatorDef(src);
  const plots = srcDef ? sourcePlots(src, srcDef) : [];
  const plot = plots.length > 1 ? plots.find((x) => x.key === ref.plot) : undefined;
  return `${base} · ${indicatorTitle(src, depth + 1)}${plot ? ` (${plot.name})` : ''}`;
}

// the plots an indicator offers as a source to another (its lines and histograms, by name)
export function sourcePlots(cfg: IndicatorConfig, def: IndicatorDef): { key: string; name: string; kind: Plot['kind'] }[] {
  if (cfg.type === 'STRATEGY') return [];
  try {
    const full = cfg.type === 'BOLLINGER' ? { ...cfg, bandVisible: { upper: true, mid: true, lower: true } } : cfg;
    return def.compute([], full).filter((x) => x.kind === 'line' || x.kind === 'histogram').map((x) => ({ key: x.key, name: x.name, kind: x.kind }));
  } catch {
    return [];
  }
}

// binary search of a plot value at (or just before) a bar time
export function valueAt(data: PlotPoint[], time: number): PlotPoint | null {
  let lo = 0, hi = data.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].time <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && data[best].time === time ? data[best] : null;
}
