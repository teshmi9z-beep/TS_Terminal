import fs from 'node:fs';
import path from 'node:path';
import { COLS, readDataset } from './dataset';
import { daily, DATA, FROM, load15, MARKETS, SPLIT, type Market } from './pa-lib';
import { TIGHT } from './pa-check-costs';
import { NB_RULE, NB_SESSIONS, nbBand, nbDayTrade, nbNoise, nbSessions, type NbSessionKey } from '../../src/robots/noiseBand';
import { nyOffset } from '../../src/robots/features';

// Second round of the price-action study (2026-11-12): "beat the market".
// 1. the market to beat: buy and hold of each market, per year and since 2020 / 2022;
// 2. the noise-band robot's trades (src/robots/noiseBand.ts, tight costs) on a fixed universe,
//    each with what was known at its entry (VIX, the market's own volatility against its past
//    year, the gap, the hour, the daily trend...): where does the edge sit? Read on the tuning
//    period (2020-01 → 2024-08), checked on 2024-09 → 2026-09.
// node robots/.build/pa2-regime.mjs → robots/pa/regimes.txt, robots/pa/nb-trades.json
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const yr = (t: number) => new Date(t * 1000).getUTCFullYear();

// ---------------------------------------------------------------- 1. buy and hold
say('================ 1. LE MARCHÉ À BATTRE : acheter et garder (clôtures journalières, sans frais ni financement) ================');
const cagr = (a: number, b: number, t0: number, t1: number) => Math.pow(b / a, (365.25 * 86400) / (t1 - t0)) - 1;
const data = MARKETS.filter((m) => m.sym in TIGHT).map((m) => ({ m, b: load15(m) }));
const dailies = new Map(data.map(({ m, b }) => [m.sym, daily(b)]));
for (const { m } of data) {
  const d = dailies.get(m.sym)!;
  const row = (from: number) => {
    let i0 = 0;
    while (i0 < d.n && d.t[i0] < from) i0++;
    let peak = 0, dd = 0;
    for (let i = i0; i < d.n; i++) { peak = Math.max(peak, d.c[i]); dd = Math.max(dd, 1 - d.c[i] / peak); }
    return `${(100 * cagr(d.c[i0], d.c[d.n - 1], d.t[i0], d.t[d.n - 1])).toFixed(1).padStart(6)} %/an, creux ${(100 * dd).toFixed(0).padStart(3)} %`;
  };
  const ys: string[] = [];
  for (let y = 2020; y <= 2026; y++) {
    let a = NaN, z = NaN;
    for (let i = 0; i < d.n; i++) if (yr(d.t[i]) === y) { if (Number.isNaN(a)) a = i ? d.c[i - 1] : d.o[i]; z = d.c[i]; }
    ys.push(`${y} ${(100 * (z / a - 1)).toFixed(0)}`);
  }
  say(`${m.sym.padEnd(8)} depuis 2020 ${row(FROM)} | depuis 2022 ${row(Date.UTC(2022, 0, 1) / 1000)} | ${ys.join(' · ')}`);
}

// ---------------------------------------------------------------- 2. the robot's trades and their context
const vix = (() => {
  const { rows } = readDataset(path.join(DATA, 'yf_VIX_1d.bin'));
  const t: number[] = [], c: number[] = [];
  for (let i = 0; i < rows.length / COLS; i++) { t.push(Math.floor(rows[i * COLS] / 86400)); c.push(rows[i * COLS + 4]); }
  // the last close before the day
  return (day: number) => { let lo = 0, hi = t.length - 1, at = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] < day) { at = mid; lo = mid + 1; } else hi = mid - 1; } return at >= 0 ? c[at] : NaN; };
})();

export type Tr = {
  sym: string; key: string; cls: string; t: number; day: number; side: number; r: number; gross: number; costR: number;
  vix: number; volRatio: number; slot: number; slots: number; trend: number; gap: number; gapWith: number; over: number; dow: number; prevWith: number; unit: number;
};
const UNIVERSE: [string, NbSessionKey[]][] = [
  ['SPX500', ['us']], ['NDX100', ['us']], ['DJI', ['us']],
  ['XAUUSD', ['nym', 'ldn']], ['XAGUSD', ['nym', 'ldn']], ['BRENT', ['nym', 'ldn']],
  ...['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'].map((s): [string, NbSessionKey[]] => [s, ['ldn', 'nym']]),
];
const all: Tr[] = [];
for (const [sym, keys] of UNIVERSE) {
  const hit = data.find((x) => x.m.sym === sym);
  if (!hit) continue;
  const { m, b } = hit as { m: Market; b: ReturnType<typeof load15> };
  for (const key of keys) {
    const se = nbSessions(b, key, 900);
    const noise = nbNoise(b, se, NB_RULE.look);
    const units: number[] = [], closes: number[] = [];
    let prevMove = 0;
    for (let d = 0; d < se.days.length; d++) {
      const D = se.days[d];
      const band = D.full ? nbBand(b, se, D, noise[d], NB_RULE.k) : null;
      const dayClose = D.idx[se.slots - 1] >= 0 ? b.c[D.idx[se.slots - 1]] : NaN;
      if (band && b.t[D.idx[0]] >= FROM) {
        const t = nbDayTrade(b, se, D, band, true, NB_RULE);
        if (t) {
          const costR = (2 * TIGHT[sym] * t.entry) / t.risk;
          const past = units.slice(-250).sort((x, y) => x - y);
          let sma = 0; const cl = closes.slice(-20); for (const x of cl) sma += x / cl.length;
          const O = b.o[D.idx[0]];
          const local = b.t[t.entryBar] + nyOffset(b.t[t.entryBar]);
          const trigJ = D.idx.indexOf(t.trigger);
          all.push({
            sym, key, cls: m.cls, t: b.t[t.entryBar], day: D.date, side: t.side, gross: (t.legs[0].r + t.legs[1].r) / 2, costR, r: (t.legs[0].r + t.legs[1].r) / 2 - costR,
            vix: vix(D.date), volRatio: past.length >= 60 ? band.unit / past[past.length >> 1] : NaN,
            slot: Math.round(((((local % 86400) + 86400) % 86400) - NB_SESSIONS[key].open) / 900), slots: se.slots,
            trend: cl.length >= 20 ? t.side * Math.sign(D.prevC - sma) : 0,
            gap: Math.abs(O / D.prevC - 1) / band.unit, gapWith: t.side * Math.sign(O - D.prevC),
            over: (t.side > 0 ? b.c[t.trigger] / band.hi[trigJ] - 1 : 1 - b.c[t.trigger] / band.lo[trigJ]) / band.unit,
            dow: new Date(D.date * 86400000).getUTCDay(), prevWith: t.side * Math.sign(prevMove), unit: band.unit,
          });
        }
      }
      if (D.full) {
        if (band) units.push(band.unit);
        prevMove = dayClose - b.o[D.idx[0]];
        closes.push(dayClose);
      }
    }
  }
}
all.sort((a, z) => a.t - z.t);
fs.mkdirSync('robots/pa', { recursive: true });
fs.writeFileSync('robots/pa/nb-trades.json', JSON.stringify(all));

// r here: the mean of the two entries, in R (1 R = the stop, 2 usual session moves)
type S = { n: number; avg: number; t: number };
function st(ts: Tr[]): S {
  if (!ts.length) return { n: 0, avg: 0, t: 0 };
  const byDay = new Map<number, number>();
  let sum = 0;
  for (const x of ts) { sum += x.r; byDay.set(x.day, (byDay.get(x.day) ?? 0) + x.r); }
  const v = [...byDay.values()], mu = v.reduce((a, z) => a + z, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, z) => a + (z - mu) ** 2, 0) / Math.max(1, v.length - 1));
  return { n: ts.length, avg: sum / ts.length, t: sd ? (mu / sd) * Math.sqrt(v.length) : 0 };
}
const f = (s: S) => `${String(s.n).padStart(5)} tr ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)} R t ${s.t.toFixed(1).padStart(4)}`;
const both = (ts: Tr[]) => `avant ${f(st(ts.filter((x) => x.t < SPLIT)))} | après ${f(st(ts.filter((x) => x.t >= SPLIT)))}`;

say('\n================ 2. ROBOT BANDE DE BRUIT, univers fixe, frais serrés (R = moyenne des 2 entrées) ================');
const legsOf = [...new Set(all.map((x) => `${x.sym}/${x.key}`))];
for (const L of legsOf) say(`${L.padEnd(12)} ${both(all.filter((x) => `${x.sym}/${x.key}` === L))}`);

const POOLS: [string, (x: Tr) => boolean][] = [
  ['indices US', (x) => x.cls === 'Index'],
  ['or + argent + Brent', (x) => x.cls === 'Commodity'],
  ['forex', (x) => x.cls === 'Forex'],
  ['tout', () => true],
];
const BUCKETS: [string, [string, (x: Tr) => boolean][]][] = [
  ['VIX de la veille', [['< 15', (x) => x.vix < 15], ['15-20', (x) => x.vix >= 15 && x.vix < 20], ['20-25', (x) => x.vix >= 20 && x.vix < 25], ['≥ 25', (x) => x.vix >= 25]]],
  ['volatilité du marché / sa médiane d’un an', [['< 0,8', (x) => x.volRatio < 0.8], ['0,8-1,2', (x) => x.volRatio >= 0.8 && x.volRatio < 1.2], ['≥ 1,2', (x) => x.volRatio >= 1.2]]],
  ['heure d’entrée (part de la séance)', [['1er tiers', (x) => x.slot < x.slots / 3], ['2e tiers', (x) => x.slot >= x.slots / 3 && x.slot < (2 * x.slots) / 3], ['3e tiers', (x) => x.slot >= (2 * x.slots) / 3]]],
  ['sens', [['achat', (x) => x.side > 0], ['vente', (x) => x.side < 0]]],
  ['tendance 20 séances', [['avec', (x) => x.trend > 0], ['contre', (x) => x.trend < 0]]],
  ['gap d’ouverture', [['petit (< 0,25 mouvement)', (x) => x.gap < 0.25], ['grand, dans le sens du trade', (x) => x.gap >= 0.25 && x.gapWith > 0], ['grand, contre', (x) => x.gap >= 0.25 && x.gapWith < 0]]],
  ['séance de la veille', [['dans le même sens', (x) => x.prevWith > 0], ['en sens contraire', (x) => x.prevWith < 0]]],
  ['dépassement de la bande au signal', [['< 0,1 mouvement', (x) => x.over < 0.1], ['0,1-0,3', (x) => x.over >= 0.1 && x.over < 0.3], ['≥ 0,3', (x) => x.over >= 0.3]]],
  ['jour', [['lundi', (x) => x.dow === 1], ['mardi', (x) => x.dow === 2], ['mercredi', (x) => x.dow === 3], ['jeudi', (x) => x.dow === 4], ['vendredi', (x) => x.dow === 5]]],
];
for (const [pn, pf] of POOLS) {
  const pool = all.filter(pf);
  say(`\n--- ${pn} : ${both(pool)}`);
  for (const [bn, bs] of BUCKETS) {
    say(`  ${bn}`);
    for (const [name, test] of bs) say(`    ${name.padEnd(30)} ${both(pool.filter(test))}`);
  }
}
fs.writeFileSync('robots/pa/regimes.txt', lines.join('\n'));
