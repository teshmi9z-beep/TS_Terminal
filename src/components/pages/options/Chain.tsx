import { useState, type ReactNode } from 'react';
import { useKept } from '../../kept';
import { byStrike, daysTo, type Expiration, type OptionRow, type StrikeRow, type Underlying } from '../../../data/options';
import { fr, pct, signCls } from '../../../data/format';
import { TvLogo } from '../common';
import { useChain } from './hooks';
import { COLUMNS, DEFAULT_COLS, compact, expLabel, n2, strikeLabel, type ColId, type Pick, type Side } from './format';

// a vertical spread in place of each option: calls K / K+w, puts K / K-w
type Quote = { bid: number | null; ask: number | null; theo: number | null; delta: number | null; iv: number | null; gamma: number | null; theta: number | null; vega: number | null; rho: number | null; volume: number | null; oi: number | null; legs: [OptionRow, OptionRow | null] };

function quoteOf(rows: StrikeRow[], i: number, type: 'call' | 'put', width: number): Quote | null {
  const o = rows[i][type];
  if (!o) return null;
  if (!width) return { ...o, legs: [o, null] };
  const other = rows[i + (type === 'call' ? width : -width)]?.[type];
  if (!other) return null;
  const sub = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);
  return {
    bid: sub(o.bid, other.ask), ask: sub(o.ask, other.bid), theo: sub(o.theo, other.theo), delta: sub(o.delta, other.delta),
    gamma: sub(o.gamma, other.gamma), theta: sub(o.theta, other.theta), vega: sub(o.vega, other.vega), rho: sub(o.rho, other.rho),
    iv: null, volume: null, oi: null, legs: [o, other],
  };
}

function Group({ u, e, open, onToggle, side, strikes, spread, cols, onPick }: {
  u: Underlying; e: Expiration; open: boolean; onToggle: () => void; side: Side; strikes: number; spread: number; cols: ColId[];
  onPick: (e: Expiration, p: Pick) => void;
}) {
  const { chain, error } = useChain(u, open ? e : null);
  const rows = chain ? byStrike(chain.rows) : [];
  const atm = rows.findIndex((r) => r.strike >= u.price);
  const cut = atm < 0 ? rows.length : atm;
  const from = strikes ? Math.max(0, cut - strikes) : 0;
  const to = strikes ? Math.min(rows.length, cut + strikes) : rows.length;
  const maxVol = Math.max(1, ...rows.slice(from, to).flatMap((r) => [r.call?.volume ?? 0, r.put?.volume ?? 0]));
  const dte = daysTo(e.exp);
  const ncols = (side === 'both' ? cols.length * 2 : cols.length) + 2;

  const pick = (q: Quote, type: 'call' | 'put', buy: boolean) => {
    const [a, b] = q.legs;
    const leg = (o: OptionRow, qty: 1 | -1) => ({ type, strike: o.strike, qty, price: (qty > 0 ? o.ask : o.bid) ?? o.theo ?? 0, iv: o.iv ?? 0.3 });
    onPick(e, b ? [leg(a, buy ? 1 : -1), leg(b, buy ? -1 : 1)] : [leg(a, buy ? 1 : -1)]);
  };

  const cells = (r: StrikeRow, i: number, type: 'call' | 'put') => {
    const q = quoteOf(rows, i, type, spread);
    const itm = type === 'call' ? r.strike < u.price : r.strike > u.price;
    const m = q ? (q.bid != null && q.ask != null && q.ask > 0 ? (q.bid + q.ask) / 2 : q.theo) : null;
    const order = type === 'call' ? cols : [...cols].reverse();
    return order.map((c): ReactNode => {
      const cls = `${itm ? 'itm' : ''} op-c-${c}`;
      if (!q) return <td key={type + c} className={cls}>{c === 'bidask' ? '— × —' : '—'}</td>;
      switch (c) {
        case 'delta': return <td key={type + c} className={cls}>{n2(q.delta)}</td>;
        case 'gamma': return <td key={type + c} className={cls}>{n2(q.gamma, 4)}</td>;
        case 'theta': return <td key={type + c} className={cls}>{n2(q.theta, 3)}</td>;
        case 'vega': return <td key={type + c} className={cls}>{n2(q.vega, 3)}</td>;
        case 'rho': return <td key={type + c} className={cls}>{n2(q.rho, 3)}</td>;
        case 'be': return <td key={type + c} className={cls}>{m == null ? '—' : fr(type === 'call' ? r.strike + m : r.strike - m)}</td>;
        case 'iv': return <td key={type + c} className={cls}>{q.iv == null ? '—' : `${fr(q.iv * 100)}%`}</td>;
        case 'theo': return <td key={type + c} className={cls}>{n2(q.theo)}</td>;
        case 'dist': return <td key={type + c} className={cls}>{fr(Math.abs(r.strike - u.price))}</td>;
        case 'oi': return <td key={type + c} className={cls}>{compact(q.oi)}</td>;
        case 'volume': return (
          <td key={type + c} className={`${cls} op-vol ${type}`}>
            <span>{q.volume == null ? '—' : compact(q.volume)}</span>
            <i><b style={{ width: `${((q.volume ?? 0) / maxVol) * 100}%` }} /></i>
          </td>
        );
        case 'bidask': return (
          <td key={type + c} className={`${cls} op-ba`}>
            <button className="op-bid" title="Vendre" onClick={() => pick(q, type, false)}>{n2(q.bid)}</button>
            <span>×</span>
            <button className="op-ask" title="Acheter" onClick={() => pick(q, type, true)}>{n2(q.ask)}</button>
          </td>
        );
      }
      return null;
    });
  };

  const priceRow = (
    <tr key="price" className="op-price-row">
      <td colSpan={ncols}>
        <span className="op-price-pill">
          <TvLogo logoid={u.logoid} text={u.ticker} size={16} />
          <b>{u.ticker}</b> {fr(u.price)} <small>{u.currency}</small>
          <em className={signCls(u.change)}>{u.changeAbs != null ? `${u.changeAbs > 0 ? '+' : ''}${fr(u.changeAbs)}` : ''} {pct(u.change)}</em>
        </span>
      </td>
    </tr>
  );

  return (
    <tbody>
      <tr className="op-exp-row" onClick={onToggle}>
        <td colSpan={ncols}>
          <span className={`op-chev ${open ? 'open' : ''}`}>›</span>
          <b>{expLabel(e.exp)}</b>
          <span className={`op-badge dte ${dte <= 1 ? 'hot' : ''}`}>{dte} DTE</span>
          <span className="op-badge">{e.root}</span>
          {e.atmIv != null && <span className="op-exp-iv">IV {fr(e.atmIv * 100, 1)}%</span>}
        </td>
      </tr>
      {open && error && <tr><td colSpan={ncols} className="pg-error">{error}</td></tr>}
      {open && !chain && !error && <tr><td colSpan={ncols} className="pg-empty"><span className="spinner" /> Chargement…</td></tr>}
      {open && rows.slice(from, to).flatMap((r, j) => {
        const i = from + j;
        const out: ReactNode[] = [];
        if (i === cut) out.push(priceRow);
        out.push(
          <tr key={r.strike} className="op-row">
            {side !== 'puts' && cells(r, i, 'call')}
            <td className="op-strike"><span>{strikeLabel(r.strike)}</span></td>
            {side !== 'calls' && cells(r, i, 'put')}
            <td className="op-pad" />
          </tr>,
        );
        return out;
      })}
      {open && chain && cut >= to && to > from && priceRow}
      {open && chain && !rows.length && <tr><td colSpan={ncols} className="pg-empty">Aucune option.</td></tr>}
    </tbody>
  );
}

export default function ChainTable({ u, exps, side, strikes, spread, cols, onPick, onCols }: {
  u: Underlying; exps: Expiration[]; side: Side; strikes: number; spread: number; cols: ColId[];
  onPick: (e: Expiration, p: Pick) => void; onCols: (c: ColId[]) => void;
}) {
  // the expirations unfolded come back with the tab
  const [openKeys, setOpenKeys] = useKept<string[]>(`options.open.${u.id}|${exps.length}|${exps[0]?.key ?? ''}`, () => (exps[0] ? [exps[0].key] : []), true);
  const open = new Set(openKeys);
  const [colMenu, setColMenu] = useState(false);
  const toggle = (k: string) => setOpenKeys((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const head = (type: 'call' | 'put') => (type === 'call' ? cols : [...cols].reverse()).map((c) => (
    <th key={type + c} className={`op-c-${c}`}>{COLUMNS.find((x) => x.id === c)?.label}</th>
  ));
  return (
    <div className="pg-scroll op-chain-wrap">
      <table className="op-chain">
        <thead>
          <tr className="op-group">
            {side !== 'puts' && <th colSpan={cols.length}>Calls</th>}
            <th />
            {side !== 'calls' && <th colSpan={cols.length}>Puts</th>}
            <th />
          </tr>
          <tr>
            {side !== 'puts' && head('call')}
            <th className="op-strike">↑ Strike</th>
            {side !== 'calls' && head('put')}
            <th className="op-pad">
              <button className="op-cols-btn" title="Colonnes" onClick={() => setColMenu(!colMenu)}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2" y="2.5" width="3" height="11" rx=".5" /><rect x="6.5" y="2.5" width="3" height="11" rx=".5" /><rect x="11" y="2.5" width="3" height="11" rx=".5" /></svg>
              </button>
              {colMenu && (
                <div className="op-dd-menu right op-cols-menu" onMouseLeave={() => setColMenu(false)}>
                  <div className="op-dd-head">Colonnes</div>
                  {COLUMNS.map((c) => (
                    <label key={c.id} className="home-check">
                      <input
                        type="checkbox" checked={cols.includes(c.id)}
                        onChange={(ev) => onCols(ev.target.checked ? COLUMNS.map((x) => x.id).filter((id) => id === c.id || cols.includes(id)) : cols.filter((x) => x !== c.id))}
                      />
                      {c.label}
                    </label>
                  ))}
                  <button className="home-reset" onClick={() => onCols(DEFAULT_COLS)}>Par défaut</button>
                </div>
              )}
            </th>
          </tr>
        </thead>
        {exps.map((e) => (
          <Group key={e.key} u={u} e={e} open={open.has(e.key)} onToggle={() => toggle(e.key)} side={side} strikes={strikes} spread={spread} cols={cols} onPick={onPick} />
        ))}
      </table>
      {!exps.length && <div className="pg-empty">Aucune échéance.</div>}
    </div>
  );
}

