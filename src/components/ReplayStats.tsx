import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { PaperTrade } from '../store/store';
import { REPLAY_CAPITAL, useReplayTrading, type ReplaySession } from '../store/replayTrading';
import type { TradeFilter } from '../strategy/stats';
import { Dashboard } from './strategy/StrategyReport';
import { equityAfter, paperStats, type Span } from './paperStats';
import { LOCALE } from '../i18n/lang';

const fmt = (v: number) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))} €`;
// replay times: the date of the replayed bar
const when = (ms: number) => new Date(ms).toLocaleString(LOCALE, { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const day = (s: number | null) => (s == null ? '—' : new Date(s * 1000).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' }));
const played = (s: ReplaySession) => new Date(s.endedAt ?? s.startedAt).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const REASON: Record<PaperTrade['reason'], string> = { manuel: 'manuel', stop: 'stop', objectif: 'objectif', robot: 'robot', fin: 'fin de session' };

export function TradesTable({ trades }: { trades: PaperTrade[] }) {
  return (
    <table className="pf-table">
      <thead><tr><th>Symbole</th><th>Côté</th><th>Qté</th><th>Entrée</th><th>Sortie</th><th>P&L</th><th>Motif</th><th>Ouverte</th><th>Clôturée</th></tr></thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id + t.closedAt}>
            <td>{t.ticker}</td>
            <td><span className={`tr-badge ${t.side}`}>{t.side === 'long' ? 'Achat' : 'Vente'}</span></td>
            <td>{t.qty}</td>
            <td>{t.entry}</td>
            <td>{t.exit}</td>
            <td className={t.pnl >= 0 ? 'up' : 'down'}>{eur(t.pnl)}</td>
            <td className="muted">{REASON[t.reason]}</td>
            <td className="muted">{when(t.openedAt)}</td>
            <td className="muted">{when(t.closedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// the capital after each trade (by trade number), with the starting capital as base line
function EquityCurve({ values }: { values: number[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w, h } = size;
  const L = 8, R = 76, T = 14, B = 22;
  const pw = Math.max(10, w - L - R), ph = Math.max(10, h - T - B);
  const base = values[0] ?? REPLAY_CAPITAL;
  const hi = Math.max(...values), lo = Math.min(...values);
  const span = hi - lo || 1;
  const x = (i: number) => L + (values.length > 1 ? (i / (values.length - 1)) * pw : pw / 2);
  const y = (v: number) => T + ((hi - v) / span) * ph;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1] ?? base;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - L) / pw) * (values.length - 1));
    setHover(values.length > 1 && i >= 0 && i < values.length ? i : null);
  };
  return (
    <div className="rps-equity" ref={wrap}>
      {w > 0 && values.length > 1 && (
        <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {[hi, base, lo].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
            <g key={v}>
              <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} stroke={v === base ? 'var(--text-faint)' : 'var(--border)'} strokeDasharray={v === base ? '4 3' : undefined} />
              <text x={L + pw + 6} y={y(v)} dominantBaseline="middle" fontSize="10" fill="var(--text-muted)">{fmt(v)}</text>
            </g>
          ))}
          <path d={`${line} L${x(values.length - 1).toFixed(1)} ${(T + ph).toFixed(1)} L${x(0).toFixed(1)} ${(T + ph).toFixed(1)} Z`} fill="rgba(41, 98, 255, 0.12)" />
          <path d={line} fill="none" stroke="#2962ff" strokeWidth="2" strokeLinejoin="round" />
          <text x={L} y={h - 6} fontSize="10" fill="var(--text-muted)">départ</text>
          <text x={L + pw} y={h - 6} fontSize="10" fill="var(--text-muted)" textAnchor="end">trade {values.length - 1}</text>
          <rect x={L + pw + 2} y={y(last) - 8} width={R - 6} height={16} rx={2} fill={last >= base ? '#089981' : '#f23645'} />
          <text x={L + pw + 6} y={y(last)} dominantBaseline="middle" fontSize="10" fill="#fff">{fmt(last)}</text>
          {hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ph} stroke="var(--text-faint)" />
              <circle cx={x(hover)} cy={y(values[hover])} r={4} fill="#2962ff" stroke="var(--bg-panel)" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {hover != null && (
        <div className="rp-perf-tip" style={{ left: x(hover) > w / 2 ? undefined : x(hover) + 12, right: x(hover) > w / 2 ? w - x(hover) + 12 : undefined, top: 8 }}>
          <div className="rp-perf-tip-head">{hover === 0 ? 'Départ' : `Après le trade ${hover}`}</div>
          <div className="rp-perf-tip-row"><span>Capital</span><b>{fmt(values[hover])} €</b></div>
          {hover > 0 && <div className="rp-perf-tip-row"><span>Trade</span><b className={values[hover] >= values[hover - 1] ? 'pos' : 'neg'}>{eur(values[hover] - values[hover - 1])}</b></div>}
          <div className="rp-perf-tip-row total"><span>Depuis le départ</span><b className={values[hover] >= base ? 'pos' : 'neg'}>{eur(values[hover] - base)}</b></div>
        </div>
      )}
      {values.length <= 1 && <div className="side-empty">Aucun trade clôturé.</div>}
    </div>
  );
}

type View = 'dashboard' | 'sessions' | 'trades' | 'equity';
const VIEWS: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Tableau de bord' },
  { id: 'sessions', label: 'Liste des sessions' },
  { id: 'trades', label: 'Liste des trades' },
  { id: 'equity', label: 'Courbe de capital' },
];
const FILTERS: { id: TradeFilter; label: string }[] = [
  { id: 'all', label: 'Tous les trades' },
  { id: 'long', label: 'Positions acheteuses' },
  { id: 'short', label: 'Positions vendeuses' },
];

// "Sessions passées" of the replay tab: the strategy tester's statistics (dashboard,
// trades, capital curve) for all the sessions played, one of them, or the one in progress
export default function ReplaySessionsStats() {
  const sessions = useReplayTrading((s) => s.sessions);
  const account = useReplayTrading((s) => s.account);
  const current = useReplayTrading((s) => s.session);
  const clearSessions = useReplayTrading((s) => s.clearSessions);
  const [view, setView] = useState<View>('dashboard');
  const [scopeRaw, setScope] = useState<string>('all');
  const [filter, setFilter] = useState<TradeFilter>('all');
  const [openSession, setOpenSession] = useState<string | null>(null);
  const hasCurrent = account.history.length > 0;
  // a scope that is gone (history cleared, session ended) falls back to all
  const scope = scopeRaw === 'current' ? (hasCurrent ? 'current' : 'all') : scopeRaw === 'all' || sessions.some((s) => s.id === scopeRaw) ? scopeRaw : 'all';

  // the trades of the scope, in the order the capital moved (sessions oldest first)
  const picked = useMemo(() => {
    if (scope === 'current') return { trades: account.history, initial: account.initial, spans: [{ from: current.from, to: current.to }] as Span[], ordered: false };
    const list = scope === 'all' ? [...sessions].reverse() : sessions.filter((s) => s.id === scope);
    const trades = list.flatMap((s) => [...s.trades].sort((a, b) => a.closedAt - b.closedAt || a.openedAt - b.openedAt));
    return { trades, initial: list[0]?.initial ?? REPLAY_CAPITAL, spans: list.map((s) => ({ from: s.from, to: s.to })), ordered: true };
  }, [scope, sessions, account.history, account.initial, current.from, current.to]);
  const stats = useMemo(() => paperStats(picked.trades, picked.initial, picked.spans, filter, picked.ordered), [picked, filter]);
  const equity = useMemo(() => equityAfter(stats.trades, picked.initial), [stats.trades, picked.initial]);
  const shownTrades = useMemo(() => {
    const list = filter === 'all' ? picked.trades : picked.trades.filter((t) => t.side === filter);
    return [...list].reverse();
  }, [picked.trades, filter]);

  if (!sessions.length && !hasCurrent) {
    return <div className="side-empty">Aucune session terminée. Une session se range ici quand vous quittez le replay, en choisissez un autre départ, ou avec « Terminer la session ». Ses statistiques s’affichent alors ici, comme dans le testeur de stratégie.</div>;
  }
  const label = (s: ReplaySession) => {
    const res = (s.final ?? s.initial) - s.initial;
    return `${played(s)} · ${s.tickers.join(', ')} · ${s.trades.length} trade${s.trades.length > 1 ? 's' : ''} · ${eur(res)}`;
  };

  return (
    <div className="rps">
      <div className="rp-head">
        <select className="rp-view" value={view} onChange={(e) => setView(e.target.value as View)}>
          {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <div className="rp-strategy">
          <select className="rps-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            {sessions.length > 0 && <option value="all">Toutes les sessions ({sessions.length})</option>}
            {hasCurrent && <option value="current">Session en cours ({account.history.length} trade{account.history.length > 1 ? 's' : ''})</option>}
            {sessions.length > 0 && (
              <optgroup label="Une session">
                {sessions.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
              </optgroup>
            )}
          </select>
          <select value={filter} onChange={(e) => setFilter(e.target.value as TradeFilter)}>
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        <div className="rp-period">
          <div><span>Début :</span> {day(stats.startTime || null)} <b>[{fmt(stats.startEquity)} €]</b></div>
          <div><span>Fin :</span> {day(stats.endTime || null)} <b>[{fmt(stats.endEquity)} €]</b></div>
        </div>
        <div className="rp-spacer" />
        <span className="rp-src">
          {scope === 'all' ? 'Les sessions à la suite, en partant de 10 000 €' : 'Période rejouée'} · P&L en €, frais compris
        </span>
        {sessions.length > 0 && (
          <button className="pill-btn" onClick={() => { if (window.confirm('Effacer l’historique des sessions replay ?')) clearSessions(); }}>Effacer l’historique</button>
        )}
      </div>
      <div className="rp-body">
        {view === 'dashboard' && <Dashboard s={stats} cur="€" />}
        {view === 'trades' && (shownTrades.length ? <TradesTable trades={shownTrades} /> : <div className="side-empty">Aucun trade.</div>)}
        {view === 'equity' && <EquityCurve values={equity} />}
        {view === 'sessions' && (
          sessions.length === 0 ? <div className="side-empty">Aucune session terminée : la session en cours se range ici quand elle se termine.</div> : (
            <table className="pf-table">
              <thead><tr><th>Jouée le</th><th>Symboles</th><th>Période rejouée</th><th>Trades</th><th>Gagnants</th><th>Ratio G/P</th><th>Drawdown max</th><th>Résultat</th><th>Capital final</th><th /></tr></thead>
              <tbody>
                {sessions.map((s) => {
                  const ss = paperStats(s.trades, s.initial, [{ from: s.from, to: s.to }], 'all');
                  const res = (s.final ?? s.initial) - s.initial;
                  const isOpen = openSession === s.id;
                  return (
                    <Fragment key={s.id}>
                      <tr className="rp-session-row" title="Cliquer pour voir ses trades" onClick={() => setOpenSession(isOpen ? null : s.id)}>
                        <td>{isOpen ? '▾' : '▸'} {played(s)}</td>
                        <td>{s.tickers.join(', ')}</td>
                        <td className="muted">{day(s.from)} → {day(s.to)}</td>
                        <td>{ss.total}</td>
                        <td>{ss.total ? `${ss.winRate.toFixed(0)} %` : '—'}</td>
                        <td>{ss.total ? (Number.isFinite(ss.profitFactor) ? fmt(ss.profitFactor) : '∞') : '—'}</td>
                        <td className={ss.maxDrawdown < 0 ? 'down' : ''}>{ss.maxDrawdown < 0 ? `−${fmt(-ss.maxDrawdown)} €` : '—'}</td>
                        <td className={res >= 0 ? 'up' : 'down'}>{eur(res)}</td>
                        <td>{fmt(s.final ?? s.initial)} €</td>
                        <td>
                          <button className="pill-btn" onClick={(e) => { e.stopPropagation(); setScope(s.id); setView('dashboard'); }}>Statistiques</button>
                        </td>
                      </tr>
                      {isOpen && <tr className="rp-session-trades"><td colSpan={10}><TradesTable trades={s.trades} /></td></tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}

