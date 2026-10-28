import { useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { barCloseTime, formatCountdown, isDailyTf, type ChartEngine } from './chartUtils';

// time left in the current bar, drawn under the last-price label like TradingView.
// Positioned every frame straight on the DOM node so panning stays smooth.
export default function PriceAxisCountdown({ engine }: { engine: RefObject<ChartEngine> }) {
  const ref = useRef<HTMLDivElement>(null);
  const timeframe = useStore((s) => s.timeframe);
  const upColor = useStore((s) => s.chartSettings.upColor);
  const downColor = useStore((s) => s.chartSettings.downColor);
  const source = useChartUi((s) => s.feedStatus.source);
  const replaying = useChartUi((s) => s.replay.mode === 'on');
  const wanted = useStore((s) => s.chartSettings.showCountdown !== false);
  // daily+ bars of session-based markets close with the exchange session, not at
  // midnight, so only 24/7 crypto gets a countdown on those timeframes
  const enabled = wanted && !replaying && (!isDailyTf(timeframe) || source === 'binance');

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      const e = engine.current;
      const chart = e.chart;
      const series = e.mainSeries;
      const last = e.candles[e.candles.length - 1];
      let shown = false;
      // shown even when the price series is hidden (e.g. only the HA candles are displayed)
      if (enabled && el && chart && series && last) {
        const close = barCloseTime(timeframe, last.time);
        const remaining = close == null ? -1 : close - Date.now() / 1000;
        const y = series.priceToCoordinate(last.close);
        const paneH = chart.panes()[0]?.getHeight() ?? 0;
        // a bar whose close time already passed means the market is closed
        if (remaining > 0 && y != null && y > 0 && y < paneH - 22) {
          shown = true;
          el.style.display = 'block';
          el.style.top = `${y + 10}px`;
          el.style.left = `${chart.paneSize(0).width + 1}px`;
          el.style.width = `${Math.max(0, chart.priceScale('right').width() - 1)}px`;
          el.style.background = last.close >= last.open ? upColor : downColor;
          const text = formatCountdown(remaining);
          if (el.textContent !== text) el.textContent = text;
        }
      }
      if (el && !shown) el.style.display = 'none';
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, timeframe, upColor, downColor, enabled]);

  return <div ref={ref} className="price-countdown" />;
}
