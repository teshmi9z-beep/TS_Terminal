import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore, WORKSPACE_KEYS, type AppTab } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { useQuotes } from '../../data/feeds/quotes';
import { pricePrecision } from '../chartUtils';
import { SymbolLogo } from '../SymbolLogo';
import ToolIcon from './ToolIcon';
import {
  TOOL_LABELS, activateTab, autosaveLayout, closeOtherTabs, closeTab, duplicateTab, freshChart, moveTab, newTab, reopenClosedTab,
} from './tabActions';
import { getDragSymbol, isSymbolDrag } from '../symbolDnd';
import type { Symbol } from '../../types';
import { LOCALE } from '../../i18n/lang';

function ChartTitle({ sym }: { sym: Symbol }) {
  const q = useQuotes((s) => s.quotes[sym.ticker]);
  const last = q?.last;
  const chg = last != null && q?.prevClose ? ((last - q.prevClose) / q.prevClose) * 100 : null;
  const cls = chg == null ? '' : chg >= 0 ? 'up' : 'down';
  return (
    <>
      <SymbolLogo sym={sym} size={16} />
      <span className="tab2-sym">{sym.ticker}</span>
      {last != null && (
        <span className={`tab2-quote ${cls}`}>
          {chg != null && <span className="tab2-arrow">{chg >= 0 ? '▲' : '▼'}</span>}
          {last.toLocaleString(LOCALE, { minimumFractionDigits: pricePrecision(sym, last), maximumFractionDigits: pricePrecision(sym, last) })}
          {chg != null && <small>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</small>}
        </span>
      )}
    </>
  );
}

// saves the layout of the active chart tab a moment after its chart changes, and when leaving
export function LayoutAutosave() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useStore.subscribe((s, prev) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab || tab.kind !== 'chart' || !tab.layoutId || s.activeTabId !== prev.activeTabId) return;
      if (!WORKSPACE_KEYS.some((k) => s[k] !== prev[k])) return;
      clearTimeout(timer);
      timer = setTimeout(autosaveLayout, 1500);
    });
    window.addEventListener('beforeunload', autosaveLayout);
    return () => { unsub(); clearTimeout(timer); window.removeEventListener('beforeunload', autosaveLayout); };
  }, []);
  return null;
}

// TradingView desktop's tabs: charts (symbol and live price), the "Nouvel onglet" page, tools
const onNetChange = (cb: () => void) => {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb); };
};

export default function TabBar() {
  const online = useSyncExternalStore(onNetChange, () => navigator.onLine);
  const openOffline = () => useChartUi.getState().openDialog('offline');
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeTabId);
  const symbol = useStore((s) => s.symbol);
  const workspaces = useStore((s) => s.workspaces);
  const closedCount = useStore((s) => s.closedTabs.length);
  const uiTheme = useStore((s) => s.uiTheme);
  const setUiTheme = useStore((s) => s.setUiTheme);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [more, setMore] = useState(false);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  // a symbol dragged from a list over the tabs: where its new chart tab would go
  const [symAt, setSymAt] = useState<number | null>(null);

  function dropSymbol(e: React.DragEvent, at: number) {
    e.preventDefault();
    e.stopPropagation();
    setSymAt(null);
    const sym = getDragSymbol(e);
    if (sym) newTab({ kind: 'chart', layoutId: null, state: freshChart(sym) }, at);
  }
  const overSymbol = (e: React.DragEvent, at: number) => {
    if (!isSymbolDrag(e)) return false;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (symAt !== at) setSymAt(at);
    return true;
  };

  useEffect(() => {
    if (!ctx && !more) return;
    const close = () => { setCtx(null); setMore(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('blur', close); };
  }, [ctx, more]);

  const title = (t: AppTab) => {
    if (t.kind === 'home') return <><ToolIcon tool="home" size={15} /><span>Nouvel onglet</span></>;
    if (t.kind === 'tool' && t.tool) return <><ToolIcon tool={t.tool} size={15} /><span>{TOOL_LABELS[t.tool]}</span></>;
    const sym = t.id === activeId ? symbol : t.state?.symbol ?? symbol;
    return <ChartTitle sym={sym} />;
  };
  const tip = (t: AppTab) => (t.kind === 'chart' ? `Mise en page : ${workspaces.find((w) => w.id === t.layoutId)?.name ?? 'non enregistrée'}` : undefined);

  const item = (label: string, action: () => void, disabled = false) => (
    <button disabled={disabled} onMouseDown={(e) => e.stopPropagation()} onClick={() => { action(); setCtx(null); setMore(false); }}>{label}</button>
  );

  return (
    <div className="tab2-bar">
      {/* a symbol dropped on the tabs opens in a new chart tab, after the tab it is dropped on (at the end elsewhere) */}
      <div
        className={`tab2-list ${symAt != null ? 'sym-drop' : ''}`}
        onDragOver={(e) => { if (!overSymbol(e, tabs.length)) e.preventDefault(); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSymAt(null); }}
        onDrop={(e) => { if (isSymbolDrag(e)) dropSymbol(e, tabs.length); }}
      >
        {tabs.map((t, i) => (
          <div
            key={t.id} title={tip(t)}
            className={`tab2 ${t.id === activeId ? 'active' : ''} ${dropAt === i ? 'drop' : ''} ${symAt === i + 1 ? 'sym-after' : ''}`}
            draggable
            onDragStart={() => { drag.current = i; }}
            onDragOver={(e) => { if (overSymbol(e, i + 1)) return; e.preventDefault(); setDropAt(i); }}
            onDragLeave={() => setDropAt(null)}
            onDrop={(e) => {
              if (isSymbolDrag(e)) { dropSymbol(e, i + 1); return; }
              e.preventDefault(); if (drag.current != null && drag.current !== i) moveTab(drag.current, i); drag.current = null; setDropAt(null);
            }}
            onMouseDown={(e) => { if (e.button === 0) activateTab(t.id); }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
            onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: t.id }); }}
          >
            <span className="tab2-title">{title(t)}</span>
            <button className="tab2-x" title="Fermer l’onglet" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(t.id)}>✕</button>
          </div>
        ))}
        {symAt != null && <span className="tab2-sym-hint">＋ Ouvrir dans un nouvel onglet</span>}
        <button className="tab2-add" title="Nouvel onglet (ou glissez un actif d’une liste sur les onglets)" onClick={() => newTab({ kind: 'home' })}>＋</button>
      </div>
      <div className="tab2-right">
        {!online && <button className="tab2-offline" title="Pas de connexion : données enregistrées sur cet ordinateur" onClick={openOffline}>Hors ligne</button>}
        <button className="tab2-icon" title="Plus" onMouseDown={(e) => e.stopPropagation()} onClick={() => setMore(!more)}>•••</button>
        {more && (
          <div className="tab2-menu right" onMouseDown={(e) => e.stopPropagation()}>
            {item('Nouvel onglet', () => newTab({ kind: 'home' }))}
            {item('Rouvrir l’onglet fermé', reopenClosedTab, !closedCount)}
            <div className="tab2-sep" />
            {item(document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran', () => {
              if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen();
            })}
            {item(uiTheme === 'dark' ? 'Thème clair' : 'Thème sombre', () => setUiTheme(uiTheme === 'dark' ? 'light' : 'dark'))}
            <div className="tab2-sep" />
            {item('Données hors ligne…', openOffline)}
          </div>
        )}
      </div>
      {ctx && (
        <div className="tab2-menu" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
          {item('Dupliquer l’onglet', () => duplicateTab(ctx.id))}
          {item('Fermer l’onglet', () => closeTab(ctx.id))}
          {item('Fermer les autres onglets', () => closeOtherTabs(ctx.id), tabs.length < 2)}
          {item('Fermer les onglets à droite', () => closeOtherTabs(ctx.id, true), tabs.findIndex((t) => t.id === ctx.id) === tabs.length - 1)}
          <div className="tab2-sep" />
          {item('Nouvel onglet', () => newTab({ kind: 'home' }))}
          {item('Rouvrir l’onglet fermé', reopenClosedTab, !closedCount)}
        </div>
      )}
    </div>
  );
}
