import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CLS_FR, acc, meanR, merge, tOf, type Acc, type Cls } from './night-lib';
import { keyOf, labelOf, markets, specs, type FResult } from './flux-lib';

// The flux study's runner: every market / timeframe on all the cores, then per entry
// timeframe, flux timeframe and asset class, the settings found on 2020-01 → 2024-08 (enough
// trades, a positive expectancy with t ≥ 2.5, most of the class's markets positive) and
// whether they hold on 2024-09 → now. Reports in robots/flux/<name>.txt and .json.
// Usage: node robots/.build/flux-study.mjs [--tf 15m,1h] [--extra] [--kind EMA] [--out name]

const OUT = path.resolve('robots/flux');
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const TFS = (arg('--tf') ?? '5m,15m,1h,4h,1d').split(',');
const EXTRA = process.argv.includes('--extra');
const KIND = arg('--kind') ?? 'SMA';
const NAME = arg('--out') ?? `etude${EXTRA ? '-extra' : ''}${KIND !== 'SMA' ? `-${KIND}` : ''}`;
const CLASSES: Cls[] = ['Index', 'Forex', 'Commodity'];

async function runAll(): Promise<FResult[]> {
  const jobs = markets(TFS, EXTRA).map((m) => ({ id: m.id, tf: m.tf, extra: EXTRA, kind: KIND }));
  const results: FResult[] = [];
  const size = Math.min(jobs.length, Math.max(1, os.cpus().length - 2));
  let next = 0;
  await new Promise<void>((done, fail) => {
    let running = 0;
    const start = () => {
      const w = new Worker(new URL('./flux-worker.mjs', import.meta.url));
      running++;
      const feed = () => {
        if (next >= jobs.length) { w.terminate(); running--; if (!running) done(); return; }
        w.postMessage(jobs[next++]);
      };
      w.on('message', (msg: { ok: boolean; result?: FResult; error?: string }) => {
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

type Side = { n: number; r: number; t: number; win: number; pf: number; pos: number; with: number };
export type Row = {
  key: string; label: string; tf: string; fluxTf: string; cls: Cls; markets: number;
  is: Side; oos: Side; all: Side;
  per: { sym: string; isN: number; isR: number; oosN: number; oosR: number }[];
  years: Record<number, number>;
  found: boolean; holds: boolean;
};
const stat = (a: Acc) => ({ n: a[0], r: meanR(a), t: tOf(a), win: a[0] ? a[1] / a[0] : 0, pf: a[5] > 0 ? a[4] / a[5] : 0 });

function read(results: FResult[]): Row[] {
  const labels = new Map<string, string>();
  for (const tf of TFS) for (const s of specs(tf, KIND)) labels.set(keyOf(s), labelOf(s));
  const rows: Row[] = [];
  for (const tf of TFS) for (const cls of CLASSES) {
    const group = results.filter((r) => r.tf === tf && r.cls === cls);
    if (!group.length) continue;
    const intraday = tf !== '4h' && tf !== '1d';
    for (const key of Object.keys(group[0].res)) {
      const is = acc(), oos = acc(), all = acc(), years: Record<number, Acc> = {};
      const per: Row['per'] = [];
      let isPos = 0, isWith = 0, oosPos = 0, oosWith = 0, allPos = 0, allWith = 0;
      for (const g of group) {
        const r = g.res[key];
        merge(is, r.is); merge(oos, r.oos); merge(all, r.is); merge(all, r.oos);
        for (const [y, a] of Object.entries(r.years)) merge((years[+y] ??= acc()), a);
        per.push({ sym: g.sym, isN: r.is[0], isR: meanR(r.is), oosN: r.oos[0], oosR: meanR(r.oos) });
        if (r.is[0] >= 20) { isWith++; if (r.is[2] > 0) isPos++; }
        if (r.oos[0] >= 10) { oosWith++; if (r.oos[2] > 0) oosPos++; }
        if (r.is[0] + r.oos[0] >= 20) { allWith++; if (r.is[2] + r.oos[2] > 0) allPos++; }
      }
      const s = { ...stat(is), pos: isPos, with: isWith }, o = { ...stat(oos), pos: oosPos, with: oosWith };
      const found = s.n >= (intraday ? 150 : 60) && s.r >= 0.05 && s.t >= 2.5 && s.pos >= Math.max(isWith >= 3 ? 2 : 1, Math.ceil(0.6 * isWith));
      const holds = found && o.n >= (intraday ? 50 : 25) && o.r > 0 && o.t >= 1 && o.pos >= Math.ceil(0.5 * oosWith);
      rows.push({
        key, label: labels.get(key) ?? key, tf, fluxTf: key.split('|')[1].slice(1), cls, markets: group.length,
        is: s, oos: o, all: { ...stat(all), pos: allPos, with: allWith }, per,
        years: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, +a[2].toFixed(1)])), found, holds,
      });
    }
  }
  return rows;
}

function report(rows: Row[]): string {
  const L: string[] = [`# Étude du flux (${NAME}, moyennes ${KIND}) — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
  const f2 = (x: number) => x.toFixed(2);
  const groups = [...new Set(rows.map((r) => `${r.tf}|${r.fluxTf}|${r.cls}`))];
  let found = 0, held = 0;
  for (const g of groups) {
    const [tf, fluxTf, cls] = g.split('|') as [string, string, Cls];
    const rs = rows.filter((r) => r.tf === tf && r.fluxTf === fluxTf && r.cls === cls);
    const f = rs.filter((r) => r.found), h = f.filter((r) => r.holds);
    found += f.length; held += h.length;
    // base rate: a setting positive on the search part, positive again on the check part
    const pos = rs.filter((r) => r.is.n >= 100 && r.is.r > 0);
    const base = pos.length ? pos.filter((r) => r.oos.r > 0).length / pos.length : 0;
    const meanAll = rs.reduce((a, r) => a + r.all.r, 0) / rs.length;
    L.push(`## entrées ${tf} · flux ${fluxTf} · ${CLS_FR[cls]} (${rs[0].markets} marchés) — ${rs.length} réglages · ${f.length} trouvés · ${h.length} tiennent · positifs avant ⇒ après : ${(base * 100).toFixed(0)} % de ${pos.length} · moyenne de tous les réglages ${f2(meanAll)} R/trade`);
    for (const r of [...f].sort((a, b) => b.oos.r - a.oos.r).slice(0, 15)) {
      L.push(`${r.holds ? 'TIENT ' : '      '}${r.label}  [${r.key}]`);
      L.push(`        avant : ${r.is.n} trades · ${f2(r.is.r)} R/trade · t ${f2(r.is.t)} · ${(r.is.win * 100).toFixed(0)} % gagnants · PF ${f2(r.is.pf)} · ${r.is.pos}/${r.is.with} marchés +`);
      L.push(`        après : ${r.oos.n} trades · ${f2(r.oos.r)} R/trade · t ${f2(r.oos.t)} · ${(r.oos.win * 100).toFixed(0)} % gagnants · PF ${f2(r.oos.pf)} · ${r.oos.pos}/${r.oos.with} marchés + · années ${Object.entries(r.years).map(([y, v]) => `${y}:${v}`).join(' ')}`);
    }
    // for information: the best families of this group over the whole period
    const best = [...rs].filter((r) => r.all.n >= 100).sort((a, b) => b.all.t - a.all.t).slice(0, 3);
    if (best.length) L.push(`  (pour info, meilleurs sur toute la période : ${best.map((r) => `${r.key} ${f2(r.all.r)} R t ${f2(r.all.t)} ${r.all.pos}/${r.all.with}`).join(' ; ')})`);
    L.push('');
  }
  L.splice(1, 0, `Total : ${found} réglages trouvés, ${held} tiennent sur le contrôle.`);
  return L.join('\n');
}

fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const results = await runAll();
fs.writeFileSync(path.join(OUT, `${NAME}-marches.json`), JSON.stringify(results));
const rows = read(results);
fs.writeFileSync(path.join(OUT, `${NAME}.json`), JSON.stringify(rows));
const txt = report(rows);
fs.writeFileSync(path.join(OUT, `${NAME}.txt`), txt + '\n');
console.log(txt.split('\n').filter((l) => l.startsWith('#') || l.startsWith('Total') || l.startsWith('TIENT')).join('\n'));
console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
