import { useState } from 'react';
import { useStore, type PaperTrade } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { tradePnlEur, useReplayTrading } from '../store/replayTrading';
import ReplaySessionsStats, { TradesTable } from './ReplayStats';
import { pricePrecision } from './chartUtils';
import { currentPrice } from './symbolActions';
import { endReplaySession, tradingApi } from './tradingAccount';
import { LOCALE } from '../i18n/lang';

const fmt = (v: number) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))} €`;
// replay times: the date of the replayed bar
const when = (ms: number) => new Date(ms).toLocaleString(LOCALE, { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// win rate, total and deepest fall of the capital over a list of trades (newest first)
function statsOf(trades: PaperTrade[], initial: number) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  let eq = initial, peak = initial, dd = 0;
  for (const t of [...trades].reverse()) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { n, winRate: n ? (wins / n) * 100 : 0, total, dd };
}

// Bottom tab "Trading virtuel replay": the replay account's session (positions,
// orders, trades, results) and the sessions already played, with the strategy
// tester's statistics.
export default function ReplayTradingPanel() {
  const account = useReplayTrading((s) => s.account);
  const sessions = useReplayTrading((s) => s.sessions);
  const lastPrice = useReplayTrading((s) => s.lastPrice);
  const showMarks = useStore((s) => s.showTradeMarks);
  const setShowMarks = useStore((s) => s.setShowTradeMarks);
  const replayOn = useChartUi((s) => s.replay.mode === 'on');
  useChartUi((s) => s.replay.at);
  const ticker = useStore((s) => s.symbol.ticker);
  const [tab, setTab] = useState<'positions' | 'orders' | 'trades' | 'sessions'>('positions');
  const api = tradingApi(true);

  // a position's price: the replay bar for the charted symbol, else where its replay stopped
  const priceOf = (t: string) => (replayOn && t === ticker ? currentPrice()?.price : undefined) ?? lastPrice[t]?.price ?? null;
  const unrealized = account.positions.reduce((s, p) => { const q = priceOf(p.symbol.ticker); return q == null ? s : s + tradePnlEur(p, q); }, 0);
  const st = statsOf(account.history, account.initial);
  const sessionPnl = account.balance - account.initial;
  const busy = account.history.length + account.positions.length + account.orders.length > 0;
  // every open position closed at its price (the replay bar, or where its replay stopped)
  const closeAll = () => {
    let n = 0, pnl = 0;
    for (const p of account.positions) {
      const q = priceOf(p.symbol.ticker);
      if (q == null) continue;
      pnl += tradePnlEur(p, q);
      api.close(p.id, q);
      n++;
    }
    if (n) useChartUi.getState().showToast(`Replay : ${n} position${n > 1 ? 's' : ''} clôturée${n > 1 ? 's' : ''} (${eur(pnl)})`);
  };
  const cancelAll = () => { for (const o of account.orders) api.cancelOrder(o.id); };

  return (
    <div className="portfolio">
      <div className="pf-summary">
        <div className="pf-account">Compte replay</div>
        <div><span>Capital</span><b>{fmt(account.balance + unrealized)} €</b></div>
        <div><span>P&L latent</span><b className={unrealized >= 0 ? 'up' : 'down'}>{eur(unrealized)}</b></div>
        <div><span>Session</span><b className={sessionPnl >= 0 ? 'up' : 'down'}>{eur(sessionPnl)}</b></div>
        <div><span>Trades</span><b>{st.n}</b></div>
        <div><span>Gagnants</span><b>{st.n ? `${st.winRate.toFixed(0)} %` : '—'}</b></div>
        <div><span>Pire baisse</span><b className={st.dd > 0 ? 'down' : ''}>{st.dd > 0 ? `−${fmt(st.dd)} €` : '—'}</b></div>
        <div className="pf-spacer" />
        {!replayOn && <span className="rp-note">Lancez un replay (bouton Replay en haut) pour trader dans le passé.</span>}
        <label className="pf-toggle" title="Flèches des entrées et croix des clôtures sur les bougies, détail au survol">
          <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} /> Trades sur le graphique
        </label>
        <button className="pill-btn" disabled={!account.positions.length} title="Clôture toutes les positions ouvertes à leur cours de replay (les ordres en attente restent)" onClick={closeAll}>
          Tout clôturer
        </button>
        <button className="pill-btn" disabled={!busy} title="Ferme les positions à leur dernier cours de replay et range la session dans l’historique" onClick={endReplaySession}>
          Terminer la session
        </button>
      </div>
      <div className="tr-tabs">
        <button className={tab === 'positions' ? 'active' : ''} onClick={() => setTab('positions')}>Positions ({account.positions.length})</button>
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Ordres ({account.orders.length})</button>
        <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Trades de la session ({account.history.length})</button>
        <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>Sessions passées ({sessions.length})</button>
      </div>
      <div className="pf-table-wrap">
        {tab === 'positions' && (
          account.positions.length === 0 ? <div className="side-empty">Aucune position. Pendant un replay : boutons VENTE / ACHAT, bouton Ordre de la barre de gauche ou « Passer un ordre ». Capital de départ : 10 000 € par session.</div> : (
            <table className="pf-table">
              <thead><tr><th>Symbole</th><th>Côté</th><th>Qté</th><th>Entrée</th><th>Cours</th><th>P&L</th><th>Stop</th><th>Objectif</th><th>Ouverte</th><th /></tr></thead>
              <tbody>
                {account.positions.map((p) => {
                  const q = priceOf(p.symbol.ticker);
                  const pnl = q != null ? tradePnlEur(p, q) : null;
                  const d = pricePrecision(p.symbol, q ?? p.entry);
                  const paused = !(replayOn && p.symbol.ticker === ticker);
                  return (
                    <tr key={p.id}>
                      <td>{p.symbol.ticker}{paused && <span className="muted" title="Son replay avance quand ce symbole est sur le graphique"> · en pause</span>}</td>
                      <td><span className={`tr-badge ${p.side}`}>{p.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                      <td>{p.qty}</td>
                      <td>{p.entry.toFixed(d)}</td>
                      <td>{q != null ? q.toFixed(d) : '—'}</td>
                      <td className={pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}>{pnl == null ? '—' : eur(pnl)}</td>
                      <td>{p.sl ?? '—'}</td>
                      <td>{p.tp ?? '—'}</td>
                      <td className="muted">{when(p.openedAt)}</td>
                      <td><button className="pill-btn" disabled={q == null} onClick={() => { if (q != null) api.close(p.id, q); }}>Clôturer</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
        {tab === 'orders' && (
          account.orders.length === 0 ? <div className="side-empty">Aucun ordre en attente.</div> : (
            <table className="pf-table">
              <thead><tr><th>Symbole</th><th>Côté</th><th>Type</th><th>Qté</th><th>Prix</th><th>Stop</th><th>Objectif</th><th>Placé</th><th>{account.orders.length > 1 && <button className="pill-btn" onClick={cancelAll}>Tout annuler</button>}</th></tr></thead>
              <tbody>
                {account.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.symbol.ticker}</td>
                    <td><span className={`tr-badge ${o.side}`}>{o.side === 'long' ? 'Achat' : 'Vente'}</span></td>
                    <td>{o.type === 'limit' ? 'Limite' : 'Stop'}</td>
                    <td>{o.qty}</td>
                    <td>{o.price}</td>
                    <td>{o.sl ?? '—'}</td>
                    <td>{o.tp ?? '—'}</td>
                    <td className="muted">{when(o.createdAt)}</td>
                    <td><button className="pill-btn" onClick={() => api.cancelOrder(o.id)}>Annuler</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        {tab === 'trades' && (account.history.length === 0 ? <div className="side-empty">Aucun trade clôturé dans cette session.</div> : <TradesTable trades={account.history} />)}
        {tab === 'sessions' && <ReplaySessionsStats />}
      </div>
    </div>
  );
}
