import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FAMILIES } from '../../src/data/indexFamilies';
import { EM_RULE, emLevels, emRegimeOk, emTrades, type EmDay } from '../../src/robots/emRule';
import { MARKETS, VIX, VIX_DAYS, readRows, sessionsOf, volAtOpen, type Sess } from './em-lib';

// Checks the platform's Expected Move robot (src/robots/emRule.ts) against the study:
// A. calibrated on the same 15-minute sessions as the study: the same trades, the same R;
// B. calibrated on the cash index's daily bars, as the platform does (the futures' hourly bars
//    from Yahoo start at :00, not at the 9:30 open), the trades still on the 15-minute sessions.
// Usage: node robots/.build/em-check.mjs

const TRADE_FROM = Date.UTC(2020, 6, 1) / 1000;
const COST_CME = 0.00005;
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
type Row = [number, number, number, number, number];

const toDay = (s: Sess): EmDay => ({ day: s.day, o: s.O, h: s.H, l: s.L, c: s.C, full: s.full });

function run(ss: Sess[], us: boolean, history: (k: number) => EmDay[]) {
  const years = YEARS.map(() => ({ n: 0, R: 0 }));
  for (let k = 0; k < ss.length; k++) {
    const s = ss[k];
    if (s.t0 < TRADE_FROM || !s.full) continue;
    if (!emRegimeOk(volAtOpen(VIX, VIX_DAYS, s.day, us))) continue;
    const lv = emLevels(history(k), s.O);
    if (!lv) continue;
    for (const t of emTrades({ t: [], o: s.o, h: s.h, l: s.l, c: s.c }, lv)) {
      const risk = Math.abs(t.entry - t.stop);
      const y = years[new Date(s.t0 * 1000).getUTCFullYear() - 2020];
      y.n++; y.R += t.r - (2 * COST_CME * t.entry) / risk;
    }
  }
  return years;
}

const fmt = (x: number) => x.toFixed(1);
const total = { A: YEARS.map(() => 0), B: YEARS.map(() => 0), nA: 0, nB: 0 };
console.log(`Règle : ${JSON.stringify(EM_RULE)}`);
for (const m of MARKETS) {
  const f = INDEX_FAMILIES.find((x) => x.id === m.fam)!;
  const ss = sessionsOf(readRows(m.file).filter((r) => r[0] >= Date.UTC(2019, 9, 1) / 1000), f, m.skipFirst);
  const days = ss.map(toDay);
  const A = run(ss, m.us, (k) => days.slice(0, k));
  // the cash index's daily bars, before each session's date
  const dailyFile = path.resolve('robots/gaps/data', `${m.id}_1d.json`);
  const daily: EmDay[] = (JSON.parse(fs.readFileSync(dailyFile, 'utf8')) as Row[]).map(([t, o, h, l, c]) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), o, h, l, c, full: true }));
  const B = run(ss, m.us, (k) => { const d = ss[k].day; let n = 0; while (n < daily.length && daily[n].day < d) n++; return daily.slice(0, n); });
  const line = (y: { n: number; R: number }[]) => `${y.map((x, i) => `${YEARS[i]} ${fmt(x.R)}`).join(' · ')} = ${fmt(y.reduce((s, x) => s + x.R, 0))} R / ${y.reduce((s, x) => s + x.n, 0)} tr`;
  console.log(`${m.name}${m.artifact ? ' (artefact, hors total)' : ''}`);
  console.log(`  A séances 15 min : ${line(A)}`);
  console.log(`  B cash journalier : ${line(B)}`);
  if (m.artifact) continue;
  A.forEach((x, i) => { total.A[i] += x.R; total.nA += x.n; });
  B.forEach((x, i) => { total.B[i] += x.R; total.nB += x.n; });
}
console.log(`5 marchés fiables, A : ${total.A.map((x, i) => `${YEARS[i]} ${x.toFixed(0)}`).join(' · ')} = ${fmt(total.A.reduce((s, x) => s + x, 0))} R / ${total.nA} tr`);
console.log(`5 marchés fiables, B : ${total.B.map((x, i) => `${YEARS[i]} ${x.toFixed(0)}`).join(' · ')} = ${fmt(total.B.reduce((s, x) => s + x, 0))} R / ${total.nB} tr`);
console.log('Étude (mêmes marchés) : 2020 69 · 2021 80 · 2022 182 · 2023 15 · 2024 17 · 2025 17 · 2026 -4');
