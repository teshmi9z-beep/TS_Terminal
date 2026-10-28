import { useMemo, useState } from 'react';
import { useKept } from '../../kept';
import { byStrike, daysTo, expiryTime, legsPnl, payoffStats, probabilityOfProfit, type Expiration, type Leg, type StrikeRow, type Underlying } from '../../../data/options';
import { fr, pct, signCls } from '../../../data/format';
import { nextId } from '../../../store/store';
import { Chips } from '../common';
import { useChain } from './hooks';
import { expLabel, strikeLabel } from './format';

type Mood = 'bull2' | 'bull' | 'neutral' | 'bear' | 'bear2' | 'volatile';
const MOODS: [Mood, string, number][] = [
  ['bear2', 'Très baissier', -0.08], ['bear', 'Baissier', -0.03], ['neutral', 'Neutre', 0], ['bull', 'Haussier', 0.03], ['bull2', 'Très haussier', 0.08], ['volatile', 'Volatil', 0],
];

type Candidate = { name: string; legs: Leg[]; cost: number; maxGain: number | null; maxLoss: number | null; atTarget: number; ret: number | null; pop: number };

// every strategy of the kind that fits the outlook, on the strikes around the price
function candidates(rows: StrikeRow[], u: Underlying, e: Expiration, mood: Mood): { name: string; legs: Leg[] }[] {
  const atm = rows.reduce((b, r, i) => (Math.abs(r.strike - u.price) < Math.abs(rows[b].strike - u.price) ? i : b), 0);
  const leg = (i: number, type: 'call' | 'put', qty: number): Leg | null => {
    const o = rows[i]?.[type];
    if (!o) return null;
    const premium = (qty > 0 ? o.ask : o.bid) ?? o.theo;
    if (premium == null || premium <= 0) return null;
    return { id: nextId(), type, strike: o.strike, qty, premium, iv: o.iv ?? 0.3, expiration: e.exp, root: e.root, mult: u.multiplier };
  };
  const out: { name: string; legs: Leg[] }[] = [];
  const add = (name: string, legs: (Leg | null)[]) => { if (legs.every(Boolean)) out.push({ name, legs: legs as Leg[] }); };
  const k = (i: number) => strikeLabel(rows[i]?.strike ?? 0);
  const span = 8;
  const bull = mood === 'bull' || mood === 'bull2', bear = mood === 'bear' || mood === 'bear2';
  for (let i = atm - span; i <= atm + span; i++) {
    if (i < 0 || i >= rows.length) continue;
    if (bull) {
      add(`Achat call ${k(i)}`, [leg(i, 'call', 1)]);
      add(`Vente put ${k(i)}`, [leg(i, 'put', -1)]);
      for (const w of [1, 2, 4]) {
        add(`Spread haussier calls ${k(i)}/${k(i + w)}`, [leg(i, 'call', 1), leg(i + w, 'call', -1)]);
        add(`Bull put spread ${k(i - w)}/${k(i)}`, [leg(i, 'put', -1), leg(i - w, 'put', 1)]);
      }
    }
    if (bear) {
      add(`Achat put ${k(i)}`, [leg(i, 'put', 1)]);
      add(`Vente call ${k(i)}`, [leg(i, 'call', -1)]);
      for (const w of [1, 2, 4]) {
        add(`Spread baissier puts ${k(i)}/${k(i - w)}`, [leg(i, 'put', 1), leg(i - w, 'put', -1)]);
        add(`Bear call spread ${k(i)}/${k(i + w)}`, [leg(i, 'call', -1), leg(i + w, 'call', 1)]);
      }
    }
    if (mood === 'neutral') {
      for (const w of [1, 2, 3]) {
        if (i >= atm) add(`Iron condor ${k(2 * atm - i - w)}/${k(2 * atm - i)}/${k(i)}/${k(i + w)}`, [leg(2 * atm - i - w, 'put', 1), leg(2 * atm - i, 'put', -1), leg(i, 'call', -1), leg(i + w, 'call', 1)]);
        add(`Papillon calls ${k(i - w)}/${k(i)}/${k(i + w)}`, [leg(i - w, 'call', 1), leg(i, 'call', -2), leg(i + w, 'call', 1)]);
      }
    }
    if (mood === 'volatile') {
      if (i === atm) add(`Straddle ${k(i)}`, [leg(i, 'call', 1), leg(i, 'put', 1)]);
      if (i > atm) add(`Strangle ${k(2 * atm - i)}/${k(i)}`, [leg(i, 'call', 1), leg(2 * atm - i, 'put', 1)]);
    }
  }
  return out;
}

export default function Finder({ u, exps, onBuild }: { u: Underlying; exps: Expiration[]; onBuild: (legs: Leg[]) => void }) {
  const [mood, setMood] = useKept<Mood>('options.finder.mood', 'bull');
  const [expKey, setExpKey] = useState<string>(exps.find((e) => daysTo(e.exp) >= 7)?.key ?? exps[0]?.key ?? '');
  const [targetText, setTargetText] = useState<string | null>(null);
  const [sort, setSort] = useKept<'atTarget' | 'ret' | 'pop'>('options.finder.sort', 'ret');
  const e = exps.find((x) => x.key === expKey) ?? exps[0] ?? null;
  const { chain } = useChain(u, e);
  const moveOf = MOODS.find((m) => m[0] === mood)![2];
  const typed = targetText == null ? NaN : +targetText.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const target = typed > 0 ? typed : u.price * (1 + moveOf);
  const [now] = useState(() => Date.now());

  const list = useMemo((): Candidate[] => {
    if (!chain || !e) return [];
    const rows = byStrike(chain.rows);
    if (!rows.length) return [];
    const years = Math.max(1 / 365, (expiryTime(e.exp) - now) / 3.156e10);
    const iv = e.atmIv ?? 0.3;
    return candidates(rows, u, e, mood).map((c) => {
      const strikes = c.legs.map((l) => l.strike);
      const st = payoffStats(c.legs, Math.min(u.price * 0.5, ...strikes) * 0.5, Math.max(u.price * 1.5, ...strikes) * 1.5);
      const atTarget = legsPnl(c.legs, target);
      const risk = st.maxLoss == null ? null : Math.abs(st.maxLoss);
      return { ...c, cost: st.cost, maxGain: st.maxGain, maxLoss: st.maxLoss, atTarget, ret: risk ? atTarget / risk : null, pop: probabilityOfProfit(c.legs, u.price, iv, years) };
    }).filter((c) => c.atTarget > 0);
  }, [chain, e, u, mood, target, now]);
  const sorted = [...list].sort((a, b) => (sort === 'pop' ? b.pop - a.pop : sort === 'atTarget' ? b.atTarget - a.atTarget : (b.ret ?? -1) - (a.ret ?? -1))).slice(0, 40);
  const cur = u.currency;

  return (
    <div className="op-finder">
      <div className="op-finder-form">
        <div><span className="op-sub">Perspective</span><Chips value={mood} onChange={(m) => { setMood(m); setTargetText(null); }} options={MOODS.map(([id, l]) => [id, l])} /></div>
        <div className="op-finder-row">
          <label>Cours visé<input value={targetText ?? fr(target)} onChange={(ev) => setTargetText(ev.target.value)} /><small className={signCls(target - u.price)}>{pct(((target - u.price) / u.price) * 100)}</small></label>
          <label>À l’échéance
            <select className="pg-select" value={e?.key ?? ''} onChange={(ev) => setExpKey(ev.target.value)}>
              {exps.map((x) => <option key={x.key} value={x.key}>{expLabel(x.exp)} · {daysTo(x.exp)} j · {x.root}</option>)}
            </select>
          </label>
          <label>Trier par
            <select className="pg-select" value={sort} onChange={(ev) => setSort(ev.target.value as typeof sort)}>
              <option value="ret">Rendement / risque</option><option value="atTarget">Gain au cours visé</option><option value="pop">Probabilité de gain</option>
            </select>
          </label>
        </div>
      </div>
      {!chain && <div className="pg-empty"><span className="spinner" /> Chargement de la chaîne…</div>}
      {chain && (
        <div className="pg-scroll">
          <table className="pg-table">
            <thead>
              <tr><th className="left">Stratégie</th><th>Coût</th><th>Gain max</th><th>Perte max</th><th>Gain au cours visé</th><th>Rendement / risque</th><th>Prob. de gain</th><th /></tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.name}>
                  <td className="left"><b>{c.name}</b></td>
                  <td>{c.cost >= 0 ? `${fr(c.cost)} ${cur}` : <span className="up">+{fr(-c.cost)} {cur} crédit</span>}</td>
                  <td className="up">{c.maxGain == null ? 'Illimité' : fr(c.maxGain)}</td>
                  <td className="down">{c.maxLoss == null ? 'Illimitée' : fr(c.maxLoss)}</td>
                  <td className={signCls(c.atTarget)}>{fr(c.atTarget)}</td>
                  <td>{c.ret == null ? '—' : `${fr(c.ret * 100, 0)} %`}</td>
                  <td>{fr(c.pop * 100, 0)} %</td>
                  <td><button className="pill-btn" onClick={() => onBuild(c.legs.map((l) => ({ ...l, id: nextId() })))}>Construire</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!sorted.length && <div className="pg-empty">Aucune stratégie gagnante au cours visé sur cette échéance.</div>}
          <div className="pg-note">Gains à l’échéance, pour un contrat (× {u.multiplier}). Probabilité : loi log-normale avec la volatilité implicite à la monnaie de l’échéance.</div>
        </div>
      )}
    </div>
  );
}
