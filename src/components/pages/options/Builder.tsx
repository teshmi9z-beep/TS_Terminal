import { useMemo, useState } from 'react';
import { byStrike, daysTo, expiryTime, legsPnl, mid, payoffStats, type Expiration, type Leg, type Underlying } from '../../../data/options';
import { fr, pct, signCls } from '../../../data/format';
import { nextId } from '../../../store/store';
import { useChain, useWidth } from './hooks';
import { expLabel, strikeLabel } from './format';
import { LOCALE } from '../../../i18n/lang';

const DAY = 86400000;

function Payoff({ legs, spot, at, cur }: { legs: Leg[]; spot: number; at: number; cur: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(w, 200), h = 380, padL = 70, padB = 26, padT = 12, padR = 10, N = 240;
  const strikes = legs.map((l) => l.strike);
  const lo = Math.min(spot * 0.85, ...strikes.map((k) => k * 0.95));
  const hi = Math.max(spot * 1.15, ...strikes.map((k) => k * 1.05));
  const pts = useMemo(() => Array.from({ length: N + 1 }, (_, i) => {
    const s = lo + ((hi - lo) * i) / N;
    return { s, exp: legsPnl(legs, s), now: legsPnl(legs, s, at) };
  }), [legs, lo, hi, at]);
  const ys = pts.flatMap((p) => [p.exp, p.now]);
  let y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const pad = (y1 - y0 || 1) * 0.08;
  y0 -= pad; y1 += pad;
  const x = (s: number) => padL + ((s - lo) / (hi - lo)) * (W - padL - padR);
  const y = (v: number) => padT + ((y1 - v) / (y1 - y0)) * (h - padT - padB);
  const path = (k: 'exp' | 'now') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.s).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const area = `${path('exp')}L${x(hi)},${y(0)}L${x(lo)},${y(0)}Z`;
  const hp = hover != null ? pts[hover] : null;
  return (
    <div className="op-payoff" ref={ref}>
      <svg
        width={W} height={h}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const s = lo + ((e.clientX - r.left - padL) / (W - padL - padR)) * (hi - lo);
          setHover(Math.max(0, Math.min(N, Math.round(((s - lo) / (hi - lo)) * N))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id="op-above"><rect x="0" y="0" width={W} height={y(0)} /></clipPath>
          <clipPath id="op-below"><rect x="0" y={y(0)} width={W} height={h} /></clipPath>
        </defs>
        {Array.from({ length: 6 }, (_, i) => y0 + ((y1 - y0) * i) / 5).map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="op-grid" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="op-axis">{fr(t, 0)}</text>
          </g>
        ))}
        {Array.from({ length: 7 }, (_, i) => lo + ((hi - lo) * i) / 6).map((t) => (
          <text key={t} x={x(t)} y={h - 8} textAnchor="middle" className="op-axis">{fr(t, t > 100 ? 0 : 2)}</text>
        ))}
        <path d={area} className="op-fill-up" clipPath="url(#op-above)" />
        <path d={area} className="op-fill-down" clipPath="url(#op-below)" />
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="op-zero" />
        <path d={path('now')} className="op-today" />
        <path d={path('exp')} className="op-exp" />
        <line x1={x(spot)} x2={x(spot)} y1={padT} y2={h - padB} className="op-spot" />
        <text x={x(spot) + 4} y={padT + 10} className="op-axis">{fr(spot)}</text>
        {hp && (
          <g>
            <line x1={x(hp.s)} x2={x(hp.s)} y1={padT} y2={h - padB} className="op-cross" />
            <circle cx={x(hp.s)} cy={y(hp.exp)} r="3.5" className="op-dot" />
            <circle cx={x(hp.s)} cy={y(hp.now)} r="3" className="op-dot now" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="op-tip" style={{ left: Math.min(W - 200, x(hp.s) + 12) }}>
          <div>Cours <b>{fr(hp.s)}</b> ({pct(((hp.s - spot) / spot) * 100)})</div>
          <div>À l’échéance <b className={signCls(hp.exp)}>{fr(hp.exp)} {cur}</b></div>
          <div>À la date choisie <b className={signCls(hp.now)}>{fr(hp.now)} {cur}</b></div>
        </div>
      )}
      <div className="op-legend"><span><i className="exp" />À l’échéance</span><span><i className="today" />À la date choisie (Black-Scholes)</span></div>
    </div>
  );
}

export default function Builder({ u, exps, legs, setLegs }: { u: Underlying; exps: Expiration[]; legs: Leg[]; setLegs: (l: Leg[]) => void }) {
  // the expiration of the legs picked in the chain, else the first one at least a day away
  const [expKey, setExpKey] = useState<string>(() => (legs[0] && exps.find((e) => e.exp === legs[0].expiration && e.root === legs[0].root)?.key)
    || (exps.find((e) => daysTo(e.exp) >= 1)?.key ?? exps[0]?.key ?? ''));
  const e = exps.find((x) => x.key === expKey) ?? exps[0] ?? null;
  const { chain } = useChain(u, e);
  const rows = chain ? byStrike(chain.rows) : [];
  const [now] = useState(() => Date.now());
  const last = legs.length ? Math.min(...legs.map((l) => expiryTime(l.expiration))) : now;
  const days = Math.max(0, Math.floor((last - now) / DAY));
  const [dayOffset, setDayOffset] = useState(0);
  const at = now + Math.min(dayOffset, days) * DAY;

  const atm = rows.length ? rows.reduce((b, r, i) => (Math.abs(r.strike - u.price) < Math.abs(rows[b].strike - u.price) ? i : b), 0) : 0;
  const leg = (type: 'call' | 'put', d: number, qty: number): Leg | null => {
    const o = rows[Math.max(0, Math.min(rows.length - 1, atm + d))]?.[type];
    if (!o || !e) return null;
    const premium = (qty > 0 ? o.ask : o.bid) ?? o.theo ?? 0;
    return { id: nextId(), type, strike: o.strike, qty, premium, iv: o.iv ?? 0.3, expiration: e.exp, root: e.root, mult: u.multiplier };
  };
  const presets: [string, string, () => (Leg | null)[]][] = [
    ['Achat de call', 'haussier', () => [leg('call', 0, 1)]],
    ['Achat de put', 'baissier', () => [leg('put', 0, 1)]],
    ['Vente de put', 'haussier', () => [leg('put', -1, -1)]],
    ['Vente de call', 'baissier', () => [leg('call', 1, -1)]],
    ['Spread haussier (calls)', 'haussier', () => [leg('call', 0, 1), leg('call', 2, -1)]],
    ['Spread baissier (puts)', 'baissier', () => [leg('put', 0, 1), leg('put', -2, -1)]],
    ['Bull put spread', 'haussier', () => [leg('put', -1, -1), leg('put', -3, 1)]],
    ['Bear call spread', 'baissier', () => [leg('call', 1, -1), leg('call', 3, 1)]],
    ['Straddle', 'volatil', () => [leg('call', 0, 1), leg('put', 0, 1)]],
    ['Strangle', 'volatil', () => [leg('call', 2, 1), leg('put', -2, 1)]],
    ['Iron condor', 'neutre', () => [leg('put', -4, 1), leg('put', -2, -1), leg('call', 2, -1), leg('call', 4, 1)]],
    ['Papillon', 'neutre', () => [leg('call', -2, 1), leg('call', 0, -2), leg('call', 2, 1)]],
  ];
  const strikes = legs.map((l) => l.strike);
  const stats = legs.length ? payoffStats(legs, Math.min(u.price * 0.5, ...strikes) * 0.5, Math.max(u.price * 1.5, ...strikes) * 1.5) : null;
  const update = (id: string, p: Partial<Leg>) => setLegs(legs.map((l) => (l.id === id ? { ...l, ...p } : l)));
  // greeks from the loaded chain (legs of the shown expiration)
  const greeks = legs.reduce((g, l) => {
    const o = chain?.exp === l.expiration && chain.root === l.root ? rows.find((r) => r.strike === l.strike)?.[l.type] : undefined;
    const k = l.qty * l.mult;
    return o ? { delta: g.delta + (o.delta ?? 0) * k, gamma: g.gamma + (o.gamma ?? 0) * k, theta: g.theta + (o.theta ?? 0) * k, vega: g.vega + (o.vega ?? 0) * k } : g;
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 });
  const cur = u.currency;

  return (
    <div className="op-gen">
      <div className="op-gen-side">
        <div className="op-sub">Échéance</div>
        <select className="pg-select" value={e?.key ?? ''} onChange={(ev) => setExpKey(ev.target.value)}>
          {exps.map((x) => <option key={x.key} value={x.key}>{expLabel(x.exp)} · {daysTo(x.exp)} j · {x.root}</option>)}
        </select>
        <div className="op-sub">Stratégies</div>
        <div className="op-presets">
          {presets.map(([label, mood, f]) => (
            <button key={label} className={`op-preset ${mood}`} disabled={!rows.length} onClick={() => setLegs(f().filter((l): l is Leg => !!l))}>
              <b>{label}</b><small>{mood}</small>
            </button>
          ))}
        </div>
        <div className="op-sub">Jambes {legs.length > 0 && <button className="op-link" onClick={() => setLegs([])}>Tout effacer</button>}</div>
        {!legs.length && <div className="pg-note">Choisissez une stratégie, ou cliquez sur un bid (vente) ou un ask (achat) dans la chaîne.</div>}
        {legs.map((l) => {
          const lrows = chain?.exp === l.expiration && chain.root === l.root ? rows : [];
          return (
            <div key={l.id} className="op-leg">
              <button className={`op-side ${l.qty > 0 ? 'buy' : 'sell'}`} onClick={() => update(l.id, { qty: -l.qty })}>{l.qty > 0 ? 'Achat' : 'Vente'}</button>
              <input className="op-qty" type="number" min={1} value={Math.abs(l.qty)} onChange={(ev) => update(l.id, { qty: Math.sign(l.qty) * Math.max(1, +ev.target.value || 1) })} />
              <button className="op-type" onClick={() => {
                const type = l.type === 'call' ? 'put' : 'call';
                const o = lrows.find((r) => r.strike === l.strike)?.[type];
                update(l.id, { type, ...(o ? { premium: (l.qty > 0 ? o.ask : o.bid) ?? mid(o) ?? l.premium, iv: o.iv ?? l.iv } : {}) });
              }}>{l.type === 'call' ? 'Call' : 'Put'}</button>
              {lrows.length ? (
                <select className="op-strike-sel" value={l.strike} onChange={(ev) => {
                  const k = +ev.target.value;
                  const o = lrows.find((r) => r.strike === k)?.[l.type];
                  update(l.id, { strike: k, ...(o ? { premium: (l.qty > 0 ? o.ask : o.bid) ?? mid(o) ?? l.premium, iv: o.iv ?? l.iv } : {}) });
                }}>
                  {lrows.map((r) => <option key={r.strike} value={r.strike}>{strikeLabel(r.strike)}</option>)}
                </select>
              ) : <span className="op-strike-lbl">{strikeLabel(l.strike)}</span>}
              <span className="op-leg-exp">{expLabel(l.expiration, true)}</span>
              <input className="op-prem" type="number" step="0.01" value={l.premium} onChange={(ev) => update(l.id, { premium: +ev.target.value || 0 })} title="Prime" />
              <button className="pl-btn danger" onClick={() => setLegs(legs.filter((x) => x.id !== l.id))}>✕</button>
            </div>
          );
        })}
      </div>
      <div className="op-gen-main">
        {!legs.length ? (
          <div className="pg-empty big">Aucune jambe : la courbe de gain s’affichera ici.</div>
        ) : (
          <>
            {stats && (
              <div className="op-stats">
                <div><span>{stats.cost >= 0 ? 'Débit net' : 'Crédit net'}</span><b>{fr(Math.abs(stats.cost))} {cur}</b></div>
                <div><span>Gain max</span><b className="up">{stats.maxGain == null ? 'Illimité' : `${fr(stats.maxGain)} ${cur}`}</b></div>
                <div><span>Perte max</span><b className="down">{stats.maxLoss == null ? 'Illimitée' : `${fr(stats.maxLoss)} ${cur}`}</b></div>
                <div><span>Seuil(s) de rentabilité</span><b>{stats.breakevens.length ? stats.breakevens.map((b) => fr(b)).join(' · ') : '—'}</b></div>
                <div><span>Delta</span><b>{fr(greeks.delta, 2)}</b></div>
                <div><span>Gamma</span><b>{fr(greeks.gamma, 4)}</b></div>
                <div><span>Theta / jour</span><b className={signCls(greeks.theta)}>{fr(greeks.theta)} {cur}</b></div>
                <div><span>Vega</span><b>{fr(greeks.vega)}</b></div>
              </div>
            )}
            <Payoff legs={legs} spot={u.price} at={at} cur={cur} />
            <div className="op-date">
              <span>Date d’évaluation</span>
              <input type="range" min={0} max={days} value={Math.min(dayOffset, days)} onChange={(ev) => setDayOffset(+ev.target.value)} />
              <b>{new Date(at).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}</b>
              <small>{days - Math.min(dayOffset, days)} j avant l’échéance</small>
            </div>
            <div className="pg-note">Multiplicateur du contrat : {u.multiplier}. Courbe « date choisie » : modèle Black-Scholes avec la volatilité implicite de chaque jambe.</div>
          </>
        )}
      </div>
    </div>
  );
}
