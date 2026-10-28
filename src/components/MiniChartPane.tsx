import { useEffect, useRef, useState } from 'react';
import {
  createChart, ColorType, CandlestickSeries,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { MiniIndicators } from './indicatorSeries';
import { COMPANION_EVENT } from '../indicators/companion';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { SYMBOLS } from '../data/symbols';
import { openFeed } from '../data/feeds';
import { chartColors, pricePrecision, timeFormatters, isDailyTf, type ChartEngine } from './chartUtils';
import { TIME_TIMEFRAMES, type Candle, type Timeframe } from '../types';
import { getDragSymbol, isSymbolDrag } from './symbolDnd';
import { openPopout } from './popouts';
import PaneOverlays from './PaneOverlays';
import { LOCALE } from '../i18n/lang';

const bar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

// A small chart of the 2 / 4 window layouts and of the free windows: its own symbol and
// timeframe, with the main chart's indicators and the same legends and controls (eye,
// settings, code, delete, pane up / down / collapse / maximize).
// The symbol and the timeframe are reported (onTickerChange / onTimeframeChange) so the layout keeps
// them: a free window or a 2 / 4 window chart comes back as it was after the layout changed.
export default function MiniChartPane({ initialTicker, initialTimeframe, onTickerChange, onTimeframeChange }: {
  initialTicker: string;
  initialTimeframe?: Timeframe;
  onTickerChange?: (t: string) => void;
  onTimeframeChange?: (tf: Timeframe) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // what the legends read, like the main chart's engine
  const engine = useRef<ChartEngine>({ chart: null, mainSeries: null, candles: [], indicators: [], precision: 2 });
  const indRef = useRef<MiniIndicators | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [version, setVersion] = useState(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  // a maximized indicator pane, on this chart only
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const maximizedRef = useRef<string | null>(null);
  maximizedRef.current = maximizedId;
  const indicators = useStore((s) => s.indicators);
  const chartSettings = useStore((s) => s.chartSettings);
  const uiTheme = useStore((s) => s.uiTheme);
  const timeZone = useStore((s) => s.timeZone);
  const watchlists = useStore((s) => s.watchlists);
  const mainSymbol = useStore((s) => s.symbol);
  const [ticker, setTicker] = useState(initialTicker);
  // its own timeframe if it has one, else the main chart's when a small chart can show it
  const [timeframe, setTimeframe] = useState<Timeframe>(() => {
    const ok = (tf?: Timeframe) => !!tf && (TIME_TIMEFRAMES as readonly Timeframe[]).includes(tf);
    if (ok(initialTimeframe)) return initialTimeframe!;
    const tf = useStore.getState().timeframe;
    return ok(tf) ? tf : '15m';
  });
  const changeTimeframe = (tf: Timeframe) => { setTimeframe(tf); onTimeframeChange?.(tf); };
  // a chart opened on the main timeframe keeps it from now on
  useEffect(() => {
    if (initialTimeframe !== timeframe) onTimeframeChange?.(timeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // read by the resize observer, set up once
  const tfRef = useRef(timeframe);
  tfRef.current = timeframe;
  const [source, setSource] = useState('');
  const [dropHint, setDropHint] = useState(false);
  // "Cacher" of the symbol menu: this chart's candles hidden, its indicators kept
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const changeTicker = (t: string) => { setTicker(t); onTickerChange?.(t); };

  // symbols from the built-in list plus anything added to a watchlist from the search
  const known = new Map(SYMBOLS.map((s) => [s.ticker, s]));
  for (const t of watchlists) for (const r of t.items) if (r.kind === 'asset' && !known.has(r.data.ticker)) known.set(r.data.ticker, r.data);
  if (!known.has(mainSymbol.ticker)) known.set(mainSymbol.ticker, mainSymbol);
  const symbol = known.get(ticker);

  // pane heights, collapsed / maximized panes and hidden indicators, as on the main chart
  const layout = () => {
    const el = containerRef.current;
    if (!el || !indRef.current) return;
    indRef.current.layout(el.clientHeight, tfRef.current, maximizedRef.current, useStore.getState().indicators);
    if (hiddenRef.current) seriesRef.current?.applyOptions({ visible: false });
  };

  useEffect(() => {
    // layout() shows the candles again unless their pane is taken by a maximized indicator
    layout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  // "⛶": this chart alone and big in the main window (1 window), the layout kept to come back to
  const showBig = () => {
    if (!symbol) return;
    const st = useStore.getState();
    useChartUi.getState().setReturnLayout(st.layout === 1 ? null : st.layout);
    st.setSymbol(symbol);
    st.setTimeframe(timeframe);
    st.setLayout(1);
  };

  // the symbol menu (right-click, or "•••" in the legend) on this chart's own symbol and price
  const openMenu = (x: number, y: number) => {
    if (!symbol) return;
    const k = engine.current.candles;
    const last = k[k.length - 1];
    useChartUi.getState().setSymbolMenu({
      x, y,
      target: { symbol, timeframe, price: last ? { price: last.close, precision: engine.current.precision } : null, hidden, setHidden },
    });
  };

  useEffect(() => {
    const el = containerRef.current!;
    const colors = chartColors(useStore.getState().uiTheme);
    const s = useStore.getState().chartSettings;
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: s.background }, textColor: colors.text, fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: s.gridColor }, horzLines: { color: s.gridColor } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      width: el.clientWidth,
      height: el.clientHeight,
    });
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: s.upColor, downColor: s.downColor,
      borderUpColor: s.borderUpColor ?? s.upColor, borderDownColor: s.borderDownColor ?? s.downColor,
      wickUpColor: s.wickUpColor, wickDownColor: s.wickDownColor,
    }, 0);
    chartRef.current = chart;
    engine.current.chart = chart;
    engine.current.mainSeries = seriesRef.current;
    indRef.current = new MiniIndicators(chart, () => seriesRef.current, () => engine.current.candles);
    // the legends show the values under this chart's crosshair
    chart.subscribeCrosshairMove((param) => setHoverTime(param.time != null && param.point ? (param.time as number) : null));
    const ro = new ResizeObserver(() => { chart.resize(el.clientWidth, el.clientHeight); layout(); });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      chart.remove();
      chartRef.current = null; seriesRef.current = null; indRef.current = null;
      engine.current = { chart: null, mainSeries: null, candles: [], indicators: [], precision: 2 };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const colors = chartColors(uiTheme);
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: chartSettings.background }, textColor: colors.text },
      grid: { vertLines: { color: chartSettings.gridColor }, horzLines: { color: chartSettings.gridColor } },
    });
    seriesRef.current?.applyOptions({
      upColor: chartSettings.upColor, downColor: chartSettings.downColor,
      borderUpColor: chartSettings.borderUpColor ?? chartSettings.upColor, borderDownColor: chartSettings.borderDownColor ?? chartSettings.downColor,
      wickUpColor: chartSettings.wickUpColor, wickDownColor: chartSettings.wickDownColor,
    });
  }, [uiTheme, chartSettings]);

  useEffect(() => {
    const f = timeFormatters(timeZone, timeframe);
    chartRef.current?.applyOptions({
      localization: { locale: LOCALE, timeFormatter: f.timeFormatter },
      timeScale: { tickMarkFormatter: f.tickMarkFormatter, timeVisible: !isDailyTf(timeframe) },
    });
  }, [timeZone, timeframe]);

  // the main chart's indicators, built on this chart's own bars
  const drawIndicators = () => {
    if (!symbol || !indRef.current) return;
    indRef.current.rebuild(useStore.getState().indicators, symbol, timeframe, engine.current.precision);
    engine.current.indicators = indRef.current.runtimes;
    layout();
    setVersion((v) => v + 1);
  };
  const refreshIndicators = (lastOnly: boolean) => {
    if (symbol && indRef.current?.count) indRef.current.refresh(symbol, timeframe, lastOnly);
    setVersion((v) => v + 1);
  };

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    let off: (() => void) | null = null;
    setSource('…');
    engine.current.candles = [];
    indRef.current?.clear();
    engine.current.indicators = [];
    setVersion((v) => v + 1);
    openFeed(symbol, timeframe, { estimate: true }).then(({ session, candles }) => {
      const series = seriesRef.current;
      if (cancelled || !series) return;
      const p = pricePrecision(symbol, candles[candles.length - 1].close);
      engine.current.precision = p;
      series.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: 1 / 10 ** p } });
      series.setData(candles.map(bar));
      engine.current.candles = candles.slice();
      drawIndicators();
      chartRef.current?.timeScale().scrollToRealTime();
      setSource(session.label);
      off = session.subscribe((c) => {
        const list = engine.current.candles, last = list[list.length - 1];
        // an older bar: a correction, or an estimated CME bar replaced by the real one
        const older = !!last && c.time < last.time;
        try { series.update(bar(c), older); } catch { return; /* a bar the chart doesn't have */ }
        if (older) { const i = list.findIndex((x) => x.time === c.time); if (i >= 0) list[i] = c; }
        else if (last && last.time === c.time) list[list.length - 1] = c; else list.push(c);
        // indicators follow the live bar, a few times a second at most
        if (!refreshTimer.current) refreshTimer.current = setTimeout(() => { refreshTimer.current = null; refreshIndicators(true); }, 500);
      });
    });
    return () => { cancelled = true; off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, timeframe]);

  // indicators added, removed or set on any chart (they are shared with the main chart)
  useEffect(() => {
    if (engine.current.candles.length) drawIndicators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicators]);

  useEffect(() => {
    layout();
    setVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maximizedId]);

  // another symbol's bars an indicator needed have arrived (the future of a cash index...)
  useEffect(() => {
    const redraw = () => refreshIndicators(false);
    window.addEventListener(COMPANION_EVENT, redraw);
    return () => window.removeEventListener(COMPANION_EVENT, redraw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, timeframe]);

  return (
    <div
      className={`mini-chart-pane ${dropHint ? 'drop-target' : ''}`}
      onDragOver={(e) => { if (isSymbolDrag(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setDropHint(true); } }}
      onDragLeave={() => setDropHint(false)}
      onDrop={(e) => {
        setDropHint(false);
        const sym = getDragSymbol(e);
        if (!sym) return;
        e.preventDefault();
        e.stopPropagation();
        changeTicker(sym.ticker);
      }}
    >
      <div className="mini-chart-header">
        <select value={ticker} onChange={(e) => changeTicker(e.target.value)}>
          {[...known.values()].map((s) => <option key={s.ticker} value={s.ticker}>{s.ticker}</option>)}
        </select>
        <select value={timeframe} onChange={(e) => changeTimeframe(e.target.value as Timeframe)}>
          {TIME_TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
        </select>
        <span className="mini-chart-source">{source}</span>
        <button
          className="remove-btn mini-big" title="Afficher en grand dans la fenêtre principale (mode 1 fenêtre), avec son actif et son unité de temps"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={showBig}
        >
          ⛶
        </button>
        <button
          className="remove-btn mini-detach" title="Ouvrir dans une vraie fenêtre (déplaçable sur un autre écran)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => { if (symbol) openPopout(symbol, timeframe); }}
        >
          ↗
        </button>
      </div>
      <div
        className="mini-chart-body"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('input, textarea, select, button')) return;
          e.preventDefault();
          openMenu(e.clientX, e.clientY);
        }}
      >
        <div className="mini-chart-canvas" ref={containerRef} />
        {symbol && (
          <PaneOverlays
            engine={engine}
            containerRef={containerRef}
            mini={{ symbol, timeframe, source, hoverTime, maximizedId, setMaximizedId, version, hidden, openMenu }}
          />
        )}
      </div>
    </div>
  );
}
