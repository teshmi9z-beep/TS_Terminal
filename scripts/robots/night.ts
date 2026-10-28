import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { FAMILIES } from './night-families';
import { acc, CLASSES, CLS_FR, marketList, meanR, merge, tOf, type Acc, type Cls, type MarketResult } from './night-lib';

// The night lab's runner: every market / timeframe of a family on all the cores, then per
// asset class and timeframe, the variants found on 2020-01 → 2024-08 (enough trades, a
// positive expectancy with t ≥ 2.5, most of the class's markets positive) and whether they
// hold on 2024-09 → now. Reports in robots/night/<family>.txt and .json.
// Usage: node robots/.build/night.mjs <family>[,<family>…] [--tf 5m,15m]

const OUT = path.resolve('robots/night');
const [famArg = 'pivots'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const tfArg = process.argv.includes('--tf') ? process.argv[process.argv.indexOf('--tf') + 1].split(',') : null;
// --out <suffix>: reports as <family>-<suffix>.txt (check runs keep the main reports)
const suffix = process.argv.includes('--out') ? `-${process.argv[process.argv.indexOf('--out') + 1]}` : '';

async function runAll(fam: string): Promise<MarketResult[]> {
  const family = FAMILIES[fam];
  const markets = marketList(tfArg ?? family.tfs);
  const jobs = markets.map((m) => ({ fam, id: m.id, tf: m.tf }));
  const results: MarketResult[] = [];
  const size = Math.min(jobs.length, Math.max(1, os.cpus().length - 2));
  let next = 0;
  await new Promise<void>((done, fail) => {
    let running = 0;
    const start = () => {
      if (next >= jobs.length) { if (!running) done(); return; }
      const w = new Worker(new URL('./night-worker.mjs', import.meta.url));
      running++;
      const feed = () => {
        if (next >= jobs.length) { w.terminate(); running--; if (!running) done(); return; }
        w.postMessage(jobs[next++]);
      };
      w.on('message', (msg: { ok: boolean; result?: MarketResult; error?: string }) => {
        if (!msg.ok) { fail(new Error(msg.error)); return; }
        results.push(msg.result!);
        process.stdout.write(`\r  ${fam} : ${results.length}/${jobs.length} marchés`);
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

type Row = {
  key: string; label: string; tf: string; cls: Cls; markets: number;
  is: { n: number; r: number; t: number; win: number; pf: number; pos: number; with: number };
  oos: { n: number; r: number; t: number; win: number; pf: number; pos: number; with: number };
  per: { sym: string; isN: number; isR: number; oosN: number; oosR: number }[];
  years: Record<number, number>;
  found: boolean; holds: boolean;
};
const stat = (a: Acc) => ({ n: a[0], r: meanR(a), t: tOf(a), win: a[0] ? a[1] / a[0] : 0, pf: a[5] > 0 ? a[4] / a[5] : 0 });

function read(fam: string, results: MarketResult[]) {
  const family = FAMILIES[fam];
  const labels = new Map<string, string>();
  for (const tf of tfArg ?? family.tfs) for (const v of family.variants(tf)) labels.set(v.key, v.label);
  const rows: Row[] = [];
  const tfs = [...new Set(results.map((r) => r.tf))];
  for (const tf of tfs) for (const cls of CLASSES) {
    const group = results.filter((r) => r.tf === tf && r.cls === cls);
    if (!group.length) continue;
    const keys = Object.keys(group[0].res);
    const intraday = tf !== '4h' && tf !== '1d';
    for (const key of keys) {
      const is = acc(), oos = acc(), years: Record<number, Acc> = {};
      const per: Row['per'] = [];
      let isPos = 0, isWith = 0, oosPos = 0, oosWith = 0;
      for (const g of group) {
        const r = g.res[key];
        merge(is, r.is); merge(oos, r.oos);
        for (const [y, a] of Object.entries(r.years)) merge((years[+y] ??= acc()), a);
        per.push({ sym: g.sym, isN: r.is[0], isR: meanR(r.is), oosN: r.oos[0], oosR: meanR(r.oos) });
        if (r.is[0] >= 20) { isWith++; if (r.is[2] > 0) isPos++; }
        if (r.oos[0] >= 10) { oosWith++; if (r.oos[2] > 0) oosPos++; }
      }
      const s = { ...stat(is), pos: isPos, with: isWith }, o = { ...stat(oos), pos: oosPos, with: oosWith };
      const found = s.n >= (intraday ? 150 : 60) && s.r >= 0.05 && s.t >= 2.5 && s.pos >= Math.max(isWith >= 3 ? 2 : 1, Math.ceil(0.6 * isWith));
      const holds = found && o.n >= (intraday ? 50 : 25) && o.r > 0 && o.t >= 1 && o.pos >= Math.ceil(0.5 * oosWith);
      rows.push({
        key, label: labels.get(key) ?? key, tf, cls, markets: group.length, is: s, oos: o, per,
        years: Object.fromEntries(Object.entries(years).map(([y, a]) => [y, +a[2].toFixed(1)])), found, holds,
      });
    }
  }
  return rows;
}

function report(fam: string, rows: Row[]): string {
  const family = FAMILIES[fam];
  const L: string[] = [`# ${family.label} (${fam}) — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
  const f2 = (x: number) => x.toFixed(2);
  const groups = [...new Set(rows.map((r) => `${r.tf}|${r.cls}`))];
  let found = 0, held = 0;
  for (const g of groups) {
    const [tf, cls] = g.split('|') as [string, Cls];
    const rs = rows.filter((r) => r.tf === tf && r.cls === cls);
    const f = rs.filter((r) => r.found), h = f.filter((r) => r.holds);
    found += f.length; held += h.length;
    // base rate: a variant positive on the search part, positive again on the check part
    const pos = rs.filter((r) => r.is.n >= 100 && r.is.r > 0);
    const base = pos.length ? pos.filter((r) => r.oos.r > 0).length / pos.length : 0;
    L.push(`## ${tf} · ${CLS_FR[cls]} (${rs[0].markets} marchés) — ${rs.length} variantes · ${f.length} trouvées · ${h.length} tiennent · positives avant ⇒ positives après : ${(base * 100).toFixed(0)} % de ${pos.length}`);
    for (const r of [...f].sort((a, b) => b.oos.r - a.oos.r).slice(0, 25)) {
      L.push(`${r.holds ? 'TIENT ' : '      '}${r.label}`);
      L.push(`        avant : ${r.is.n} trades · ${f2(r.is.r)} R/trade · t ${f2(r.is.t)} · ${(r.is.win * 100).toFixed(0)} % gagnants · PF ${f2(r.is.pf)} · ${r.is.pos}/${r.is.with} marchés +`);
      L.push(`        après : ${r.oos.n} trades · ${f2(r.oos.r)} R/trade · t ${f2(r.oos.t)} · ${(r.oos.win * 100).toFixed(0)} % gagnants · PF ${f2(r.oos.pf)} · ${r.oos.pos}/${r.oos.with} marchés + · années ${Object.entries(r.years).map(([y, v]) => `${y}:${v}`).join(' ')}`);
    }
    // the best of the check part among the variants positive before, whatever their strength (for information)
    const best = [...pos].filter((r) => r.oos.n >= 30).sort((a, b) => b.oos.t - a.oos.t).slice(0, 3);
    if (best.length) L.push(`  (pour info, meilleurs sur le contrôle parmi les positifs avant : ${best.map((r) => `${r.key} ${f2(r.is.r)}→${f2(r.oos.r)} R`).join(' ; ')})`);
    L.push('');
  }
  L.splice(1, 0, `Total : ${found} variantes trouvées, ${held} tiennent sur le contrôle.`);
  return L.join('\n');
}

fs.mkdirSync(OUT, { recursive: true });
for (const fam of famArg.split(',')) {
  const t0 = Date.now();
  const results = await runAll(fam);
  const rows = read(fam, results);
  fs.writeFileSync(path.join(OUT, `${fam}${suffix}.json`), JSON.stringify(rows));
  const txt = report(fam, rows);
  fs.writeFileSync(path.join(OUT, `${fam}${suffix}.txt`), txt + '\n');
  console.log(txt.split('\n').filter((l) => l.startsWith('#') || l.startsWith('Total') || l.startsWith('TIENT')).join('\n'));
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
