import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { useQuotes } from '../data/feeds/quotes';
import { PRESETS } from '../data/presets';
import { SYMBOLS } from '../data/symbols';
import { openFeed } from '../data/feeds';
import { rsi } from '../indicators/math';
import { SymbolLogo } from './SymbolLogo';
import { openFromList } from './chartLink';
import { formatVolume, pricePrecision } from './chartUtils';
import type { AssetCategory, Symbol } from '../types';

type SortKey = 'ticker' | 'last' | 'chg' | 'vol' | 'rsi';

const CATEGORY_LISTS: { id: string; label: string; category: AssetCategory }[] = [
  { id: 'cat-crypto', label: 'Toutes les cryptos', category: 'Crypto' },
  { id: 'cat-forex', label: 'Tout le forex', category: 'Forex' },
  { id: 'cat-index', label: 'Tous les indices', category: 'Indices' },
  { id: 'cat-commo', label: 'Toutes les matières premières', category: 'Matieres premieres' },
];

// daily RSI 14 per ticker, fetched on demand and kept for the session
const rsiCache = new Map<string, number>();

// screener of a list (watchlist, presets, crypto, forex...): live quotes, sort, filters, optional daily RSI
export default function ListScreener() {
  const watchlists = useStore((s) => s.watchlists);
  const activeWatchlistId = useStore((s) => s.activeWatchlistId);
  const addToWatchlist = useStore((s) => s.addToWatchlist);
  const current = useStore((s) => s.symbol);
  const setScreenerSymbols = useChartUi((s) => s.setScreenerSymbols);
  const quotes = useQuotes((s) => s.quotes);
  const [listId, setListId] = useState('cac40');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'chg', dir: -1 });
  const [minChg, setMinChg] = useState('');
  const [maxChg, setMaxChg] = useState('');
  const [text, setText] = useState('');
  const [rsiState, setRsiState] = useState<{ running: boolean; done: number }>({ running: false, done: 0 });

  const symbols: Symbol[] = useMemo(() => {
    if (listId === 'watchlist') {
      const tab = watchlists.find((t) => t.id === activeWatchlistId) ?? watchlists[0];
      return tab.items.flatMap((r) => (r.kind === 'asset' ? [r.data] : []));
    }
    const cat = CATEGORY_LISTS.find((c) => c.id === listId);
    if (cat) return SYMBOLS.filter((s) => s.category === cat.category);
    return PRESETS.find((p) => p.id === listId)?.symbols ?? [];
  }, [listId, watchlists, activeWatchlistId]);

  useEffect(() => {
    setScreenerSymbols(symbols);
    return () => setScreenerSymbols([]);
  }, [symbols, setScreenerSymbols]);

  const rows = useMemo(() => {
    const lo = parseFloat(minChg), hi = parseFloat(maxChg), t = text.trim().toUpperCase();
    return symbols
      .map((s) => {
        const q = quotes[s.ticker];
        const chg = q?.prevClose ? ((q.last - q.prevClose) / q.prevClose) * 100 : NaN;
        return { s, last: q?.last ?? NaN, chg, vol: q?.volume ?? NaN, rsi: rsiCache.get(s.ticker) ?? NaN };
      })
      .filter((r) => (!t || r.s.ticker.includes(t) || r.s.name.toUpperCase().includes(t))
        && (isNaN(lo) || r.chg >= lo) && (isNaN(hi) || r.chg <= hi))
      .sort((a, b) => {
        if (sort.key === 'ticker') return a.s.ticker.localeCompare(b.s.ticker) * sort.dir;
        const va = a[sort.key], vb = b[sort.key];
        if (isNaN(va)) return 1;
        if (isNaN(vb)) return -1;
        return (va - vb) * sort.dir;
      });
    // rsiState.done forces a refresh while RSI values come in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols, quotes, sort, minChg, maxChg, text, rsiState.done]);

  async function computeRsi() {
    setRsiState({ running: true, done: 0 });
    let done = 0;
    const queue = symbols.filter((s) => !rsiCache.has(s.ticker));
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          const { candles, session } = await openFeed(s, '1D');
          if (session.source !== 'sim') {
            const r = rsi(candles, 14);
            if (r.length) rsiCache.set(s.ticker, r[r.length - 1].value);
          }
        } catch { /* skip symbol */ }
        setRsiState({ running: true, done: ++done });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setRsiState({ running: false, done });
  }

  const head = (key: SortKey, label: string) => (
    <th onClick={() => setSort((cur) => ({ key, dir: cur.key === key ? (cur.dir === 1 ? -1 : 1) : key === 'ticker' ? 1 : -1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );

  return (
    <>
      <div className="scr-controls">
        <select value={listId} onChange={(e) => setListId(e.target.value)}>
          <option value="watchlist">Liste de surveillance active</option>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label.replace('echantillon', 'échantillon')}</option>)}
          {CATEGORY_LISTS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input placeholder="Filtrer (symbole, nom)" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="scr-range">
          <span>Var % entre</span>
          <input value={minChg} onChange={(e) => setMinChg(e.target.value)} placeholder="min" />
          <span>et</span>
          <input value={maxChg} onChange={(e) => setMaxChg(e.target.value)} placeholder="max" />
        </div>
        <button className="pill-btn" disabled={rsiState.running} onClick={() => void computeRsi()}>
          {rsiState.running ? `RSI… ${rsiState.done}/${symbols.length}` : 'Calculer le RSI 14 (jour)'}
        </button>
      </div>
      <div className="scr-table-wrap">
        <table className="scr-table">
          <thead>
            <tr>{head('ticker', 'Symbole')}{head('last', 'Dernier')}{head('chg', 'Var %')}{head('vol', 'Vol')}{head('rsi', 'RSI')}<th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.s.ticker} className={r.s.ticker === current.ticker ? 'active' : ''} onClick={() => openFromList(r.s)}>
                <td><span className="scr-sym"><SymbolLogo sym={r.s} size={16} />{r.s.ticker}</span></td>
                <td>{isNaN(r.last) ? '—' : r.last.toFixed(pricePrecision(r.s, r.last))}</td>
                <td className={r.chg >= 0 ? 'up' : 'down'}>{isNaN(r.chg) ? '—' : `${r.chg >= 0 ? '+' : ''}${r.chg.toFixed(2)}%`}</td>
                <td>{isNaN(r.vol) ? '—' : formatVolume(r.vol)}</td>
                <td className={r.rsi >= 70 ? 'down' : r.rsi <= 30 ? 'up' : ''}>{isNaN(r.rsi) ? '—' : r.rsi.toFixed(0)}</td>
                <td><button className="remove-btn" title="Ajouter à la liste" onClick={(e) => { e.stopPropagation(); addToWatchlist(r.s); }}>＋</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="side-empty">{rows.length} / {symbols.length} symboles · cours Binance / Yahoo actualisés en continu</div>
    </>
  );
}
