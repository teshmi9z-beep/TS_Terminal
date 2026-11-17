import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { acc, meanR, merge, tOf, type Acc } from './night-lib';
import { markets } from './flux-lib';
import { fromKey, gacc, labelOf, settings, keyOf, variants, type GAcc, type GResult } from './fluxgrid-lib';

// The flux grid study's runner: every market on 5 and 15 minutes on all the cores, then per
// entry timeframe and asset class, each setting's baskets on 2020-01 → 2024-08 (tuning) and
// 2024-09 → now (check). A setting is "found" when its tuning is positive with t ≥ 2 and on
// most of the class's markets, and "holds" when the check is too. Also the averages by
// choice (guard, sizes, invalidation, target), to see what each one brings.
// Reports in robots/fluxgrid/<name>.txt and .json.
// Usage: node robots/.build/fluxgrid-study.mjs [--tf 5m,15m] [--extra] [--variants | --keys k1,k2] [--out name]

const OUT = path.resolve('robots/fluxgrid');
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const TFS = (arg('--tf') ?? '5m,15m').split(',');
const EXTRA = process.argv.includes('--extra');
const NAME = arg('--out') ?? `etude${EXTRA ? '-extra' : ''}`;
// some settings only (keys as in fluxgrid-lib.ts), e.g. the options f / z
const KEYS = process.argv.includes('--variants') ? variants().map(keyOf) : arg('--keys')?.split(',');
const LIST = KEYS ? KEYS.map(fromKey) : settings();

async function runAll(): Promise<GResult[]> {
  const jobs = markets(TFS, EXTRA).map((m) => ({ id: m.id, tf: m.tf, extra: EXTRA, keys: KEYS }));
  const results: GResult[] = [];
  const size = Math.min(jobs.length, Math.max(1, os.cpus().length - 2));
  let next = 0;
  await new Promise<void>((done, fail) => {
    let running = 0;
    const start = () => {
      const w = new Worker(new URL('./fluxgrid-worker.mjs', import.meta.url));
      running++;
      const feed = () => {
        if (next >= jobs.length) { w.terminate(); running--; if (!running) done(); return; }
        w.postMessage(jobs[next++]);
      };
      w.on('message', (msg: { ok: boolean; result?: GResult; error?: string }) => {
        if (!msg.ok) { fail(new Error(msg.error)); return; }
        results.push(msg.result!);
        process.stdout.write(`\r  ${results.length}/${jobs.length} marchés`);
        feed();
      });
      w.on('error', fail);
      feed();
    };
    for (let k = 0; k < size; k++) start();
  });
  process.stdout.write('\n');
  return results;
}

const mergeG = (into: GAcc, g: GAcc) => {
  merge(into.a, g.a);
  into.worst = Math.min(into.worst, g.worst); into.dd = Math.max(into.dd, g.dd);
  into.fills += g.fills; into.cut += g.cut; into.cost += g.cost;
  for (const [k, v] of Object.entries(g.why)) into.why[k] = (into.why[k] ?? 0) + v;
};
type Side = { n: number; r: number; gross: number; t: number; win: number; pf: number; worst: number; dd: number; fills: number; cut: number; why: Record<string, number>; pos: number; with: number };
const side = (g: GAcc, pos: number, w: number): Side => ({
  n: g.a[0], r: meanR(g.a), gross: g.a[0] ? (g.a[2] + g.cost) / g.a[0] : 0, t: tOf(g.a), win: g.a[0] ? g.a[1] / g.a[0] : 0, pf: g.a[5] > 0 ? g.a[4] / g.a[5] : 0,
  worst: g.worst, dd: g.dd, fills: g.a[0] ? g.fills / g.a[0] : 0, cut: g.a[0] ? g.cut / g.a[0] : 0, why: g.why, pos, with: w,
});
export type Row = {
  key: string; label: string; tf: string; cls: string; markets: number;
  is: Side; oos: Side; all: Side;
  per: { sym: string; isN: number; isR: number; oosN: number; oosR: number; worst: number; dd: number }[];
  years: Record<number, number>;
  found: boolean; holds: boolean;
};

const results = await runAll();
fs.mkdirSync(OUT, { recursive: true });
const rows: Row[] = [];
const groups = [...new Set(results.map((r) => `${r.tf}|${r.cls}`))].sort();
for (const g of groups) {
  const [tf, cls] = g.split('|');
  const mk = results.filter((r) => r.tf === tf && r.cls === cls);
  for (const s of LIST) {
    const key = keyOf(s);
    const is = gacc(), oos = gacc(), all = gacc();
    const years: Record<number, Acc> = {};
    let posIS = 0, withIS = 0, posOOS = 0, withOOS = 0;
    const per: Row['per'] = [];
    for (const m of mk) {
      const r = m.res[key];
      mergeG(is, r.is); mergeG(oos, r.oos); mergeG(all, r.is); mergeG(all, r.oos);
      for (const [y, a] of Object.entries(r.years)) merge((years[Number(y)] ??= acc()), a);
      if (r.is.a[0] >= 20) { withIS++; if (meanR(r.is.a) > 0) posIS++; }
      if (r.oos.a[0] >= 10) { withOOS++; if (meanR(r.oos.a) > 0) posOOS++; }
      per.push({ sym: m.sym, isN: r.is.a[0], isR: meanR(r.is.a), oosN: r.oos.a[0], oosR: meanR(r.oos.a), worst: Math.min(r.is.worst, r.oos.worst), dd: Math.max(r.is.dd, r.oos.dd) });
    }
    const I = side(is, posIS, withIS), O = side(oos, posOOS, withOOS);
    const found = I.n >= 100 && I.r > 0 && I.t >= 2 && posIS * 2 > withIS;
    const holds = found && O.r > 0 && posOOS * 2 >= withOOS;
    rows.push({
      key, label: labelOf(s), tf, cls, markets: mk.length, is: I, oos: O, all: side(all, 0, 0),
      per: per.sort((a, z) => a.sym.localeCompare(z.sym)),
      years: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, a[2]])), found, holds,
    });
  }
}

// the averages by choice, basket-weighted, per entry timeframe
const lines: string[] = [];
const f2 = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(3);
lines.push(`Grille sur le flux — ${new Date().toISOString()}  (marchés ${EXTRA ? 'de contrôle' : 'principaux'}, ${TFS.join(', ')})`, '');
const choice = (name: string, pick: (k: string) => string) => {
  for (const tf of TFS) {
    const by = new Map<string, { is: Acc; oos: Acc }>();
    for (const r of rows.filter((x) => x.tf === tf)) {
      const k = pick(r.key);
      const e = by.get(k) ?? { is: acc(), oos: acc() };
      // rebuild from the side's mean and count (sum of R)
      e.is[0] += r.is.n; e.is[2] += r.is.r * r.is.n; e.oos[0] += r.oos.n; e.oos[2] += r.oos.r * r.oos.n;
      by.set(k, e);
    }
    lines.push(`${name} (${tf}) : ${[...by].map(([k, e]) => `${k} ${f2(meanR(e.is))} → ${f2(meanR(e.oos))}`).join('   ')}`);
  }
};
choice('Garde-fou', (k) => fromKey(k).guard);
choice('Tailles', (k) => fromKey(k).size);
choice('Invalidation', (k) => fromKey(k).stop);
choice('Objectif', (k) => fromKey(k).tp);
choice('Entrées', (k) => String(fromKey(k).levels));
choice('Classe', () => '');
lines.push('');
for (const g of groups) {
  const [tf, cls] = g.split('|');
  const rs = rows.filter((r) => r.tf === tf && r.cls === cls).sort((a, z) => z.is.r - a.is.r);
  lines.push(`== ${tf} · ${cls} (${rs[0].markets} marchés) · trouvés ${rs.filter((r) => r.found).length} · tiennent ${rs.filter((r) => r.holds).length}`);
  for (const r of rs.slice(0, 12)) {
    lines.push(`  ${r.found ? (r.holds ? '✔' : '✘') : ' '} ${r.key.padEnd(24)} réglage ${f2(r.is.r)} R (${r.is.n}, t ${r.is.t.toFixed(1)}, ${r.is.pos}/${r.is.with}, gagnants ${(r.is.win * 100).toFixed(0)} %, pire ${r.is.worst.toFixed(1)} R) · validation ${f2(r.oos.r)} R (${r.oos.n}, ${r.oos.pos}/${r.oos.with}, pire ${r.oos.worst.toFixed(1)} R) · entrées ${r.all.fills.toFixed(1)} · sans frais ${f2(r.all.gross)} R`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(OUT, `${NAME}.txt`), lines.join('\n'));
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(rows));
console.log(lines.join('\n'));
