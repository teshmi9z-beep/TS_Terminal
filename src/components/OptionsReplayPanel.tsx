import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { intrinsic, optionPnlEur, OPTIONS_CAPITAL, useOptionsReplay, type OptionPosition } from '../store/optionsReplay';
import { SYMBOLS } from '../data/symbols';
import { COMPANION_EVENT, companion } from '../indicators/companion';
import { currentPrice } from './symbolActions';
import { atmVol, daysText, expiriesAt, quote, ROOTS, rootOf, tradingDaysLeft, volAt, type Root } from '../options/model';
import { LOCALE } from '../i18n/lang';

const n2 = (v: number) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { maximumFractionDigits: 0 })} €`;
const when = (t: number) => new Date(t * 1000).toLocaleString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// the volatility indices' daily bars, loaded once and kept while the panel is shown
function useVols(r: Root | null) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const on = () => redraw((x) => x + 1);
    window.addEventListener(COMPANION_EVENT, on);
    return () => window.removeEventListener(COMPANION_EVENT, on);
  }, []);
  if (!r) return null;
  const from = Math.floor(Date.now() / 1000) - 6 * 365 * 86400;
  const load = (t: string) => { const s = SYMBOLS.find((x) => x.ticker === t); return s ? companion(s, '1D', from) : null; };
  return { v1d: load('VIX1D'), vix: load('VIX'), v30: load(r.vol30) };
}

// a small line of the option's value since it was opened
function Spark({ marks, entry }: { marks: OptionPosition['marks']; entry: number }) {
  if (marks.length < 2) return <span className="muted">—</span>;
  const w = 120, h = 28;
  const vs = marks.map((m) => m.v);
  const lo = Math.min(...vs, entry), hi = Math.max(...vs, entry), span = hi - lo || 1;
  const x = (i: number) => (i / (marks.length - 1)) * w, y = (v: number) => h - ((v - lo) / span) * h;
  const last = vs[vs.length - 1];
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1={0} x2={w} y1={y(entry)} y2={y(entry)} stroke="var(--text-faint)" strokeDasharray="3 3" strokeWidth={1} />
      <polyline fill="none" stroke={last >= entry ? 'var(--up)' : 'var(--down)'} strokeWidth={1.5} points={vs.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
    </svg>
  );
}

// Bottom tab "Options replay": during a bar replay of a CME index future (US500, US100,
// US30), the chain of its options priced by the model (src/options/model.ts), bought and
// sold with an account of its own, and what each position earns or loses through the price
// moving and through time passing.
export default function OptionsReplayPanel() {
  const symbol = useStore((s) => s.symbol);
  const replayOn = useChartUi((s) => s.replay.mode === 'on');
  useChartUi((s) => s.replay.at);
  const { balance, positions, history, open, close, mark, reset } = useOptionsReplay();
  const [expIdx, setExpIdx] = useState(0);
  const [qty, setQty] = useState(1);
  const [learn, setLearn] = useState(true);
  const r = rootOf(symbol.ticker);
  const vols = useVols(r);
  const cur = currentPrice();
  const F = cur?.price ?? NaN, t = cur?.time ?? 0;

  // volatilities now: the one-day index (VIX1D, brought to the Nasdaq / Dow × their 30-day
  // index / VIX), and the 30-day one
  const v = useMemo(() => {
    if (!vols || !r) return null;
    const ok = (c: ReturnType<typeof companion> | null) => (c?.state === 'ready' ? c.candles : []);
    const v30 = volAt(ok(vols.v30), t), vix = volAt(ok(vols.vix), t), v1 = volAt(ok(vols.v1d), t);
    const v1d = r.vol30 === 'VIX' ? v1 : (v30 * v1) / vix;
    return { v30, v1d, loading: [vols.v1d, vols.vix, vols.v30].some((c) => c?.state === 'loading') };
  }, [vols, r, t]);

  const exps = useMemo(() => (t ? expiriesAt(t) : []), [t]);
  const exp = exps[Math.min(expIdx, exps.length - 1)];
  const days = exp ? tradingDaysLeft(t, exp.time) : 0;
  const atm = v ? atmVol(v.v1d, v.v30, days) : NaN;

  // the price of each open position now, and its mark on the small chart
  const valueOf = (p: OptionPosition) => {
    if (p.future !== symbol.ticker || !replayOn || !Number.isFinite(F) || !v) return null;
    const d = tradingDaysLeft(t, p.expiry);
    if (d <= 0) return intrinsic(p, F);
    const a = atmVol(v.v1d, v.v30, d);
    return Number.isFinite(a) ? quote(r!, F, p.strike, d, a, p.call).mid : null;
  };
  useEffect(() => {
    for (const p of positions) { const val = valueOf(p); if (val != null) mark(p.id, t, val); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const showToast = useChartUi((s) => s.showToast);
  if (!r) {
    return (
      <div className="portfolio"><div className="side-empty">
        Mets en replay le future d’un indice : {ROOTS.map((x) => `${x.future} (options ${x.root})`).join(', ')}. Le prix des options est calculé à chaque bougie à partir du future et de la volatilité du jour.
      </div></div>
    );
  }
  const unreal = positions.reduce((s, p) => { const val = valueOf(p); return val == null ? s : s + optionPnlEur(p, val); }, 0);
  const ready = replayOn && Number.isFinite(F) && Number.isFinite(atm) && exp;

  // the strikes around the price
  const step = r.strikeStep, center = Math.round(F / step) * step;
  const strikes = ready ? Array.from({ length: 21 }, (_, i) => center + (i - 10) * step) : [];
  const trade = (call: boolean, K: number, side: 'long' | 'short') => {
    const q = quote(r, F, K, days, atm, call);
    const price = side === 'long' ? q.ask : q.bid;
    if (price <= 0) { showToast('Personne n’achète cette option : elle ne vaut presque rien'); return; }
    open({ future: r.future, call, strike: K, expiry: exp!.time, expiryLabel: exp!.label, side, qty, entry: price, entryF: F, openedAt: t });
    const cost = price * r.mult * qty;
    showToast(`${side === 'long' ? 'Achat' : 'Vente'} ${qty} ${r.root} ${call ? 'call' : 'put'} ${K} (${exp!.label}) à ${n2(price)} pts = ${n2(cost)} $ ${side === 'long' ? 'payés' : 'encaissés'}`);
  };

  return (
    <div className="portfolio">
      <div className="pf-summary">
        <div className="pf-account">Options replay · {r.root}</div>
        <div><span>Capital</span><b>{n2(balance + unreal)} €</b></div>
        <div><span>P&L latent</span><b className={unreal >= 0 ? 'up' : 'down'}>{eur(unreal)}</b></div>
        <div><span>Résultat</span><b className={balance >= OPTIONS_CAPITAL ? 'up' : 'down'}>{eur(balance - OPTIONS_CAPITAL)}</b></div>
        <div><span>Future</span><b>{Number.isFinite(F) ? n2(F) : '—'}</b></div>
        <div><span>Vol 1 j / 30 j</span><b>{v && Number.isFinite(v.v1d) ? n2(v.v1d) : '—'} / {v && Number.isFinite(v.v30) ? n2(v.v30) : '—'}</b></div>
        <div><span>Heure replay</span><b>{t ? when(t) : '—'}</b></div>
        <div className="pf-spacer" />
        <label className="pf-toggle" title="Une ligne d’explication sous chaque position"><input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} /> Mode apprendre</label>
        <label className="pf-toggle">Contrats <input type="number" min={1} max={50} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(50, Math.round(+e.target.value) || 1)))} style={{ width: 48 }} /></label>
        <button className="pill-btn" disabled={positions.length > 0} title="Remet le compte options à 10 000 € (positions fermées d’abord)" onClick={reset}>Remettre à 10 000 €</button>
      </div>

      {!replayOn && <div className="rp-note" style={{ padding: '8px 12px' }}>Lance un replay sur {r.future} (bouton Replay en haut) : la chaîne d’options suit chaque bougie rejouée.</div>}
      {replayOn && v?.loading && <div className="rp-note" style={{ padding: '8px 12px' }}>Chargement des indices de volatilité…</div>}
      {replayOn && !v?.loading && !Number.isFinite(atm) && <div className="rp-note" style={{ padding: '8px 12px' }}>Pas de volatilité connue à cette date (VIX1D depuis avril 2023).</div>}

      <div className="pf-table-wrap" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        {ready && (
          <div style={{ flex: '0 0 auto' }}>
            <div className="tr-tabs" style={{ flexWrap: 'wrap' }}>
              {exps.map((e, i) => (
                <button key={e.day} className={exp === e ? 'active' : ''} onClick={() => setExpIdx(i)}>{e.label}</button>
              ))}
            </div>
            <div className="rp-note" style={{ padding: '4px 10px' }}>
              Reste {daysText(days)} · vol {n2(atm * 100)} % · mouvement attendu ± {n2(F * atm * Math.sqrt(days / 252))} pts · 1 pt = {r.mult} $
            </div>
            <table className="pf-table">
              <thead><tr><th>Δ call</th><th>Call vente</th><th>Call achat</th><th style={{ textAlign: 'center' }}>Strike</th><th>Put vente</th><th>Put achat</th><th>Δ put</th></tr></thead>
              <tbody>
                {strikes.map((K) => {
                  const c = quote(r, F, K, days, atm, true), p = quote(r, F, K, days, atm, false);
                  const atRow = K === center;
                  return (
                    <tr key={K} style={atRow ? { background: 'var(--bg-hover)' } : undefined}>
                      <td className="muted">{c.delta.toFixed(2)}</td>
                      <td><button className="pill-btn" title="Vendre ce call (encaisser la prime)" onClick={() => trade(true, K, 'short')}>{n2(c.bid)}</button></td>
                      <td><button className="pill-btn" title="Acheter ce call (parier sur la hausse)" onClick={() => trade(true, K, 'long')}><b className="up">{n2(c.ask)}</b></button></td>
                      <td style={{ textAlign: 'center', fontWeight: atRow ? 700 : 400, background: K < F ? 'rgba(8,153,129,.08)' : 'rgba(242,54,69,.08)' }}>{K}</td>
                      <td><button className="pill-btn" title="Vendre ce put (encaisser la prime)" onClick={() => trade(false, K, 'short')}>{n2(p.bid)}</button></td>
                      <td><button className="pill-btn" title="Acheter ce put (parier sur la baisse)" onClick={() => trade(false, K, 'long')}><b className="down">{n2(p.ask)}</b></button></td>
                      <td className="muted">{p.delta.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ flex: 1, minWidth: 360 }}>
          <table className="pf-table">
            <thead><tr><th>Option</th><th>Côté</th><th>Entrée</th><th>Valeur</th><th>P&L</th><th>Depuis l’achat</th><th>Échéance</th><th /></tr></thead>
            <tbody>
              {positions.length === 0 && <tr><td colSpan={8} className="muted">Aucune position. Clique sur un prix de la chaîne : à droite pour acheter, à gauche pour vendre.</td></tr>}
              {positions.map((p) => {
                const val = valueOf(p);
                const pnl = val == null ? null : optionPnlEur(p, val);
                const left = tradingDaysLeft(t, p.expiry);
                // what the price move did and what the time did: the option repriced at the
                // future of its entry with the time left now
                let hint = '';
                if (learn && val != null && v) {
                  const a = atmVol(v.v1d, v.v30, left);
                  const sameF = left > 0 && Number.isFinite(a) ? quote(r, p.entryF, p.strike, left, a, p.call).mid : intrinsic(p, p.entryF);
                  const sgn = p.side === 'long' ? 1 : -1;
                  const k = r.mult * p.qty * sgn;
                  const timePart = (sameF - p.entry) * k, movePart = (val - sameF) * k;
                  const itm = intrinsic(p, F) > 0;
                  hint = `Cours ${movePart >= 0 ? '+' : '−'}${n2(Math.abs(movePart))} $ · temps et volatilité ${timePart >= 0 ? '+' : '−'}${n2(Math.abs(timePart))} $ · ${itm ? 'dans la monnaie' : 'hors de la monnaie'}`
                    + (p.side === 'long' && timePart < -Math.abs(movePart) ? ' — le temps te coûte plus que le cours ne te rapporte' : '')
                    + (p.side === 'short' && timePart > 0 && movePart < 0 ? ' — le temps te paie, le cours joue contre toi' : '');
                }
                return (
                  <tr key={p.id}>
                    <td>
                      {r.root} {p.call ? 'Call' : 'Put'} {p.strike}
                      {p.future !== symbol.ticker && <span className="muted"> · {p.future}</span>}
                      {hint && <div className="muted" style={{ fontSize: 11 }}>{hint}</div>}
                    </td>
                    <td><span className={`tr-badge ${p.side}`}>{p.side === 'long' ? 'Achat' : 'Vente'} ×{p.qty}</span></td>
                    <td>{n2(p.entry)}</td>
                    <td>{val == null ? '—' : n2(val)}</td>
                    <td className={pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}>{pnl == null ? '—' : eur(pnl)}</td>
                    <td><Spark marks={p.marks} entry={p.entry} /></td>
                    <td className="muted">{p.expiryLabel}<br />{left > 0 ? `reste ${daysText(left)}` : 'expire'}</td>
                    <td>
                      <button className="pill-btn" disabled={val == null} onClick={() => {
                        if (val == null) return;
                        const q = left > 0 ? quote(r, F, p.strike, left, atmVol(v!.v1d, v!.v30, left), p.call) : null;
                        const price = q ? (p.side === 'long' ? q.bid : q.ask) : val;
                        const got = close(p.id, price, t);
                        showToast(`Option clôturée à ${n2(price)} pts (${eur(got)})`);
                      }}>Clôturer</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {history.length > 0 && (
            <table className="pf-table" style={{ marginTop: 10 }}>
              <thead><tr><th>Trades clôturés</th><th>Côté</th><th>Entrée</th><th>Sortie</th><th>P&L</th><th>Fin</th></tr></thead>
              <tbody>
                {history.slice(0, 30).map((h) => (
                  <tr key={h.id}>
                    <td>{rootOf(h.future)?.root} {h.call ? 'Call' : 'Put'} {h.strike} <span className="muted">· {h.expiryLabel}</span></td>
                    <td>{h.side === 'long' ? 'Achat' : 'Vente'} ×{h.qty}</td>
                    <td>{n2(h.entry)}</td>
                    <td>{n2(h.exit)}</td>
                    <td className={h.pnl >= 0 ? 'up' : 'down'}>{eur(h.pnl)}</td>
                    <td className="muted">{h.reason === 'échéance' ? (h.exit > 0 ? 'échéance, réglée' : 'expirée sans valeur') : when(h.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
