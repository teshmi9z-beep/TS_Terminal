import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { acc, meanR, merge, tOf, type Acc } from './night-lib';
import { markets } from './flux-lib';
import { DRAWS, revKey, revLabel, revSettings, type RevResult } from './fluxrev-lib';

// The flux reversal study's runner (see fluxrev-lib.ts): every market at 5 min, 15 min and 1 h
// on all the cores, then per entry timeframe and class each setting on 2020-01 → 2024-08
// (tuning) and 2024-09 → now (check), against its random twins. "Found": positive tuning with
// t ≥ 2, on most of the class's markets, above 90 % of the random draws; "holds": the check
// positive too, above 80 % of the draws, on half the markets at least.
// Usage: node robots/.build/fluxrev-study.mjs [--tf 5m,15m,1h] [--extra] [--out name]
// → robots/fluxgrid/inverse.txt and .json

const OUT = path.resolve('robots/fluxgrid');
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const TFS = (arg('--tf') ?? '5m,15m,1h').split(',');
const EXTRA = process.argv.includes('--extra');
const NAME = arg('--out') ?? `inverse${EXTRA ? '-extra' : ''}`;

async function runAll(): Promise<RevResult[]> {
  const jobs = markets(TFS, EXTRA).map((m) => ({ id: m.id, tf: m.tf, extra: EXTRA }));
  const results: RevResult[] = [];
  const size = Math.min(jobs.length, Math.max(1, os.cpus().length - 2));
  let next = 0;
  await new Promise<void>((done, fail) => {
    let running = 0;
    const start = () => {
      const w = new Worker(new URL('./fluxrev-worker.mjs', import.meta.url));
      running++;
      const feed = () => {
        if (next >= jobs.length) { w.terminate(); running--; if (!running) done(); return; }
        w.postMessage(jobs[next++]);
      };
      w.on('message', (msg: { ok: boolean; result?: RevResult; error?: string }) => {
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

// a period: trades, R a trade, t, win rate, markets positive / with 20 (10) trades, the random
// twins' mean R a trade and the share of draws the signal beats
type Side = { n: number; r: number; gross: number; t: number; win: number; pos: number; with: number; rnd: number; beat: number };
export type RevRow = {
  key: string; label: string; tf: string; cls: string; markets: number;
  is: Side; oos: Side; all: { n: number; r: number; t: number };
  per: { sym: string; isN: number; isR: number; oosN: number; oosR: number }[];
  years: Record<number, number>;
  found: boolean; holds: boolean;
};

const results = await runAll();
fs.mkdirSync(OUT, { recursive: true });
const rows: RevRow[] = [];
const groups = [...new Set(results.map((r) => `${r.tf}|${r.cls}`))].sort();
for (const g of groups) {
  const [tf, cls] = g.split('|');
  const mk = results.filter((r) => r.tf === tf && r.cls === cls);
  for (const s of revSettings(tf)) {
    const key = revKey(s);
    const is = acc(), oos = acc(), all = acc();
    const years: Record<number, Acc> = {};
    const dIS = Array.from({ length: DRAWS }, () => [0, 0]), dOOS = Array.from({ length: DRAWS }, () => [0, 0]);
    let posIS = 0, withIS = 0, posOOS = 0, withOOS = 0, cIS = 0, cOOS = 0;
    const per: RevRow['per'] = [];
    for (const m of mk) {
      const r = m.res[key];
      merge(is, r.is); merge(oos, r.oos); merge(all, r.is); merge(all, r.oos);
      cIS += r.cost[0]; cOOS += r.cost[1];
      for (const [y, a] of Object.entries(r.years)) merge((years[Number(y)] ??= acc()), a);
      r.rIS.forEach(([sm, k], j) => { dIS[j][0] += sm; dIS[j][1] += k; });
      r.rOOS.forEach(([sm, k], j) => { dOOS[j][0] += sm; dOOS[j][1] += k; });
      if (r.is[0] >= 20) { withIS++; if (meanR(r.is) > 0) posIS++; }
      if (r.oos[0] >= 10) { withOOS++; if (meanR(r.oos) > 0) posOOS++; }
      per.push({ sym: m.sym, isN: r.is[0], isR: meanR(r.is), oosN: r.oos[0], oosR: meanR(r.oos) });
    }
    const side = (a: Acc, draws: number[][], pos: number, w: number, cost: number): Side => {
      const means = draws.filter(([, k]) => k > 0).map(([sm, k]) => sm / k);
      const r = meanR(a);
      return {
        n: a[0], r, gross: a[0] ? (a[2] + cost) / a[0] : 0, t: tOf(a), win: a[0] ? a[1] / a[0] : 0, pos, with: w,
        rnd: means.length ? means.reduce((u, v) => u + v, 0) / means.length : 0,
        beat: means.length ? means.filter((v) => v < r).length / means.length : 0,
      };
    };
    const I = side(is, dIS, posIS, withIS, cIS), O = side(oos, dOOS, posOOS, withOOS, cOOS);
    const found = I.n >= 100 && I.r > 0 && I.t >= 2 && posIS * 2 > withIS && I.beat >= 0.9;
    const holds = found && O.r > 0 && O.beat >= 0.8 && posOOS * 2 >= withOOS;
    rows.push({
      key, label: revLabel(s), tf, cls, markets: mk.length, is: I, oos: O, all: { n: all[0], r: meanR(all), t: tOf(all) },
      per: per.sort((a, z) => a.sym.localeCompare(z.sym)),
      years: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, a[2]])), found, holds,
    });
  }
}

const f2 = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(3);
const lines: string[] = [`L'inverse de la grille — ${new Date().toISOString()}  (marchés ${EXTRA ? 'de contrôle' : 'principaux'}, ${TFS.join(', ')})`, ''];
// the averages by signal and by target, per entry timeframe, against the random twins
for (const tf of TFS) {
  for (const [name, pick] of [['Signal', (k: string) => k.split('|').slice(0, 2).join(' ')], ['Objectif', (k: string) => k.split('|')[2]]] as const) {
    const by = new Map<string, number[]>();
    for (const r of rows.filter((x) => x.tf === tf)) {
      const e = by.get(pick(r.key)) ?? [0, 0, 0, 0, 0, 0];
      e[0] += r.is.n; e[1] += r.is.r * r.is.n; e[2] += r.is.rnd * r.is.n; e[3] += r.oos.n; e[4] += r.oos.r * r.oos.n; e[5] += r.oos.rnd * r.oos.n;
      by.set(pick(r.key), e);
    }
    lines.push(`${name} (${tf}) : ${[...by].map(([k, e]) => `${k} ${f2(e[1] / e[0])} (hasard ${f2(e[2] / e[0])}) → ${f2(e[4] / e[3])} (hasard ${f2(e[5] / e[3])})`).join('   ')}`);
  }
}
lines.push('');
for (const g of groups) {
  const [tf, cls] = g.split('|');
  const rs = rows.filter((r) => r.tf === tf && r.cls === cls).sort((a, z) => z.is.r - a.is.r);
  lines.push(`== ${tf} · ${cls} (${rs[0].markets} marchés) · trouvés ${rs.filter((r) => r.found).length} · tiennent ${rs.filter((r) => r.holds).length}`);
  for (const r of rs.slice(0, 10)) {
    lines.push(`  ${r.found ? (r.holds ? '✔' : '✘') : ' '} ${r.key.padEnd(22)} réglage ${f2(r.is.r)} R (${r.is.n}, t ${r.is.t.toFixed(1)}, ${r.is.pos}/${r.is.with}, gagnants ${(r.is.win * 100).toFixed(0)} %, hasard ${f2(r.is.rnd)}, battu ${(r.is.beat * 100).toFixed(0)} %) · validation ${f2(r.oos.r)} R (${r.oos.n}, ${r.oos.pos}/${r.oos.with}, hasard ${f2(r.oos.rnd)}, battu ${(r.oos.beat * 100).toFixed(0)} %) · sans frais ${f2(r.is.gross)} → ${f2(r.oos.gross)}`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(OUT, `${NAME}.txt`), lines.join('\n'));
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(rows));
console.log(lines.join('\n'));
