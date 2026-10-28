import fs from 'node:fs';
import path from 'node:path';
import { FAMILIES } from './night-families';
import { loadBars, makeCtx, marketList, simulate, type Cls } from './night-lib';

// Walk-forward of a night-lab family: each year from 2022, the variant with the best mean R
// on all the years before (at least `min` trades, pooled over the class's markets) is traded
// the next year as it is. What the choice itself is worth, without hindsight.
// Usage: node robots/.build/night-wf.mjs <family> <tf> <class> [min trades]

const [fam, tf, cls, minArg] = process.argv.slice(2);
const min = parseInt(minArg ?? '100', 10);
const variants = FAMILIES[fam].variants(tf);
const ctxs = marketList([tf], [cls as Cls]).map((m) => makeCtx(m, loadBars(m.file)));
// every variant's trades: [year, R]
const all = variants.map((v) => {
  const out: [number, number][] = [];
  for (const x of ctxs) for (const t of simulate(x, v.orders(x))) out.push([new Date(t.t * 1000).getUTCFullYear(), t.r]);
  return out;
});
const lines: string[] = [`=== Walk-forward ${fam} · ${tf} · ${cls} (${variants.length} variantes, au moins ${min} trades pour être choisie)`];
let total = 0, n = 0;
for (let y = 2022; y <= 2026; y++) {
  let best = -1, bestR = -Infinity;
  all.forEach((tr, k) => {
    const past = tr.filter(([yy]) => yy < y);
    if (past.length < min) return;
    const m = past.reduce((s, [, r]) => s + r, 0) / past.length;
    if (m > bestR) { bestR = m; best = k; }
  });
  if (best < 0) { lines.push(`  ${y} : aucune variante n’a assez de trades`); continue; }
  const next = all[best].filter(([yy]) => yy === y);
  const sum = next.reduce((s, [, r]) => s + r, 0);
  total += sum; n += next.length;
  lines.push(`  ${y} : ${variants[best].key} (avant : ${bestR.toFixed(2)} R/trade) → ${next.length} trades, ${sum >= 0 ? '+' : ''}${sum.toFixed(1)} R (${next.length ? (sum / next.length).toFixed(2) : '0'} R/trade)`);
}
lines.push(`  Total 2022 → 2026 : ${n} trades, ${total >= 0 ? '+' : ''}${total.toFixed(1)} R (${n ? (total / n).toFixed(3) : 0} R/trade)`);
console.log(lines.join('\n'));
fs.appendFileSync(path.resolve('robots/night/wf.txt'), lines.join('\n') + '\n\n');
