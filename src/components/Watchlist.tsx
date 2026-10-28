import { useEffect, useRef, useState } from 'react';
import { useStore, rowKey } from '../store/store';
import type { WatchlistItem, WatchlistRow, WatchlistSortColumn, WatchlistTab } from '../types';
import { useChartUi } from '../store/chartUi';
import PanelControls from './PanelControls';
import { useQuotes, type Quote } from '../data/feeds/quotes';
import PresetPicker from './PresetPicker';
import WatchlistColumnsMenu from './WatchlistColumnsMenu';
import { SymbolLogo } from './SymbolLogo';
import SymbolDetails from './SymbolDetails';
import { formatVolume, pricePrecision } from './chartUtils';
import { setDragSymbol } from './symbolDnd';
import { droppedOutsideWindow, openPopout } from './popouts';
import { openFromList } from './chartLink';

// last price with a short green/red flash when it ticks, like TradingView
function PriceCell({ value, precision }: { value: number; precision: number }) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<'' | 'up' | 'down'>('');
  useEffect(() => {
    if (value === prev.current) return;
    setFlash(value > prev.current ? 'up' : 'down');
    prev.current = value;
    const id = setTimeout(() => setFlash(''), 700);
    return () => clearTimeout(id);
  }, [value]);
  return <div className={`wl-col-value wl-price flash-${flash}`}>{value.toFixed(precision)}</div>;
}

// no quote yet -> null (the placeholder simulated prices stored with the item are not shown)
function quoteView(q: Quote | undefined) {
  const last = q?.last ?? null;
  const prevClose = q?.prevClose;
  const change = last != null && prevClose != null ? last - prevClose : 0;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;
  return { last, change, changePct, hasChange: last != null && prevClose != null, volume: q?.volume, live: !!q && q.source !== 'sim' && q.source !== 'local', estimated: !!q?.estimated };
}

// a row's value in the sorted column; null (no quote yet) always goes last
function sortValue(col: WatchlistSortColumn, s: WatchlistItem, q: Quote | undefined, byName: boolean): number | string | null {
  if (col === 'symbol') return byName ? s.name : s.ticker;
  const v = quoteView(q);
  if (col === 'last') return v.last;
  if (col === 'volume') return v.volume ?? null;
  if (!v.hasChange) return null;
  return col === 'chg' ? v.change : v.changePct;
}

// sorted inside each section (and above the first one), like TradingView: sections stay put
function sortRows(rows: WatchlistRow[], sort: WatchlistTab['sort'], quotes: Record<string, Quote>, byName: boolean): WatchlistRow[] {
  if (!sort) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = (r: WatchlistRow) => (r.kind === 'asset' ? sortValue(sort.col, r.data, quotes[r.data.ticker], byName) : null);
  const cmp = (a: WatchlistRow, b: WatchlistRow) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return dir * (typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number));
  };
  const out: WatchlistRow[] = [];
  let group: WatchlistRow[] = [];
  const flush = () => { out.push(...group.sort(cmp)); group = []; };
  for (const r of rows) {
    if (r.kind === 'section') { flush(); out.push(r); } else group.push(r);
  }
  flush();
  return out;
}

export default function Watchlist() {
  const watchlists = useStore((s) => s.watchlists);
  const activeWatchlistId = useStore((s) => s.activeWatchlistId);
  const setActiveWatchlistId = useStore((s) => s.setActiveWatchlistId);
  const addWatchlistTab = useStore((s) => s.addWatchlistTab);
  const renameWatchlistTab = useStore((s) => s.renameWatchlistTab);
  const removeWatchlistTab = useStore((s) => s.removeWatchlistTab);
  const moveWatchlistTab = useStore((s) => s.moveWatchlistTab);
  const setWatchlistSort = useStore((s) => s.setWatchlistSort);
  const setWatchlistItems = useStore((s) => s.setWatchlistItems);
  const symbol = useStore((s) => s.symbol);
  const removeFromWatchlist = useStore((s) => s.removeFromWatchlist);
  const reorderWatchlist = useStore((s) => s.reorderWatchlist);
  const addSection = useStore((s) => s.addSection);
  const renameSection = useStore((s) => s.renameSection);
  const removeSection = useStore((s) => s.removeSection);
  const settings = useStore((s) => s.watchlistSettings);
  const side = useStore((s) => s.watchlistSide);
  const setSide = useStore((s) => s.setWatchlistSide);
  const timeframe = useStore((s) => s.timeframe);
  const quotes = useQuotes((s) => s.quotes);
  const openSearch = useChartUi((s) => s.openSearch);
  const feedStatus = useChartUi((s) => s.feedStatus);
  const [showPresets, setShowPresets] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const dragKey = useRef<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const dragTabId = useRef<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);

  const activeTab = watchlists.find((t) => t.id === activeWatchlistId) ?? watchlists[0];
  const sort = activeTab.sort;
  const rows = sortRows(activeTab.items, sort, quotes, settings.labelMode === 'name');

  function onDrop(targetKey: string) {
    const from = dragKey.current;
    dragKey.current = null;
    setDragOverKey(null);
    if (!from || from === targetKey) return;
    const fromIndex = rows.findIndex((r) => rowKey(r) === from);
    const toIndex = rows.findIndex((r) => rowKey(r) === targetKey);
    if (fromIndex < 0 || toIndex < 0) return;
    if (!sort) { reorderWatchlist(fromIndex, toIndex); return; }
    // dragged while sorted: the sorted order becomes the manual one, with this move
    const items = [...rows];
    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);
    setWatchlistItems(items);
  }

  // a column header click: ascending, then descending, then back to the manual order
  function toggleSort(col: WatchlistSortColumn) {
    if (sort?.col !== col) setWatchlistSort({ col, dir: 'asc' });
    else if (sort.dir === 'asc') setWatchlistSort({ col, dir: 'desc' });
    else setWatchlistSort(undefined);
  }
  const sortHeader = (col: WatchlistSortColumn, label: string, className: string) => (
    <span
      className={`${className} wl-sortable ${sort?.col === col ? 'sorted' : ''}`}
      title="Trier : croissant, décroissant, puis ordre manuel"
      onClick={() => toggleSort(col)}
    >
      {label}{sort?.col === col && <span className="wl-sort-arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </span>
  );

  // which section (if any) each row sits under, to support per-section collapse
  const sectionOf: (string | null)[] = [];
  rows.reduce<string | null>((cur, r, i) => { const id = r.kind === 'section' ? r.id : cur; sectionOf[i] = id; return id; }, null);

  const detailQuote = quotes[symbol.ticker];
  const detailsHeight = useStore((st) => st.watchlistDetailsHeight);
  const setDetailsHeight = useStore((st) => st.setWatchlistDetailsHeight);
  const listRef = useRef<HTMLDivElement>(null);
  // the top edge of the details, dragged: the list keeps 80 px at least
  function startSplitDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY, startH = detailsHeight;
    const total = (listRef.current?.clientHeight ?? 400) + startH;
    const move = (ev: MouseEvent) => setDetailsHeight(Math.round(Math.max(120, Math.min(total - 80, startH + startY - ev.clientY))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'row-resize';
  }

  return (
    <div className="watchlist">

      <div className="wl-header">
        <span className="wl-header-title">{activeTab.name}</span>
        <div className="wl-header-actions">
          <button className="ind-btn" title="Ajouter un symbole" onClick={() => openSearch('add')}>＋</button>
          <button
            className="ind-btn" title="Ajouter une section"
            onClick={() => { const name = window.prompt('Nom de la section :', 'Nouvelle section'); if (name) addSection(name); }}
          >▤</button>
          <button className="ind-btn" title="Nouvelle liste vide" onClick={() => {
            const name = window.prompt('Nom de la nouvelle liste :', 'Nouvelle liste');
            if (name) addWatchlistTab(name);
          }}>☰</button>
          <button className="ind-btn" title="Listes prédéfinies" onClick={() => setShowPresets(true)}>⊞</button>
          <button className="ind-btn" title="Colonnes et affichage" onClick={() => setShowColumns(true)}>⋯</button>
          <button
            className="ind-btn" title={side === 'right' ? 'Déplacer la liste à gauche du terminal' : 'Remettre la liste à droite'}
            onClick={() => setSide(side === 'right' ? 'left' : 'right')}
          >
            {side === 'right' ? '⇤' : '⇥'}
          </button>
          <PanelControls left={side === 'left'} />
        </div>
      </div>

      <div className="watchlist-tabs">
        {watchlists.map((t) => (
          <button
            key={t.id}
            className={`wl-tab ${t.id === activeWatchlistId ? 'active' : ''} ${dragOverTab === t.id ? 'drag-over' : ''}`}
            // drag a tab left or right to move it
            draggable
            onDragStart={(e) => { dragTabId.current = t.id; e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={(e) => { if (!dragTabId.current) return; e.preventDefault(); setDragOverTab(t.id); }}
            onDragLeave={() => setDragOverTab((cur) => (cur === t.id ? null : cur))}
            onDrop={(e) => { if (!dragTabId.current) return; e.preventDefault(); moveWatchlistTab(dragTabId.current, t.id); dragTabId.current = null; setDragOverTab(null); }}
            onDragEnd={() => { dragTabId.current = null; setDragOverTab(null); }}
            onClick={() => setActiveWatchlistId(t.id)}
            onDoubleClick={() => {
              const name = window.prompt('Renommer la liste :', t.name);
              if (name) renameWatchlistTab(t.id, name);
            }}
          >
            {t.name}
            {watchlists.length > 1 && (
              <span className="wl-tab-close" onClick={(e) => { e.stopPropagation(); removeWatchlistTab(t.id); }}>✕</span>
            )}
          </button>
        ))}
      </div>
      {showPresets && <PresetPicker onClose={() => setShowPresets(false)} />}
      {showColumns && <WatchlistColumnsMenu onClose={() => setShowColumns(false)} />}

      {settings.tableView && (
        <div className="wl-col-header">
          {sortHeader('symbol', 'Symbole', 'wl-col-symbol')}
          {settings.showLast && sortHeader('last', 'Dernier', 'wl-col-metric')}
          {settings.showChg && sortHeader('chg', 'Var', 'wl-col-metric')}
          {settings.showChgPct && sortHeader('chgPct', 'Var%', 'wl-col-metric')}
          {settings.showVolume && sortHeader('volume', 'Vol', 'wl-col-metric')}
          <span className="wl-col-spacer" />
        </div>
      )}

      <div className="watchlist-items" ref={listRef}>
        {rows.map((row, rowIndex) => {
          const key = rowKey(row);
          const dragProps = {
            draggable: true,
            // assets also drag onto charts / the free-window canvas, or out of the browser
            onDragStart: (e: React.DragEvent) => { dragKey.current = key; if (row.kind === 'asset') setDragSymbol(e, row.data); },
            onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOverKey(key); },
            onDragLeave: () => setDragOverKey((cur) => (cur === key ? null : cur)),
            onDrop: (e: React.DragEvent) => { e.preventDefault(); onDrop(key); },
            onDragEnd: (e: React.DragEvent) => {
              dragKey.current = null;
              setDragOverKey(null);
              if (row.kind === 'asset' && e.dataTransfer.dropEffect === 'none' && droppedOutsideWindow(e)) {
                openPopout(row.data, timeframe, { left: e.screenX - 120, top: e.screenY - 16 });
              }
            },
          };

          if (row.kind === 'section') {
            const collapsed = !!collapsedSections[row.id];
            return (
              <div
                key={key}
                {...dragProps}
                className={`watchlist-section ${dragOverKey === key ? 'drag-over' : ''}`}
                onClick={() => setCollapsedSections((c) => ({ ...c, [row.id]: !c[row.id] }))}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const name = window.prompt('Renommer la section :', row.name);
                  if (name) renameSection(row.id, name);
                }}
              >
                <span className={`cat-caret ${collapsed ? 'closed' : ''}`}>▾</span>
                <span className="wl-section-name">{row.name}</span>
                <button className="remove-btn" onClick={(e) => { e.stopPropagation(); removeSection(row.id); }}>✕</button>
              </div>
            );
          }

          const sectionId = sectionOf[rowIndex];
          if (sectionId && collapsedSections[sectionId]) return null;

          const s = row.data;
          const v = quoteView(quotes[s.ticker]);
          const up = v.change >= 0;
          const precision = v.last != null ? pricePrecision(s, v.last) : 2;
          return (
            <div
              key={key}
              {...dragProps}
              className={`watchlist-item ${symbol.ticker === s.ticker ? 'active' : ''} ${dragOverKey === key ? 'drag-over' : ''}`}
              onClick={() => openFromList(s)}
            >
              {settings.showLogo && <SymbolLogo sym={s} />}
              <div className="wl-main">
                <div className="wl-ticker">
                  {settings.labelMode === 'name' ? s.name : s.ticker}
                  {v.live && <span className={`wl-live-dot${v.estimated ? ' est' : ''}`} title={v.estimated ? 'Cours estimé en temps réel (dernier cours différé + mouvement des contrats perpétuels sur le même indice)' : 'Cours réel'} />}
                </div>
                {settings.labelMode === 'symbol' && !settings.tableView && <div className="wl-name">{s.name}</div>}
              </div>
              {settings.showLast && (v.last != null ? <PriceCell value={v.last} precision={precision} /> : <div className="wl-col-value wl-price muted">—</div>)}
              {settings.showChg && <div className={`wl-col-value wl-change ${up ? 'up' : 'down'}`}>{v.hasChange ? `${up ? '+' : ''}${v.change.toFixed(precision)}` : '—'}</div>}
              {settings.showChgPct && <div className={`wl-col-value wl-change ${up ? 'up' : 'down'}`}>{v.hasChange ? `${up ? '+' : ''}${v.changePct.toFixed(2)}%` : '—'}</div>}
              {settings.showVolume && <div className="wl-col-value wl-name">{v.volume != null ? formatVolume(v.volume) : '—'}</div>}
              <button className="remove-btn wl-remove" onClick={(e) => { e.stopPropagation(); removeFromWatchlist(s.ticker); }}>✕</button>
            </div>
          );
        })}
        <button className="wl-add-row" onClick={() => openSearch('add')}>＋ Ajouter un symbole</button>
      </div>

      {/* drag up or down: more room for the details or for the list, like TradingView */}
      <div className="wl-split" title="Glisser pour agrandir la fiche ou la liste" onMouseDown={startSplitDrag} />
      <div className="wl-details-scroll" style={{ height: detailsHeight }}>
        <SymbolDetails key={symbol.ticker} symbol={symbol} quote={detailQuote} feedStatus={feedStatus} />
      </div>
    </div>
  );
}
