import { useStore } from '../store/store';
import { useChartUi, type RangeSpan } from '../store/chartUi';
import { mainChart } from './mainChart';
import ClockWidget from './ClockWidget';
import type { Timeframe } from '../types';

const DAY = 86400;

// TradingView's date-range shortcuts: each picks a sensible resolution and zooms to the span
const RANGES: { label: string; tf: Timeframe; span: RangeSpan; title: string }[] = [
  { label: '1J', tf: '1m', span: DAY, title: '1 jour (1 minute)' },
  { label: '5J', tf: '5m', span: 5 * DAY, title: '5 jours (5 minutes)' },
  { label: '1M', tf: '30m', span: 30 * DAY, title: '1 mois (30 minutes)' },
  { label: '3M', tf: '1h', span: 91 * DAY, title: '3 mois (1 heure)' },
  { label: '6M', tf: '4h', span: 182 * DAY, title: '6 mois (4 heures)' },
  { label: 'YTD', tf: '1D', span: 'ytd', title: 'Depuis le début de l’année (jour)' },
  { label: '1A', tf: '1D', span: 365 * DAY, title: '1 an (jour)' },
  { label: '5A', tf: '1W', span: 5 * 365 * DAY, title: '5 ans (semaine)' },
  { label: 'Tout', tf: '1M', span: 'all', title: 'Tout l’historique (mois)' },
];

export default function BottomBar() {
  const requestRange = useChartUi((s) => s.requestRange);
  const autoScale = useChartUi((s) => s.autoScale);
  const priceScaleMode = useStore((s) => s.priceScaleMode);
  const setPriceScaleMode = useStore((s) => s.setPriceScaleMode);

  function enableAutoScale() {
    mainChart.engine?.mainSeries?.priceScale().applyOptions({ autoScale: true });
    useChartUi.getState().setAutoScale(true);
  }

  return (
    <div className="bottom-bar">
      <div className="bb-ranges">
        {RANGES.map((r) => (
          <button key={r.label} className="bb-btn" title={r.title} onClick={() => requestRange(r.tf, r.span)}>{r.label}</button>
        ))}
      </div>
      <div className="bb-spacer" />
      <ClockWidget />
      <div className="bb-sep" />
      <button
        className={`bb-btn ${priceScaleMode === 'percent' ? 'active' : ''}`} title="Échelle en pourcentage"
        onClick={() => setPriceScaleMode(priceScaleMode === 'percent' ? 'normal' : 'percent')}
      >%</button>
      <button
        className={`bb-btn ${priceScaleMode === 'log' ? 'active' : ''}`} title="Échelle logarithmique"
        onClick={() => setPriceScaleMode(priceScaleMode === 'log' ? 'normal' : 'log')}
      >log</button>
      <button className={`bb-btn ${autoScale ? 'active' : ''}`} title="Échelle automatique" onClick={enableAutoScale}>auto</button>
    </div>
  );
}
