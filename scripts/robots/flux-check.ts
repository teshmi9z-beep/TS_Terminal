import { acc, add, makeCtx, meanR, SPLIT, tOf, type Acc, type Cls, type Order, type Trade } from './night-lib';
import { SIM, barsOf, fluxOf, keyOf, markets, ordersOf, specs } from './flux-lib';

// A close look at one flux setting on a class of markets: market by market, long / short,
// year by year, at twice the costs, and against random entries in the flux's direction
// (same number of trades, same stop sizes in ATR, same target, same exit when the flux
// turns): the share of 300 random runs the setting beats, on the search and check parts.
// Usage: node robots/.build/flux-check.mjs <key> --tf 1h --cls Index [--extra] [--kind EMA]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const KEY = process.argv[2];
const TF = arg('--tf') ?? '1h';
const CLS = (arg('--cls') ?? 'Index') as Cls;
const KIND = arg('--kind') ?? 'SMA';
const EXTRA = process.argv.includes('--extra');
const RUNS = 300;
const MODE = process.env.FLUX_MODE ?? 'with';

const spec = specs(TF, KIND).find((s) => keyOf(s) === KEY);
if (!spec) throw new Error(`réglage inconnu : ${KEY}`);
const f2 = (x: number) => x.toFixed(2);
const line = (name: string, a: Acc) => `${name.padEnd(10)} ${String(a[0]).padStart(5)} trades · ${f2(meanR(a)).padStart(5)} R/trade · t ${f2(tOf(a)).padStart(5)} · ${a[0] ? ((a[1] / a[0]) * 100).toFixed(0) : 0} % gagnants · total ${a[2].toFixed(0)} R`;

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// a CFD's overnight financing, per night held, as a share of the price: about the benchmark
// rate + 2.5 % a year for an index or metal bought (a sale earns a little: counted as 0),
// a broker's fee of about 1 % a year on forex
const NIGHT = CLS === 'Forex' ? 0.01 / 365 : 0.068 / 365;
let nights = 0;
const isAll = acc(), oosAll = acc(), longs = acc(), shorts = acc(), dbl = acc(), fin = acc(), years: Record<number, Acc> = {};
const luckIs = new Float64Array(RUNS), luckOos = new Float64Array(RUNS);
console.log(`${KEY} · entrées ${TF} · ${CLS}${EXTRA ? ' (marchés de contrôle)' : ''} · moyennes ${KIND}\n`);
for (const m of markets([TF], EXTRA).filter((x) => x.cls === CLS)) {
  const x = makeCtx(m, barsOf(m));
  const trades = SIM(x, ordersOf(x, spec));
  const is = acc(), oos = acc();
  for (const t of trades) {
    add(t.t < SPLIT ? is : oos, t.r);
    add(t.t < SPLIT ? isAll : oosAll, t.r);
    add(t.dir > 0 ? longs : shorts, t.r);
    add(dbl, t.r - t.costR);
    // nights: the 22:00 UTC crossings (a Friday to Monday holding counts 3)
    const held = Math.floor((x.b.t[t.x] - 79200) / 86400) - Math.floor((x.b.t[t.e] - 79200) / 86400);
    nights += held;
    add(fin, t.r - (t.dir > 0 || CLS === 'Forex' ? (held * NIGHT * t.costR) / (2 * m.cost) : 0));
    add((years[new Date(t.t * 1000).getUTCFullYear()] ??= acc()), t.r);
  }
  console.log(`${m.sym.padEnd(8)} avant: ${line('', is)}\n${''.padEnd(8)} après: ${line('', oos)}`);

  // the random twins
  const { st, flip } = fluxOf(x, spec.fluxTf, KIND);
  const ratios = trades.map((t) => (2 * m.cost * x.b.o[t.e]) / t.costR / x.atr[t.e - 1]).filter((v) => Number.isFinite(v) && v > 0);
  // the twins' side: the flux's, against it, or (flux ignored) long as often as the setting
  const longShare = trades.filter((t) => t.dir > 0).length / Math.max(1, trades.length);
  const sideAt = (i: number): 1 | -1 => (MODE === 'none' ? (rnd() < longShare ? 1 : -1) : ((MODE === 'against' ? -st[i] : st[i]) as 1 | -1));
  const splitBar = (() => { let i = 0; while (i < x.n && x.b.t[i] < SPLIT) i++; return i; })();
  const part = (from: number, to: number, count: number): number => {
    if (!count || !ratios.length) return 0;
    const bars: number[] = [];
    for (let tries = 0; bars.length < count * 4 && tries < count * 400; tries++) {
      const i = from + Math.floor(rnd() * (to - from - 1));
      if (st[i] && i >= x.start) bars.push(i);
    }
    bars.sort((a, z) => a - z);
    const orders: Order[] = bars.map((i) => {
      const d = sideAt(i), stop = x.b.c[i] - d * ratios[Math.floor(rnd() * ratios.length)] * x.atr[i];
      return { i, dir: d, stop, target: spec.target ? x.b.c[i] + spec.target * (x.b.c[i] - stop) : NaN, exitAt: MODE === 'none' ? undefined : flip[i] };
    });
    const got: Trade[] = SIM(x, orders).slice(0, count);
    return got.reduce((a, t) => a + t.r, 0);
  };
  for (let r = 0; r < RUNS; r++) {
    luckIs[r] += part(0, splitBar, is[0]);
    luckOos[r] += part(splitBar, x.n, oos[0]);
  }
}
const beat = (runs: Float64Array, total: number) => (runs.filter((v) => v < total).length / RUNS) * 100;
const avg = (runs: Float64Array) => runs.reduce((a, v) => a + v, 0) / RUNS;
console.log(`\n${line('avant', isAll)}\n${line('après', oosAll)}\n${line('achats', longs)}\n${line('ventes', shorts)}\n${line('frais ×2', dbl)}\n${line('nuits CFD', fin)} · ${(nights / Math.max(1, fin[0])).toFixed(1)} nuits par trade`);
console.log(`années : ${Object.entries(years).map(([y, a]) => `${y} ${a[2].toFixed(0)} R (${a[0]})`).join(' · ')}`);
console.log(`\nau hasard ${MODE === 'none' ? 'sans flux' : MODE === 'against' ? 'contre le flux' : 'dans le sens du flux'} (${RUNS} tirages) :`);
console.log(`  avant : le réglage ${isAll[2].toFixed(0)} R, le hasard ${avg(luckIs).toFixed(0)} R en moyenne → battu ${beat(luckIs, isAll[2]).toFixed(1)} % des tirages`);
console.log(`  après : le réglage ${oosAll[2].toFixed(0)} R, le hasard ${avg(luckOos).toFixed(0)} R en moyenne → battu ${beat(luckOos, oosAll[2]).toFixed(1)} % des tirages`);
