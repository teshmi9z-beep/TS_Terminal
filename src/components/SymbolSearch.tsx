import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { SYMBOLS } from '../data/symbols';
import { yahooSearch } from '../data/feeds/yahoo';
import { fromYahoo } from '../data/feeds/searchSymbols';
import { binanceUsdtBases } from '../data/feeds/binance';
import { SymbolLogo } from './SymbolLogo';
import type { AssetCategory, Symbol } from '../types';

type Filter = 'all' | AssetCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tout' },
  { id: 'Actions', label: 'Actions' },
  { id: 'Crypto', label: 'Crypto' },
  { id: 'Forex', label: 'Forex' },
  { id: 'Indices', label: 'Indices' },
  { id: 'Matieres premieres', label: 'Matières premières' },
];

const CATEGORY_LABEL: Record<AssetCategory, string> = {
  Actions: 'action', Crypto: 'crypto', Forex: 'forex', Indices: 'indice', 'Matieres premieres': 'future',
};

export default function SymbolSearch() {
  const search = useChartUi((s) => s.search);
  const closeSearch = useChartUi((s) => s.closeSearch);
  const setSymbol = useStore((s) => s.setSymbol);
  const addToWatchlist = useStore((s) => s.addToWatchlist);
  const addCompare = useStore((s) => s.addCompare);
  const watchlists = useStore((s) => s.watchlists);
  const activeWatchlistId = useStore((s) => s.activeWatchlistId);
  const [query, setQuery] = useState(search.initial);
  const [filter, setFilter] = useState<Filter>('all');
  const [remote, setRemote] = useState<Symbol[]>([]);
  const [cryptoBases, setCryptoBases] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { binanceUsdtBases().then(setCryptoBases); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSearch(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSearch]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) return;
    let cancelled = false;
    const id = setTimeout(() => {
      setLoading(true);
      yahooSearch(q)
        .then((hits) => { if (!cancelled) setRemote(hits.map(fromYahoo).filter((s): s is Symbol => !!s)); })
        .catch(() => { if (!cancelled) setRemote([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 220);
    return () => { cancelled = true; clearTimeout(id); };
  }, [query]);

  const results = useMemo(() => {
    const q = query.trim().toUpperCase();
    const seen = new Set<string>();
    const out: Symbol[] = [];
    const push = (s: Symbol) => { if (!seen.has(s.ticker)) { seen.add(s.ticker); out.push(s); } };
    const local = SYMBOLS.filter((s) => !q || s.ticker.includes(q) || s.name.toUpperCase().includes(q));
    local.sort((a, b) => Number(!a.ticker.startsWith(q)) - Number(!b.ticker.startsWith(q)));
    local.forEach(push);
    if (q.length >= 2) {
      cryptoBases
        .filter((b) => b.startsWith(q.replace(/USDT?$/, '')))
        .slice(0, 12)
        .forEach((b) => push({ ticker: `${b}USD`, name: `${b} / TetherUS`, basePrice: 1, category: 'Crypto', exchange: 'Binance', binance: `${b}USDT` }));
    }
    if (q) remote.forEach(push);
    return out.filter((s) => filter === 'all' || s.category === filter).slice(0, 80);
  }, [query, remote, cryptoBases, filter]);

  useEffect(() => {
    listRef.current?.querySelector('.ss-item.cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const activeTab = watchlists.find((t) => t.id === activeWatchlistId);
  const inList = (s: Symbol) => !!activeTab?.items.some((r) => r.kind === 'asset' && r.data.ticker === s.ticker);

  function choose(s: Symbol) {
    if (search.mode === 'add') { addToWatchlist(s); return; }
    if (search.mode === 'compare') {
      const ui = useChartUi.getState();
      if (ui.compareTarget) { useStore.getState().updateCompare(ui.compareTarget, { symbol: s }); ui.setCompareTarget(null); }
      else if (!addCompare(s)) ui.showToast('5 symboles comparés au maximum : retirez-en un dans la légende du graphique');
    }
    else setSymbol(s);
    closeSearch();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(results.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter' && results[cursor]) choose(results[cursor]);
  }

  const title = search.mode === 'add' ? 'Ajouter à la liste' : search.mode === 'compare' ? 'Comparer un symbole' : 'Recherche de symbole';

  return (
    <div className="modal-backdrop" onMouseDown={closeSearch}>
      <div className="symbol-search" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ss-head">
          <span className="ss-title">{title}</span>
          <button className="remove-btn" onClick={closeSearch}>✕</button>
        </div>
        <div className="ss-input-row">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2L16 16" /></svg>
          <input autoFocus placeholder="Symbole ou nom (ex : AAPL, Total, BTC, EURUSD)" value={query} onChange={(e) => { setQuery(e.target.value); setCursor(0); }} onKeyDown={onKey} />
          {loading && <span className="spinner small" />}
        </div>
        <div className="ss-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={`ss-chip ${filter === f.id ? 'active' : ''}`} onClick={() => { setFilter(f.id); setCursor(0); }}>{f.label}</button>
          ))}
        </div>
        <div className="ss-list" ref={listRef}>
          {results.map((s, i) => {
            const added = search.mode === 'add' && inList(s);
            return (
              <div
                key={s.ticker}
                className={`ss-item ${i === cursor ? 'cursor' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(s)}
              >
                <SymbolLogo sym={s} />
                <span className="ss-ticker">{s.ticker}</span>
                <span className="ss-name">{s.name}</span>
                <span className="ss-type">{CATEGORY_LABEL[s.category]}</span>
                <span className="ss-exch">{s.exchange ?? (s.binance || s.category === 'Crypto' ? 'Binance' : '')}</span>
                {search.mode === 'add' && <span className={`ss-add ${added ? 'done' : ''}`}>{added ? '✓' : '+'}</span>}
              </div>
            );
          })}
          {!results.length && !loading && <div className="ss-empty">Aucun symbole trouvé</div>}
        </div>
        <div className="ss-foot">Sources : Binance (crypto, temps réel) · Yahoo Finance (actions, indices, forex, matières premières)</div>
      </div>
    </div>
  );
}
