import fs from 'node:fs';
import { daily, load15, MARKETS, rng } from './pa-lib';
import type { Tr } from './pa2-regime';

// Second round, the comparison with the market. The noise-band robot (src/robots/noiseBand.ts,
// one fixed rule) traded as a portfolio without hindsight: each year from 2022, a market and
// session is traded only if the same rule had t > 1.5 on it over all the years before
// (robots/pa/nb-trades.json, 23 markets and sessions, tight costs). One account, a fixed share
// of it risked on each signal (1 R = the stop), sizes set from the evening before. Against
// buying and holding the S&P 500, the Nasdaq 100 and gold over the same days.
// node robots/.build/pa2-portfolio.mjs [cost multiplier] → robots/pa/portefeuille.txt
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const mult = Number(process.argv[2] ?? 1);
const all = (JSON.parse(fs.readFileSync('robots/pa/nb-trades.json', 'utf8')) as Tr[]).map((x) => ({ ...x, r: x.gross - mult * x.costR }));
const yr = (t: number) => new Date(t * 1000).getUTCFullYear();
const legOf = (x: Tr) => `${x.sym}/${x.key}`;

// ---------------------------------------------------------------- the walk-forward choice of markets
function tOf(ts: Tr[]): number {
  const byDay = new Map<number, number>();
  for (const x of ts) byDay.set(x.day, (byDay.get(x.day) ?? 0) + x.r);
  const v = [...byDay.values()];
  if (v.length < 100) return 0;
  const mu = v.reduce((a, z) => a + z, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, z) => a + (z - mu) ** 2, 0) / (v.length - 1));
  return sd ? (mu / sd) * Math.sqrt(v.length) : 0;
}
const legs = [...new Set(all.map(legOf))];
const picked: Tr[] = [];
say(`================ PORTEFEUILLE SANS REGARD EN ARRIÈRE (frais serrés × ${mult}) ================`);
say('Marchés tradés chaque année (t > 1,5 sur toutes les années d’avant, même règle) :');
for (let Y = 2022; Y <= 2026; Y++) {
  const names: string[] = [];
  for (const L of legs) {
    const mine = all.filter((x) => legOf(x) === L);
    if (tOf(mine.filter((x) => yr(x.t) < Y)) <= 1.5) continue;
    const got = mine.filter((x) => yr(x.t) === Y);
    picked.push(...got);
    names.push(`${L} ${got.reduce((a, x) => a + x.r, 0).toFixed(1)} R`);
  }
  say(`  ${Y} : ${names.join(' · ') || 'aucun'}`);
}
picked.sort((a, z) => a.day - z.day || a.t - z.t);
const n = picked.length, sum = picked.reduce((a, x) => a + x.r, 0);
say(`\n${n} signaux, ${sum.toFixed(1)} R, ${(sum / n).toFixed(3)} R par signal, t ${tOf(picked).toFixed(1)}`);
fs.writeFileSync('robots/pa/portefeuille-trades.json', JSON.stringify(picked));

// ---------------------------------------------------------------- daily curves
const days = [...new Set(picked.map((x) => x.day))].sort((a, z) => a - z);
const first = days[0], last = days[days.length - 1];
const cal: number[] = [];
for (let d = first; d <= last; d++) { const w = new Date(d * 86400000).getUTCDay(); if (w >= 1 && w <= 5) cal.push(d); }
const byDay = new Map<number, Tr[]>();
for (const x of picked) byDay.set(x.day, [...(byDay.get(x.day) ?? []), x]);
function robot(f: number): number[] {
  // daily returns: every signal of the day risks f of the account as it stood the evening before
  return cal.map((d) => (byDay.get(d) ?? []).reduce((a, x) => a + f * x.r, 0));
}
function market(sym: string): number[] {
  const d = daily(load15(MARKETS.find((m) => m.sym === sym)!));
  const px = new Map<number, number>();
  for (let i = 0; i < d.n; i++) px.set(Math.round(d.t[i] / 86400), d.c[i]);
  let prev = NaN;
  for (let k = first - 1; k > first - 10 && Number.isNaN(prev); k--) prev = px.get(k) ?? NaN;
  return cal.map((day) => { const p = px.get(day); if (!p || Number.isNaN(prev)) return 0; const r = p / prev - 1; prev = p; return r; });
}
type Sum = { cagr: number; dd: number; sharpe: number; worstY: number; ys: string };
function sumUp(r: number[]): Sum {
  let eq = 1, peak = 1, dd = 0, s = 0, s2 = 0;
  const y = new Map<number, number>();
  r.forEach((x, i) => { eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); s += x; s2 += x * x; const k = new Date(cal[i] * 86400000).getUTCFullYear(); y.set(k, (y.get(k) ?? 1) * (1 + x)); });
  const mu = s / r.length, sd = Math.sqrt(s2 / r.length - mu * mu);
  const years = (cal.length / 261);
  return { cagr: Math.pow(eq, 1 / years) - 1, dd, sharpe: (mu / sd) * Math.sqrt(261), worstY: Math.min(...[...y.values()].map((v) => v - 1)), ys: [...y].map(([k, v]) => `${String(k).slice(2)}:${(100 * (v - 1)).toFixed(0)}`).join(' ') };
}
const line = (name: string, r: number[]) => { const s = sumUp(r); return `${name.padEnd(52)} ${(100 * s.cagr).toFixed(1).padStart(6)} %/an  creux ${(100 * s.dd).toFixed(0).padStart(3)} %  Sharpe ${s.sharpe.toFixed(2)}  pire année ${(100 * s.worstY).toFixed(0).padStart(4)} %  | ${s.ys}`; };
const corr = (a: number[], b: number[]) => { const n2 = a.length, ma = a.reduce((x, y) => x + y, 0) / n2, mb = b.reduce((x, y) => x + y, 0) / n2; let c = 0, va = 0, vb = 0; for (let i = 0; i < n2; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };

const spx = market('SPX500'), ndx = market('NDX100'), xau = market('XAUUSD');
say(`\nDu ${new Date(first * 86400000).toISOString().slice(0, 10)} au ${new Date(last * 86400000).toISOString().slice(0, 10)}, un seul compte :`);
say('Le marché (acheter et garder, sans frais ni financement) :');
say(line('S&P 500', spx)); say(line('Nasdaq 100', ndx)); say(line('Or', xau));
say(line('S&P 500 tenu en CFD (financement 6,8 % par an)', spx.map((x) => x - 0.068 / 261)));
say('\nLe robot seul, selon la part du compte risquée par signal :');
for (const f of [0.005, 0.01, 0.015, 0.02, 0.03]) say(line(`Robot, ${(100 * f).toFixed(1).replace('.', ',')} % par signal`, robot(f)));
say(`\nCorrélation des journées du robot avec le S&P 500 : ${corr(robot(0.01), spx).toFixed(2)} · avec le Nasdaq : ${corr(robot(0.01), ndx).toFixed(2)} · avec l’or : ${corr(robot(0.01), xau).toFixed(2)}`);
say('\nLe marché tenu + le robot par-dessus (même compte : l’indice en ETF ou en future, le robot en marge) :');
for (const f of [0.005, 0.01]) {
  say(line(`S&P 500 + robot à ${(100 * f).toFixed(1).replace('.', ',')} %`, spx.map((x, i) => x + robot(f)[i])));
  say(line(`Nasdaq 100 + robot à ${(100 * f).toFixed(1).replace('.', ',')} %`, ndx.map((x, i) => x + robot(f)[i])));
}

// what the same portfolio may do over a year: the trading days redrawn (blocks of 5 days), 5 000 draws
say('\nUne année tirée au hasard dans ces journées (blocs de 5 jours, 5 000 tirages) :');
const next = rng(2026);
for (const f of [0.01, 0.02]) {
  const r = robot(f), ends: number[] = [], dds: number[] = [];
  let beat = 0;
  for (let k = 0; k < 5000; k++) {
    let eq = 1, peak = 1, dd = 0, m = 1;
    for (let b = 0; b < 52; b++) { const at = Math.floor(next() * (r.length - 5)); for (let j = 0; j < 5; j++) { eq *= 1 + r[at + j]; m *= 1 + spx[at + j]; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); } }
    ends.push(eq - 1); dds.push(dd); if (eq > m) beat++;
  }
  ends.sort((a, z) => a - z); dds.sort((a, z) => a - z);
  const q = (a: number[], p: number) => (100 * a[Math.floor(p * a.length)]).toFixed(0);
  say(`  ${(100 * f).toFixed(0)} % par signal : médiane ${q(ends, 0.5)} %, 1 an sur 10 sous ${q(ends, 0.1)} %, année perdante ${((100 * ends.filter((x) => x < 0).length) / 5000).toFixed(0)} % du temps, creux médian ${q(dds, 0.5)} %, 1 an sur 20 pire que ${q(dds, 0.95)} % ; bat le S&P des mêmes jours ${((100 * beat) / 5000).toFixed(0)} % du temps`);
}
fs.writeFileSync(`robots/pa/portefeuille${mult === 1 ? '' : `-frais-x${mult}`}.txt`, lines.join('\n'));
