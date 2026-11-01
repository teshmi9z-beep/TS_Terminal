import { useEffect, useState } from 'react';
import { useChartUi } from '../store/chartUi';
import { useStore } from '../store/store';
import { warmFeeds } from '../data/feeds';
import { listenIg } from '../data/feeds/ig';
import { brokerLabel, igList, igLists, searchIg, useBroker, type IgList, type IgSearchHit } from '../store/broker';
import { igMarketOf, openIgMarket, symbolOfIg, usableIg } from './brokerAccount';
import { findSymbol, setDragSymbol } from './symbolDnd';
import { droppedOutsideWindow, openPopout } from './popouts';
import { useKept } from './kept';
import PanelControls from './PanelControls';
import { BrokerLogo } from './BrokerDialog';

// "Marchés IG", in the right bar like the screener: the contracts the IG account can trade. IG no longer
// serves its whole tree of markets, so: a search over all of them (shares too), the IG account's own
// lists, and the main markets the platform charts, by category. A click opens the chart, the ticket
// then trading that very contract.

const MAIN: [string, string[]][] = [
  // IG's index CFDs "au comptant", charted with IG's own prices (IG symbols: see IG_INDICES in brokerAccount.ts)
  ['Indices', ['IGUS500', 'IGUST100', 'IGUS30', 'IGUS2000', 'IGDE40', 'IGFR40', 'IGUK100', 'STOXX50', 'IGJP225', 'IGHK50']],
  ['Forex', ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'USDCHF', 'AUDUSD', 'USDCAD', 'EURCHF']],
  ['Matières premières', ['XAUUSD', 'XAGUSD', 'WTI', 'NATGAS', 'COPPER']],
  ['Crypto', ['BTCUSD', 'ETHUSD']],
];

export default function BrokerMarkets() {
  const connected = useBroker((s) => !!s.account);
  const active = useBroker((s) => s.active);
  const [query, setQuery] = useKept('ig.markets.query', '', true);
  const [open, setOpen] = useKept<string[]>('ig.markets.open', ['main:Indices']);
  const [hits, setHits] = useState<IgSearchHit[] | null>(null);
  const [lists, setLists] = useState<IgList[] | null>(null);
  const toggle = (key: string) => setOpen((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));

  // the search waits for the typing to stop (IG allows few requests a minute)
  useEffect(() => {
    const q = query.trim();
    if (!connected || q.length < 2) return;
    let alive = true;
    const t = setTimeout(() => {
      searchIg(q).then((r) => { if (alive) setHits(r.filter(usableIg)); }).catch(() => { if (alive) setHits([]); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [query, connected]);
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    igLists().then((r) => { if (alive) setLists(r); }).catch(() => { if (alive) setLists([]); });
    return () => { alive = false; };
  }, [connected]);
  // the main markets' charts loaded in the background, in the chart's timeframe, once the open
  // chart had its turn: a click then opens them at once
  const timeframe = useStore((s) => s.timeframe);
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => warmFeeds(MAIN.flatMap(([, tickers]) => tickers).map(findSymbol).filter((s) => !!s), timeframe), 3000);
    return () => clearTimeout(t);
  }, [connected, timeframe]);

  const searching = query.trim().length >= 2;
  return (
    <div className="side-panel bk-markets">
      <div className="side-title with-ctl"><BrokerLogo id={active} size={18} /><span className="bk-markets-title">Marchés IG</span><PanelControls panel="broker" /></div>
      {!connected ? (
        <div className="side-empty bk-off">
          {brokerLabel(active)} n’est pas connecté.
          <button className="pill-btn primary" onClick={() => useChartUi.getState().openDialog('brokers')}>Se connecter</button>
        </div>
      ) : (
        <>
          <input className="bk-search" placeholder="Rechercher un marché IG (actions comprises)" value={query} onChange={(e) => setQuery(e.target.value)} />
          {searching ? (
            hits == null ? <div className="side-empty">Recherche…</div>
              : hits.length === 0 ? <div className="side-empty">Aucun marché IG trouvé</div>
                : <div className="bk-rows">{hits.map((h) => <MarketRow key={h.epic} hit={h} />)}</div>
          ) : (
            <>
              <div className="bk-group">Principaux marchés</div>
              {MAIN.map(([name, tickers]) => (
                <Section key={name} title={name} open={open.includes(`main:${name}`)} onToggle={() => toggle(`main:${name}`)}>
                  {tickers.map((t) => <MainRow key={t} ticker={t} />)}
                </Section>
              ))}
              <div className="bk-group">Mes listes IG</div>
              {lists == null ? <div className="side-empty">Chargement…</div> : lists.map((l) => (
                <Section key={l.id} title={l.name} open={open.includes(`list:${l.id}`)} onToggle={() => toggle(`list:${l.id}`)}>
                  <ListRows id={l.id} />
                </Section>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="bk-section">
      <button className="bk-section-head" onClick={onToggle}><span className={`bk-caret ${open ? 'open' : ''}`}>▸</span>{title}</button>
      {open && <div className="bk-rows">{children}</div>}
    </div>
  );
}

// one IG market: its name, its sell / buy prices, and whether it trades now. Dragged onto a chart
// (or a 2 / 4 window, the tabs, out of the window) like a row of the watchlist, its ticket then
// trading that very contract.
function MarketRow({ hit: found, label }: { hit: IgSearchHit; label?: string }) {
  // IG's price now (read every few seconds while the row is shown), else the one the search gave
  useEffect(() => listenIg(found.epic, () => undefined), [found.epic]);
  const live = useBroker((s) => s.igMarkets[found.epic]);
  const hit = live && live.bid != null ? { ...found, bid: live.bid, offer: live.offer, status: live.status } : found;
  const closed = hit.status && hit.status !== 'TRADEABLE';
  const timeframe = useStore((s) => s.timeframe);
  const sym = symbolOfIg(hit.epic, hit.name);
  return (
    <button
      className="bk-row" onClick={() => openIgMarket(hit.epic, hit.name)} title="Ouvrir le graphique et trader ce contrat (ou le glisser sur un graphique)"
      draggable={!!sym}
      onDragStart={(e) => {
        if (!sym) return;
        useBroker.getState().setMarket(sym.ticker, { epic: hit.epic, name: hit.name, fromIg: true });
        setDragSymbol(e, sym);
      }}
      onDragEnd={(e) => { if (sym && e.dataTransfer.dropEffect === 'none' && droppedOutsideWindow(e)) openPopout(sym, timeframe, { left: e.screenX - 120, top: e.screenY - 16 }); }}
    >
      <span className="bk-row-name" translate="no">{label && <b>{label}</b>}{hit.name}</span>
      <span className="bk-row-px">{hit.bid != null && hit.offer != null ? `${hit.bid} / ${hit.offer}` : '—'}</span>
      {closed && <span className="bk-row-status">fermé</span>}
    </button>
  );
}

// a main market of the platform, with the IG contract it trades (found once, then kept)
function MainRow({ ticker }: { ticker: string }) {
  const sym = findSymbol(ticker);
  const known = useBroker((s) => s.markets[ticker]);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!sym || known) return;
    let alive = true;
    igMarketOf(sym).then((m) => { if (alive && !m) setMissing(true); }).catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [sym, known]);
  if (!sym) return null;
  if (!known) return <div className="bk-row muted"><span className="bk-row-name"><b>{ticker}</b>{missing ? 'pas de contrat IG trouvé' : 'recherche…'}</span></div>;
  // IG's own name and price only (the chart it opens shows its own ticker)
  return <MarketRow hit={{ epic: known.epic, name: known.name, type: '', expiry: '-', bid: null, offer: null, status: '' }} />;
}

function ListRows({ id }: { id: string }) {
  const [rows, setRows] = useState<IgSearchHit[] | null>(null);
  useEffect(() => {
    let alive = true;
    igList(id).then((r) => { if (alive) setRows(r); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [id]);
  if (rows == null) return <div className="side-empty">Chargement…</div>;
  if (!rows.length) return <div className="side-empty">Liste vide</div>;
  return <>{rows.map((h) => <MarketRow key={h.epic} hit={h} />)}</>;
}
