import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { currentPrice, addAlertAtPrice, addTextNote } from './symbolActions';
import { GearIcon } from './GearIcon';
import { openPopout } from './popouts';

const ic = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function Item({ icon, label, shortcut, onClick, children }: {
  icon?: ReactNode; label: string; shortcut?: string; onClick?: () => void; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sm-item" onClick={onClick} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="sm-icon">{icon}</span>
      <span className="sm-label">{label}</span>
      {shortcut && <span className="sm-shortcut">{shortcut}</span>}
      {children && <span className="sm-arrow">›</span>}
      {children && open && <div className="sm-sub">{children}</div>}
    </div>
  );
}

// TradingView's symbol "..." menu (also opened by a right-click on the chart). On a small chart
// (2 / 4 windows, free windows) it acts on that chart's symbol, price and series.
export default function SymbolMenu() {
  const pos = useChartUi((s) => s.symbolMenu);
  const setSymbolMenu = useChartUi((s) => s.setSymbolMenu);
  const openDialog = useChartUi((s) => s.openDialog);
  const mainHidden = useChartUi((s) => s.mainHidden);
  const setMainHidden = useChartUi((s) => s.setMainHidden);
  const showToast = useChartUi((s) => s.showToast);
  const openSymbolInfo = useChartUi((s) => s.openSymbolInfo);
  const mainSymbol = useStore((s) => s.symbol);
  const addAlert = useStore((s) => s.addAlert);
  const watchlists = useStore((s) => s.watchlists);
  const addToWatchlistTab = useStore((s) => s.addToWatchlistTab);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // keep the menu inside the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!pos || !el) return;
    const r = el.getBoundingClientRect();
    setPlace({
      left: Math.max(4, Math.min(pos.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(pos.y, window.innerHeight - r.height - 4)),
    });
  }, [pos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSymbolMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSymbolMenu]);

  if (!pos) return null;
  const target = pos.target;
  const symbol = target?.symbol ?? mainSymbol;
  const cur = target ? target.price : currentPrice();
  const hidden = target ? target.hidden : mainHidden;
  const priceTxt = cur ? cur.price.toFixed(cur.precision) : '—';
  const t = symbol.ticker;
  const run = (fn: () => void) => () => { setSymbolMenu(null); fn(); };
  const alertHere = () => {
    if (!cur) return;
    addAlert(t, +cur.price.toFixed(cur.precision), symbol);
    showToast(`🔔 Alerte créée sur ${t} à ${priceTxt}`);
  };

  return (
    <>
      <div className="sm-backdrop" onMouseDown={() => setSymbolMenu(null)} onContextMenu={(e) => { e.preventDefault(); setSymbolMenu(null); }} />
      <div
        ref={ref} className="symbol-menu"
        style={place ? { left: place.left, top: place.top } : { left: pos.x, top: pos.y, visibility: 'hidden' }}
      >
        <Item icon={<svg {...ic}><circle cx="9" cy="10" r="6" /><path d="M9 7v3l2 1.5M3 3.5l2-1.5M15 3.5l-2-1.5" /></svg>}
          label={`Ajouter une alerte sur ${t} à ${priceTxt}`} shortcut={target ? undefined : 'Alt + A'} onClick={run(target ? alertHere : addAlertAtPrice)} />
        <Item icon={<svg {...ic}><path d="M2 14l4-5 3 3 4-6 3 3" /><path d="M13 2v4M11 4h4" /></svg>}
          label={`Ajouter un indicateur à ${t}…`} onClick={run(() => openDialog('indicators'))} />
        <div className="sm-sep" />
        <Item icon={<svg {...ic}><circle cx="9" cy="9" r="6.5" /><path d="M9 8v4.5M9 5.5v.5" /></svg>}
          label="Info du symbole…" onClick={run(() => (target ? openSymbolInfo(symbol) : openDialog('symbolInfo')))} />
        <div className="sm-sep" />
        <Item label={`Copier le prix ${priceTxt}`} onClick={run(() => {
          if (!cur) return;
          void navigator.clipboard.writeText(priceTxt).then(() => showToast(`Prix copié : ${priceTxt}`));
        })} />
        <div className="sm-sep" />
        <Item icon={hidden
          ? <svg {...ic}><path d="M1.5 9s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" /><circle cx="9" cy="9" r="2.2" /></svg>
          : <svg {...ic}><path d="M1.5 9s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z" /><path d="M3 15L15 3" /></svg>}
          label={hidden ? 'Afficher la série' : 'Cacher'} onClick={run(() => (target ? target.setHidden(!hidden) : setMainHidden(!hidden)))} />
        <div className="sm-sep" />
        <Item icon={<svg {...ic}><path d="M3 4h9M3 8h9M3 12h5M13 10v6M10 13h6" /></svg>} label={`Ajouter ${t} à la watchlist`}>
          {watchlists.map((w) => {
            const has = w.items.some((r) => r.kind === 'asset' && r.data.ticker === t);
            return (
              <div
                key={w.id} className={`sm-item ${has ? 'disabled' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (has) return;
                  addToWatchlistTab(w.id, symbol);
                  setSymbolMenu(null);
                  showToast(`${t} ajouté à « ${w.name} »`);
                }}
              >
                <span className="sm-icon">{has ? '✓' : ''}</span>
                <span className="sm-label">{w.name}</span>
              </div>
            );
          })}
        </Item>
        <Item icon={<svg {...ic}><path d="M10 3h5v5M15 3l-7 7" /><path d="M13 11v4H3V5h4" /></svg>}
          label="Ouvrir dans une nouvelle fenêtre" onClick={run(() => openPopout(symbol, target?.timeframe ?? useStore.getState().timeframe))} />
        {/* the small charts don't draw the drawings: a note is for the main chart */}
        {!target && (
          <Item icon={<svg {...ic}><path d="M3 3h12v9l-3 3H3z" /><path d="M12 15v-3h3M6 7h6M6 10h4" /></svg>}
            label={`Ajouter une note de texte pour ${t}`} shortcut="Alt + N" onClick={run(addTextNote)} />
        )}
        <div className="sm-sep" />
        <Item icon={<GearIcon size={16} />} label="Configurations…" onClick={run(() => openDialog('settings'))} />
      </div>
    </>
  );
}
