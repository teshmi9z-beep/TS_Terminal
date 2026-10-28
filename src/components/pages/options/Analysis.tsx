import { useEffect, useState } from 'react';
import { useKept } from '../../kept';
import { byStrike, daysTo, fetchChain, maxPain, type Chain, type Expiration, type Underlying } from '../../../data/options';
import { fr } from '../../../data/format';
import { Chips } from '../common';
import { useChain, useWidth } from './hooks';
import { compact, expLabel, strikeLabel } from './format';
import { LineChart, type Series } from './ui';

const COLORS = ['#2962ff', '#ff9800', '#22ab94', '#e91e63', '#9c27b0'];

// implied volatility: the smile of a few expirations, and the term structure at the money
export function Volatility({ u, exps }: { u: Underlying; exps: Expiration[] }) {
  const choices = exps.slice(0, 16);
  const [picked, setPicked] = useState<string[]>(() => {
    const a = exps.find((e) => daysTo(e.exp) >= 7), b = exps.find((e) => daysTo(e.exp) >= 30), c = exps.find((e) => daysTo(e.exp) >= 90);
    return [...new Set([a, b, c].filter(Boolean).map((e) => e!.key))];
  });
  const [chains, setChains] = useState<Record<string, Chain>>({});
  useEffect(() => {
    let alive = true;
    for (const k of picked) {
      const e = exps.find((x) => x.key === k);
      if (e) fetchChain(u, e).then((c) => { if (alive) setChains((m) => ({ ...m, [k]: c })); }, () => {});
    }
    return () => { alive = false; };
  }, [picked, u, exps]);

  const smile: Series[] = picked.flatMap((k, i) => {
    const c = chains[k];
    if (!c) return [];
    const pts = byStrike(c.rows)
      .filter((r) => r.strike > u.price * 0.8 && r.strike < u.price * 1.2)
      .map((r): [number, number] | null => {
        // out of the money side, like TradingView: puts under the price, calls above
        const o = r.strike < u.price ? r.put : r.call;
        return o?.iv != null && o.iv > 0 && o.iv < 5 ? [r.strike, o.iv * 100] : null;
      })
      .filter((p): p is [number, number] => !!p);
    return [{ label: `${expLabel(c.exp, true)} (${c.root})`, color: COLORS[i % COLORS.length], points: pts }];
  });
  const term: Series[] = [{
    label: 'IV à la monnaie', color: '#2962ff',
    points: exps.filter((e) => e.atmIv != null && e.atmIv > 0 && e.atmIv < 5).map((e): [number, number] => [daysTo(e.exp), e.atmIv! * 100]),
  }];

  return (
    <div className="op-analysis pg-scroll">
      <section>
        <h3>Smile de volatilité</h3>
        <div className="op-exp-chips">
          {choices.map((e) => (
            <button key={e.key} className={`pg-chip ${picked.includes(e.key) ? 'active' : ''}`} onClick={() => setPicked(picked.includes(e.key) ? picked.filter((x) => x !== e.key) : [...picked, e.key].slice(-5))}>
              {expLabel(e.exp, true)} <small>{e.root}</small>
            </button>
          ))}
        </div>
        <LineChart series={smile} height={320} xFmt={(x) => strikeLabel(Math.round(x * 100) / 100)} yFmt={(y) => `${fr(y, 1)}%`} marker={{ x: u.price, label: fr(u.price) }} />
      </section>
      <section>
        <h3>Structure par terme</h3>
        <LineChart series={term} height={260} xFmt={(x) => `${Math.round(x)} j`} yFmt={(y) => `${fr(y, 1)}%`} />
      </section>
      <div className="pg-note">Volatilité implicite (TradingView). Smile : puts sous le cours, calls au-dessus.</div>
    </div>
  );
}

function VolumeBars({ rows, mode, price }: { rows: { strike: number; c: number; p: number }[]; mode: string; price: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(w, 200), h = 340, padL = 56, padB = 26, padT = 12;
  const max = Math.max(1, ...rows.flatMap((r) => [r.c, r.p]));
  const band = (W - padL - 8) / Math.max(1, rows.length);
  const mid = padT + (h - padT - padB) / 2;
  const scale = (v: number) => (v / max) * ((h - padT - padB) / 2);
  const priceX = rows.length ? padL + band * rows.filter((r) => r.strike < price).length : null;
  return (
    <div className="op-line" ref={ref}>
      <svg width={W} height={h} onMouseLeave={() => setHover(null)}>
        {[max, max / 2, 0, max / 2, max].map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={W - 8} y1={padT + (i * (h - padT - padB)) / 4} y2={padT + (i * (h - padT - padB)) / 4} className="op-grid" />
            <text x={padL - 6} y={padT + (i * (h - padT - padB)) / 4 + 4} textAnchor="end" className="op-axis">{compact(Math.round(v))}</text>
          </g>
        ))}
        {rows.map((r, i) => (
          <g key={r.strike} onMouseEnter={() => setHover(i)}>
            <rect x={padL + band * i} y={padT} width={band} height={h - padT - padB} fill="transparent" />
            <rect x={padL + band * i + band * 0.15} width={band * 0.7} y={mid - scale(r.c)} height={Math.max(0.5, scale(r.c))} className="op-bar-call" />
            <rect x={padL + band * i + band * 0.15} width={band * 0.7} y={mid} height={Math.max(0.5, scale(r.p))} className="op-bar-put" />
          </g>
        ))}
        <line x1={padL} x2={W - 8} y1={mid} y2={mid} className="op-zero" />
        {priceX != null && <line x1={priceX} x2={priceX} y1={padT} y2={h - padB} className="op-spot" />}
        {rows.map((r, i) => (i % Math.max(1, Math.ceil(rows.length / 12)) === 0 ? <text key={r.strike} x={padL + band * (i + 0.5)} y={h - 8} textAnchor="middle" className="op-axis">{strikeLabel(r.strike)}</text> : null))}
      </svg>
      {hover != null && rows[hover] && (
        <div className="op-tip" style={{ left: Math.min(W - 180, padL + band * hover + band) }}>
          <div>Strike <b>{strikeLabel(rows[hover].strike)}</b></div>
          <div><i className="fu-dot" style={{ background: '#2962ff' }} />Calls <b>{compact(rows[hover].c)}</b></div>
          <div><i className="fu-dot" style={{ background: '#f23645' }} />Puts <b>{compact(rows[hover].p)}</b></div>
        </div>
      )}
      <div className="op-legend"><span><i style={{ borderTopColor: '#2962ff' }} />Calls ({mode})</span><span><i style={{ borderTopColor: '#f23645' }} />Puts ({mode})</span></div>
    </div>
  );
}

// volume and open interest by strike for an expiration, put/call ratios, max pain
export function VolumeTab({ u, exps }: { u: Underlying; exps: Expiration[] }) {
  const [key, setKey] = useState<string>(exps.find((e) => daysTo(e.exp) >= 1)?.key ?? exps[0]?.key ?? '');
  const [mode, setMode] = useKept<'volume' | 'oi'>('options.volume.mode', 'volume');
  const e = exps.find((x) => x.key === key) ?? exps[0] ?? null;
  const { chain } = useChain(u, e);
  if (!u.yahoo) return <div className="pg-empty big">Volume et intérêt ouvert non disponibles pour les options sur contrats à terme.</div>;
  const rows = chain ? byStrike(chain.rows) : [];
  const near = rows.filter((r) => r.strike > u.price * 0.85 && r.strike < u.price * 1.15);
  const sum = (f: (r: (typeof rows)[number]) => number | null | undefined) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  const cv = sum((r) => r.call?.volume), pv = sum((r) => r.put?.volume), co = sum((r) => r.call?.oi), po = sum((r) => r.put?.oi);
  const pain = maxPain(rows);
  return (
    <div className="op-analysis pg-scroll">
      <div className="op-exp-chips">
        {exps.slice(0, 20).map((x) => (
          <button key={x.key} className={`pg-chip ${x.key === e?.key ? 'active' : ''}`} onClick={() => setKey(x.key)}>{expLabel(x.exp, true)} <small>{daysTo(x.exp)} j</small></button>
        ))}
      </div>
      <div className="op-stats wide">
        <div><span>Volume calls</span><b>{compact(cv)}</b></div>
        <div><span>Volume puts</span><b>{compact(pv)}</b></div>
        <div><span>Ratio put/call (volume)</span><b>{cv ? fr(pv / cv) : '—'}</b></div>
        <div><span>Intérêt ouvert calls</span><b>{compact(co)}</b></div>
        <div><span>Intérêt ouvert puts</span><b>{compact(po)}</b></div>
        <div><span>Ratio put/call (OI)</span><b>{co ? fr(po / co) : '—'}</b></div>
        <div><span>Max pain</span><b>{pain == null ? '—' : strikeLabel(pain)}</b></div>
      </div>
      <div className="pg-toolbar"><Chips value={mode} onChange={setMode} options={[['volume', 'Volume'], ['oi', 'Intérêt ouvert']]} /></div>
      {!chain ? <div className="pg-empty"><span className="spinner" /> Chargement…</div> : (
        <VolumeBars price={u.price} mode={mode === 'volume' ? 'volume' : 'intérêt ouvert'} rows={near.map((r) => ({
          strike: r.strike,
          c: (mode === 'volume' ? r.call?.volume : r.call?.oi) ?? 0,
          p: (mode === 'volume' ? r.put?.volume : r.put?.oi) ?? 0,
        }))} />
      )}
      <div className="pg-note">Volume et intérêt ouvert : Yahoo Finance (différé). Max pain : strike où la valeur totale des options à l’échéance est la plus faible.</div>
    </div>
  );
}
