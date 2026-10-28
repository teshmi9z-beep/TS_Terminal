import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { getIndicatorDef, indicatorTitle, valueAt } from '../indicators/registry';
import { isSeriesPlot } from '../indicators/types';
import { mainChart } from './mainChart';
import { formatPrice, formatVolume, indexAtOrBefore, timeFormatters } from './chartUtils';
import PanelControls from './PanelControls';

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return <div className="dw-row"><span>{k}</span><b style={color ? { color } : undefined}>{v}</b></div>;
}

// TradingView's "Fenêtre de données": every value of the bar under the crosshair
export default function DataWindow() {
  const hoverTime = useChartUi((s) => s.hoverTime);
  useChartUi((s) => s.dataVersion);
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const timeZone = useStore((s) => s.timeZone);
  useStore((s) => s.indicators);

  const e = mainChart.engine;
  const candles = e?.candles ?? [];
  const idx = candles.length ? (hoverTime != null ? indexAtOrBefore(candles, hoverTime) : candles.length - 1) : -1;
  const bar = idx >= 0 ? candles[idx] : null;
  const prev = idx > 0 ? candles[idx - 1] : null;
  const p = e?.precision ?? 2;

  if (!e || !bar) return <div className="side-panel"><div className="side-title with-ctl">Fenêtre de données<PanelControls /></div><div className="side-empty">Aucune donnée (graphique principal uniquement).</div></div>;

  const change = prev ? bar.close - prev.close : 0;
  const pct = prev ? (change / prev.close) * 100 : 0;
  const date = timeFormatters(timeZone, timeframe).timeFormatter(bar.time as never);

  return (
    <div className="side-panel">
      <div className="side-title with-ctl">Fenêtre de données<PanelControls /></div>
      <div className="dw-block">
        <div className="dw-head">{symbol.ticker} · {timeframe}</div>
        <Row k="Date" v={date} />
        <Row k="Ouverture" v={formatPrice(bar.open, p)} />
        <Row k="Plus haut" v={formatPrice(bar.high, p)} />
        <Row k="Plus bas" v={formatPrice(bar.low, p)} />
        <Row k="Clôture" v={formatPrice(bar.close, p)} />
        <Row k="Variation" v={`${change >= 0 ? '+' : ''}${formatPrice(change, p)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`} color={change >= 0 ? 'var(--up)' : 'var(--down)'} />
        <Row k="Volume" v={formatVolume(bar.volume)} />
      </div>
      {e.indicators.map((rt) => {
        const def = getIndicatorDef(rt.cfg);
        const plots = rt.plots.filter(isSeriesPlot);
        if (!plots.length) return null;
        return (
          <div key={rt.cfg.id} className="dw-block">
            <div className="dw-head">{indicatorTitle(rt.cfg)}</div>
            {plots.map((pl) => {
              const v = valueAt(pl.data, bar.time);
              return (
                <Row
                  key={pl.key} k={pl.name} color={v?.color ?? pl.color}
                  v={v && Number.isFinite(v.value) ? (def?.volumeFormat ? formatVolume(v.value) : formatPrice(v.value, def?.overlay ? p : 2)) : '—'}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
