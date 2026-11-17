import fs from 'node:fs';
import path from 'node:path';
import { nbBacktest, type NbSessionKey } from '../../src/robots/noiseBand';
import { TIGHT } from './pa-check-costs';

// Second round, the only clean test left: the robot's rule on bars no study has seen. The lab's
// files stop on 2026-09-18; Yahoo's 15-minute bars of the last 60 days (futures NQ, ES, GC and
// the USDJPY rate) are fetched apart into <dir>, and only the sessions after 2026-09-18 count
// (the 14 sessions before them calibrate the band).
// node robots/.build/pa2-unseen.mjs <dir with NQ=F.json ES=F.json GC=F.json JPY=X.json>
const dir = process.argv[2];
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const FROM = Date.UTC(2026, 8, 19) / 1000;
type Y = { chart: { result: { timestamp: number[]; indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] } };
function bars(file: string) {
  const r = (JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Y).chart.result[0], q = r.indicators.quote[0];
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  r.timestamp.forEach((ts, i) => {
    // whole 15-minute bars only (the last one is the quote of the moment)
    if (ts % 900 || q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) return;
    t.push(ts); o.push(q.open[i]!); h.push(q.high[i]!); l.push(q.low[i]!); c.push(q.close[i]!);
  });
  return { t, o, h, l, c, n: t.length };
}
const LEGS: [string, string, string, NbSessionKey, boolean][] = [
  // name, file, cost key, session, in the walk-forward portfolio of 2026
  ['Nasdaq 100 (NQ)', 'NQ=F.json', 'NDX100', 'us', true],
  ['USDJPY, Londres', 'JPY=X.json', 'USDJPY', 'ldn', true],
  ['Or (GC), New York', 'GC=F.json', 'XAUUSD', 'nym', true],
  ['Or (GC), Londres', 'GC=F.json', 'XAUUSD', 'ldn', true],
  ['S&P 500 (ES)', 'ES=F.json', 'SPX500', 'us', false],
];
say('================ DONNÉES JAMAIS VUES : séances du 19 septembre au 11 novembre 2026 (Yahoo, 15 min), frais serrés ================');
let tot = 0, cnt = 0;
const daysR = new Map<number, number>();
for (const [name, file, ck, key, inPf] of LEGS) {
  const b = bars(file);
  const ts = nbBacktest(b, key, TIGHT[ck], FROM);
  const rs = ts.map((t) => (t.net[0] + t.net[1]) / 2);
  const sum = rs.reduce((a, x) => a + x, 0), wins = rs.filter((x) => x > 0).length;
  say(`${name.padEnd(20)} ${String(ts.length).padStart(3)} signaux  ${(sum >= 0 ? '+' : '') + sum.toFixed(2)} R  ${ts.length ? ((100 * wins) / ts.length).toFixed(0) : 0} % gagnants  (${ts.length ? (sum / ts.length).toFixed(3) : '0'} R par signal)${inPf ? '' : '   hors portefeuille'}`);
  if (inPf) { tot += sum; cnt += ts.length; ts.forEach((t, i) => daysR.set(t.date, (daysR.get(t.date) ?? 0) + rs[i])); }
}
const v = [...daysR.values()], mu = v.reduce((a, x) => a + x, 0) / (v.length || 1);
const sd = Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, v.length - 1));
say(`\nPortefeuille 2026 (Nasdaq, USDJPY Londres, or New York et Londres) : ${cnt} signaux, ${(tot >= 0 ? '+' : '') + tot.toFixed(2)} R, ${(tot / (cnt || 1)).toFixed(3)} R par signal, t ${(sd ? (mu / sd) * Math.sqrt(v.length) : 0).toFixed(1)} sur ${v.length} jours`);
for (const f of [0.01, 0.02]) { let eq = 1, peak = 1, dd = 0; for (const d of [...daysR.keys()].sort((a, z) => a - z)) { eq *= 1 + f * daysR.get(d)!; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); } say(`  à ${100 * f} % par signal : ${(100 * (eq - 1)).toFixed(1)} % sur la période, creux ${(100 * dd).toFixed(1)} %`); }
// the market over the same weeks
for (const [name, file] of [['S&P 500 (ES)', 'ES=F.json'], ['Nasdaq 100 (NQ)', 'NQ=F.json'], ['Or (GC)', 'GC=F.json']]) {
  const b = bars(file);
  let i0 = 0;
  while (i0 < b.n && b.t[i0] < FROM) i0++;
  say(`  ${name} acheté et gardé sur la même période : ${(100 * (b.c[b.n - 1] / b.c[i0] - 1)).toFixed(1)} %`);
}
fs.writeFileSync('robots/pa/jamais-vu.txt', lines.join('\n'));
