import { useState } from 'react';
import { useStore } from '../store/store';
import { useQuotes } from '../data/feeds/quotes';
import { pricePrecision } from './chartUtils';
import { findSymbol } from './symbolDnd';
import { LOCALE } from '../i18n/lang';

const fmt = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const date = (t: number) => new Date(t).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// TradingView's paper trading panel, under the chart: account summary, then
// positions / orders / history. Orders are placed from the "Trader" ticket.
export default function PortfolioPanel() {
  const paper = useStore((s) => s.paper);
  const setSymbol = useStore((s) => s.setSymbol);
  const paperClose = useStore((s) => s.paperClose);
  const paperModify = useStore((s) => s.paperModify);
  const paperCancelOrder = useStore((s) => s.paperCancelOrder);
  const paperReset = useStore((s) => s.paperReset);
  const rightPanel = useStore((s) => s.rightPanel);
  const showMarks = useStore((s) => s.showTradeMarks);
  const setShowMarks = useStore((s) => s.setShowTradeMarks);
  const quotes = useQuotes((s) => s.quotes);
  const [tab, setTab] = useState<'positions' | 'orders' | 'history'>('positions');

  const pnlOf = (p: (typeof paper.positions)[number]) => {
    const q = quotes[p.symbol.ticker]?.last;
    return q == null ? null : (q - p.entry) * p.qty * (p.side === 'long' ? 1 : -1);
  };
  const unrealized = paper.positions.reduce((s, p) => s + (pnlOf(p) ?? 0), 0);
  const realized = paper.history.reduce((s, t) => s + t.pnl, 0);
  const equity = paper.balance + unrealized;
  const num = (s: string) => (s.trim() ? parseFloat(s.replace(',', '.')) : undefined);
  const goTo = (ticker: string, sym: (typeof paper.positions)[number]['symbol']) => setSymbol(findSymbol(ticker) ?? sym);

  return (
    <div className="portfolio">
      <div className="pf-summary">
        <div className="pf-account">Compte virtuel</div>
        <div><span>Capital</span><b>{fmt(equity)}</b></div>
        <div><span>Solde</span><b>{fmt(paper.balance)}</b></div>
        <div><span>P&L latent</span><b className={unrealized >= 0 ? 'up' : 'down'}>{unrealized >= 0 ? '+' : ''}{fmt(unrealized)}</b></div>
        <div><span>P&L réalisé</span><b className={realized >= 0 ? 'up' : 'down'}>{realized >= 0 ? '+' : ''}{fmt(realized)}</b></div>
        <div><span>Capital initial</span><b>{fmt(paper.initial)}</b></div>
        <div className="pf-spacer" />
        <label className="pf-toggle" title="Flèches des entrées et croix des clôtures sur les bougies, détail au survol">
          <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} /> Trades sur le graphique
        </label>
        <button className={`pill-btn ${rightPanel === 'trading' ? '' : 'primary'}`} onClick={() => useStore.getState().toggleTradingPanel()}>
          {rightPanel === 'trading' ? 'Fermer le ticket d’ordre' : 'Passer un ordre'}
        </button>
        <button
          className="pill-btn"
          onClick={() => {
            const v = window.prompt('Capital de départ du compte virtuel :', String(paper.initial));
            if (v != null && parseFloat(v) > 0) paperReset(parseFloat(v));
          }}
        >
          Réinitialiser
        </button>
      </div>
      <div className="tr-tabs">
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>Positions ({paper.positions.length})</button>
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Ordres ({paper.orders.length})</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Historique ({paper.history.length})</button>
      </div>
      <div className="pf-table-wrap">
        {tab === 'positions' && (
          paper.positions.length === 0 ? <div className="side-empty">Aucune position ouverte. « Passer un ordre » ou boutons VENTE / ACHAT du graphique.</div> : (
            <table className="pf-table">
              <thead><tr><th>Symbole</th><th>Côté</th><th>Qté</th><th>Prix moyen</th><th>Cours</th><th>P&L</th><th>Stop loss</th><th>Take profit</th><th>Ouverte</th><th /></tr></thead>
              <tbody>
                {paper.positions.map((p) => {
                  const q = quotes[p.symbol.ticker]?.last;
                  const pnl = pnlOf(p);
                  const d = pricePrecision(p.symbol, q ?? p.entry);
                  return (
                    <tr key={p.id}>
                      <td><button className="side-link" onClick={() => goTo(p.symbol.ticker, p.symbol)}>{p.symbol.ticker}</button></td>
                      <td><span className={`tr-badge ${p.side}`}>{p.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                      <td>{p.qty}</td>
                      <td>{p.entry.toFixed(d)}</td>
                      <td>{q != null ? q.toFixed(d) : '—'}</td>
                      <td className={pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}>{pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${fmt(pnl)}`}</td>
                      <td><input className="pf-input" defaultValue={p.sl ?? ''} placeholder="—" onBlur={(e) => paperModify(p.id, { sl: num(e.target.value) })} /></td>
                      <td><input className="pf-input" defaultValue={p.tp ?? ''} placeholder="—" onBlur={(e) => paperModify(p.id, { tp: num(e.target.value) })} /></td>
                      <td className="muted">{date(p.openedAt)}</td>
                      <td><button className="pill-btn" disabled={q == null} onClick={() => { if (q != null) paperClose(p.id, q); }}>Clôturer</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
        {tab === 'orders' && (
          paper.orders.length === 0 ? <div className="side-empty">Aucun ordre en attente.</div> : (
            <table className="pf-table">
              <thead><tr><th>Symbole</th><th>Côté</th><th>Type</th><th>Qté</th><th>Prix</th><th>Stop loss</th><th>Take profit</th><th>Créé</th><th /></tr></thead>
              <tbody>
                {paper.orders.map((o) => (
                  <tr key={o.id}>
                    <td><button className="side-link" onClick={() => goTo(o.symbol.ticker, o.symbol)}>{o.symbol.ticker}</button></td>
                    <td><span className={`tr-badge ${o.side}`}>{o.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                    <td>{o.type === 'limit' ? 'Limite' : 'Stop'}</td>
                    <td>{o.qty}</td>
                    <td>{o.price}</td>
                    <td>{o.sl ?? '—'}</td>
                    <td>{o.tp ?? '—'}</td>
                    <td className="muted">{date(o.createdAt)}</td>
                    <td><button className="pill-btn" onClick={() => paperCancelOrder(o.id)}>Annuler</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        {tab === 'history' && (
          paper.history.length === 0 ? <div className="side-empty">Aucune transaction clôturée.</div> : (
            <table className="pf-table">
              <thead><tr><th>Symbole</th><th>Côté</th><th>Qté</th><th>Entrée</th><th>Sortie</th><th>P&L</th><th>Motif</th><th>Ouverte</th><th>Clôturée</th></tr></thead>
              <tbody>
                {paper.history.map((t) => (
                  <tr key={t.id + t.closedAt}>
                    <td>{t.ticker}</td>
                    <td><span className={`tr-badge ${t.side}`}>{t.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                    <td>{t.qty}</td>
                    <td>{t.entry}</td>
                    <td>{t.exit}</td>
                    <td className={t.pnl >= 0 ? 'up' : 'down'}>{t.pnl >= 0 ? '+' : ''}{fmt(t.pnl)}</td>
                    <td className="muted">{t.reason}</td>
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
