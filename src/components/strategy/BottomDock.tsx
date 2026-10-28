import { useEffect } from 'react';
import { useStore, type BottomTab } from '../../store/store';
import StrategyEditor from './StrategyEditor';
import StrategyReport from './StrategyReport';
import PortfolioPanel from '../PortfolioPanel';
import ReplayTradingPanel from '../ReplayTradingPanel';
import OptionsReplayPanel from '../OptionsReplayPanel';
import { useOptionsReplay } from '../../store/optionsReplay';
import { useReplayTrading } from '../../store/replayTrading';

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'editor', label: 'Éditeur de stratégie' },
  { id: 'tester', label: 'Testeur de stratégie' },
  { id: 'trading', label: 'Trading virtuel' },
  { id: 'replay', label: 'Trading virtuel replay' },
  { id: 'options', label: 'Options replay' },
];

const ic = { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// TradingView's bottom panel: strategy editor, strategy tester and the virtual
// account, under the chart; resizable, foldable to its tab bar, or maximized
export default function BottomDock() {
  const dock = useStore((s) => s.bottomDock);
  const setDock = useStore((s) => s.setBottomDock);
  const positions = useStore((s) => s.paper.positions.length);
  const replayPositions = useReplayTrading((s) => s.account.positions.length);
  const optionPositions = useOptionsReplay((s) => s.positions.length);
  const open = dock.tab != null;
  const maximized = open && dock.maximized;

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, textarea, select')) setDock({ maximized: false }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized, setDock]);

  function onResizeDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY, startH = dock.height;
    const onMove = (ev: MouseEvent) => setDock({ height: Math.max(140, Math.min(window.innerHeight - 180, startH - (ev.clientY - startY))) });
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className={`bottom-dock ${open ? 'open' : ''} ${maximized ? 'maximized' : ''}`} style={open && !maximized ? { height: dock.height } : undefined}>
      {open && !maximized && <div className="bd-resize" onMouseDown={onResizeDown} title="Glisser pour redimensionner" />}
      <div className="bd-tabs">
        {TABS.map((t) => (
          <button
            key={t.id} className={`bd-tab ${dock.tab === t.id ? 'active' : ''}`}
            onClick={() => setDock({ tab: dock.tab === t.id ? null : t.id, ...(dock.tab === t.id ? { maximized: false } : {}) })}
          >
            {t.label}
            {t.id === 'trading' && positions > 0 && <span className="bd-badge">{positions}</span>}
            {t.id === 'replay' && replayPositions > 0 && <span className="bd-badge">{replayPositions}</span>}
            {t.id === 'options' && optionPositions > 0 && <span className="bd-badge">{optionPositions}</span>}
          </button>
        ))}
        <div className="bd-spacer" />
        {open ? (
          <>
            <button className="bd-icon" title={maximized ? 'Restaurer (Échap)' : 'Agrandir le panneau'} onClick={() => setDock({ maximized: !maximized })}>
              {maximized
                ? <svg {...ic}><path d="M5 1.5v3.5H1.5M9 1.5v3.5h3.5M5 12.5V9H1.5M9 12.5V9h3.5" /></svg>
                : <svg {...ic}><path d="M1.5 5V1.5H5M12.5 5V1.5H9M1.5 9v3.5H5M12.5 9v3.5H9" /></svg>}
            </button>
            <button className="bd-icon" title="Réduire le panneau" onClick={() => setDock({ tab: null, maximized: false })}>
              <svg {...ic}><path d="M3 5.5l4 4 4-4" /></svg>
            </button>
          </>
        ) : (
          <button className="bd-icon" title="Ouvrir le panneau" onClick={() => setDock({ tab: 'tester' })}>
            <svg {...ic}><path d="M3 8.5l4-4 4 4" /></svg>
          </button>
        )}
      </div>
      {open && (
        <div className="bd-content">
          {dock.tab === 'editor' && <StrategyEditor />}
          {dock.tab === 'tester' && <StrategyReport />}
          {dock.tab === 'trading' && <PortfolioPanel />}
          {dock.tab === 'replay' && <ReplayTradingPanel />}
          {dock.tab === 'options' && <OptionsReplayPanel />}
        </div>
      )}
    </div>
  );
}
