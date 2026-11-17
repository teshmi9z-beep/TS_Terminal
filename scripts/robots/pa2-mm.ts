import fs from 'node:fs';
import { daily, FROM, load15, MARKETS, rng, SPLIT, type Bars, type Cls } from './pa-lib';
import { TIGHT } from './pa-check-costs';
import { NB_RULE, nbBand, nbDayTrade, nbNoise, nbSessions, type NbSessionKey } from '../../src/robots/noiseBand';

// The money-management lab (2026-11-12). Part 1: entries at random (random bar, random side),
// so that no result can come from the entry: what each way of managing a trade does by itself.
// Part 2: the same plans on the noise-band robot's real signals.
// Everything is in R: 1 R = the first stop's distance (S x ATR 14 for the random entries), and a
// plan always risks 1 R in all when it starts (3 entries: a third each).
// node robots/.build/pa2-mm.mjs → robots/pa/mm-hasard.txt
const lines: string[] = [];
const say = (s = '', show = false) => { if (show || process.argv.includes('tout')) console.log(s); lines.push(s); };

// ---------------------------------------------------------------- the plans
// legs: the entries taken at the start, each with its share of the risk and its target in R (0: none)
// be: the stop goes to the entry after the first target (or once the price made +be R when there is none)
// lock: after the second target the stop goes to the first one
// trail: a trailing stop that many R behind the best price (from the start, or after the first target with trailAfter)
// add: entries added later at these R (pyramid when positive, averaging down when negative), each 1 unit
//      of size; with a pyramid the stop of everything goes up one step at each add
// time: bars held at most
type Plan = { name: string; legs: { w: number; tp: number }[]; be?: number | 'tp1'; lock?: boolean; trail?: number; trailAfter?: boolean; add?: number[]; time?: number };
const one = (tp: number) => [{ w: 1, tp }];
const PLANS: Plan[] = [
  { name: 'SL fixe, TP fixe 1 R', legs: one(1) },
  { name: 'SL fixe, TP fixe 2 R', legs: one(2) },
  { name: 'SL fixe, TP fixe 3 R', legs: one(3) },
  { name: 'SL fixe, sortie au temps (50 bougies)', legs: one(0), time: 50 },
  { name: 'Stop suiveur à 1 R', legs: one(0), trail: 1 },
  { name: 'Stop suiveur à 1,5 R', legs: one(0), trail: 1.5 },
  { name: 'Break-even à +1 R, TP 3 R', legs: one(3), be: 1 },
  { name: '3 entrées TP 1 / 2 / 3 R, SL fixe', legs: [{ w: 1 / 3, tp: 1 }, { w: 1 / 3, tp: 2 }, { w: 1 / 3, tp: 3 }] },
  { name: '3 entrées TP 1 / 2 / 3 R, SL à l’entrée après TP1, à TP1 après TP2', legs: [{ w: 1 / 3, tp: 1 }, { w: 1 / 3, tp: 2 }, { w: 1 / 3, tp: 3 }], be: 'tp1', lock: true },
  { name: '2 entrées : TP 1 R + suiveur 1,5 R, break-even après TP1', legs: [{ w: 0.5, tp: 1 }, { w: 0.5, tp: 0 }], be: 'tp1', trail: 1.5, trailAfter: true },
  { name: '4 entrées : TP 0,5 / 1 / 2 R + suiveur 1,5 R, break-even après TP 0,5', legs: [{ w: 0.25, tp: 0.5 }, { w: 0.25, tp: 1 }, { w: 0.25, tp: 2 }, { w: 0.25, tp: 0 }], be: 'tp1', trail: 1.5, trailAfter: true },
  { name: 'Pyramide : + 1 à +1 R et +2 R, stop remonté d’un cran, suiveur 1,5 R', legs: one(0), add: [1, 2], trail: 1.5 },
  { name: 'Moyenne à la baisse : + 1 à −0,5 R, TP 1 R', legs: one(1), add: [-0.5] },
];

type Series = { o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; n: number; roll?: Uint8Array };
// one trade: the gross result in R, the size traded (for the costs: 1 = the starting size once in and out), the bars held
function trade(b: Series, e: number, dir: number, R: number, p: Plan, end: number): { r: number; size: number; bars: number } {
  const entry = b.o[e];
  let stop = entry - dir * R, best = entry, r = 0, size = 1;
  // open parts: weight (in starting size), entry price, target price or NaN
  let open = p.legs.map((l) => ({ w: l.w, px: entry, tp: l.tp ? entry + dir * l.tp * R : NaN, born: -1 }));
  const adds = (p.add ?? []).map((a) => ({ at: entry + dir * a * R, a, done: false }));
  let tps = 0, trailing = !!p.trail && !p.trailAfter;
  const close = (px: number, k: number) => { r += (open[k].w * dir * (px - open[k].px)) / R; };
  let q = e;
  for (; q <= end; q++) {
    if (b.roll?.[q]) continue;
    const hi = dir > 0 ? b.h[q] : -b.l[q], lo = dir > 0 ? b.l[q] : -b.h[q], op = dir > 0 ? b.o[q] : -b.o[q];
    const sgn = (v: number) => (dir > 0 ? v : -v);
    // averaging down: the add is reached before the stop and before the targets
    // (filled at the open when the bar opens beyond it; it cannot reach its target on the bar it was filled on, unless the bar closes there)
    for (const a of adds) if (!a.done && a.a < 0 && lo <= sgn(a.at)) { a.done = true; open.push({ w: 1, px: sgn(Math.min(op, sgn(a.at))), tp: open[0]?.tp ?? NaN, born: q }); size += 1; }
    // the stop first (the worst case inside a bar)
    if (lo <= sgn(stop)) { const px = q === e ? stop : sgn(Math.min(op, sgn(stop))); for (let k = 0; k < open.length; k++) close(px, k); open = []; break; }
    // targets (on the entry bar only when the bar closes beyond: the order inside it is unknown)
    for (let k = open.length - 1; k >= 0; k--) {
      const tp = open[k].tp;
      if (Number.isNaN(tp)) continue;
      const hit = q === e || open[k].born === q ? sgn(b.c[q]) >= sgn(tp) : hi >= sgn(tp);
      if (hit) { close(q === e || open[k].born === q ? b.c[q] : sgn(Math.max(op, sgn(tp))), k); open.splice(k, 1); tps++; }
    }
    if (!open.length) break;
    // pyramid adds, the stop of everything one step up
    for (const a of adds) if (!a.done && a.a > 0 && q > e && hi >= sgn(a.at)) {
      a.done = true; open.push({ w: 1, px: sgn(Math.max(op, sgn(a.at))), tp: NaN, born: q }); size += 1;
      const ns = a.at - dir * R; if (dir * (ns - stop) > 0) stop = ns;
      // the add's bar also trades at the raised stop: which came first is unknown. A bar that closes against the
      // trade is read as high first, then the stop (PYR=pire: always stopped, PYR=mieux: never); the intraday
      // bars of a session's open are several times the ATR of the night before, so the two bounds are far apart
      const mode = process.env.PYR ?? 'bougie';
      if (lo <= sgn(stop) && (mode === 'pire' || (mode === 'bougie' && sgn(b.c[q]) < op))) { for (let k = 0; k < open.length; k++) close(stop, k); open = []; }
    }
    if (!open.length) break;
    // the stop for the next bars
    if (p.be === 'tp1' ? tps >= 1 : p.be !== undefined && hi >= sgn(entry + dir * p.be * R)) { if (dir * (entry - stop) > 0) stop = entry; }
    if (p.lock && tps >= 2) { const ns = entry + dir * R; if (dir * (ns - stop) > 0) stop = ns; }
    if (p.trailAfter && tps >= 1) trailing = true;
    best = dir > 0 ? Math.max(best, b.h[q]) : Math.min(best, b.l[q]);
    if (trailing) { const ns = best - dir * p.trail! * R; if (dir * (ns - stop) > 0) stop = ns; }
    // a stop moved on this bar and already passed by its close: out at the close (the order inside the bar is unknown)
    if (sgn(b.c[q]) <= sgn(stop)) { for (let k = 0; k < open.length; k++) close(b.c[q], k); open = []; break; }
    if (q >= end || (p.time && q - e + 1 >= p.time)) { for (let k = 0; k < open.length; k++) close(b.c[q], k); open = []; break; }
  }
  for (let k = 0; k < open.length; k++) close(b.c[Math.min(q, b.n - 1)], k);
  return { r, size, bars: Math.min(q, end) - e + 1 };
}

type Acc = { n: number; g: number; g2: number; cost: number; wins: number; sw: number; sl: number; bars: number; seq: number[] };
const acc = (): Acc => ({ n: 0, g: 0, g2: 0, cost: 0, wins: 0, sw: 0, sl: 0, bars: 0, seq: [] });
function push(a: Acc, r: number, costR: number, bars: number) {
  const net = r - costR;
  a.n++; a.g += r; a.g2 += r * r; a.cost += costR; a.bars += bars;
  if (net > 0) { a.wins++; a.sw += net; } else a.sl -= net;
  a.seq.push(net);
}
function row(name: string, a: Acc): string {
  const mu = a.g / a.n, sd = Math.sqrt(a.g2 / a.n - mu * mu), net = mu - a.cost / a.n;
  // the worst run of the sequence, in R, and the longest losing streak
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const x of a.seq) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); streak = x > 0 ? 0 : streak + 1; worst = Math.max(worst, streak); }
  const payoff = a.wins && a.n - a.wins ? (a.sw / a.wins) / (a.sl / (a.n - a.wins)) : 0;
  const s = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  return `${name.padEnd(74)} brut ${s(mu)} (t ${((mu / sd) * Math.sqrt(a.n)).toFixed(1).padStart(5)})  net ${s(net)}  gagnants ${((100 * a.wins) / a.n).toFixed(0).padStart(2)} %  gain/perte ${payoff.toFixed(2)}  écart-type ${sd.toFixed(2)}  durée ${(a.bars / a.n).toFixed(0).padStart(3)}  pire série ${String(worst).padStart(2)}  creux ${dd.toFixed(0)} R`;
}

// ---------------------------------------------------------------- bars of each timeframe
function atr14(b: Series): Float64Array {
  const out = new Float64Array(b.n);
  let v = 0;
  for (let i = 0; i < b.n; i++) {
    const tr = i ? Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) : b.h[i] - b.l[i];
    v = i < 14 ? (v * i + tr) / (i + 1) : (v * 13 + tr) / 14;
    out[i] = v;
  }
  return out;
}
function aggregate(b: Bars, sec: number): Series & { t: number[] } {
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], roll: number[] = [];
  let cur = -1;
  for (let i = 0; i < b.n; i++) {
    const k = Math.floor(b.t[i] / sec);
    if (k !== cur) { cur = k; t.push(k * sec); o.push(b.o[i]); h.push(b.h[i]); l.push(b.l[i]); c.push(b.c[i]); roll.push(0); }
    const j = t.length - 1;
    h[j] = Math.max(h[j], b.h[i]); l[j] = Math.min(l[j], b.l[i]); c[j] = b.c[i];
    // an hourly bar holding rollover bars is left out, as in the lab
    if (b.roll[i] && sec <= 3600) roll[j] = 1;
  }
  return { t, o, h, l, c, n: t.length, roll: Uint8Array.from(roll) };
}

const data = MARKETS.filter((m) => m.sym in TIGHT).map((m) => ({ m, b: load15(m) }));
const TFS = ['15 min', '1 h', '4 h', 'jour'];
const CLS: Cls[] = ['Index', 'Forex', 'Commodity'];
const CLS_FR: Record<Cls, string> = { Index: 'indices', Forex: 'forex', Commodity: 'matières premières' };
const N = 2500, HOLD = 200;

say('================ 1. ENTRÉES AU HASARD (bougie et sens tirés au sort), depuis 2020 ================');
say(`${N} entrées par marché et par unité de temps ; stop à S × ATR 14 ; ${HOLD} bougies au plus ; net = frais serrés`);
// results[S][tf][cls][plan]
const res = new Map<string, Acc>();
const key = (S: number, tf: string, cls: string, p: number) => `${S}|${tf}|${cls}|${p}`;
for (const { m, b } of data) {
  const d = daily(b);
  const series: Series[] = [b, aggregate(b, 3600), aggregate(b, 14400), d];
  const times: ArrayLike<number>[] = [b.t, (series[1] as ReturnType<typeof aggregate>).t, (series[2] as ReturnType<typeof aggregate>).t, d.t];
  series.forEach((s, ti) => {
    const atr = atr14(s);
    let first = 0;
    while (first < s.n && times[ti][first] < FROM) first++;
    first = Math.max(first, 20);
    const next = rng(1000 + ti * 7 + m.sym.length * 31 + m.sym.charCodeAt(0));
    const n = ti === 3 ? Math.min(N, 1500) : N;
    for (let k = 0; k < n; k++) {
      const i = first + Math.floor(next() * (s.n - first - 3));
      const dir = next() < 0.5 ? 1 : -1;
      const e = i + 1;
      if (s.roll?.[e] || !(atr[i] > 0)) continue;
      for (const S of [1, 2, 3]) {
        const R = S * atr[i];
        const unitCost = (2 * TIGHT[m.sym] * s.o[e]) / R;
        PLANS.forEach((p, pi) => {
          const t = trade(s, e, dir, R, p, Math.min(s.n - 1, e + HOLD - 1));
          for (const c of [m.cls, 'tout']) {
            const kk = key(S, TFS[ti], c, pi);
            push(res.get(kk) ?? res.set(kk, acc()).get(kk)!, t.r, unitCost * t.size, t.bars);
          }
        });
      }
    }
  });
}
for (const S of [2]) for (const tf of TFS) {
  say(`\n--- stop ${S} ATR · ${tf} · tous les marchés`);
  PLANS.forEach((p, pi) => say(row(p.name, res.get(key(S, tf, 'tout', pi))!)));
}
say('\n--- par classe (stop 2 ATR) : résultat brut en R par plan, 15 min / 1 h / 4 h / jour');
for (const c of CLS) {
  say(`  ${CLS_FR[c]}`);
  PLANS.forEach((p, pi) => say(`    ${p.name.padEnd(74)} ${TFS.map((tf) => { const a = res.get(key(2, tf, c, pi))!; const mu = a.g / a.n, sd = Math.sqrt(a.g2 / a.n - mu * mu); return `${(mu >= 0 ? '+' : '') + mu.toFixed(3)} (t ${((mu / sd) * Math.sqrt(a.n)).toFixed(1)})`; }).join('  ')}`));
}
say('\n--- la taille du stop (tous marchés, 1 h) : net en R, frais serrés, stop à 1 / 2 / 3 ATR');
PLANS.forEach((p, pi) => say(`    ${p.name.padEnd(74)} ${[1, 2, 3].map((S) => { const a = res.get(key(S, '1 h', 'tout', pi))!; const v = (a.g - a.cost) / a.n; return `${(v >= 0 ? '+' : '') + v.toFixed(3)}`; }).join('  ')}`));

// ---------------------------------------------------------------- 2. the same plans on the robot's signals
say('\n================ 2. LES MÊMES PLANS SUR LES SIGNAUX DU ROBOT BANDE DE BRUIT (15 min, sortie au plus tard en fin de séance) ================');
say('1 R = S fois le mouvement habituel d’une séance ; Nasdaq, S&P 500, or (New York), USDJPY (Londres) ; frais serrés');
const LEGS: [string, NbSessionKey][] = [['NDX100', 'us'], ['SPX500', 'us'], ['XAUUSD', 'nym'], ['USDJPY', 'ldn']];
type Sig = { sym: string; b: Bars; e: number; dir: number; unitPx: number; end: number; t: number; day: number };
const sigs: Sig[] = [];
for (const [sym, k] of LEGS) {
  const b = data.find((x) => x.m.sym === sym)!.b;
  const se = nbSessions(b, k, 900), noise = nbNoise(b, se, NB_RULE.look);
  for (let d = 0; d < se.days.length; d++) {
    const D = se.days[d];
    if (!D.full || b.t[D.idx[0]] < FROM) continue;
    const band = nbBand(b, se, D, noise[d], NB_RULE.k);
    const t = band && nbDayTrade(b, se, D, band, true, NB_RULE);
    if (!t || !band) continue;
    let end = t.entryBar;
    for (let q = se.slots - 1; q >= 0; q--) if (D.idx[q] >= 0) { end = D.idx[q]; break; }
    sigs.push({ sym, b, e: t.entryBar, dir: t.side, unitPx: band.unit * t.entry, end, t: b.t[t.entryBar], day: D.date });
  }
}
sigs.sort((a, z) => a.t - z.t);
const SESSION_PLANS: Plan[] = [{ name: 'SL fixe, sortie en fin de séance', legs: one(0) }, ...PLANS.filter((p) => !p.time)];
for (const S of [1, 2, 3]) {
  say(`\n--- stop à ${S} mouvement(s) habituel(s) · résultat en R (1 R = ce stop)`);
  for (const p of SESSION_PLANS) {
    const a = acc(), is = acc(), oos = acc();
    for (const s of sigs) {
      const R = S * s.unitPx;
      const t = trade(s.b, s.e, s.dir, R, p, s.end);
      const c = ((2 * TIGHT[s.sym] * s.b.o[s.e]) / R) * t.size;
      push(a, t.r, c, t.bars); push(s.t < SPLIT ? is : oos, t.r, c, t.bars);
    }
    const net = (x: Acc) => (x.g - x.cost) / x.n;
    say(`${row(p.name, a)} | avant ${net(is).toFixed(3)} après ${net(oos).toFixed(3)}`);
  }
}
fs.writeFileSync('robots/pa/mm-hasard.txt', lines.join('\n'));
