import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import MiniChartPane from './MiniChartPane';

// The 2 / 4 window layouts. Each chart keeps its symbol and timeframe (gridCharts): leaving the
// layout (a chart shown big with "⛶", or 1 window) and coming back finds them as they were. A chart
// never set opens on the main symbol (the first one), ETH, EUR/USD or gold.
export default function MultiChartGrid() {
  const layout = useStore((s) => s.layout);
  const grid = useStore((s) => s.gridCharts);
  const setGridChart = useStore((s) => s.setGridChart);
  const [defaults] = useState(() => [useStore.getState().symbol.ticker, 'ETHUSD', 'EURUSD', 'XAUUSD']);
  const n = layout === 4 ? 4 : 2;

  // the charts shown get their symbol written down, so they don't follow the main one later
  useEffect(() => {
    const st = useStore.getState();
    for (let i = 0; i < n; i++) if (!st.gridCharts[i]?.ticker) st.setGridChart(i, { ticker: defaults[i] });
  }, [n, defaults]);

  return (
    <div className={`multi-chart-grid grid-${n}`}>
      {Array.from({ length: n }, (_, i) => (
        <MiniChartPane
          key={i}
          initialTicker={grid[i]?.ticker ?? defaults[i]}
          initialTimeframe={grid[i]?.tf}
          onTickerChange={(t) => setGridChart(i, { ticker: t })}
          onTimeframeChange={(tf) => setGridChart(i, { tf })}
        />
      ))}
    </div>
  );
}
