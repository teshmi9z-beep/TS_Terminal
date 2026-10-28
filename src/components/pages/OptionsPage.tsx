import { useEffect, useState } from 'react';
import { peekKept, remember, useKept } from '../kept';
import { daysTo, fetchExpirations, resolveUnderlying, type Expiration, type Leg, type Underlying } from '../../data/options';
import { tvToSymbol } from '../../data/tv';
import { fr, pct, signCls } from '../../data/format';
import { nextId } from '../../store/store';
import { showOnChart } from '../tabs/tabActions';
import { Loading, TvLogo } from './common';
import ChainTable from './options/Chain';
import Builder from './options/Builder';
import Finder from './options/Finder';
import { Volatility, VolumeTab } from './options/Analysis';
import { Dropdown } from './options/ui';
import { DEFAULT_COLS, expLabel, type ColId, type Pick, type Side } from './options/format';

type View = 'chain' | 'builder' | 'finder' | 'vol' | 'volume';
const VIEWS: [View, string][] = [['chain', 'Chaîne'], ['builder', 'Générateur de stratégie'], ['finder', 'Outil de recherche de stratégies'], ['vol', 'Volatilité'], ['volume', 'Volume']];

const POPULAR: [string, string][] = [
  ['AAPL', 'Apple'], ['NVDA', 'NVIDIA'], ['TSLA', 'Tesla'], ['MSFT', 'Microsoft'], ['AMZN', 'Amazon'], ['META', 'Meta'],
  ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ'], ['IWM', 'iShares Russell 2000'], ['SPX', 'Indice S&P 500'], ['NDX', 'Indice Nasdaq 100'],
  ['ES1!', 'E-mini S&P 500'], ['NQ1!', 'E-mini Nasdaq 100'], ['GC1!', 'Or'], ['CL1!', 'Pétrole brut WTI'], ['ZN1!', 'T-Note 10 ans'],
];
const STRIKES: [number, string][] = [[4, '±4 strikes'], [6, '±6 strikes'], [8, '±8 strikes'], [10, '±10 strikes'], [15, '±15 strikes'], [20, '±20 strikes'], [0, 'Tous les strikes']];
const SPREADS: [number, string][] = [[0, 'Aucun'], [1, 'Vertical, 1 strike'], [2, 'Vertical, 2 strikes'], [3, 'Vertical, 3 strikes'], [5, 'Vertical, 5 strikes']];

const COLS_KEY = 'tesh.options.columns';
function loadCols(): ColId[] {
  try { const v = JSON.parse(localStorage.getItem(COLS_KEY) ?? 'null') as ColId[] | null; return Array.isArray(v) && v.length ? v : DEFAULT_COLS; } catch { return DEFAULT_COLS; }
}

function SymbolPicker({ u, onPick }: { u: Underlying | null; onPick: (s: string) => void }) {
  const [text, setText] = useState('');
  return (
    <Dropdown
      className="op-sym-dd"
      label={u ? <><TvLogo logoid={u.logoid} text={u.input} size={20} /><b>{u.input}</b></> : <b>Symbole</b>}
    >
      {(close) => (
        <div className="op-sym-menu">
          <input
            autoFocus placeholder="Symbole (AAPL, SPY, SPX, ES1!…)" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { onPick(text.trim()); setText(''); close(); } }}
          />
          <div className="op-dd-head">Populaires</div>
          {POPULAR.map(([s, n]) => (
            <button key={s} onClick={() => { onPick(s); close(); }}><b>{s}</b><span>{n}</span></button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

// TradingView's options: chain by expiration, strategy generator and finder, volatility, volume
export default function OptionsPage() {
  const [query, setQuery] = useKept('options.query', 'AAPL');
  const [u, setU] = useKept<Underlying | null>('options.u', null, true);
  const [error, setError] = useState<string | null>(null);
  const [exps, setExps] = useKept<{ id: string; list: Expiration[] } | null>('options.exps', null, true);
  const [view, setView] = useKept<View>('options.view', 'chain');
  const [side, setSide] = useKept<Side>('options.side', 'both');
  const [strikes, setStrikes] = useKept('options.strikes', 6);
  const [spread, setSpread] = useKept('options.spread', 0);
  const [expFilter, setExpFilter] = useKept<string | null>('options.expFilter', null);
  const [cols, setColsState] = useState<ColId[]>(loadCols);
  const [legs, setLegs] = useKept<Leg[]>('options.legs', []);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    // back on the tab: the underlying and its expirations are still there
    if (peekKept('options.loadedFor') === query) return;
    let alive = true;
    resolveUnderlying(query).then((r) => {
      if (!alive) return;
      if (!r) { setError(`Aucune option trouvée pour « ${query} »`); return; }
      setU(r); setError(null);
      fetchExpirations(r).then((list) => { if (alive) { setExps({ id: r.id, list }); remember('options.loadedFor', query, true); } }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [query, setU, setExps]);

  const setCols = (c: ColId[]) => { setColsState(c); try { localStorage.setItem(COLS_KEY, JSON.stringify(c)); } catch { /* private mode */ } };
  const list = exps && u && exps.id === u.id ? exps.list : null;
  const shown = list ? (expFilter ? list.filter((e) => e.key === expFilter) : list) : [];

  const onPick = (e: Expiration, p: Pick) => {
    if (!u) return;
    setLegs((l) => [...l, ...p.map((x): Leg => ({ id: nextId(), type: x.type, strike: x.strike, qty: x.qty, premium: x.price, iv: x.iv, expiration: e.exp, root: e.root, mult: u.multiplier }))]);
    setFlash(`${p.map((x) => `${x.qty > 0 ? 'Achat' : 'Vente'} ${x.type === 'call' ? 'call' : 'put'} ${fr(x.strike, x.strike % 1 ? 1 : 0)}`).join(' + ')} ajouté au générateur`);
    setTimeout(() => setFlash(null), 2500);
  };

  return (
    <div className="pg op-page">
      <div className="pg-head"><h1>Options</h1></div>
      <div className="op-views">
        {VIEWS.map(([id, label]) => (
          <button key={id} className={`pg-chip ${view === id ? 'active' : ''}`} onClick={() => setView(id)}>
            {label}{id === 'builder' && legs.length > 0 && <span className="op-count">{legs.length}</span>}
          </button>
        ))}
      </div>
      <div className="op-toolbar">
        <SymbolPicker u={u} onPick={(s) => {
          // another underlying: its own expirations and strategy
          const q = s.toUpperCase();
          if (q !== query) { setExpFilter(null); setLegs([]); }
          setQuery(q);
        }} />
        {view === 'chain' && (
          <>
            <Dropdown label={<><span className="muted">Expiration</span> <b>{expFilter && list ? expLabel(list.find((e) => e.key === expFilter)?.exp ?? 0) : 'Toutes les échéances'}</b></>}>
              {(close) => (
                <div className="op-dd-list">
                  <button className={!expFilter ? 'active' : ''} onClick={() => { setExpFilter(null); close(); }}>Toutes les échéances</button>
                  {(list ?? []).map((e) => (
                    <button key={e.key} className={expFilter === e.key ? 'active' : ''} onClick={() => { setExpFilter(e.key); close(); }}>
                      {expLabel(e.exp)} <small>{daysTo(e.exp)} DTE · {e.root}</small>
                    </button>
                  ))}
                </div>
              )}
            </Dropdown>
            <Dropdown label={<b>{STRIKES.find((s) => s[0] === strikes)?.[1]}</b>}>
              {(close) => (
                <div className="op-dd-list">
                  {STRIKES.map(([n, l]) => <button key={n} className={n === strikes ? 'active' : ''} onClick={() => { setStrikes(n); close(); }}>{l}</button>)}
                </div>
              )}
            </Dropdown>
            <Dropdown label={<span className={spread ? '' : 'muted'}>{spread ? `Spread ${spread}` : 'Spread'}</span>}>
              {(close) => (
                <div className="op-dd-list">
                  {SPREADS.map(([n, l]) => <button key={n} className={n === spread ? 'active' : ''} onClick={() => { setSpread(n); close(); }}>{l}</button>)}
                </div>
              )}
            </Dropdown>
            <span className="op-spacer" />
            <div className="op-seg">
              {([['calls', 'Calls'], ['puts', 'Puts'], ['both', 'Calls et puts']] as [Side, string][]).map(([id, l]) => (
                <button key={id} className={side === id ? 'active' : ''} onClick={() => setSide(id)}>{l}</button>
              ))}
            </div>
          </>
        )}
        {view !== 'chain' && u && (
          <span className="op-und-mini">
            <button onClick={() => showOnChart(tvToSymbol(u.id, u.name))} title="Ouvrir sur le graphique">{u.name}</button>
            <b>{fr(u.price)}</b> <small>{u.currency}</small> <span className={signCls(u.change)}>{pct(u.change)}</span>
          </span>
        )}
      </div>
      {error && <div className="pg-error">{error}</div>}
      {flash && <div className="op-flash">{flash} <button className="op-link" onClick={() => setView('builder')}>Voir</button></div>}
      {!u || !list ? (!error && <Loading />) : (
        <>
          {view === 'chain' && <ChainTable key={`${u.id}|${expFilter ?? ''}`} u={u} exps={shown} side={side} strikes={strikes} spread={spread} cols={cols} onPick={onPick} onCols={setCols} />}
          {view === 'builder' && <Builder u={u} exps={list} legs={legs} setLegs={setLegs} />}
          {view === 'finder' && <Finder u={u} exps={list} onBuild={(l) => { setLegs(l); setView('builder'); }} />}
          {view === 'vol' && <Volatility u={u} exps={list} />}
          {view === 'volume' && <VolumeTab u={u} exps={list} />}
        </>
      )}
      <div className="pg-note">
        Données différées : TradingView (cotations, grecques, volatilité), Yahoo Finance (volume et intérêt ouvert des options américaines).
        {u?.kind === 'future' && ` Options sur ${u.ticker} (contrat le plus proche de ${u.input}), multiplicateur ${u.multiplier}.`}
      </div>
    </div>
  );
}
