import { useEffect, type ReactElement } from 'react';
import { useStore, type RightPanelId } from '../store/store';
import { useChartUi } from '../store/chartUi';
import Watchlist from './Watchlist';
import AlertsSidePanel from './AlertsSidePanel';
import DataWindow from './DataWindow';
import Screener from './Screener';
import PineEditor from './PineEditor';
import TradingPanel from './TradingPanel';
import YieldCurves from './YieldCurves';
import MacroMap from './MacroMap';

const ic = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// the order ticket ('trading') opens from the top bar's "Trader" button, not from here
const PANELS: { id: RightPanelId; label: string; icon: ReactElement }[] = [
  { id: 'watchlist', label: 'Liste de surveillance', icon: <svg {...ic}><path d="M5 6h14M5 12h14M5 18h9" /><circle cx="18.5" cy="18" r="1.5" /></svg> },
  { id: 'alerts', label: 'Alertes', icon: <svg {...ic}><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.5 1.5M4 5l3-2.5M20 5l-3-2.5" /></svg> },
  { id: 'data', label: 'Fenêtre de données', icon: <svg {...ic}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M4 14h16M10 9v11" /></svg> },
  { id: 'screener', label: 'Screener', icon: <svg {...ic}><path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" /></svg> },
  { id: 'pine', label: 'Éditeur Pine', icon: <svg {...ic}><path d="M3 19l6-9 4 5 3-4 5 8z" /><path d="M9 10l1.5-2.5" /></svg> },
  { id: 'yields', label: 'Courbes de rendement', icon: <svg {...ic}><path d="M4 4v16h16" /><path d="M7 16.5c1.5-4.5 4-7.5 12-9" /><circle cx="7" cy="16.5" r="1" /><circle cx="12" cy="10.5" r="1" /><circle cx="19" cy="7.5" r="1" /></svg> },
  { id: 'macro', label: 'Macro Maps', icon: <svg {...ic}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.3 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.3-3.5-8.5s1-6 3.5-8.5z" /></svg> },
];

// wider panels need room for their columns / code
const MIN_WIDTH: Partial<Record<RightPanelId, number>> = { screener: 460, pine: 480, trading: 330, data: 260, yields: 400, macro: 380 };

// TradingView's right "widget bar": a thin icon strip that opens one panel at a time
export default function RightSidebar() {
  const panel = useStore((s) => s.rightPanel);
  const setPanel = useStore((s) => s.setRightPanel);
  const besidePanel = useStore((s) => s.rightPanelBeside);
  const setBeside = useStore((s) => s.setRightPanelBeside);
  const width = useStore((s) => s.watchlistWidth);
  const setWidth = useStore((s) => s.setWatchlistWidth);
  const alertsCount = useStore((s) => s.alerts.filter((a) => !a.triggered).length);
  const watchlistSide = useStore((s) => s.watchlistSide);
  const leftOpen = useStore((s) => s.leftWatchlistOpen);
  const setLeftOpen = useStore((s) => s.setLeftWatchlistOpen);
  const fullscreen = useChartUi((s) => s.rightFullscreen);
  const setFullscreen = useChartUi((s) => s.setRightFullscreen);
  // the watchlist docked on the left is not shown here
  const shown = panel === 'watchlist' && watchlistSide === 'left' ? null : panel;
  const isFull = fullscreen && shown != null;
  // the order ticket shows next to the panel that was open when it opened (the ticket alone when none was)
  const beside = shown === 'trading' && !isFull && besidePanel && besidePanel !== 'trading' && !(besidePanel === 'watchlist' && watchlistSide === 'left') ? besidePanel : null;
  const ticketAside = beside != null;
  const main = beside ?? shown;

  useEffect(() => {
    if (!shown && fullscreen) setFullscreen(false);
  }, [shown, fullscreen, setFullscreen]);

  useEffect(() => {
    if (!isFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, textarea, select')) setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFull, setFullscreen]);

  function onResizeDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const onMove = (ev: MouseEvent) => setWidth(startW - (ev.clientX - startX));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className="right-area">
      {ticketAside && (
        <div className="right-panel ticket-aside" style={{ width: MIN_WIDTH.trading }}>
          <TradingPanel />
        </div>
      )}
      {main && (
        <div className={`right-panel ${isFull ? 'fullscreen' : ''}`} style={isFull ? undefined : { width: Math.max(width, MIN_WIDTH[main] ?? 0) }}>
          {!isFull && <div className="watchlist-resize-handle" onMouseDown={onResizeDown} />}
          {main === 'watchlist' && <Watchlist />}
          {main === 'alerts' && <AlertsSidePanel />}
          {main === 'data' && <DataWindow />}
          {main === 'screener' && <Screener />}
          {main === 'pine' && <PineEditor />}
          {main === 'trading' && <TradingPanel />}
          {main === 'yields' && <YieldCurves />}
          {main === 'macro' && <MacroMap />}
        </div>
      )}
      <div className="right-strip">
        {PANELS.map((p) => {
          const leftWl = p.id === 'watchlist' && watchlistSide === 'left';
          const active = leftWl ? leftOpen : panel === p.id || (panel === 'trading' && beside === p.id);
          return (
            <button
              key={p.id} className={`rs-btn ${active ? 'active' : ''}`}
              data-tip={leftWl ? `${p.label} (à gauche)` : p.label} aria-label={p.label}
              // with the order ticket open, a panel opens (or closes) next to it
              onClick={() => (leftWl ? setLeftOpen(!leftOpen) : panel === 'trading' && !isFull ? setBeside(beside === p.id ? null : p.id) : setPanel(panel === p.id ? null : p.id))}
            >
              {p.icon}
              {p.id === 'alerts' && alertsCount > 0 && <span className="rs-badge">{alertsCount}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
