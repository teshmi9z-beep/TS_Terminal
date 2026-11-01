import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { brokerLabel, isLive, useBroker } from '../store/broker';
import { amendIgPosition, brokerApi, linkIgMarket, openIgMarket, symbolOfIg } from './brokerAccount';
import { BrokerLogo } from './BrokerDialog';
import { setDragSymbol } from './symbolDnd';
import { droppedOutsideWindow, openPopout } from './popouts';
import { LOCALE } from '../i18n/lang';
import type { Timeframe } from '../types';

const fmt = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const date = (t: number) => (t ? new Date(t).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const money = (v: number | null, cur: string) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${fmt(v)} ${cur}`);

// a position's or an order's row dragged onto a chart (the main one, a 2 / 4 window, a free window,
// the tabs) opens its market there, the ticket then trading that very contract; dropped out of the
// browser window, in a window of its own (like the rows of "Marchés IG")
function dragRow(epic: string, name: string, timeframe: Timeframe) {
  const sym = symbolOfIg(epic, name);
  if (!sym) return {};
  return {
    draggable: true,
    className: 'pf-drag',
    onDragStart: (e: React.DragEvent) => {
      // the stop / limit fields keep their text selection
      if ((e.target as HTMLElement).closest('input')) { e.preventDefault(); return; }
      linkIgMarket(sym, epic, name);
      setDragSymbol(e, sym);
    },
    onDragEnd: (e: React.DragEvent) => {
      if (e.dataTransfer.dropEffect === 'none' && droppedOutsideWindow(e)) openPopout(sym, timeframe, { left: e.screenX - 120, top: e.screenY - 16 });
    },
  };
}

// The panel under the chart for a broker's account (IG demo): its balance, then its positions,
// pending orders and closed trades as IG shows them, in IG's own prices and market names.
export default function BrokerPortfolio() {
  const account = useBroker((s) => s.account);
  const active = useBroker((s) => s.active);
  const snap = useBroker((s) => s.snap);
  const error = useBroker((s) => s.error);
  const rightPanel = useStore((s) => s.rightPanel);
  const showMarks = useStore((s) => s.showTradeMarks);
  const setShowMarks = useStore((s) => s.setShowTradeMarks);
  const openDialog = useChartUi((s) => s.openDialog);
  const timeframe = useStore((s) => s.timeframe);
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions');
  const setWantHistory = useBroker((s) => s.setWantHistory);
  // IG's history is asked only while it is shown
  useEffect(() => { setWantHistory(tab === 'history'); return () => setWantHistory(false); }, [tab, setWantHistory]);

  if (!account) {
    return (
      <div className="portfolio">
        <div className="side-empty bk-off">
          <BrokerLogo id={active} size={28} />
          {brokerLabel(active)} n’est pas connecté.
          <button className="pill-btn primary" onClick={() => openDialog('brokers')}>Se connecter</button>
        </div>
      </div>
    );
  }
  const cur = account.currency;
  // the amounts come with the first snapshot, a moment after signing in
  const amounts = snap?.account;
  const positions = snap?.positions ?? [];
  const orders = snap?.orders ?? [];
  const history = snap?.history ?? [];
  const num = (s: string) => (s.trim() ? parseFloat(s.replace(',', '.')) : null);
  const api = brokerApi();

  return (
    <div className="portfolio">
      <div className="pf-summary">
        <div className={`pf-account bk-account ${isLive(active) ? 'down' : ''}`}><BrokerLogo id={active} size={18} /> {brokerLabel(active)} · {account.id}{isLive(active) && <span className="bk-real-tag">ARGENT RÉEL</span>}</div>
        {amounts ? (
          <>
            <div><span>Capital</span><b>{fmt(amounts.balance + amounts.pnl)} {cur}</b></div>
            <div><span>Solde</span><b>{fmt(amounts.balance)} {cur}</b></div>
            <div><span>P&L latent</span><b className={amounts.pnl >= 0 ? 'up' : 'down'}>{money(amounts.pnl, cur)}</b></div>
            <div><span>Disponible</span><b>{fmt(amounts.available)} {cur}</b></div>
          </>
        ) : <div className="muted">Chargement du compte IG…</div>}
        {error && <div className="bk-error" title={error}>{error}</div>}
        <div className="pf-spacer" />
        <label className="pf-toggle" title="Positions et ordres sur le graphique">
          <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} /> Trades sur le graphique
        </label>
        <button className={`pill-btn ${rightPanel === 'trading' ? '' : 'primary'}`} onClick={() => useStore.getState().toggleTradingPanel()}>
          {rightPanel === 'trading' ? 'Fermer le ticket d’ordre' : 'Passer un ordre'}
        </button>
        <button className="pill-btn" onClick={() => openDialog('guards')}>Garde-fous</button>
        <button className="pill-btn" onClick={() => useStore.getState().setRightPanel('broker')}>Marchés IG</button>
        <button className="pill-btn" onClick={() => openDialog('brokers')}>Changer de courtier</button>
      </div>
      <div className="tr-tabs">
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>Positions ({positions.length})</button>
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Ordres ({orders.length})</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historique</button>
      </div>
      <div className="pf-table-wrap">
        {tab === 'positions' && (
          positions.length === 0 ? <div className="side-empty">Aucune position ouverte chez IG.</div> : (
            <table className="pf-table">
              <thead><tr><th>Marché IG</th><th>Côté</th><th>Taille</th><th>Entrée</th><th>Cours</th><th>P&L</th><th>Stop</th><th>Limite</th><th>Ouverte</th><th /></tr></thead>
              <tbody>
                {positions.map((p) => {
                  const q = p.side === 'long' ? p.bid : p.offer;
                  return (
                    <tr key={p.id} {...dragRow(p.epic, p.name, timeframe)}>
                      <td translate="no"><button className="side-link" title="Ouvrir le graphique (ou glisser la ligne sur un graphique)" onClick={() => openIgMarket(p.epic, p.name)}>{p.name}</button></td>
                      <td><span className={`tr-badge ${p.side}`}>{p.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                      <td>{p.size}</td>
                      <td>{p.level}</td>
                      <td>{q ?? '—'}</td>
                      <td className={p.pnl == null ? '' : p.pnl >= 0 ? 'up' : 'down'}>{money(p.pnl, p.currency)}</td>
                      <td><input key={`${p.id}:sl:${p.sl}`} className="pf-input" defaultValue={p.sl ?? ''} placeholder="—" onBlur={(e) => { const v = num(e.target.value); if (v !== p.sl) amendIgPosition(p.id, v, p.tp); }} /></td>
                      <td><input key={`${p.id}:tp:${p.tp}`} className="pf-input" defaultValue={p.tp ?? ''} placeholder="—" onBlur={(e) => { const v = num(e.target.value); if (v !== p.tp) amendIgPosition(p.id, p.sl, v); }} /></td>
                      <td className="muted">{date(p.openedAt)}</td>
                      <td><button className="pill-btn" onClick={() => api.close(p.id, 0)}>Clôturer</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
        {tab === 'orders' && (
          orders.length === 0 ? <div className="side-empty">Aucun ordre en attente chez IG.</div> : (
            <table className="pf-table">
              <thead><tr><th>Marché IG</th><th>Côté</th><th>Type</th><th>Taille</th><th>Niveau</th><th>Stop</th><th>Limite</th><th>Créé</th><th /></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} {...dragRow(o.epic, o.name, timeframe)}>
                    <td translate="no"><button className="side-link" title="Ouvrir le graphique (ou glisser la ligne sur un graphique)" onClick={() => openIgMarket(o.epic, o.name)}>{o.name}</button></td>
                    <td><span className={`tr-badge ${o.side}`}>{o.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                    <td>{o.type === 'limit' ? 'Limite' : 'Stop'}</td>
                    <td>{o.size}</td>
                    <td>{o.level}</td>
                    <td>{o.sl ?? '—'}</td>
                    <td>{o.tp ?? '—'}</td>
                    <td className="muted">{date(o.createdAt)}</td>
                    <td><button className="pill-btn" onClick={() => api.cancelOrder(o.id)}>Annuler</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        {tab === 'history' && (
          history.length === 0 ? <div className="side-empty">{snap?.history ? 'Aucune transaction clôturée sur 30 jours.' : 'Chargement de l’historique IG…'}</div> : (
            <table className="pf-table">
              <thead><tr><th>Marché IG</th><th>Côté</th><th>Taille</th><th>Entrée</th><th>Sortie</th><th>P&L</th><th>Ouverte</th><th>Clôturée</th></tr></thead>
              <tbody>
                {history.map((t) => (
                  <tr key={t.id + t.closedAt}>
                    <td translate="no">{t.name}</td>
                    <td><span className={`tr-badge ${t.side}`}>{t.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                    <td>{t.size}</td>
                    <td>{t.entry ?? '—'}</td>
                    <td>{t.exit ?? '—'}</td>
                    <td className={t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down'}>{money(t.pnl, cur)}</td>
                    <td className="muted">{date(t.openedAt)}</td>
                    <td className="muted">{date(t.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}
