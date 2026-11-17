import fs from 'node:fs';
import path from 'node:path';
import { runGrid } from '../../src/robots/fluxGrid';
import { markets } from './flux-lib';
import { fromKey, prepOf } from './fluxgrid-lib';
import { SPLIT } from './night-lib';

// The account curves of the flux grid for the Robots tab: the user's rule with and without
// its guards, and the least bad variant, on every main market at 5 and 15 minutes; per entry
// timeframe and class the R summed month by month (1 R = 1 % of the account per basket), per
// market the totals, and the last baskets of the user's rule.
// Usage: node robots/.build/fluxgrid-curves.mjs  → robots/fluxgrid/courbes.json

export const CURVES = [
  { id: 'user', key: '5|mart|low|flip|both' },
  { id: 'bare', key: '5|mart|low|flip|none' },
  { id: 'best', key: '5|mart|mid|cloud|both|z3' },
];
type Curve = { months: [number, number][]; n: number; wins: number; total: number; worst: number; isR: number; isN: number; oosR: number; oosN: number };
const out: Record<string, Record<string, Curve>> = {};
const per: { tf: string; cls: string; sym: string; id: string; n: number; total: number; worst: number }[] = [];
const recent: Record<string, { t: number; sym: string; dir: number; fills: number; why: string; r: number }[]> = {};

for (const tf of ['5m', '15m']) {
  for (const m of markets([tf])) {
    process.stdout.write(`\r  ${tf} ${m.sym}          `);
    const p = prepOf(m);
    for (const c of CURVES) {
      const { baskets } = runGrid(p, fromKey(c.key), m.cost);
      const g = `${tf}|${m.cls}`;
      const cv = ((out[c.id] ??= {})[g] ??= { months: [], n: 0, wins: 0, total: 0, worst: 0, isR: 0, isN: 0, oosR: 0, oosN: 0 });
      const byMonth = new Map<number, number>(cv.months);
      let total = 0, worst = 0;
      for (const b of baskets) {
        if (b.why === 'end') continue;
        const d = new Date(b.t0 * 1000), mo = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
        byMonth.set(mo, (byMonth.get(mo) ?? 0) + b.r);
        cv.n++; if (b.r > 0) cv.wins++; cv.total += b.r; cv.worst = Math.min(cv.worst, b.r);
        if (b.t0 < SPLIT) { cv.isR += b.r; cv.isN++; } else { cv.oosR += b.r; cv.oosN++; }
        total += b.r; worst = Math.min(worst, b.r);
      }
      cv.months = [...byMonth].sort((a, z) => a[0] - z[0]);
      per.push({ tf, cls: m.cls, sym: m.sym, id: c.id, n: baskets.length, total, worst });
      if (c.id === 'user') (recent[`${tf}|${m.cls}`] ??= []).push(...baskets.slice(-12).map((b) => ({ t: b.t0, sym: m.sym, dir: b.dir, fills: b.fills.length, why: b.why, r: b.r })));
    }
  }
}
process.stdout.write('\n');
for (const k of Object.keys(recent)) recent[k] = recent[k].sort((a, z) => z.t - a.t).slice(0, 12);
fs.writeFileSync(path.resolve('robots/fluxgrid/courbes.json'), JSON.stringify({ curves: CURVES, out, per, recent }));
for (const c of CURVES) for (const [g, v] of Object.entries(out[c.id])) console.log(c.id.padEnd(5), g.padEnd(16), `${v.n} paniers, ${((v.wins / v.n) * 100).toFixed(0)} % gagnants, total ${v.total.toFixed(1)} R, pire ${v.worst.toFixed(1)} R, réglage ${(v.isR / v.isN).toFixed(3)} → validation ${(v.oosR / v.oosN).toFixed(3)}`);
