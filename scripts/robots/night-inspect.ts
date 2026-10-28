import fs from 'node:fs';
import path from 'node:path';
import { FAMILIES } from './night-families';
import { acc, add, loadBars, makeCtx, marketList, meanR, SPLIT, simulate, tOf, type Cls, type Ctx, type Order } from './night-lib';

// A close look at night-lab variants that held (night.ts): against the same orders moved
// to random days at the same time of day (same side, stop, target and exit), 200 times;
// with 50 % more costs; year by year and market by market.
// Usage: node robots/.build/night-inspect.mjs <family> <tf> <class> <key>[;<key>…]

const [fam, tf, cls, keysArg] = process.argv.slice(2);
const keys = keysArg.split(';');
const family = FAMILIES[fam];
const markets = marketList([tf], [cls as Cls]);
const ctxs: Ctx[] = markets.map((m) => makeCtx(m, loadBars(m.file)));
const RUNS = 200;
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

// the same order at another bar j: prices moved by the difference of the closes
function moved(x: Ctx, od: Order, j: number): Order {
  const shift = x.b.c[j] - x.b.c[od.i];
  const exitAt = od.exitAt === undefined ? undefined : od.exitAt === x.dayEnd[od.i] ? x.dayEnd[j] : j + (od.exitAt - od.i);
  return { ...od, i: j, stop: od.stop + shift, target: od.target + shift, entry: od.entry === undefined ? undefined : od.entry + shift, exitAt };
}

for (const key of keys) {
  const v = family.variants(tf).find((z) => z.key === key);
  if (!v) { say(`inconnu : ${key}`); continue; }
  say(`\n=== ${tf} · ${cls} · ${v.label}\n    (${key})`);
  const real = { is: acc(), oos: acc() };
  const years: Record<number, number> = {};
  const per: string[] = [];
  const ordersOf = ctxs.map((x) => v.orders(x));
  ctxs.forEach((x, k) => {
    const tr = simulate(x, ordersOf[k]);
    const a = acc(), b = acc();
    for (const t of tr) {
      add(t.t < SPLIT ? real.is : real.oos, t.r);
      add(t.t < SPLIT ? a : b, t.r);
      const y = new Date(t.t * 1000).getUTCFullYear();
      years[y] = (years[y] ?? 0) + t.r;
    }
    per.push(`${x.m.sym} ${a[0]}/${meanR(a).toFixed(2)}→${b[0]}/${meanR(b).toFixed(2)}`);
  });
  say(`    réel : avant ${real.is[0]} trades ${meanR(real.is).toFixed(3)} R (t ${tOf(real.is).toFixed(2)}) · après ${real.oos[0]} trades ${meanR(real.oos).toFixed(3)} R (t ${tOf(real.oos).toFixed(2)})`);
  say(`    par marché (avant → après, trades/R moyen) : ${per.join(' · ')}`);
  say(`    par année (R) : ${Object.entries(years).map(([y, r]) => `${y} ${r.toFixed(1)}`).join(' · ')}`);

  // the random twins: for each order, a bar at the same time of day in the same year
  const byHour = ctxs.map((x) => {
    const m = new Map<string, number[]>();
    for (let i = x.start; i < x.n - 1; i++) {
      const k2 = `${new Date(x.b.t[i] * 1000).getUTCFullYear()}|${x.ny[i]}`;
      let a = m.get(k2);
      if (!a) { a = []; m.set(k2, a); }
      a.push(i);
    }
    return m;
  });
  let beatIs = 0, beatOos = 0;
  const rIs: number[] = [], rOos: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const a = acc(), b = acc();
    ctxs.forEach((x, k) => {
      const twins = ordersOf[k].map((od) => {
        const pool = byHour[k].get(`${new Date(x.b.t[od.i] * 1000).getUTCFullYear()}|${x.ny[od.i]}`) ?? [];
        return pool.length ? moved(x, od, pool[Math.floor(Math.random() * pool.length)]) : null;
      }).filter((z): z is Order => z !== null).sort((p, q) => p.i - q.i);
      for (const t of simulate(x, twins)) add(t.t < SPLIT ? a : b, t.r);
    });
    rIs.push(meanR(a)); rOos.push(meanR(b));
    if (meanR(a) >= meanR(real.is)) beatIs++;
    if (meanR(b) >= meanR(real.oos)) beatOos++;
  }
  const avg = (z: number[]) => z.reduce((s, q) => s + q, 0) / z.length;
  say(`    hasard (mêmes heures, même sens, même stop / objectif) : avant ${avg(rIs).toFixed(3)} R, fait aussi bien ${((beatIs / RUNS) * 100).toFixed(1)} % du temps · après ${avg(rOos).toFixed(3)} R, fait aussi bien ${((beatOos / RUNS) * 100).toFixed(1)} % du temps`);

  // costs 50 % higher
  const hi = { is: acc(), oos: acc() };
  ctxs.forEach((x, k) => {
    const y = { ...x, m: { ...x.m, cost: x.m.cost * 1.5 } };
    for (const t of simulate(y, ordersOf[k])) add(t.t < SPLIT ? hi.is : hi.oos, t.r);
  });
  say(`    frais +50 % : avant ${meanR(hi.is).toFixed(3)} R · après ${meanR(hi.oos).toFixed(3)} R`);
}
fs.mkdirSync(path.resolve('robots/night'), { recursive: true });
fs.appendFileSync(path.resolve('robots/night/inspect.txt'), out.join('\n') + '\n');
