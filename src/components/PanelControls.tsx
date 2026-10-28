import { useStore, type RightPanelId } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { usePanelMode } from './panelMode';

const ic = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// like TradingView's widget headers: full screen and close, at the top right of a
// right-bar module (the watchlist docked on the left only has "close").
// `panel`: 'trading' for the order ticket; the other panels, when the ticket is
// open, are the one next to it and close (or go full screen) without it
export default function PanelControls({ left = false, panel }: { left?: boolean; panel?: RightPanelId }) {
  const setPanel = useStore((s) => s.setRightPanel);
  const setLeftOpen = useStore((s) => s.setLeftWatchlistOpen);
  const full = useChartUi((s) => s.rightFullscreen);
  const setFull = useChartUi((s) => s.setRightFullscreen);
  // a module opened as a tab page has no panel controls (the tab closes it)
  if (usePanelMode() === 'page') return null;
  return (
    <span className="panel-ctl">
      {!left && (
        <button
          className="panel-ctl-btn" title={full ? 'Quitter le plein écran (Échap)' : 'Plein écran'}
          onClick={() => {
            const st = useStore.getState();
            // the panel next to the ticket takes the whole side (the ticket closes)
            if (!full && st.rightPanel === 'trading' && panel !== 'trading' && st.rightPanelBeside) { setPanel(st.rightPanelBeside); st.setRightPanelBeside(null); }
            setFull(!full);
          }}
        >
          {full
            ? <svg {...ic}><path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /></svg>
            : <svg {...ic}><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" /></svg>}
        </button>
      )}
      <button
        className="panel-ctl-btn" title="Fermer"
        onClick={() => {
          if (left) { setLeftOpen(false); return; }
          const st = useStore.getState();
          setFull(false);
          if (st.rightPanel === 'trading' && panel === 'trading') st.toggleTradingPanel();
          else if (st.rightPanel === 'trading') st.setRightPanelBeside(null);
          else setPanel(null);
        }}
      >
        <svg {...ic}><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
      </button>
    </span>
  );
}
