import fs from 'node:fs';
import path from 'node:path';
import { makeCtx, SPLIT, type Cls } from './night-lib';
import { SIM, barsOf, markets, ordersOf, type Spec } from './flux-lib';

// The imbalance (FVG) robot on one 10 000 € account: every market of a class traded at once,
// each trade risking 0.5 % of the starting capital (50 €), the costs of the lab, then also a
// CFD's overnight financing. Year by year, the worst drawdown, the longest losing run.
// Usage: node robots/.build/flux-portfolio.mjs --tf 1h --cls Index [--flux 1d] [--risk 0.5]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const TF = arg('--tf') ?? '1h';
const CLS = (arg('--cls') ?? 'Index') as Cls;
const RISK = Number(arg('--risk') ?? 0.5) / 100;
const CAPITAL = 10000;
const NIGHT = CLS === 'Forex' ? 0.01 / 365 : 0.068 / 365;
const spec: Spec = { fam: 'fvg', fluxTf: arg('--flux') ?? '1d', kind: 'SMA', gap: 0.1, at: 'mid', target: 3 };

type T = { sym: string; tIn: number; tOut: number; dir: number; r: number; rFin: number };
const all: T[] = [];
for (const m of markets([TF]).filter((x) => x.cls === CLS)) {
  const x = makeCtx(m, barsOf(m));
  for (const t of SIM(x, ordersOf(x, spec))) {
    const nights = Math.floor((x.b.t[t.x] - 79200) / 86400) - Math.floor((x.b.t[t.e] - 79200) / 86400);
    const fin = t.dir > 0 || CLS === 'Forex' ? (nights * NIGHT * t.costR) / (2 * m.cost) : 0;
    all.push({ sym: m.sym, tIn: x.b.t[t.e], tOut: x.b.t[t.x], dir: t.dir, r: t.r, rFin: t.r - fin });
  }
}
// results booked at the exit
all.sort((a, z) => a.tOut - z.tOut);

const run = (key: 'r' | 'rFin') => {
  let eq = CAPITAL, peak = CAPITAL, maxDD = 0, ddAt = 0, streak = 0, worstStreak = 0;
  const years: Record<number, { pnl: number; n: number; start: number }> = {};
  const curve: [number, number][] = [];
  for (const t of all) {
    const y = new Date(t.tOut * 1000).getUTCFullYear();
    years[y] ??= { pnl: 0, n: 0, start: eq };
    const pnl = t[key] * RISK * CAPITAL;
    eq += pnl; years[y].pnl += pnl; years[y].n++;
    if (eq > peak) peak = eq;
    if ((peak - eq) / peak > maxDD) { maxDD = (peak - eq) / peak; ddAt = t.tOut; }
    streak = t[key] < 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
    curve.push([t.tOut, Math.round(eq)]);
  }
  return { eq, maxDD, ddAt, worstStreak, years, curve };
};

// the most positions open at once
const events = all.flatMap((t) => [[t.tIn, 1], [t.tOut, -1]] as [number, number][]).sort((a, z) => a[0] - z[0] || a[1] - z[1]);
let open = 0, maxOpen = 0;
for (const [, d] of events) { open += d; maxOpen = Math.max(maxOpen, open); }

const days = (all[all.length - 1].tOut - all[0].tIn) / 86400;
console.log(`FVG dans le sens du flux ${spec.fluxTf} · entrées ${TF} · ${CLS} (${[...new Set(all.map((t) => t.sym))].join(', ')}) · ${RISK * 100} % de 10 000 € par trade\n`);
console.log(`${all.length} trades en ${(days / 365).toFixed(1)} ans (${(all.length / (days / 7)).toFixed(1)} par semaine), jusqu'à ${maxOpen} positions ouvertes en même temps`);
const out: Record<string, unknown> = { spec, tf: TF, cls: CLS, risk: RISK, trades: all.length };
for (const [key, name] of [['r', 'frais du labo'], ['rFin', 'frais du labo + nuits CFD']] as const) {
  const r = run(key);
  console.log(`\n${name} : capital final ${Math.round(r.eq)} € · pire baisse ${(r.maxDD * 100).toFixed(1)} % (${new Date(r.ddAt * 1000).toISOString().slice(0, 10)}) · ${r.worstStreak} pertes d'affilée au pire`);
  for (const [y, v] of Object.entries(r.years)) console.log(`  ${y} : ${v.pnl >= 0 ? '+' : ''}${Math.round(v.pnl)} € (${((v.pnl / CAPITAL) * 100).toFixed(1)} % du capital de départ, ${v.n} trades)`);
  const after = all.filter((t) => t.tIn >= SPLIT).reduce((a, t) => a + t[key], 0) * RISK * CAPITAL;
  console.log(`  depuis septembre 2024 (contrôle) : ${after >= 0 ? '+' : ''}${Math.round(after)} €`);
  out[key] = { final: r.eq, maxDD: r.maxDD, worstStreak: r.worstStreak, years: r.years, curve: r.curve.filter((_, i) => i % 5 === 0) };
}
fs.mkdirSync(path.resolve('robots/flux'), { recursive: true });
fs.writeFileSync(path.resolve(`robots/flux/portefeuille-${CLS}-${TF}-F${spec.fluxTf}.json`), JSON.stringify(out));
