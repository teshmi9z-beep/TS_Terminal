import type { Candle, IndicatorConfig } from '../types';
import { isSeriesPlot, type IndicatorDef, type Plot } from './types';

// TradingView's "indicator on indicator": an indicator with a Source input (SMA, RSI, Bollinger...)
// computed on another indicator's plot of the same chart instead of the price (an SMA of the RSI,
// an RSI of the OBV). The source plot becomes flat bars (open = high = low = close = its value)
// and the indicator runs on them unchanged.

export const PRICE_SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];

export type SourceRef = { id: string; plot: string };

export const sourceKey = (id: string, plot: string) => `ind:${id}:${plot}`;

export function sourceRef(cfg: Pick<IndicatorConfig, 'source'>): SourceRef | null {
  const m = /^ind:([^:]+):(.+)$/.exec(cfg.source ?? '');
  return m ? { id: m[1], plot: m[2] } : null;
}

function field(c: Candle, f: string): number {
  switch (f) {
    case 'open': return c.open;
    case 'high': return c.high;
    case 'low': return c.low;
    case 'hl2': return (c.high + c.low) / 2;
    case 'hlc3': return (c.high + c.low + c.close) / 3;
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
    case 'hlcc4': return (c.high + c.low + 2 * c.close) / 4;
    case 'volume': return c.volume;
    default: return c.close;
  }
}

const flat = (time: number, v: number, volume: number): Candle => ({ time, open: v, high: v, low: v, close: v, volume });

// The bars an indicator runs on: the chart's own for its default source; else one value per bar,
// a price field or the source indicator's plot (only the bars where that plot has a value, so an
// SMA 9 of an RSI 14 starts once the RSI does). A source that is gone falls back to the price.
export function sourceCandles(
  candles: Candle[], cfg: IndicatorConfig, def: Pick<IndicatorDef, 'source'>, plotsOf: (id: string) => Plot[] | undefined,
): Candle[] {
  if (!def.source) return candles;
  const ref = sourceRef(cfg);
  if (ref) {
    const plot = plotsOf(ref.id)?.find((p) => p.key === ref.plot && isSeriesPlot(p));
    if (!plot) return candles;
    const volume = new Map(candles.map((c) => [c.time, c.volume]));
    const out: Candle[] = [];
    for (const p of plot.data) if (Number.isFinite(p.value)) out.push(flat(p.time, p.value, volume.get(p.time) ?? 0));
    return out;
  }
  const f = cfg.source ?? def.source;
  return f === def.source ? candles : candles.map((c) => flat(c.time, field(c, f), c.volume));
}

// sources before the indicators computed on them; a missing source or a loop leaves the order as is
export function sourceOrder<T extends Pick<IndicatorConfig, 'id' | 'source'>>(list: T[]): T[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const out: T[] = [];
  const done = new Set<string>();
  const busy = new Set<string>();
  const visit = (c: T) => {
    if (done.has(c.id) || busy.has(c.id)) return;
    busy.add(c.id);
    const ref = sourceRef(c);
    const src = ref ? byId.get(ref.id) : undefined;
    if (src) visit(src);
    busy.delete(c.id);
    done.add(c.id);
    out.push(c);
  };
  list.forEach(visit);
  return out;
}

// every indicator of a list computed on the same bars, sources first (alerts, small charts)
export function computeWithSources(
  list: IndicatorConfig[], candles: Candle[], defOf: (cfg: IndicatorConfig) => IndicatorDef | undefined,
): Map<string, Plot[]> {
  const out = new Map<string, Plot[]>();
  for (const cfg of sourceOrder(list)) {
    const def = defOf(cfg);
    if (!def) continue;
    try {
      out.set(cfg.id, def.compute(sourceCandles(candles, cfg, def, (id) => out.get(id)), cfg));
    } catch {
      out.set(cfg.id, []);
    }
  }
  return out;
}

// the indicators computed on `id`, directly or through others (removed with it)
export function dependentsOf(list: Pick<IndicatorConfig, 'id' | 'source'>[], id: string): string[] {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of list) {
      const ref = sourceRef(c);
      if (ref && out.has(ref.id) && !out.has(c.id)) { out.add(c.id); grew = true; }
    }
  }
  out.delete(id);
  return [...out];
}

// an overlay-type indicator (a moving average, Bollinger) on another indicator's plot is drawn in
// that indicator's pane, like on TradingView; an oscillator on an indicator gets its own pane
export const paneHostId = (cfg: IndicatorConfig, def: Pick<IndicatorDef, 'overlay'>) => (def.overlay ? sourceRef(cfg)?.id ?? null : null);
