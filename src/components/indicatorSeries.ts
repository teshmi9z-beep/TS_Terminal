import {
  LineStyle, LineType, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type LineWidth, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { getIndicatorDef, type Plot, type PlotPoint } from '../indicators/registry';
import { isSeriesPlot, isShapePlot, type PlotCandle } from '../indicators/types';
import { styledPlots, plotShown } from '../indicators/style';
import { withChartSeries } from '../indicators/companion';
import { paneHostId, sourceCandles, sourceOrder } from '../indicators/derived';
import { IndicatorShapes } from './indicatorShapes';
import { COLLAPSED_PANE_PX, shownOnTimeframe, type IndicatorRuntime } from './chartUtils';
import type { Candle, IndicatorConfig, Symbol, Timeframe } from '../types';

// Indicator plots as lightweight-charts data, shared by the main chart and the small charts of
// the 2 / 4 window layouts and the free windows (which draw the main chart's indicators too).

const ts = (t: number) => t as UTCTimestamp;
// a NaN value is a gap in the line (whitespace point)
export const plotPoint = (p: PlotPoint) => (!Number.isFinite(p.value) ? { time: ts(p.time) }
  : p.color ? { time: ts(p.time), value: p.value, color: p.color } : { time: ts(p.time), value: p.value });
export const candlePoint = (c: PlotCandle) => ({
  time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close, color: c.color, borderColor: c.color, wickColor: c.color,
});
// series data of a line / histogram / candles plot
export const seriesData = (p: Plot) => (p.kind === 'candles' ? (p.candles ?? []).map(candlePoint) : p.data.map(plotPoint));
export function lastSeriesPoint(p: Plot) {
  if (p.kind !== 'candles') { const last = p.data[p.data.length - 1]; return last && plotPoint(last); }
  const last = p.candles?.[p.candles.length - 1];
  return last && candlePoint(last);
}
export const markersOf = (plots: Plot[], cfg: IndicatorConfig): SeriesMarker<Time>[] => plots
  .flatMap((p) => (p.kind === 'markers' && plotShown(cfg, p.key) ? p.markers ?? [] : []))
  .sort((a, b) => a.time - b.time)
  .map((m) => ({ time: ts(m.time), position: m.position, shape: m.shape, color: m.color, text: m.text, price: m.price, size: m.size }) as SeriesMarker<Time>);

// The main chart's indicators on a small chart (2 / 4 windows, free windows): the same list,
// settings and colors, computed on that chart's own symbol and timeframe, built and laid out
// like the main chart does (hidden indicators keep their series for the legend's eye, panes
// collapse and one can be maximized), so PaneOverlays can show the same legends and controls.
export class MiniIndicators {
  runtimes: IndicatorRuntime[] = [];
  private chart: IChartApi;
  private price: () => ISeriesApi<SeriesType> | null;
  private candles: () => Candle[];

  constructor(chart: IChartApi, price: () => ISeriesApi<SeriesType> | null, candles: () => Candle[]) {
    this.chart = chart;
    this.price = price;
    this.candles = candles;
  }

  // `computed`: the plots of the indicators before it (an indicator on another one's plot)
  private plots(cfg: IndicatorConfig, sym: Symbol, tf: Timeframe, computed: Map<string, Plot[]>): Plot[] {
    const def = getIndicatorDef(cfg);
    let out: Plot[] = [];
    if (def) {
      try {
        out = styledPlots(cfg, withChartSeries(sym, tf, () => def.compute(sourceCandles(this.candles(), cfg, def, (id) => computed.get(id)), cfg)));
      } catch { /* a failing indicator draws nothing */ }
    }
    computed.set(cfg.id, out);
    return out;
  }

  clear() {
    for (const rt of this.runtimes) {
      try { rt.markers?.detach(); } catch { /* series removed */ }
      if (rt.shapes) this.chart.panes()[0]?.detachPrimitive(rt.shapes);
      for (const s of rt.series) this.chart.removeSeries(s);
    }
    this.runtimes = [];
  }

  rebuild(configs: IndicatorConfig[], sym: Symbol, tf: Timeframe, precision: number) {
    this.clear();
    if (!this.candles().length) return;
    let nextPane = 1;
    const computed = new Map<string, Plot[]>();
    const paneOf = new Map<string, number>();
    for (const cfg of sourceOrder(configs)) {
      const def = getIndicatorDef(cfg);
      if (!def) continue;
      const plots = this.plots(cfg, sym, tf, computed);
      const seriesPlots = plots.filter(isSeriesPlot);
      const onTf = shownOnTimeframe(cfg, tf);
      // an average of an oscillator goes in the oscillator's pane
      const host = paneHostId(cfg, def);
      const shared = host != null ? paneOf.get(host) : undefined;
      // Pine drawings only (boxes / labels) need no series, but only on the price pane
      const hasShapes = (shared ?? (def.overlay ? 0 : 1)) === 0 && plots.some(isShapePlot);
      if (!seriesPlots.length && !hasShapes) continue;
      const pane = shared ?? (def.overlay ? 0 : nextPane++);
      paneOf.set(cfg.id, pane);
      const series = seriesPlots.map((p, idx) => {
        const common = {
          priceLineVisible: false,
          lastValueVisible: true,
          visible: cfg.visible && onTf && plotShown(cfg, p.key),
          priceFormat: def.volumeFormat
            ? { type: 'volume' as const }
            : { type: 'price' as const, precision: pane === 0 ? precision : 2, minMove: pane === 0 ? 1 / 10 ** precision : 0.01 },
          ...(def.range ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range![0], maxValue: def.range![1] } }) } : {}),
        };
        const s: ISeriesApi<SeriesType> = p.kind === 'histogram'
          ? this.chart.addSeries(HistogramSeries, { color: p.color, ...common }, pane)
          : p.kind === 'candles'
            ? this.chart.addSeries(CandlestickSeries, { upColor: p.color, downColor: p.color, ...common }, pane)
            : this.chart.addSeries(LineSeries, {
              color: p.color, lineWidth: (p.width ?? 2) as LineWidth, crosshairMarkerRadius: 3,
              lineType: p.step ? LineType.WithSteps : LineType.Simple, ...common,
            }, pane);
        s.setData(seriesData(p));
        if (idx === 0) {
          // the indicator's reference levels (70 / 30...) and Pine hline()s
          const levels = cfg.levels ?? def.levels;
          for (const lv of levels ?? []) {
            s.createPriceLine({ price: lv, color: cfg.levelColor ?? '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: cfg.levels != null, title: '' });
          }
          for (const h of plots) {
            if (h.kind !== 'hline' || h.price == null || !plotShown(cfg, h.key)) continue;
            s.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: h.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: false, title: '' });
          }
        }
        return s;
      });
      if (pane > 0) this.chart.priceScale('right', pane).applyOptions({ scaleMargins: { top: 0.12, bottom: 0.06 } });
      // Pine plotshape markers: on the price series for overlays, else on the indicator
      const marks = markersOf(plots, cfg);
      const markerHost = pane === 0 ? this.price() : series[0];
      const markers = marks.length && markerHost ? createSeriesMarkers(markerHost, marks) : null;
      let shapes: IndicatorShapes | null = null;
      if (hasShapes) {
        shapes = new IndicatorShapes(this.candles, this.price);
        this.chart.panes()[0].attachPrimitive(shapes);
        shapes.setPlots(plots.filter((p) => plotShown(cfg, p.key)));
      }
      this.runtimes.push({ cfg, pane, series, plots, markers, shapes });
    }
  }

  // the main chart's pane layout: collapsed panes keep a header's height, a maximized pane takes
  // the others' room, hidden indicators (eye, timeframe visibility, collapsed pane) are hidden
  layout(height: number, tf: Timeframe, maximizedId: string | null, stored: IndicatorConfig[]) {
    const chart = this.chart;
    for (const rt of this.runtimes) rt.cfg = stored.find((i) => i.id === rt.cfg.id) ?? rt.cfg;
    const panes = chart.panes();
    const rtOf = (i: number) => (i === 0 ? undefined : this.runtimes.find((r) => r.pane === i));
    const hasMax = maximizedId != null && this.runtimes.some((r) => r.pane > 0 && r.cfg.id === maximizedId);
    const collapsed = panes.map((_, i) => (i === 0 ? hasMax : !!rtOf(i)?.cfg.collapsed || (hasMax && rtOf(i)?.cfg.id !== maximizedId)));
    if (panes.length > 1) {
      const total = Math.max(100, height - chart.timeScale().height() - (panes.length - 1));
      const nColl = collapsed.filter(Boolean).length;
      const avail = Math.max(60, total - nColl * COLLAPSED_PANE_PX);
      const factors = panes.map((_, i) => {
        const rt = rtOf(i);
        return i === 0 || !rt ? 1 : rt.cfg.paneStretch ?? getIndicatorDef(rt.cfg)?.stretch ?? 0.3;
      });
      const sumNormal = factors.reduce((s, f, i) => (collapsed[i] ? s : s + f), 0) || 1;
      panes.forEach((p, i) => p.setStretchFactor(collapsed[i] ? (COLLAPSED_PANE_PX * sumNormal) / avail : factors[i]));
    }
    this.price()?.applyOptions({ visible: !collapsed[0] });
    for (const rt of this.runtimes) {
      const shown = rt.cfg.visible && !collapsed[rt.pane] && shownOnTimeframe(rt.cfg, tf);
      const keys = rt.plots.filter(isSeriesPlot).map((p) => p.key);
      rt.series.forEach((s, i) => s.applyOptions({ visible: shown && plotShown(rt.cfg, keys[i]) }));
      rt.shapes?.setVisible(shown);
      if (rt.markers && rt.shown !== shown) rt.markers.setMarkers(shown ? markersOf(rt.plots, rt.cfg) : []);
      rt.shown = shown;
    }
  }

  // new bars or new companion data: every indicator computed again on the same series
  refresh(sym: Symbol, tf: Timeframe, lastOnly: boolean) {
    const computed = new Map<string, Plot[]>();
    for (const rt of this.runtimes) {
      const plots = this.plots(rt.cfg, sym, tf, computed);
      plots.filter(isSeriesPlot).forEach((p, i) => {
        const s = rt.series[i];
        if (!s) return;
        if (!lastOnly) { s.setData(seriesData(p)); return; }
        const last = lastSeriesPoint(p);
        if (last) { try { s.update(last); } catch { s.setData(seriesData(p)); } }
      });
      rt.markers?.setMarkers(rt.shown === false ? [] : markersOf(plots, rt.cfg));
      rt.shapes?.setPlots(plots.filter((p) => plotShown(rt.cfg, p.key)));
      rt.plots = plots;
    }
  }

  get count() { return this.runtimes.length; }
}
