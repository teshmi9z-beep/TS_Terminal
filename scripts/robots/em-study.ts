import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FAMILIES } from '../../src/data/indexFamilies';
import { MARKETS, VIX, VIX_DAYS, readRows, sessionsOf, volAtOpen, volIndex, type Sess } from './em-lib';

// The Expected Move robots (the user's "Expected Move Calibré v6" indicator turned into trading
// rules), on the cash sessions of the S&P 500, Nasdaq 100, Dow, Russell 2000, DAX and Nikkei
// since 2020. Every session is frozen at the open as the indicator does: the expected move
// EM = open × volatility / 100 / √252, the average excursions above and below the open over
// the last N sessions in EM (fu, fd) and their σ (su, sd). The levels the rules trade are
// open ± EM × (f + k σ). Rules (one trade per side and session, flat at the close):
// - fade:  a limit order at the level, against it (sell at the upper one, buy at the lower);
// - break: a stop order at the level, with it;
// - reject: the price goes beyond the level, a bar closes back inside: against it at the next open;
// - closeBreak: a bar closes beyond the level: with it at the next open.
// Stops, targets, entry windows, calibration and volatility source all vary; the side (long,
// short, both) and the volatility regime (VIX under / over 20) are cut afterwards from the same
// trades. Found on 2020-07 → 2024-08, checked on 2024-09 → now, then walked forward year by year.
// Prices: the cash indices' 15-minute session bars (IBKR, robots/gaps/data; the Dow:
// robots/data/dl_ibkr_DJI_15m.bin), which the CME futures follow during the session; costs per
// side: 0.005 % (CME future: a tick of slippage and the fees) and 0.02 % (the lab's index CFD).
// Volatility: robots/em/data (scripts/robots/em-fetch.mjs). Usage: node robots/.build/em-study.mjs

const OUT = path.resolve('robots/em');
const TRADE_FROM = Date.UTC(2020, 6, 1) / 1000;
const SPLIT = Date.UTC(2024, 8, 1) / 1000;
const COST_CME = 0.00005, COST_CFD = 0.0002;
const SQ252 = Math.sqrt(252);

// ---------------------------------------------------------------- calibration
// per session, the frozen numbers: em, fu, fd, su, sd (NaN while the sample is short)
type Cal = { em: Float64Array; fu: Float64Array; fd: Float64Array; su: Float64Array; sd: Float64Array };
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const stdev = (a: number[]) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };

function calibrate(ss: Sess[], vol: (k: number) => number, lookback: number): Cal {
  const n = ss.length;
  const c: Cal = { em: new Float64Array(n).fill(NaN), fu: new Float64Array(n).fill(NaN), fd: new Float64Array(n).fill(NaN), su: new Float64Array(n).fill(NaN), sd: new Float64Array(n).fill(NaN) };
  const up: number[] = [], dn: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = ss[k], v = vol(k);
    const em = v > 0 ? (s.O * v) / 100 / SQ252 : NaN;
    c.em[k] = em;
    if (up.length >= lookback) { c.fu[k] = avg(up); c.fd[k] = avg(dn); c.su[k] = stdev(up); c.sd[k] = stdev(dn); }
    if (Number.isFinite(em) && s.full) {
      up.push((s.H - s.O) / em); dn.push((s.O - s.L) / em);
      if (up.length > lookback) { up.shift(); dn.shift(); }
    }
  }
  return c;
}

// realized volatility (annualized %) of the last 20 session closes before session k
function realized(ss: Sess[]): Float64Array {
  const out = new Float64Array(ss.length).fill(NaN);
  for (let k = 21; k < ss.length; k++) {
    const r: number[] = [];
    for (let i = k - 20; i < k; i++) r.push(Math.log(ss[i].C / ss[i - 1].C));
    out[k] = stdev(r) * SQ252 * 100;
  }
  return out;
}

// ---------------------------------------------------------------- the rules
type Kind = 'fade' | 'break' | 'reject' | 'closeBreak';
const KINDS: Kind[] = ['fade', 'break', 'reject', 'closeBreak'];
const KS = [-0.5, 0, 0.5, 1, 1.5];
// stops: EM fractions beyond (fade, reject) or behind (break, closeBreak) the level; 'sig':
// one σ of the side's ratio (fade, reject); 'open': the session's open (break, closeBreak)
const STOPS: (number | 'sig' | 'open')[] = [0.1, 0.2, 0.3, 0.5, 'sig', 'open'];
const T_FADE = ['open', 'half', 'r1', 'r2', 'close'] as const;
const T_BREAK = ['r1', 'r2', 'r3', 'next', 'close'] as const;
const WINDOWS = [60, 120, 240, 9999];
const LOOKBACKS = [20, 60, 120];
const VOLSRC = ['iv', 'rv'] as const;

export type Variant = { key: string; kind: Kind; k: number; stop: number | 'sig' | 'open'; target: string; win: number; look: number; vol: 'iv' | 'rv' };
function variants(): Variant[] {
  const out: Variant[] = [];
  for (const vol of VOLSRC) for (const look of LOOKBACKS) for (const kind of KINDS) for (const k of KS) for (const win of WINDOWS) {
    const against = kind === 'fade' || kind === 'reject';
    for (const stop of STOPS) {
      if (stop === 'sig' && !against) continue;
      if (stop === 'open' && against) continue;
      for (const target of against ? T_FADE : T_BREAK) out.push({ key: `${kind}|k${k}|s${stop}|${target}|w${win}|L${look}|${vol}`, kind, k, stop, target, win, look, vol });
    }
  }
  return out;
}

// a trade: gross R, its cost in R per 0.01 % of cost per side, side, entry time, VIX at the open
type Trade = { g: number; c1: number; d: 1 | -1; t: number; vix: number };

// one side of one session; u = +1 the upper level, -1 the lower one
function trade(s: Sess, v: Variant, u: 1 | -1, em: number, f: number, sg: number): Trade | null {
  const z = f + v.k * sg;
  if (!(z > 0)) return null;
  const P = s.O + u * em * z;
  const against = v.kind === 'fade' || v.kind === 'reject';
  const d = (against ? -u : u) as 1 | -1;
  const nb = s.o.length;
  let e = -1, entry = NaN, extreme = NaN;
  // the trigger
  for (let j = 0; j < nb; j++) {
    if (s.min[j] >= v.win) break;
    const touched = u > 0 ? s.h[j] >= P : s.l[j] <= P;
    if (v.kind === 'fade' || v.kind === 'break') {
      if (touched) { e = j; entry = u > 0 ? Math.max(s.o[j], P) : Math.min(s.o[j], P); break; }
    } else if (v.kind === 'closeBreak') {
      if ((s.c[j] - P) * u > 0 && j + 1 < nb) { e = j + 1; entry = s.o[j + 1]; break; }
    } else {
      // reject: beyond first, then a close back inside
      if (Number.isNaN(extreme)) { if (touched) extreme = u > 0 ? s.h[j] : s.l[j]; else continue; }
      else extreme = u > 0 ? Math.max(extreme, s.h[j]) : Math.min(extreme, s.l[j]);
      if ((s.c[j] - P) * u < 0 && j + 1 < nb) { e = j + 1; entry = s.o[j + 1]; break; }
    }
  }
  if (e < 0 || e >= nb) return null;
  // the stop
  let stop: number;
  if (v.stop === 'open') stop = s.O;
  else if (v.stop === 'sig') stop = (v.kind === 'reject' ? extreme : P) + u * em * sg;
  else if (against) stop = (v.kind === 'reject' ? extreme : P) + u * em * v.stop;
  else stop = P - u * em * v.stop;
  const risk = d * (entry - stop);
  if (!(risk > 0)) return null;
  // the target
  let target = NaN;
  switch (v.target) {
    case 'open': target = s.O; break;
    case 'half': target = entry + d * Math.abs(entry - s.O) / 2; break;
    case 'r1': target = entry + d * risk; break;
    case 'r2': target = entry + d * 2 * risk; break;
    case 'r3': target = entry + d * 3 * risk; break;
    case 'next': target = P + u * em * sg; break;
  }
  if (!Number.isNaN(target) && d * (target - entry) <= 0) return null;
  // the path: the stop first (on the fill bar too), the target on the fill bar only if the
  // close is past it, out at the session's last close
  let px = s.c[nb - 1];
  for (let j = e; j < nb; j++) {
    if (d > 0 ? s.l[j] <= stop : s.h[j] >= stop) { px = j === e ? stop : d > 0 ? Math.min(s.o[j], stop) : Math.max(s.o[j], stop); break; }
    if (!Number.isNaN(target)) {
      if (j > e && (d > 0 ? s.h[j] >= target : s.l[j] <= target)) { px = d > 0 ? Math.max(s.o[j], target) : Math.min(s.o[j], target); break; }
      if (j === e && (d > 0 ? s.c[j] >= target : s.c[j] <= target)) { px = s.c[j]; break; }
    }
  }
  return { g: (d * (px - entry)) / risk, c1: (2 * 0.0001 * entry) / risk, d, t: s.t0, vix: NaN };
}

// ---------------------------------------------------------------- statistics
// n, wins, sum R, sum R², gross win, gross loss
type Acc = Float64Array;
const acc = () => new Float64Array(6);
function add(a: Acc, r: number) { a[0]++; if (r > 0) a[1]++; a[2] += r; a[3] += r * r; if (r > 0) a[4] += r; else a[5] -= r; }
const pfOf = (a: Acc) => (a[5] > 0 ? a[4] / a[5] : a[4] > 0 ? 99 : 0);
function tOf(a: Acc) { if (a[0] < 3) return 0; const m = a[2] / a[0], v = a[3] / a[0] - m * m; return v > 0 ? m / Math.sqrt(v / a[0]) : 0; }

// sides (both, long, short) × regimes (any, VIX < 20, VIX ≥ 20)
const SIDES = ['les deux', 'achat', 'vente'] as const;
const REGIMES = ['tous', 'VIX<20', 'VIX≥20'] as const;
type Cut = { side: number; reg: number };
const CUTS: Cut[] = [];
for (let side = 0; side < 3; side++) for (let reg = 0; reg < 3; reg++) CUTS.push({ side, reg });
const inCut = (t: Trade, c: Cut) => (c.side === 0 || (c.side === 1 ? t.d > 0 : t.d < 0)) && (c.reg === 0 || (c.reg === 1 ? t.vix < 20 : t.vix >= 20));
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];

type Res = { is: Acc; oos: Acc; isCfd: Acc; oosCfd: Acc; years: Acc[] };
type MarketOut = { id: string; name: string; sessions: number; from: string; to: string; res: Map<string, Res>; dist: { is: number; oos: number } };

function runMarket(m: (typeof MARKETS)[number], vs: Variant[]): MarketOut {
  const f = INDEX_FAMILIES.find((x) => x.id === m.fam)!;
  const ss = sessionsOf(readRows(m.file).filter((r) => r[0] >= Date.UTC(2019, 9, 1) / 1000), f, m.skipFirst);
  const days = ss.map((s) => s.day);
  const iv = m.iv ? volIndex(m.iv) : null;
  const ivDays = iv ? [...iv.keys()].sort() : [];
  const rv = realized(ss);
  const vixAt = ss.map((s) => volAtOpen(VIX, VIX_DAYS, s.day, m.us));
  const cals = new Map<string, Cal>();
  for (const vol of VOLSRC) for (const look of LOOKBACKS) {
    // no implied index: the realized volatility stands in (the same as 'rv')
    const src = (k: number) => (vol === 'iv' && iv ? volAtOpen(iv, ivDays, days[k], m.us) : rv[k]);
    cals.set(`${vol}|${look}`, calibrate(ss, src, look));
  }
  // the EM itself, how far the sessions went in it (for the report)
  const res = new Map<string, Res>();
  for (const v of vs) {
    const cal = cals.get(`${v.vol}|${v.look}`)!;
    const trades: Trade[] = [];
    for (let k = 0; k < ss.length; k++) {
      const s = ss[k];
      if (s.t0 < TRADE_FROM || !s.full) continue;
      const em = cal.em[k];
      if (!Number.isFinite(em) || !Number.isFinite(cal.fu[k])) continue;
      for (const u of [1, -1] as const) {
        const tr = trade(s, v, u, em, u > 0 ? cal.fu[k] : cal.fd[k], u > 0 ? cal.su[k] : cal.sd[k]);
        if (tr) { tr.vix = vixAt[k]; trades.push(tr); }
      }
    }
    CUTS.forEach((c, ci) => {
      const r: Res = { is: acc(), oos: acc(), isCfd: acc(), oosCfd: acc(), years: YEARS.map(() => acc()) };
      for (const t of trades) {
        if (!inCut(t, c)) continue;
        const cme = t.g - t.c1 * (COST_CME / 0.0001), cfd = t.g - t.c1 * (COST_CFD / 0.0001);
        if (t.t < SPLIT) { add(r.is, cme); add(r.isCfd, cfd); } else { add(r.oos, cme); add(r.oosCfd, cfd); }
        add(r.years[new Date(t.t * 1000).getUTCFullYear() - 2020], cme);
      }
      res.set(`${v.key}|${ci}`, r);
    });
  }
  const traded = ss.filter((s) => s.t0 >= TRADE_FROM);
  return {
    id: m.id, name: m.name, sessions: traded.length, from: traded[0]?.day ?? '', to: traded.at(-1)?.day ?? '', res,
    dist: { is: traded.filter((s) => s.t0 < SPLIT).length, oos: traded.filter((s) => s.t0 >= SPLIT).length },
  };
}

// ---------------------------------------------------------------- selection
const MIN_IS = 120, MIN_OOS = 40;
const passIS = (a: Acc) => a[0] >= MIN_IS && a[2] > 0 && pfOf(a) >= 1.15;
const passOOS = (a: Acc) => a[0] >= MIN_OOS && a[2] > 0 && pfOf(a) >= 1.05;
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const line = (a: Acc) => `${String(a[0]).padStart(5)} tr ${fmt(a[0] ? (a[1] / a[0]) * 100 : 0, 0).padStart(3)} % gagn. ${fmt(a[0] ? a[2] / a[0] : 0, 3).padStart(7)} R/tr ${fmt(a[2], 1).padStart(7)} R PF ${fmt(pfOf(a)).padStart(5)} t ${fmt(tOf(a), 1).padStart(5)}`;

export function labelOf(key: string): string {
  const [kind, k, s, target, w, L, vol, cut] = key.split('|');
  const c = CUTS[Number(cut)];
  const kindFr = { fade: 'contre le niveau (limite)', break: 'cassure du niveau (stop)', reject: 'rejet du niveau (clôture revenue)', closeBreak: 'clôture au-delà du niveau' }[kind as Kind];
  const kk = Number(k.slice(1));
  const lvl = kk === 0 ? 'distance moyenne' : `distance moyenne ${kk > 0 ? '+' : '−'} ${Math.abs(kk)} σ`;
  const stop = s.slice(1);
  const stopFr = stop === 'sig' ? 'stop à 1 σ' : stop === 'open' ? 'stop à l’ouverture' : `stop ${Number(stop) * 100} % de l’EM`;
  const tFr = { open: 'objectif l’ouverture', half: 'objectif mi-chemin de l’ouverture', r1: 'objectif 1 R', r2: 'objectif 2 R', r3: 'objectif 3 R', next: 'objectif le niveau + 1 σ', close: 'sortie à la clôture' }[target] ?? target;
  const wFr = w === 'w9999' ? 'toute la séance' : `${Number(w.slice(1)) / 60} h après l’ouverture`;
  return `${kindFr}, ${lvl}, ${stopFr}, ${tFr}, entrée ${wFr}, calibrage ${L.slice(1)} séances, vol. ${vol === 'iv' ? 'implicite' : 'réalisée'}, ${SIDES[c.side]}, ${REGIMES[c.reg]}`;
}

// ---------------------------------------------------------------- main
const t0 = Date.now();
const vs = variants();
console.log(`${vs.length} réglages × ${CUTS.length} découpes (sens × régime) par marché`);
const outs: MarketOut[] = [];
for (const m of MARKETS) {
  const o = runMarket(m, vs);
  outs.push(o);
  console.log(`${m.id}: ${o.sessions} séances ${o.from} → ${o.to} (réglage ${o.dist.is}, contrôle ${o.dist.oos}), ${o.res.size} combinaisons, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const rep: string[] = [];
const say = (s = '') => { rep.push(s); console.log(s); };
say(`Robots Expected Move — étude du ${new Date().toISOString().slice(0, 10)}`);
say(`Réglage 2020-07 → 2024-08, contrôle 2024-09 → maintenant. Frais par côté : CME 0,005 %, CFD 0,02 %.`);
say(`${vs.length} réglages × 9 découpes = ${vs.length * 9} combinaisons par marché.`);
for (const m of MARKETS) say(`  ${m.name} : ${m.src}`);
say();

// 1. does choosing on the tuning part help on the check part?
say('1. Le réglage choisit-il des combinaisons qui tiennent au contrôle ?');
for (const o of outs) {
  let all = 0, okOOS = 0, isN = 0, both = 0;
  for (const r of o.res.values()) {
    if (r.oos[0] < MIN_OOS) continue;
    all++;
    const po = passOOS(r.oos);
    if (po) okOOS++;
    if (passIS(r.is)) { isN++; if (po) both++; }
  }
  say(`  ${o.name.padEnd(20)} passent le réglage ${String(isN).padStart(6)} / ${all} ; parmi elles ${isN ? ((both / isN) * 100).toFixed(1) : '—'} % passent le contrôle, contre ${((okOOS / all) * 100).toFixed(1)} % de toutes`);
}
say();

// 2. the best per market, chosen on the tuning part only
say('2. Les 5 meilleures par marché, choisies sur le réglage seul (score t), et leur contrôle (frais CME)');
for (const o of outs) {
  const rows = [...o.res.entries()].filter(([, r]) => passIS(r.is) && r.oos[0] >= MIN_OOS).sort((a, b) => tOf(b[1].is) - tOf(a[1].is)).slice(0, 5);
  say(`  ${o.name}`);
  for (const [k, r] of rows) {
    say(`    ${labelOf(k)}`);
    say(`      réglage  ${line(r.is)}`);
    say(`      contrôle ${line(r.oos)}   (CFD : ${fmt(r.oosCfd[2], 1)} R)`);
  }
}
say();

// 3. the same rule on every market: the methods that hold on most of them
const clean = outs.filter((o) => !MARKETS.find((m) => m.id === o.id)!.artifact);
say(`3. Une même règle sur les ${clean.length} marchés fiables (sans le Russell cash) : réglage additionné, puis contrôle`);
const pooled = new Map<string, { is: Acc; oos: Acc; oosCfd: Acc; isPos: number; oosPos: number; per: Res[] }>();
for (const o of clean) for (const [k, r] of o.res) {
  const p = pooled.get(k) ?? { is: acc(), oos: acc(), oosCfd: acc(), isPos: 0, oosPos: 0, per: [] };
  for (let i = 0; i < 6; i++) { p.is[i] += r.is[i]; p.oos[i] += r.oos[i]; p.oosCfd[i] += r.oosCfd[i]; }
  if (r.is[2] > 0) p.isPos++;
  if (r.oos[2] > 0) p.oosPos++;
  p.per.push(r);
  pooled.set(k, p);
}
const methods = [...pooled.entries()].filter(([, p]) => p.per.length >= clean.length && passIS(p.is) && p.isPos >= p.per.length - 1).sort((a, b) => tOf(b[1].is) - tOf(a[1].is));
say(`  ${methods.length} règles gagnent au réglage sur presque tous les marchés. Les 15 meilleures :`);
for (const [k, p] of methods.slice(0, 15)) {
  const yr = YEARS.map((y, i) => { let R = 0; for (const r of p.per) R += r.years[i][2]; return `${y} ${fmt(R, 0)}`; }).join(' · ');
  say(`    ${labelOf(k)}`);
  say(`      par année (R, frais CME) : ${yr}`);
  say(`      réglage  ${line(p.is)}  (${p.isPos}/${p.per.length} marchés positifs)`);
  say(`      contrôle ${line(p.oos)}  (${p.oosPos}/${p.per.length} marchés positifs, CFD ${fmt(p.oosCfd[2], 1)} R)`);
}
say();

// 4. walk-forward: each year traded with the rule best on the years before it
say('4. Pas à pas : chaque année jouée avec la règle la meilleure sur les années d’avant (frais CME)');
const wf: Record<string, { year: number; key: string; R: number; n: number }[]> = {};
for (const o of outs) {
  const steps: { year: number; key: string; R: number; n: number }[] = [];
  for (let y = 2022; y <= 2026; y++) {
    let bestK = '', bestT = -Infinity;
    for (const [k, r] of o.res) {
      const a = acc();
      for (let yy = 2020; yy < y; yy++) { const b = r.years[yy - 2020]; for (let i = 0; i < 6; i++) a[i] += b[i]; }
      if (a[0] < MIN_IS || pfOf(a) < 1.1) continue;
      const t = tOf(a);
      if (t > bestT) { bestT = t; bestK = k; }
    }
    if (!bestK) { steps.push({ year: y, key: '', R: 0, n: 0 }); continue; }
    const b = o.res.get(bestK)!.years[y - 2020];
    steps.push({ year: y, key: bestK, R: b[2], n: b[0] });
  }
  wf[o.id] = steps;
  const tot = steps.reduce((s, x) => s + x.R, 0);
  say(`  ${o.name.padEnd(20)} ${steps.map((s) => `${s.year} ${fmt(s.R, 1).padStart(6)} R (${s.n})`).join('  ')}   total ${fmt(tot, 1)} R`);
}
say();
say(`5. Pas à pas commun : chaque année, la même règle sur les ${clean.length} marchés fiables, choisie sur les années d’avant (frais CME)`);
const wfPooled: { year: number; key: string; R: number; n: number; per: number[] }[] = [];
const keys = [...clean[0].res.keys()];
for (let y = 2022; y <= 2026; y++) {
  let bestK = '', bestT = -Infinity;
  for (const k of keys) {
    const a = acc();
    for (const o of clean) { const r = o.res.get(k); if (!r) continue; for (let yy = 2020; yy < y; yy++) { const b = r.years[yy - 2020]; for (let i = 0; i < 6; i++) a[i] += b[i]; } }
    if (a[0] < MIN_IS * 3 || pfOf(a) < 1.1) continue;
    const t = tOf(a);
    if (t > bestT) { bestT = t; bestK = k; }
  }
  const per = clean.map((o) => o.res.get(bestK)?.years[y - 2020][2] ?? 0);
  const n = clean.reduce((s, o) => s + (o.res.get(bestK)?.years[y - 2020][0] ?? 0), 0);
  wfPooled.push({ year: y, key: bestK, R: per.reduce((s, x) => s + x, 0), n, per });
  say(`  ${y} : ${fmt(per.reduce((s, x) => s + x, 0), 1)} R sur ${n} trades (${clean.map((o, i) => `${o.id} ${fmt(per[i], 1)}`).join(', ')})`);
  say(`        règle : ${bestK ? labelOf(bestK) : '—'}`);
}
say(`  total ${fmt(wfPooled.reduce((s, x) => s + x.R, 0), 1)} R sur ${wfPooled.reduce((s, x) => s + x.n, 0)} trades`);
say();
// 6. each family as a whole: every setting of it on the reliable markets, both sides, any regime
say('6. Chaque famille dans son ensemble (tous ses réglages, les deux sens, tous régimes, marchés fiables, frais CME)');
for (const kind of KINDS) {
  let n = 0, isSum = 0, oosSum = 0, oosPos = 0, isTr = 0, oosTr = 0;
  for (const [k, p] of pooled) {
    if (!k.startsWith(`${kind}|`) || !k.endsWith('|0')) continue;
    n++;
    isSum += p.is[2]; isTr += p.is[0]; oosSum += p.oos[2]; oosTr += p.oos[0];
    if (p.oos[2] > 0) oosPos++;
  }
  say(`  ${labelOf(`${kind}|k0|s0.2|r1|w9999|L60|rv|0`).split(',')[0].padEnd(36)} ${n} réglages : réglage ${fmt(isSum / isTr, 3)} R/trade, contrôle ${fmt(oosSum / oosTr, 3)} R/trade, ${((oosPos / n) * 100).toFixed(0)} % positifs au contrôle`);
}
say();
say(`${((Date.now() - t0) / 1000).toFixed(0)} s`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'EM.txt'), rep.join('\n'));
// what a later step needs, compact: per market, the combinations passing the tuning part [IS, OOS, OOS CFD, years]
const dump: Record<string, Record<string, number[][]>> = {};
for (const o of outs) {
  const d: Record<string, number[][]> = {};
  for (const [k, r] of o.res) if (passIS(r.is)) d[k] = [Array.from(r.is), Array.from(r.oos), Array.from(r.oosCfd), ...r.years.map((a) => Array.from(a))];
  dump[o.id] = d;
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ wfPooled, markets: outs.map((o) => ({ id: o.id, name: o.name, src: MARKETS.find((m) => m.id === o.id)!.src, artifact: MARKETS.find((m) => m.id === o.id)!.artifact ?? null, sessions: o.sessions, from: o.from, to: o.to, split: o.dist })), wf, dump }));
