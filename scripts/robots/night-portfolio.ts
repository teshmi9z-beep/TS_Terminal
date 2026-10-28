import fs from 'node:fs';
import path from 'node:path';
import { FAMILIES } from './night-families';
import { loadBars, makeCtx, marketList, SPLIT, simulate, type Cls } from './night-lib';

// The night lab's kept setups traded together on one account: each trade risks a share of
// the account at its entry (the R net of costs), trades may overlap; the equity, the worst
// drawdown and the years, on the search part, the check part and both.
// Usage: node robots/.build/night-portfolio.mjs <risk %> <family>:<tf>:<class>:<key> …

const [riskArg, ...specs] = process.argv.slice(2);
const risk = parseFloat(riskArg) / 100;
type T = { name: string; sym: string; t: number; x: number; r: number };
const trades: T[] = [];
for (const spec of specs) {
  const [fam, tf, cls, key] = spec.split(':');
  const v = FAMILIES[fam].variants(tf).find((z) => z.key === key)!;
  for (const m of marketList([tf], [cls as Cls])) {
    const x = makeCtx(m, loadBars(m.file));
    for (const tr of simulate(x, v.orders(x))) trades.push({ name: `${fam} ${key}`, sym: m.sym, t: tr.t, x: x.b.t[tr.x], r: tr.r });
  }
}
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

// save: a JSON file for the equity curve ([time, equity] at each exit)
function run(from: number, to: number, label: string, save?: string) {
  const list = trades.filter((t) => t.t >= from && t.t < to);
  // money is committed at entry and settled at exit: events in time order
  const ev = [...list.map((t, k) => ({ at: t.t, k, open: true })), ...list.map((t, k) => ({ at: t.x, k, open: false }))].sort((a, b) => a.at - b.at || (a.open ? 1 : -1));
  let eq = 10000, peak = 10000, dd = 0;
  const stake = new Map<number, number>();
  const years: Record<number, [number, number]> = {};
  const curve: [number, number][] = [[from, eq]];
  for (const e of ev) {
    if (e.open) { stake.set(e.k, eq * risk); continue; }
    const pnl = (stake.get(e.k) ?? 0) * list[e.k].r;
    const y = new Date(e.at * 1000).getUTCFullYear();
    years[y] ??= [eq, eq];
    eq += pnl;
    years[y][1] = eq;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
    curve.push([e.at, Math.round(eq)]);
  }
  if (save) fs.writeFileSync(save, JSON.stringify(curve));
  const days = (to === Infinity ? Math.max(...list.map((t) => t.x)) : to) - from;
  const cagr = Math.pow(eq / 10000, 365.25 * 86400 / Math.max(1, days)) - 1;
  say(`${label} : ${list.length} trades · 10 000 € → ${eq.toFixed(0)} € · ${(cagr * 100).toFixed(1)} % par an · pire creux ${(dd * 100).toFixed(1)} % · ${Object.entries(years).map(([y, [a, b]]) => `${y} ${((b / a - 1) * 100).toFixed(1)} %`).join(' · ')}`);
}

say(`=== Portefeuille à ${riskArg} % de risque par trade (10 000 € au départ, intérêts composés)`);
for (const s of specs) say(`  - ${s}`);
const byName = new Map<string, T[]>();
for (const t of trades) { const k = `${t.name} (${t.sym})`; byName.set(k, [...(byName.get(k) ?? []), t]); }
for (const [k, v] of byName) {
  const is = v.filter((t) => t.t < SPLIT), oos = v.filter((t) => t.t >= SPLIT);
  const m = (a: T[]) => (a.length ? a.reduce((s, t) => s + t.r, 0) / a.length : 0);
  say(`  ${k} : avant ${is.length} trades ${m(is).toFixed(2)} R · après ${oos.length} trades ${m(oos).toFixed(2)} R`);
}
run(Date.UTC(2020, 0, 1) / 1000, SPLIT, 'Avant (2020-01 → 2024-08)');
run(SPLIT, Infinity, 'Après (2024-09 → aujourd’hui)');
run(Date.UTC(2020, 0, 1) / 1000, Infinity, 'Tout (2020 → aujourd’hui)', process.env.NIGHT_EQUITY);
fs.appendFileSync(path.resolve('robots/night/portfolio.txt'), out.join('\n') + '\n\n');
