import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { TIME_TIMEFRAMES, type Timeframe } from '../types';
import { useKept } from './kept';
import MiniChartPane from './MiniChartPane';
import { GRID_ACTIVE_KEY } from './tabs/tabActions';

// The 2, 3, 4 and 6 window layouts (3: two above, one as wide as both below). Each chart keeps its symbol and timeframe (gridCharts): leaving the
// layout (a chart shown big with "⛶", or 1 window) and coming back finds them as they were. A chart
// never set opens on the main symbol (the first one), ETH, EUR/USD, gold, the Nasdaq or the DAX.
// The active chart (outlined: the first, else the last one clicked) takes the symbol picked in the
// lists (watchlist, IG markets, search) and the timeframe of the top bar, like TradingView.
export default function MultiChartGrid() {
  const layout = useStore((s) => s.layout);
  const grid = useStore((s) => s.gridCharts);
  const setGridChart = useStore((s) => s.setGridChart);
  const [defaults] = useState(() => [useStore.getState().symbol.ticker, 'ETHUSD', 'EURUSD', 'XAUUSD', 'US100', 'DE40']);
  const n = typeof layout === 'number' && layout > 1 ? layout : 2;
  const [kept, setActive] = useKept(GRID_ACTIVE_KEY, 0);
  const active = kept < n ? kept : 0;
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  // the charts shown get their symbol written down, so they don't follow the main one later
  useEffect(() => {
    const st = useStore.getState();
    for (let i = 0; i < n; i++) if (!st.gridCharts[i]?.ticker) st.setGridChart(i, { ticker: defaults[i] });
  }, [n, defaults]);

  // a symbol or a timeframe picked elsewhere goes to the active chart
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.layout === 1 || s.layout === 'free') return;
    if (s.symbol.ticker !== prev.symbol.ticker) s.setGridChart(activeRef.current, { ticker: s.symbol.ticker, symbol: s.symbol });
    if (s.timeframe !== prev.timeframe && (TIME_TIMEFRAMES as readonly Timeframe[]).includes(s.timeframe)) s.setGridChart(activeRef.current, { tf: s.timeframe });
  }), []);

  return (
    <div className={`multi-chart-grid grid-${n}`}>
      {Array.from({ length: n }, (_, i) => (
        <MiniChartPane
          key={i}
          initialTicker={grid[i]?.ticker ?? defaults[i]}
          initialSymbol={grid[i]?.symbol}
          initialTimeframe={grid[i]?.tf}
          initialStyle={grid[i]?.style}
          onTickerChange={(t, sym) => setGridChart(i, { ticker: t, symbol: sym })}
          onTimeframeChange={(tf) => setGridChart(i, { tf })}
          onStyleChange={(style) => setGridChart(i, { style })}
          active={i === active}
          onActivate={() => setActive(i)}
        />
      ))}
    </div>
  );
}
