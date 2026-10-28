import { dowRun } from '../../src/robots/dow';
import { allowFor, load, specs, variantOf, yearly } from './dow-lib';

// One market and one setting of the Dow structure study, looked at closely: the result
// year by year (a real edge holds most years, luck makes one or two), and the settings
// next to it (a real edge doesn't vanish one step away).
// Usage: node robots/.build/dow-inspect.mjs <market id, e.g. histdata_USDJPY_15m> "<setting key>"

const [id, k] = process.argv.slice(2);
const spec = specs().find((s) => s.id === id);
if (!spec) throw new Error(`marché inconnu : ${id}`);
const b = load(spec)!;
const run = (key: string) => {
  const v = variantOf(key);
  return dowRun(b, { ...v, cost: spec.cost }, allowFor(b, spec, v));
};
const v = variantOf(k);
const res = run(k);
console.log(`${id} · ${k} · frais ${(spec.cost * 100).toFixed(3)} % par côté · ${b.n} barres`);
for (const [y, s] of yearly(res.trades, b, spec.cost)) {
  console.log(`  ${y} : ${String(s.n).padStart(5)} trades · ${s.sumR.toFixed(1).padStart(7)} R · ${(s.n ? (s.wins / s.n) * 100 : 0).toFixed(0)} % gagnants · PF ${(s.loss ? s.gross / s.loss : 0).toFixed(2)} · pire creux ${s.maxDD.toFixed(1)} R · sans frais ${(s.sumR + s.cost).toFixed(1)} R`);
}
// neighbours: one option changed at a time
const alt: [string, (string | number)[]][] = [
  ['swing', [2, 3, 5, 8, 12]], ['body', [0.3, 0.5, 0.7]], ['box', ['candle', 'fib', 'range']], ['entry', ['contact', 'reject']],
  ['targetR', [1, 1.5, 2, 3]], ['liq', ['none', 'guard', 'beyond', 'sweep']], ['hours', ['all', 'med', 'top']], ['htf', [0, 1]],
];
const total = (key: string) => { const r = run(key); return { n: r.trades.length, R: r.trades.reduce((a, t) => a + t.r, 0) }; };
const keyOf = (o: Record<string, unknown>) => {
  const x = { ...v, ...o };
  return [x.swing, x.body, x.box, x.entry, x.target, x.targetR, x.liq, x.hours, x.maxAge, x.maxCostR, x.be ? 1 : 0, x.minLeg, x.htf, x.mode, x.noRange ? 1 : 0].join('|');
};
console.log('Voisins (une option changée) : trades, total en R');
for (const [name, vals] of alt) {
  const parts = vals.map((val) => {
    const r = total(keyOf({ [name]: val }));
    return `${val}: ${r.n} / ${r.R.toFixed(0)} R${String((v as Record<string, unknown>)[name]) === String(val) ? ' ←' : ''}`;
  });
  console.log(`  ${name.padEnd(8)} ${parts.join(' · ')}`);
}
