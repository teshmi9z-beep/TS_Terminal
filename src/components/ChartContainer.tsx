import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, ColorType, CrosshairMode, LineStyle, LineType, PriceScaleMode,
  CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type LineWidth, type SeriesMarker, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestResult } from '../strategy/types';
import { useStore, type PanePatch } from '../store/store';
import { useChartUi, type RangeSpan } from '../store/chartUi';
import { openFeed, type FeedSession } from '../data/feeds';
import { reportQuote } from '../data/feeds/quotes';
import { heikinAshi } from '../indicators/math';
import { getIndicatorDef } from '../indicators/registry';
import { isSeriesPlot, isShapePlot, type Plot } from '../indicators/types';
import { paneHostId, sourceCandles, sourceOrder } from '../indicators/derived';
import { IndicatorShapes } from './indicatorShapes';
import { styledPlots, plotShown } from '../indicators/style';
import {
  chartColors, pricePrecision, timeFormatters, indexAtOrBefore, isDailyTf, shownOnTimeframe,
  COLLAPSED_PANE_PX, type ChartEngine,
} from './chartUtils';
import { mainChart } from './mainChart';
import DrawingLayer from './DrawingLayer';
import PaneOverlays from './PaneOverlays';
import PriceAxisCountdown from './PriceAxisCountdown';
import ReplayControls from './ReplayControls';
import ChartTrading from './ChartTrading';
import TradeMarks from './TradeMarks';
import ChartEvents from './ChartEvents';
import { CompareOverlay } from './compareSeries';
import { replayBarShown } from './tradingAccount';
import { getDragSymbol, isSymbolDrag } from './symbolDnd';
import { COMPANION_EVENT, setChartBackground, setChartSeries } from '../indicators/companion';
import { lastSeriesPoint, markersOf, seriesData } from './indicatorSeries';
import type { Candle, ChartSettings, PriceScaleModeName } from '../types';
import { LOCALE } from '../i18n/lang';

const ts = (t: number) => t as UTCTimestamp;
// estimated bars (index futures estimated in real time) are drawn faded
const fade = (color: string, alpha: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const ohlcPoint = (c: Candle) => {
  const p = { time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
  if (!c.est) return p;
  const s = useStore.getState().chartSettings;
  const up = c.close >= c.open;
  return { ...p, color: fade(up ? s.upColor : s.downColor, 0.35), borderColor: fade((up ? s.borderUpColor ?? s.upColor : s.borderDownColor ?? s.downColor), 0.6), wickColor: fade(up ? s.wickUpColor : s.wickDownColor, 0.6) };
};
// strategy tester trades on the price series, like TradingView's order markers
function strategyMarkers(res: BacktestResult): SeriesMarker<Time>[] {
  const out: SeriesMarker<Time>[] = [];
  const trades = res.trades.slice(-400);
  for (const t of trades) {
    const long = t.side === 'long';
    out.push({ time: ts(t.entryTime), position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? '#2962ff' : '#e91e63', text: long ? 'Achat' : 'Vente' });
    // a reversal is shown by the next entry's marker
    if (t.exitReason === 'reverse') continue;
    const text = t.exitReason === 'stop' ? 'SL' : t.exitReason === 'target' ? 'TP' : t.exitLabel;
    out.push({ time: ts(t.exitTime), position: long ? 'aboveBar' : 'belowBar', shape: long ? 'arrowDown' : 'arrowUp', color: t.pnl >= 0 ? '#26a69a' : '#9598a1', text });
  }
  const o = res.openTrade;
  if (o) out.push({ time: ts(o.entryTime), position: o.side === 'long' ? 'belowBar' : 'aboveBar', shape: o.side === 'long' ? 'arrowUp' : 'arrowDown', color: o.side === 'long' ? '#2962ff' : '#e91e63', text: o.side === 'long' ? 'Achat' : 'Vente' });
  return out.sort((a, b) => (a.time as number) - (b.time as number));
}

const SCALE_MODE: Record<PriceScaleModeName, PriceScaleMode> = {
  normal: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage,
};

function nextHeikinAshi(prev: Candle | undefined, c: Candle): Candle {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  return { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close, volume: c.volume };
}

function makeMainSeries(chart: IChartApi, s: ChartSettings): ISeriesApi<SeriesType> {
  if (s.candleStyle === 'bars') return chart.addSeries(BarSeries, { upColor: s.upColor, downColor: s.downColor }, 0);
  if (s.candleStyle === 'line') return chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2 }, 0);
  if (s.candleStyle === 'area') {
    return chart.addSeries(AreaSeries, { lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.28)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2 }, 0);
  }
  return chart.addSeries(CandlestickSeries, {
    upColor: s.upColor, downColor: s.downColor,
    borderUpColor: s.borderUpColor ?? s.upColor, borderDownColor: s.borderDownColor ?? s.downColor,
    wickUpColor: s.wickUpColor, wickDownColor: s.wickDownColor,
  }, 0);
}

export default function ChartContainer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engine = useRef<ChartEngine>({ chart: null, mainSeries: null, candles: [], indicators: [], precision: 2 });
  const haRef = useRef<Candle[]>([]);
  const sessionRef = useRef<FeedSession | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const loadTokenRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const pendingRangeRef = useRef<RangeSpan | null>(null);
  const collapsedRef = useRef<boolean[]>([false]);
  const lastFactorsRef = useRef<number[]>([]);
  const alertLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // bar replay: the complete history while the chart only shows bars up to the
  // replay point (engine.candles is then a prefix of it)
  const fullRef = useRef<Candle[] | null>(null);
  const [ready, setReady] = useState(false);
  const [seriesGen, setSeriesGen] = useState(0);
  // bumped when the network comes back, to leave saved or simulated bars
  const [netGen, setNetGen] = useState(0);

  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const indicators = useStore((s) => s.indicators);
  const alerts = useStore((s) => s.alerts);
  const compares = useStore((s) => s.compares);
  const chartSettings = useStore((s) => s.chartSettings);
  const uiTheme = useStore((s) => s.uiTheme);
  const timeZone = useStore((s) => s.timeZone);
  const priceScaleMode = useStore((s) => s.priceScaleMode);
  const maximizedId = useChartUi((s) => s.maximizedId);
  const rangeRequest = useChartUi((s) => s.rangeRequest);
  const feedStatus = useChartUi((s) => s.feedStatus);
  const replayMode = useChartUi((s) => s.replay.mode);
  const replayTime = useChartUi((s) => s.replay.time);
  const replayJump = useChartUi((s) => s.replay.jump);
  const replayPlaying = useChartUi((s) => s.replay.playing);
  const replaySpeed = useChartUi((s) => s.replay.speed);
  const mainHidden = useChartUi((s) => s.mainHidden);

  // ---------- main series data ----------
  function setMainData() {
    const e = engine.current;
    const s = e.mainSeries;
    if (!s) return;
    const style = useStore.getState().chartSettings.candleStyle;
    if (style === 'line' || style === 'area') {
      s.setData(e.candles.map((c) => ({ time: ts(c.time), value: c.close })));
    } else if (style === 'heikin_ashi') {
      haRef.current = heikinAshi(e.candles);
      s.setData(haRef.current.map(ohlcPoint));
    } else {
      s.setData(e.candles.map(ohlcPoint));
    }
  }

  function updateMainLast() {
    const e = engine.current;
    const s = e.mainSeries;
    const c = e.candles[e.candles.length - 1];
    if (!s || !c) return;
    const style = useStore.getState().chartSettings.candleStyle;
    if (style === 'line' || style === 'area') {
      s.update({ time: ts(c.time), value: c.close });
    } else if (style === 'heikin_ashi') {
      const ha = haRef.current;
      const replacing = ha.length > 0 && ha[ha.length - 1].time === c.time;
      const bar = nextHeikinAshi(replacing ? ha[ha.length - 2] : ha[ha.length - 1], c);
      if (replacing) ha[ha.length - 1] = bar; else ha.push(bar);
      s.update(ohlcPoint(bar));
    } else {
      s.update(ohlcPoint(c));
    }
  }

  function applyPriceFormat() {
    const p = engine.current.precision;
    engine.current.mainSeries?.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: 1 / 10 ** p } });
  }

  // ---------- indicators ----------
  function rebuildIndicators() {
    const e = engine.current;
    const chart = e.chart;
    if (!chart) return;
    for (const rt of e.indicators) {
      // the markers' host may already be gone (price series swapped)
      try { rt.markers?.detach(); } catch { /* series removed */ }
      if (rt.shapes) chart.panes()[0]?.detachPrimitive(rt.shapes);
      for (const s of rt.series) chart.removeSeries(s);
    }
    e.indicators = [];
    if (e.candles.length) {
      let nextPane = 1;
      // sources first: an indicator on another one's plot runs on what that one computed
      const computed = new Map<string, Plot[]>();
      const paneOf = new Map<string, number>();
      for (const cfg of sourceOrder(useStore.getState().indicators)) {
        const def = getIndicatorDef(cfg);
        if (!def) continue;
        const plots = styledPlots(cfg, def.compute(sourceCandles(e.candles, cfg, def, (id) => computed.get(id)), cfg));
        computed.set(cfg.id, plots);
        const seriesPlots = plots.filter(isSeriesPlot);
        const onTf = shownOnTimeframe(cfg, useStore.getState().timeframe);
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
              : { type: 'price' as const, precision: pane === 0 ? e.precision : 2, minMove: pane === 0 ? 1 / 10 ** e.precision : 0.01 },
            ...(def.range ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range![0], maxValue: def.range![1] } }) } : {}),
          };
          const s: ISeriesApi<SeriesType> = p.kind === 'histogram'
            ? chart.addSeries(HistogramSeries, { color: p.color, ...common }, pane)
            : p.kind === 'candles'
              // Pine plotcandle: colors come with each candle
              ? chart.addSeries(CandlestickSeries, { upColor: p.color, downColor: p.color, ...common }, pane)
              : chart.addSeries(LineSeries, {
                color: p.color, lineWidth: (p.width ?? 2) as LineWidth, crosshairMarkerRadius: 3,
                lineType: p.step ? LineType.WithSteps : LineType.Simple, ...common,
              }, pane);
          s.setData(seriesData(p));
          // user levels replace the indicator's defaults (RSI 70/50/30...)
          const levels = cfg.levels ?? def.levels;
          if (idx === 0 && levels) {
            for (const lv of levels) {
              s.createPriceLine({
                price: lv, color: cfg.levelColor ?? '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed,
                axisLabelVisible: cfg.levels != null, title: '',
              });
            }
          }
          // Pine hline() levels
          if (idx === 0) {
            for (const h of plots) {
              if (h.kind !== 'hline' || h.price == null || !plotShown(cfg, h.key)) continue;
              s.createPriceLine({
                price: h.price, color: h.color, lineWidth: 1, lineStyle: h.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: false, title: '',
              });
            }
          }
          return s;
        });
        if (pane > 0) chart.priceScale('right', pane).applyOptions({ scaleMargins: { top: 0.12, bottom: 0.06 } });
        // Pine plotshape markers: on the price series for overlays, else on the indicator
        const marks = markersOf(plots, cfg);
        const markerHost = pane === 0 ? e.mainSeries : series[0];
        const markers = marks.length && markerHost ? createSeriesMarkers(markerHost, marks) : null;
        let shapes: IndicatorShapes | null = null;
        if (hasShapes) {
          shapes = new IndicatorShapes(() => engine.current.candles, () => engine.current.mainSeries);
          chart.panes()[0].attachPrimitive(shapes);
          shapes.setPlots(plots.filter((p) => plotShown(cfg, p.key)));
        }
        e.indicators.push({ cfg, pane, series, plots, markers, shapes });
      }
    }
    applyPaneLayout();
    useChartUi.getState().bumpData();
  }

  // recompute every indicator on the current bars; `lastOnly` pushes just the
  // newest point (live ticks) instead of resetting the whole series
  function refreshIndicatorData(lastOnly: boolean) {
    const e = engine.current;
    // e.indicators is in source order (rebuildIndicators)
    const computed = new Map<string, Plot[]>();
    for (const rt of e.indicators) {
      const def = getIndicatorDef(rt.cfg);
      if (!def) continue;
      const plots = styledPlots(rt.cfg, def.compute(sourceCandles(e.candles, rt.cfg, def, (id) => computed.get(id)), rt.cfg));
      computed.set(rt.cfg.id, plots);
      plots.filter(isSeriesPlot).forEach((p, i) => {
        const s = rt.series[i];
        if (!s) return;
        if (!lastOnly) { s.setData(seriesData(p)); return; }
        const last = lastSeriesPoint(p);
        if (last) { try { s.update(last); } catch { s.setData(seriesData(p)); } }
      });
      const marks = rt.shown === false ? [] : markersOf(plots, rt.cfg);
      // markers that came only with bars loaded after the build (another symbol's, another
      // timeframe's): created now
      if (!rt.markers && marks.length) {
        const host = rt.pane === 0 ? e.mainSeries : rt.series[0];
        if (host) rt.markers = createSeriesMarkers(host, marks);
      } else rt.markers?.setMarkers(marks);
      rt.shapes?.setPlots(plots.filter((p) => plotShown(rt.cfg, p.key)));
      rt.plots = plots;
    }
  }

  function scheduleLiveRefresh() {
    if (throttleRef.current) return;
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null;
      refreshIndicatorData(true);
      useChartUi.getState().bumpData();
    }, 250);
  }

  // ---------- panes: collapse / maximize / persisted heights ----------
  function applyPaneLayout() {
    const e = engine.current;
    const chart = e.chart;
    const el = containerRef.current;
    if (!chart || !el) return;
    // size-only changes don't rebuild the series, so refresh the runtime configs here
    const stored = useStore.getState().indicators;
    for (const rt of e.indicators) rt.cfg = stored.find((i) => i.id === rt.cfg.id) ?? rt.cfg;
    const panes = chart.panes();
    const rtOf = (i: number) => (i === 0 ? undefined : e.indicators.find((r) => r.pane === i));
    const maxId = useChartUi.getState().maximizedId;
    const hasMax = maxId != null && e.indicators.some((r) => r.pane > 0 && r.cfg.id === maxId);
    const collapsed = panes.map((_, i) => (i === 0 ? hasMax : !!rtOf(i)?.cfg.collapsed || (hasMax && rtOf(i)?.cfg.id !== maxId)));
    if (panes.length > 1) {
      const total = Math.max(100, el.clientHeight - chart.timeScale().height() - (panes.length - 1));
      const nColl = collapsed.filter(Boolean).length;
      const avail = Math.max(60, total - nColl * COLLAPSED_PANE_PX);
      const factors = panes.map((_, i) => {
        const rt = rtOf(i);
        return i === 0 || !rt ? 1 : rt.cfg.paneStretch ?? getIndicatorDef(rt.cfg)?.stretch ?? 0.3;
      });
      const sumNormal = factors.reduce((s, f, i) => (collapsed[i] ? s : s + f), 0) || 1;
      panes.forEach((p, i) => p.setStretchFactor(collapsed[i] ? (COLLAPSED_PANE_PX * sumNormal) / avail : factors[i]));
    }
    collapsedRef.current = collapsed;
    e.mainSeries?.applyOptions({ visible: !collapsed[0] && !useChartUi.getState().mainHidden });
    const tf = useStore.getState().timeframe;
    for (const rt of e.indicators) {
      const shown = rt.cfg.visible && !collapsed[rt.pane] && shownOnTimeframe(rt.cfg, tf);
      const keys = rt.plots.filter(isSeriesPlot).map((p) => p.key);
      rt.series.forEach((s, i) => s.applyOptions({ visible: shown && plotShown(rt.cfg, keys[i]) }));
      rt.shapes?.setVisible(shown);
      if (rt.markers && rt.shown !== shown) rt.markers.setMarkers(shown ? markersOf(rt.plots, rt.cfg) : []);
      rt.shown = shown;
    }
    lastFactorsRef.current = chart.panes().map((p) => p.getStretchFactor());
  }

  // the chart's own separator drag changes stretch factors; persist them
  function persistPaneDrag() {
    const e = engine.current;
    const chart = e.chart;
    if (!chart) return;
    const panes = chart.panes();
    if (panes.length < 2) return;
    const f = panes.map((p) => p.getStretchFactor());
    const prev = lastFactorsRef.current;
    if (f.length === prev.length && f.every((v, i) => Math.abs(v - prev[i]) < 1e-9)) return;
    if (useChartUi.getState().maximizedId) { applyPaneLayout(); return; }
    const heights = panes.map((p) => p.getHeight());
    const patches: PanePatch[] = [];
    panes.forEach((_, i) => {
      const rt = i > 0 ? e.indicators.find((r) => r.pane === i) : undefined;
      if (!rt) return;
      const wasCollapsed = collapsedRef.current[i];
      if (wasCollapsed && heights[i] <= COLLAPSED_PANE_PX + 14) return;
      patches.push({ id: rt.cfg.id, paneStretch: f[i] / f[0], ...(wasCollapsed ? { collapsed: false } : {}) });
    });
    lastFactorsRef.current = f;
    if (patches.length) useStore.getState().setPaneLayout(patches);
  }

  // ---------- history paging ----------
  async function loadOlder() {
    const session = sessionRef.current;
    if (!session || !session.hasMore || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    const token = loadTokenRef.current;
    try {
      const older = await session.loadOlder();
      if (token !== loadTokenRef.current) return;
      const e = engine.current;
      const first = e.candles[0]?.time ?? Infinity;
      const add = older.filter((c) => c.time < first);
      if (!add.length) return;
      if (fullRef.current) fullRef.current = [...add, ...fullRef.current];
      // setData keeps the logical (index) range, which would jump the view back
      // by the number of prepended bars: shift it to stay on the same bars
      const timeScale = e.chart?.timeScale();
      const range = timeScale?.getVisibleLogicalRange();
      e.candles = [...add, ...e.candles];
      setMainData();
      refreshIndicatorData(false);
      if (timeScale && range) timeScale.setVisibleLogicalRange({ from: range.from + add.length, to: range.to + add.length });
      useChartUi.getState().bumpData();
    } catch (err) {
      console.warn('[chart] historique:', err);
    } finally {
      loadingOlderRef.current = false;
    }
  }

  async function applyPendingRange() {
    const span = pendingRangeRef.current;
    const e = engine.current;
    const chart = e.chart;
    if (span == null || !chart || !e.candles.length) return;
    pendingRangeRef.current = null;
    if (span === 'all') {
      for (let i = 0; i < 10 && sessionRef.current?.hasMore; i++) await loadOlder();
      chart.timeScale().fitContent();
      return;
    }
    const lastT = e.candles[e.candles.length - 1].time;
    const from = span === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000 : lastT - span;
    for (let i = 0; i < 8 && e.candles[0].time > from && sessionRef.current?.hasMore; i++) await loadOlder();
    chart.timeScale().setVisibleRange({ from: ts(Math.max(from, e.candles[0].time)), to: ts(lastT) });
  }

  // ---------- live bars ----------
  // the CME estimate starts or stops while the chart is open
  function syncEstimated() {
    const s = sessionRef.current;
    const ui = useChartUi.getState();
    if (!s || !!s.estimated === !!ui.feedStatus.estimated) return;
    ui.setFeedStatus({ ...ui.feedStatus, label: s.label, realtime: s.realtime, estimated: s.estimated });
  }

  function onLiveBar(c: Candle) {
    syncEstimated();
    const e = engine.current;
    // during a replay live bars only extend the hidden full history
    const replaying = fullRef.current !== null;
    const arr = fullRef.current ?? e.candles;
    if (!arr.length) return;
    const last = arr[arr.length - 1];
    if (replaying) {
      if (c.time === last.time) arr[arr.length - 1] = c; else if (c.time > last.time) arr.push(c);
      const s = sessionRef.current;
      if (s && !s.proxy) reportQuote(useStore.getState().symbol.ticker, s.source, { last: c.close });
      return;
    }
    if (c.time < last.time) {
      // correction of an already-closed bar (Yahoo polling returns the last two)
      const i = indexAtOrBefore(arr, c.time);
      if (i >= 0 && arr[i].time === c.time) {
        arr[i] = c;
        const style = useStore.getState().chartSettings.candleStyle;
        if (style === 'candles' || style === 'bars') { try { e.mainSeries?.update(ohlcPoint(c), true); } catch { /* ignore */ } }
      }
      return;
    }
    if (c.time === last.time) arr[arr.length - 1] = c; else arr.push(c);
    updateMainLast();
    scheduleLiveRefresh();
    const s = sessionRef.current;
    if (s && !s.proxy) reportQuote(useStore.getState().symbol.ticker, s.source, { last: c.close });
  }

  // jump (not animated: an animation gets cancelled by the next data update)
  // to the latest bar, keeping the usual empty space on the right
  function goToRealTime() {
    const scale = engine.current.chart?.timeScale();
    scale?.scrollToPosition(scale.options().rightOffset, false);
  }

  // ---------- bar replay ----------
  function showReplayAt(time: number) {
    const e = engine.current;
    const full = fullRef.current ?? e.candles;
    if (!full.length) return;
    fullRef.current = full;
    const found = indexAtOrBefore(full, time);
    const idx = Math.max(0, found);
    // before the loaded history the target stays: replayFrom loads older bars
    if (found >= 0) useChartUi.getState().setReplay({ at: full[idx].time });
    e.candles = full.slice(0, idx + 1);
    setMainData();
    refreshIndicatorData(false);
    goToRealTime();
    useChartUi.getState().bumpData();
  }

  function exitReplayDisplay() {
    const e = engine.current;
    if (!fullRef.current) return;
    e.candles = fullRef.current;
    fullRef.current = null;
    setMainData();
    refreshIndicatorData(false);
    goToRealTime();
    useChartUi.getState().bumpData();
  }

  // reveals the next bar; false once the replay has caught up with the present
  function stepReplay(): boolean {
    const full = fullRef.current;
    const e = engine.current;
    if (!full) return false;
    const n = e.candles.length;
    if (n >= full.length) {
      useChartUi.getState().setReplay({ playing: false });
      useChartUi.getState().showToast('Replay : dernière barre atteinte');
      return false;
    }
    e.candles.push(full[n]);
    useChartUi.getState().setReplay({ at: full[n].time });
    updateMainLast();
    scheduleLiveRefresh();
    // the replay account trades on this bar
    replayBarShown(useStore.getState().symbol.ticker, full[n]);
    return true;
  }

  // older history may be needed to start a replay far in the past
  async function replayFrom(time: number) {
    showReplayAt(time);
    for (let i = 0; i < 10 && (fullRef.current?.[0]?.time ?? 0) > time && sessionRef.current?.hasMore; i++) await loadOlder();
    if (useChartUi.getState().replay.mode === 'on') showReplayAt(time);
  }

  // random replay start: a bar somewhere in a wider slice of history, leaving
  // enough bars after it to replay
  async function replayRandom() {
    const ui = useChartUi.getState();
    ui.setReplay({ playing: false });
    for (let i = 0; i < 4 && sessionRef.current?.hasMore; i++) await loadOlder();
    const bars = fullRef.current ?? engine.current.candles;
    if (bars.length < 120) { ui.showToast('Pas assez d’historique pour un replay aléatoire'); return; }
    const minIdx = 50;
    const maxIdx = bars.length - 60;
    const idx = minIdx + Math.floor(Math.random() * (maxIdx - minIdx));
    ui.setReplay({ mode: 'on', time: bars[idx].time, at: null, playing: false });
  }

  // ---------- chart creation ----------
  useEffect(() => {
    const el = containerRef.current!;
    const st = useStore.getState();
    const colors = chartColors(st.uiTheme);
    const chart = createChart(el, {
      layout: {
        // the chart library's attribution notice is in the README
        attributionLogo: false,
        background: { type: ColorType.Solid, color: st.chartSettings.background },
        textColor: colors.text,
        fontSize: 11,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
        panes: { separatorColor: colors.separator, separatorHoverColor: 'rgba(41, 98, 255, 0.45)', enableResize: true },
      },
      grid: {
        vertLines: { color: st.chartSettings.gridColor, visible: st.chartSettings.showGrid },
        horzLines: { color: st.chartSettings.gridColor, visible: st.chartSettings.showGrid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crossLine, labelBackgroundColor: colors.crossLabel },
        horzLine: { color: colors.crossLine, labelBackgroundColor: colors.crossLabel },
      },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8, minBarSpacing: 0.3 },
      width: el.clientWidth,
      height: el.clientHeight,
    });
    // the price pane must survive while its series is swapped (chart style change)
    chart.panes()[0].setPreserveEmptyPane(true);
    engine.current.chart = chart;
    engine.current.mainSeries = makeMainSeries(chart, st.chartSettings);
    mainChart.engine = engine.current;
    // a trade of the strategy tester far back: up to 20 older pages
    mainChart.loadBefore = async (time) => {
      for (let i = 0; i < 20 && (engine.current.candles[0]?.time ?? 0) > time && sessionRef.current?.hasMore; i++) await loadOlder();
      return (engine.current.candles[0]?.time ?? Infinity) <= time;
    };

    // replay: the click picks the starting bar
    chart.subscribeClick((param) => {
      const ui = useChartUi.getState();
      // assisted strategy editor: the clicked curve (or the nearest one) becomes a condition operand
      if (ui.strategyPick) {
        const pick = ui.strategyPick;
        const e = engine.current;
        const pane = param.paneIndex ?? 0;
        let best: { rt: (typeof e.indicators)[number]; idx: number; d: number } | null = null;
        for (const rt of e.indicators) {
          if (rt.pane !== pane) continue;
          rt.series.forEach((s, idx) => {
            if (param.hoveredSeries === s) { best = { rt, idx, d: -1 }; return; }
            const v = param.seriesData.get(s) as { value?: number; close?: number } | undefined;
            const price = v?.value ?? v?.close;
            const y = price != null && param.point ? s.priceToCoordinate(price) : null;
            const d = y != null && param.point ? Math.abs(y - param.point.y) : Infinity;
            if (d < 18 && (!best || (best.d >= 0 && d < best.d))) best = { rt, idx, d };
          });
        }
        const found = best as { rt: (typeof e.indicators)[number]; idx: number; d: number } | null;
        if (found) {
          const plot = found.rt.plots.filter(isSeriesPlot)[found.idx];
          const cfg = useStore.getState().indicators.find((c) => c.id === found.rt.cfg.id) ?? found.rt.cfg;
          if (plot) pick({ kind: 'indicator', cfg: { ...cfg }, plot: plot.key });
        } else if (pane === 0) {
          pick({ kind: 'price', field: 'close' });
        }
        return;
      }
      if (ui.replay.mode !== 'select' || param.logical == null) return;
      const bars = fullRef.current ?? engine.current.candles;
      if (!bars.length) return;
      // the bar under the click by its time: compared symbols add their own times to the time
      // scale, so its logical index is not the chart's bar index
      const clicked = param.time as number | undefined;
      const idx = clicked != null
        ? Math.max(0, indexAtOrBefore(bars, clicked))
        : Math.max(0, Math.min(bars.length - 1, Math.round(param.logical)));
      ui.setReplay({ mode: 'on', time: bars[idx].time, at: null, playing: false });
    });
    chart.subscribeCrosshairMove((param) => {
      useChartUi.getState().setHoverTime(param.time != null && param.point ? (param.time as number) : null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 30) void loadOlder();
    });

    const preventMenu = (e: MouseEvent) => e.preventDefault();
    el.addEventListener('contextmenu', preventMenu);

    // wheel over the price axis zooms the price scale instead of the time axis
    function onWheel(ev: WheelEvent) {
      const rect = el.getBoundingClientRect();
      const axisW = chart.priceScale('right').width();
      if (ev.clientX - rect.left < rect.width - axisW) return;
      const y = ev.clientY - rect.top;
      if (y > (chart.panes()[0]?.getHeight() ?? 0)) return;
      ev.preventDefault();
      const series = engine.current.mainSeries;
      const scale = series?.priceScale();
      const range = scale?.getVisibleRange();
      if (!scale || !range) return;
      scale.applyOptions({ autoScale: false });
      const mid = (range.from + range.to) / 2;
      const k = ev.deltaY > 0 ? 1.1 : 0.9;
      scale.setVisibleRange({ from: mid - (mid - range.from) * k, to: mid + (range.to - mid) * k });
    }
    el.addEventListener('wheel', onWheel, { passive: false });

    // double-click on the plot: back to auto-scale and the latest bar
    function onDblClick(ev: MouseEvent) {
      const rect = el.getBoundingClientRect();
      if (ev.clientX - rect.left > rect.width - chart.priceScale('right').width()) return;
      if ((ev.target as HTMLElement).closest('.chart-ui')) return;
      engine.current.mainSeries?.priceScale().applyOptions({ autoScale: true });
      goToRealTime();
    }
    el.addEventListener('dblclick', onDblClick);

    const onUp = () => setTimeout(persistPaneDrag, 0);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);

    const ro = new ResizeObserver(() => {
      chart.resize(el.clientWidth, el.clientHeight);
      applyPaneLayout();
    });
    ro.observe(el);

    const autoScaleTimer = setInterval(() => {
      const opts = engine.current.mainSeries?.priceScale().options();
      if (opts) useChartUi.getState().setAutoScale(opts.autoScale);
    }, 400);

    setReady(true);
    return () => {
      ro.disconnect();
      clearInterval(autoScaleTimer);
      el.removeEventListener('contextmenu', preventMenu);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
      unsubRef.current?.();
      unsubRef.current = null;
      if (throttleRef.current) clearTimeout(throttleRef.current);
      if (mainChart.engine === engine.current) { mainChart.engine = null; mainChart.loadBefore = null; }
      chart.remove();
      engine.current = { chart: null, mainSeries: null, candles: [], indicators: [], precision: 2 };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // indicators reading another symbol's bars (the future of a cash index...) redraw when they arrive
  useEffect(() => {
    const redraw = () => {
      if (!engine.current.indicators.length) return;
      refreshIndicatorData(false);
      useChartUi.getState().bumpData();
    };
    window.addEventListener(COMPANION_EVENT, redraw);
    return () => window.removeEventListener(COMPANION_EVENT, redraw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- visual options ----------
  useEffect(() => {
    const chart = engine.current.chart;
    if (!chart) return;
    const colors = chartColors(uiTheme);
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: chartSettings.background },
        textColor: colors.text,
        panes: { separatorColor: colors.separator, separatorHoverColor: 'rgba(41, 98, 255, 0.45)' },
      },
      grid: {
        vertLines: { color: chartSettings.gridColor, visible: chartSettings.showGrid },
        horzLines: { color: chartSettings.gridColor, visible: chartSettings.showGrid },
      },
      crosshair: {
        vertLine: { color: colors.crossLine, labelBackgroundColor: colors.crossLabel },
        horzLine: { color: colors.crossLine, labelBackgroundColor: colors.crossLabel },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border },
    });
    // the indicators that pick their colors from the background redraw with it
    setChartBackground(chartSettings.background);
    refreshIndicatorData(false);
  }, [ready, uiTheme, chartSettings.background, chartSettings.gridColor, chartSettings.showGrid]);

  useEffect(() => {
    const chart = engine.current.chart;
    if (!chart) return;
    const f = timeFormatters(timeZone, timeframe);
    chart.applyOptions({
      localization: { locale: LOCALE, timeFormatter: f.timeFormatter },
      timeScale: { tickMarkFormatter: f.tickMarkFormatter, timeVisible: !isDailyTf(timeframe), secondsVisible: timeframe.endsWith('T') },
    });
  }, [ready, timeZone, timeframe]);

  useEffect(() => {
    const chart = engine.current.chart;
    if (!chart) return;
    // a symbol compared in % puts the chart's scale in %, like TradingView
    const mode = compares.some((c) => c.visible && c.scale === 'percent') ? PriceScaleMode.Percentage : SCALE_MODE[priceScaleMode];
    chart.priceScale('right', 0).applyOptions({ mode });
  }, [ready, priceScaleMode, compares]);

  // chart style / colors -> recreate the main series
  const styleKey = `${chartSettings.candleStyle}|${chartSettings.upColor}|${chartSettings.downColor}|${chartSettings.wickUpColor}|${chartSettings.wickDownColor}|${chartSettings.borderUpColor}|${chartSettings.borderDownColor}`;
  const styleKeyRef = useRef(styleKey);
  useEffect(() => {
    const chart = engine.current.chart;
    if (!chart || styleKeyRef.current === styleKey) return;
    styleKeyRef.current = styleKey;
    if (engine.current.mainSeries) chart.removeSeries(engine.current.mainSeries);
    engine.current.mainSeries = makeMainSeries(chart, useStore.getState().chartSettings);
    applyPriceFormat();
    setMainData();
    alertLinesRef.current.clear();
    // overlay markers were attached to the old price series
    if (engine.current.candles.length) rebuildIndicators(); else applyPaneLayout();
    setSeriesGen((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  useEffect(() => {
    const onOnline = () => {
      const s = sessionRef.current?.source;
      if (s === 'local' || s === 'sim') setNetGen((n) => n + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // ---------- data loading on symbol / timeframe change ----------
  useEffect(() => {
    if (!ready) return;
    const token = ++loadTokenRef.current;
    const sym = useStore.getState().symbol;
    const tf = timeframe;
    unsubRef.current?.();
    unsubRef.current = null;
    sessionRef.current = null;
    const setFeedStatus = useChartUi.getState().setFeedStatus;
    setFeedStatus({ loading: true });
    openFeed(sym, tf, { estimate: true }).then(({ session, candles, fallbackReason }) => {
      if (token !== loadTokenRef.current) return;
      const e = engine.current;
      const chart = e.chart;
      if (!chart) return;
      sessionRef.current = session;
      fullRef.current = null;
      e.candles = candles;
      setChartSeries(sym, tf);
      e.precision = pricePrecision(sym, candles[candles.length - 1].close);
      applyPriceFormat();
      setMainData();
      e.mainSeries?.priceScale().applyOptions({ autoScale: true });
      goToRealTime();
      rebuildIndicators();
      // estimated bars left past the close: reload
      session.onReset = () => { if (sessionRef.current === session) setNetGen((n) => n + 1); };
      unsubRef.current = session.subscribe(onLiveBar, (meta) => reportQuote(sym.ticker, session.source, meta));
      if (!session.proxy) reportQuote(sym.ticker, session.source, { last: candles[candles.length - 1].close });
      setFeedStatus({ loading: false, source: session.source, label: session.label, realtime: session.realtime, estimated: session.estimated, error: fallbackReason });
      setSeriesGen((n) => n + 1);
      if (pendingRangeRef.current != null) void applyPendingRange();
      // a running replay keeps its date across symbol / timeframe changes
      const r = useChartUi.getState().replay;
      const at = r.at ?? r.time;
      if (r.mode === 'on' && at != null) void replayFrom(at);
    }).catch((err) => {
      if (token === loadTokenRef.current) setFeedStatus({ loading: false, error: String(err) });
    });
    return () => { unsubRef.current?.(); unsubRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, symbol.ticker, timeframe, netGen]);

  // structural indicator changes rebuild the series; size-only changes just re-layout
  const pineScripts = useStore((s) => s.pineScripts);
  // a strategy on the chart is redrawn when it is edited
  const strategyKey = useStore((s) => {
    const ids = s.indicators.filter((i) => i.type === 'STRATEGY').map((i) => i.strategyId);
    return s.strategies.filter((d) => ids.includes(d.id)).map((d) => `${d.id}:${d.updatedAt}`).join(',');
  });
  const structKey = useMemo(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    () => JSON.stringify(indicators.map(({ paneStretch, collapsed, ...rest }) => rest))
      // an edited Pine script redraws the indicators using it
      + pineScripts.map((p) => `${p.id}:${p.updatedAt}`).join(',') + strategyKey,
    [indicators, pineScripts, strategyKey],
  );
  const layoutKey = useMemo(
    () => JSON.stringify(indicators.map((i) => [i.id, i.paneStretch, i.collapsed])) + String(maximizedId),
    [indicators, maximizedId],
  );
  useEffect(() => {
    if (ready && engine.current.candles.length) rebuildIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, structKey]);
  useEffect(() => {
    if (ready) applyPaneLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, layoutKey]);

  useEffect(() => {
    if (ready) applyPaneLayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mainHidden]);

  // a new start bar replays from it; a chart tab shown again goes back to where
  // its replay stood (`at`)
  useEffect(() => {
    // while another symbol / timeframe loads, its data handler replays
    if (!ready || !engine.current.candles.length || !sessionRef.current) return;
    const r = useChartUi.getState().replay;
    if (r.mode === 'on' && r.time != null) void replayFrom(r.at ?? r.time);
    else exitReplayDisplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, replayMode, replayTime, replayJump]);

  useEffect(() => {
    if (replayMode !== 'on' || !replayPlaying) return;
    const id = setInterval(() => { if (!stepReplay()) clearInterval(id); }, 1000 / replaySpeed);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayMode, replayPlaying, replaySpeed]);

  // Maj + → : one bar forward, Échap : leave the start-bar selection
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const ui = useChartUi.getState();
      if ((ev.target as HTMLElement).closest('input, textarea, select')) return;
      if (ui.replay.mode === 'on' && ev.shiftKey && ev.key === 'ArrowRight') {
        ev.preventDefault();
        ui.setReplay({ playing: false });
        stepReplay();
      } else if (ui.replay.mode === 'select' && ev.key === 'Escape') {
        ui.setReplay({ mode: ui.replay.time != null ? 'on' : 'off' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a maximized pane that no longer exists is forgotten
  useEffect(() => {
    if (maximizedId && !indicators.some((i) => i.id === maximizedId)) useChartUi.getState().setMaximizedId(null);
  }, [indicators, maximizedId]);

  useEffect(() => {
    if (!rangeRequest) return;
    pendingRangeRef.current = rangeRequest.span;
    if (useStore.getState().timeframe !== rangeRequest.tf) useStore.getState().setTimeframe(rangeRequest.tf);
    else void applyPendingRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeRequest]);

  // ---------- strategy tester trades ----------
  const backtestResult = useChartUi((s) => s.backtest.result);
  // the strategy is on the chart as a legend item (type STRATEGY), which can be hidden or removed
  const showStrategy = useStore((s) => s.indicators.some((i) => i.type === 'STRATEGY' && i.visible && i.strategyId === s.activeStrategyId && shownOnTimeframe(i, s.timeframe)));
  const strategyMarksRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  useEffect(() => {
    try { strategyMarksRef.current?.detach(); } catch { /* series replaced */ }
    strategyMarksRef.current = null;
    const series = engine.current.mainSeries;
    const res = backtestResult;
    if (!series || !res || !showStrategy || res.ticker !== symbol.ticker || res.timeframe !== timeframe || res.strategyId !== useStore.getState().activeStrategyId) return;
    strategyMarksRef.current = createSeriesMarkers(series, strategyMarkers(res));
  }, [backtestResult, showStrategy, symbol.ticker, timeframe, seriesGen]);

  // ---------- price alerts as dashed price lines ----------
  useEffect(() => {
    const series = engine.current.mainSeries;
    if (!series) return;
    const lines = alertLinesRef.current;
    for (const [id, line] of lines) {
      const a = alerts.find((x) => x.id === id);
      if (!a || a.ticker !== symbol.ticker || a.triggered) {
        try { series.removePriceLine(line); } catch { /* series was replaced */ }
        lines.delete(id);
      }
    }
    for (const a of alerts) {
      if (a.ticker !== symbol.ticker || a.triggered || lines.has(a.id)) continue;
      lines.set(a.id, series.createPriceLine({
        price: a.price, color: '#f0b90b', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '🔔',
      }));
    }
  }, [alerts, symbol.ticker, seriesGen]);

  // ---------- compared symbols ("Comparer", 5 at most) ----------
  const compareRef = useRef<CompareOverlay | null>(null);
  useEffect(() => {
    const chart = engine.current.chart;
    if (!chart) return;
    // laid on the chart's whole history (the full one during a replay)
    const overlay = new CompareOverlay(chart, () => fullRef.current ?? engine.current.candles);
    compareRef.current = overlay;
    return () => { overlay.dispose(); compareRef.current = null; };
  }, [ready]);
  useEffect(() => { compareRef.current?.sync(compares, timeframe); }, [ready, compares, timeframe]);
  // the chart's bars changed (loaded, older history, a new bar): the compared ones follow
  const dataVersion = useChartUi((s) => s.dataVersion);
  useEffect(() => { compareRef.current?.realign(); }, [ready, dataVersion]);
  // during a replay they stop at the replay bar too
  const replayAt = useChartUi((s) => (s.replay.mode === 'on' ? s.replay.at : null));
  useEffect(() => { compareRef.current?.setLimit(replayAt); }, [ready, replayAt, compares]);

  return (
    <div
      className="chart-container" ref={containerRef}
      onDragOver={(e) => { if (isSymbolDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
      onDrop={(e) => {
        // a watchlist row dropped on the chart opens that symbol
        const sym = getDragSymbol(e);
        if (!sym) return;
        e.preventDefault();
        useStore.getState().setSymbol(sym);
      }}
    >
      <PaneOverlays engine={engine} containerRef={containerRef} />
      <PriceAxisCountdown engine={engine} />
      <DrawingLayer handles={engine} containerRef={containerRef} />
      <TradeMarks engine={engine} />
      <ChartEvents engine={engine} />
      <ChartTrading engine={engine} seriesGen={seriesGen} />
      <ReplayControls engine={engine} containerRef={containerRef} onStep={() => { stepReplay(); }} onRandom={() => { void replayRandom(); }} />
      {feedStatus.loading && <div className="chart-loading chart-ui"><span className="spinner" /> Chargement des données…</div>}
      {!feedStatus.loading && feedStatus.source === 'sim' && (
        <div className={`chart-banner chart-ui ${replayMode !== 'off' ? 'above-replay' : ''}`}>
          Données réelles indisponibles pour ce symbole / cette unité — affichage simulé
          {feedStatus.error && <small>{feedStatus.error}</small>}
        </div>
      )}
      {!feedStatus.loading && feedStatus.source === 'local' && (
        <div className={`chart-banner local chart-ui ${replayMode !== 'off' ? 'above-replay' : ''}`}>{feedStatus.error ?? 'Données enregistrées sur cet ordinateur (pas de temps réel).'}</div>
      )}
    </div>
  );
}
