import fs from 'node:fs';
import { daily, FROM, load15, MARKETS, SPLIT, type Bars, type Daily } from './pa-lib';
import { TIGHT } from './pa-check-costs';
import { nyOffset } from '../../src/robots/features';

// Second round, two slower ideas measured against buy and hold:
// 1. where the day's return is made: each market's move split by part of the day (night /
//    cash session for the US indices; Asia / London / New York for the 24-hour markets);
// 2. allocation by momentum: each month, hold the K markets that rose most over the last L
//    months (cash when a market fell), and an index held only above its 200-day average.
// node robots/.build/pa2-alloc.mjs → robots/pa/allocation.txt
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const yr = (t: number) => new Date(t * 1000).getUTCFullYear();
const data = MARKETS.filter((m) => m.sym in TIGHT).map((m) => ({ m, b: load15(m) }));

// ---------------------------------------------------------------- 1. the parts of the day
say('================ 1. OÙ SE FAIT LE RENDEMENT : par partie de la journée (heure de New York), % par an, sans frais ================');
type Part = { name: string; from: number; to: number };
const PARTS_24: Part[] = [{ name: 'Asie 18h15-3h', from: 18.25, to: 3 }, { name: 'Londres 3h-8h', from: 3, to: 8 }, { name: 'New York 8h-16h45', from: 8, to: 16.75 }];
const PARTS_US: Part[] = [{ name: 'nuit 16h-9h30', from: 16, to: 9.5 }, { name: 'séance 9h30-16h', from: 9.5, to: 16 }];
function partReturns(b: Bars, p: Part): { t: number; r: number }[] {
  // the price at each boundary: the open of the first bar at or after it (within 2 hours)
  const at = (h: number) => {
    const out = new Map<number, { t: number; px: number }>();
    for (let i = 0; i < b.n; i++) {
      if (b.roll[i]) continue;
      const local = b.t[i] + nyOffset(b.t[i]);
      const sec = ((local % 86400) + 86400) % 86400, day = Math.floor(local / 86400);
      if (sec >= h * 3600 && sec < h * 3600 + 7200 && !out.has(day)) out.set(day, { t: b.t[i], px: b.o[i] });
    }
    return out;
  };
  const A = at(p.from), Z = at(p.to);
  const out: { t: number; r: number }[] = [];
  for (const [day, a] of A) {
    // the end: the same day, or the next ones when the part crosses midnight (a weekend: up to 3 days)
    let z = p.to > p.from ? Z.get(day) : undefined;
    if (p.to <= p.from) for (let k = 1; k <= 4 && !z; k++) z = Z.get(day + k);
    if (z && z.t > a.t && z.t - a.t < 4.5 * 86400 && a.t >= FROM) out.push({ t: a.t, r: Math.log(z.px / a.px) });
  }
  return out;
}
for (const { m, b } of data) {
  const us = ['SPX500', 'NDX100', 'DJI'].includes(m.sym);
  if (m.cls === 'Index' && !us) continue;
  const parts = us ? PARTS_US : PARTS_24;
  const cells = parts.map((p) => {
    const rs = partReturns(b, p);
    const stat = (xs: { r: number }[]) => {
      const n = xs.length, mu = xs.reduce((a, x) => a + x.r, 0) / n;
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x.r - mu) ** 2, 0) / (n - 1));
      return { ann: 100 * mu * 252, t: (mu / sd) * Math.sqrt(n) };
    };
    const a = stat(rs.filter((x) => x.t < SPLIT)), o = stat(rs.filter((x) => x.t >= SPLIT));
    return `${p.name} : avant ${a.ann.toFixed(1).padStart(6)} (t ${a.t.toFixed(1)}), après ${o.ann.toFixed(1).padStart(6)} (t ${o.t.toFixed(1)})`;
  });
  say(`${m.sym.padEnd(8)} ${cells.join(' | ')}   · un aller-retour par jour coûte ${(100 * 2 * TIGHT[m.sym] * 252).toFixed(1)} %/an`);
}

// ---------------------------------------------------------------- 2. allocation by momentum
say('\n================ 2. ALLOCATION PAR MOMENTUM (journalier, rééquilibrage mensuel) ================');
const UNI = ['SPX500', 'NDX100', 'DJI', 'DAX40', 'CAC40', 'FTSE100', 'NIKKEI', 'XAUUSD', 'XAGUSD', 'BRENT'];
const ds = new Map<string, Daily>(data.filter((x) => UNI.includes(x.m.sym)).map(({ m, b }) => [m.sym, daily(b)]));
// a common calendar: every day at least 6 markets traded; a market's last close carried
const days = [...new Set([...ds.values()].flatMap((d) => [...d.t]))].sort((a, z) => a - z)
  .filter((t) => [...ds.values()].filter((d) => d.t.includes(t)).length >= 6);
const px = new Map<string, Float64Array>();
for (const [sym, d] of ds) {
  const out = new Float64Array(days.length).fill(NaN);
  let k = 0, last = NaN;
  for (let i = 0; i < days.length; i++) { while (k < d.n && d.t[k] <= days[i]) last = d.c[k++]; out[i] = last; }
  px.set(sym, out);
}
const i0 = days.findIndex((t) => t >= FROM);
type Curve = { eq: number[]; label: string };
// holding a CFD: 6.8 % a year on what is held; an ETF or a future: about nothing (0)
function summarize(c: Curve, from = i0): string {
  const part = (a: number, z: number) => {
    let peak = 0, dd = 0;
    for (let i = a; i <= z; i++) { peak = Math.max(peak, c.eq[i]); dd = Math.max(dd, 1 - c.eq[i] / peak); }
    const cagr = Math.pow(c.eq[z] / c.eq[a], (365.25 * 86400) / (days[z] - days[a])) - 1;
    // Sharpe on daily returns
    let s = 0, s2 = 0, n = 0;
    for (let i = a + 1; i <= z; i++) { const r = c.eq[i] / c.eq[i - 1] - 1; s += r; s2 += r * r; n++; }
    const mu = s / n, sd = Math.sqrt(s2 / n - mu * mu);
    return `${(100 * cagr).toFixed(1).padStart(5)} %/an creux ${(100 * dd).toFixed(0).padStart(2)} % Sharpe ${(sd ? (mu / sd) * Math.sqrt(252) : 0).toFixed(2)}`;
  };
  const sp = days.findIndex((t) => t >= SPLIT);
  const ys: string[] = [];
  for (let y = 2020; y <= 2026; y++) {
    const a = days.findIndex((t) => yr(t) === y), z = days.length - 1 - [...days].reverse().findIndex((t) => yr(t) === y);
    ys.push(`${String(y).slice(2)}:${(100 * (c.eq[z] / c.eq[Math.max(from, a - 1)] - 1)).toFixed(0)}`);
  }
  return `${c.label.padEnd(46)} tout ${part(from, days.length - 1)} | avant ${part(from, sp)} | après ${part(sp, days.length - 1)} | ${ys.join(' ')}`;
}
function hold(weightsAt: (i: number) => Map<string, number>, label: string, fin = 0, cost = 0.0003): Curve {
  const eq = new Array<number>(days.length).fill(1);
  let w = new Map<string, number>(), month = -1;
  for (let i = i0; i < days.length; i++) {
    if (i > i0) {
      let r = 0;
      for (const [s, x] of w) { const p = px.get(s)!; if (p[i - 1] > 0 && p[i] > 0) r += x * (p[i] / p[i - 1] - 1 - (fin * (days[i] - days[i - 1])) / (365 * 86400)); }
      eq[i] = eq[i - 1] * (1 + r);
    }
    const mo = new Date(days[i] * 1000).getUTCMonth();
    if (mo !== month) {
      month = mo;
      const nw = weightsAt(i);
      // the cost of what changes hands
      let turn = 0;
      for (const s of new Set([...w.keys(), ...nw.keys()])) turn += Math.abs((nw.get(s) ?? 0) - (w.get(s) ?? 0));
      eq[i] *= 1 - turn * cost;
      w = nw;
    }
  }
  return { eq, label };
}
const ew = (list: string[]) => new Map(list.map((s) => [s, 1 / list.length]));
say('Références (acheter et garder) :');
say(summarize(hold(() => ew(['SPX500']), 'S&P 500')));
say(summarize(hold(() => ew(['NDX100']), 'Nasdaq 100')));
say(summarize(hold(() => ew(['XAUUSD']), 'Or')));
say(summarize(hold(() => ew(UNI), 'Les 10 marchés à parts égales')));
say('\nMomentum : les K meilleurs sur L mois, seulement s’ils ont monté (sinon cette part reste en liquide) :');
const MONTH = 21;
for (const L of [3, 6, 12]) for (const K of [2, 3, 5]) {
  const f = (i: number) => {
    const sc = UNI.map((s) => ({ s, m: px.get(s)![i] / px.get(s)![Math.max(0, i - L * MONTH)] - 1 })).filter((x) => Number.isFinite(x.m)).sort((a, z) => z.m - a.m).slice(0, K);
    return new Map(sc.filter((x) => x.m > 0).map((x) => [x.s, 1 / K]));
  };
  say(summarize(hold(f, `${L} mois, ${K} marchés`)));
}
say('\nLe même avec le financement d’un CFD (6,8 % par an sur ce qui est tenu) :');
for (const [L, K] of [[6, 3], [12, 3]]) {
  const f = (i: number) => {
    const sc = UNI.map((s) => ({ s, m: px.get(s)![i] / px.get(s)![Math.max(0, i - L * MONTH)] - 1 })).filter((x) => Number.isFinite(x.m)).sort((a, z) => z.m - a.m).slice(0, K);
    return new Map(sc.filter((x) => x.m > 0).map((x) => [x.s, 1 / K]));
  };
  say(summarize(hold(f, `${L} mois, ${K} marchés, CFD`, 0.068)));
}
say(summarize(hold(() => ew(['SPX500']), 'S&P 500 en CFD', 0.068)));
say('\nUn indice tenu seulement au-dessus de sa moyenne 200 jours (vérifié chaque mois) :');
for (const s of ['SPX500', 'NDX100', 'NIKKEI', 'XAUUSD']) {
  const p = px.get(s)!;
  const f = (i: number) => { let sum = 0, n = 0; for (let j = Math.max(0, i - 199); j <= i; j++) if (p[j] > 0) { sum += p[j]; n++; } return p[i] > sum / n ? ew([s]) : new Map<string, number>(); };
  say(summarize(hold(f, `${s} au-dessus de sa moyenne 200 j`)));
}
fs.writeFileSync('robots/pa/allocation.txt', lines.join('\n'));
