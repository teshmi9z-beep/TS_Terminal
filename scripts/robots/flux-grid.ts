import { acc, add, makeCtx, meanR, SPLIT, tOf, type Acc, type Cls } from './night-lib';
import { SIM, barsOf, markets, ordersOf, type Spec } from './flux-lib';

// The imbalance (FVG) setting's neighbours on a class of markets: one setting changed at a
// time around the base (flux 1d, gap ≥ 0.1 ATR, entry in the middle, target 3 R, the limit
// waiting 30 bars, stop 0.1 ATR past the three bars): a real edge stays positive nearby.
// Usage: node robots/.build/flux-grid.mjs --tf 1h --cls Index [--extra]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const TF = arg('--tf') ?? '1h';
const CLS = (arg('--cls') ?? 'Index') as Cls;
const EXTRA = process.argv.includes('--extra');

const BASE: Spec = { fam: 'fvg', fluxTf: '1d', kind: 'SMA', gap: 0.1, depth: 0.5, target: 3, expire: 30, buf: 0.1 };
const tries: [string, Partial<Spec>][] = [['base', {}]];
for (const fluxTf of ['1h', '4h']) tries.push([`flux ${fluxTf}`, { fluxTf }]);
tries.push(['moyennes EMA', { kind: 'EMA' }]);
for (const gap of [0, 0.05, 0.2, 0.3, 0.5]) tries.push([`trou ≥ ${gap} ATR`, { gap }]);
for (const depth of [0, 0.25, 0.75, 1]) tries.push([`entrée à ${depth * 100} % du trou`, { depth }]);
for (const target of [1.5, 2, 2.5, 4, 5, 0]) tries.push([target ? `objectif ${target} R` : 'sans objectif', { target }]);
for (const expire of [1, 5, 10, 60]) tries.push([`limite ${expire} barres`, { expire }]);
for (const buf of [0, 0.25, 0.5]) tries.push([`marge du stop ${buf} ATR`, { buf }]);

const ctxs = markets([TF], EXTRA).filter((m) => m.cls === CLS).map((m) => makeCtx(m, barsOf(m)));
const f2 = (x: number) => x.toFixed(2).padStart(5);
console.log(`FVG · entrées ${TF} · ${CLS}${EXTRA ? ' (marchés de contrôle)' : ''} · ${ctxs.map((x) => x.m.sym).join(', ')}\n`);
console.log(`${''.padEnd(26)}  avant: trades  R/trade     t    après: trades  R/trade     t   marchés + après`);
for (const [name, over] of tries) {
  const s = { ...BASE, ...over };
  const is = acc(), oos = acc();
  let pos = 0;
  for (const x of ctxs) {
    const o: Acc = acc();
    for (const t of SIM(x, ordersOf(x, s))) { add(t.t < SPLIT ? is : oos, t.r); if (t.t >= SPLIT) add(o, t.r); }
    if (o[2] > 0) pos++;
  }
  console.log(`${name.padEnd(26)}  ${String(is[0]).padStart(12)} ${f2(meanR(is))}  ${f2(tOf(is))}   ${String(oos[0]).padStart(12)} ${f2(meanR(oos))}  ${f2(tOf(oos))}   ${pos}/${ctxs.length}`);
}
