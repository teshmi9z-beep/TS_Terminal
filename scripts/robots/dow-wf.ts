import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { dowRun } from '../../src/robots/dow';
import { activeOnly, allowFor, load, specs, variantOf, yearly, type Spec } from './dow-lib';

// Walk-forward of the Dow structure study, as it would have been lived: each year from
// 2023 on is traded with the setting that did best on the years before it only (2020 to
// the year before), among every setting the stages tried on that market. The sum of those
// years is what re-tuning the robot once a year would have made.
// Writes robots/dow/wf/<market>.json.
// Usage: node robots/.build/dow-wf.mjs s1,s2,s3 [--tf 15m,1h,4h] [--only EURUSD] [--threads 8] [--out robots/dow/wf-s1]

type YearRow = [number, number, number]; // year, trades, R
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
// --out: another folder (the walk-forward of another set of settings)
const OUT = path.resolve(arg('--out') ?? 'robots/dow/wf');
// the first year traded (--first 2022: one more test year, chosen on 2020-2021 only)
const FIRST_TEST = Number(process.env.DOW_WF_FIRST ?? 2023);

if (!isMainThread) {
  parentPort!.on('message', (msg: { spec: Spec; keys: string[]; active?: boolean } | null) => {
    if (!msg) process.exit(0);
    const { spec, keys } = msg!;
    const loaded = load(spec);
    if (!loaded) { parentPort!.postMessage({ id: spec.id, skipped: true }); return; }
    // --active: the quiet hours taken out, as in stage q1
    const b = msg!.active ? activeOnly(loaded) : loaded;
    // every setting's result year by year
    const table: Record<string, YearRow[]> = {};
    for (const k of keys) {
      const v = variantOf(k);
      const res = dowRun(b, { ...v, cost: spec.cost }, allowFor(b, spec, v));
      table[k] = yearly(res.trades, b, spec.cost).map(([y, s]) => [y, s.n, s.sumR]);
    }
    const years = [...new Set(Object.values(table).flatMap((r) => r.map(([y]) => y)))].sort();
    const steps: { year: number; key: string | null; trades: number; R: number; pastR: number }[] = [];
    for (const Y of years.filter((y) => y >= FIRST_TEST)) {
      // the best of the past years (enough trades: 20 a year of past)
      let best: string | null = null, bestR = 0;
      for (const [k, rows] of Object.entries(table)) {
        const past = rows.filter(([y]) => y < Y);
        const n = past.reduce((a, [, t]) => a + t, 0), R = past.reduce((a, [, , r]) => a + r, 0);
        const span = Y - 2020;
        if (n < (spec.tf === '1d' ? 8 : 20) * span) continue;
        if (R / span > bestR) { bestR = R / span; best = k; }
      }
      const row = best ? table[best].find(([y]) => y === Y) : undefined;
      steps.push({ year: Y, key: best, trades: row?.[1] ?? 0, R: row?.[2] ?? 0, pastR: bestR });
    }
    // the setting to trade now: the best of every year so far
    let current: string | null = null, currentR = 0;
    const span = Math.max(1, (b.t[b.n - 1] - b.t[0]) / (365 * 86400));
    for (const [k, rows] of Object.entries(table)) {
      const n = rows.reduce((a, [, t]) => a + t, 0), R = rows.reduce((a, [, , r]) => a + r, 0);
      if (n < (spec.tf === '1d' ? 8 : 20) * span) continue;
      if (R / span > currentR) { currentR = R / span; current = k; }
    }
    parentPort!.postMessage({ id: spec.id, steps, settings: keys.length, current, currentR, currentYears: current ? table[current] : [] });
  });
} else {
  const plans = (process.argv[2] ?? 's1').split(',');
  const tfs = arg('--tf')?.split(',') ?? ['15m', '1h', '4h'];
  const only = arg('--only')?.toUpperCase().split(',');
  const threads = Number(arg('--threads') ?? Math.max(1, os.cpus().length - 4));
  fs.mkdirSync(OUT, { recursive: true });
  const todo = specs().filter((s) => tfs.includes(s.tf) && (!only || only.includes(s.symbol)));
  // the settings tried on each market, all stages together
  const keysOf = new Map<string, string[]>();
  for (const s of todo) {
    const keys = new Set<string>();
    for (const plan of plans) {
      const f = path.resolve('robots/dow/results', plan, `${s.id}.json`);
      if (fs.existsSync(f)) for (const [k] of JSON.parse(fs.readFileSync(f, 'utf8')).rows as [string][]) keys.add(k);
    }
    keysOf.set(s.id, [...keys]);
  }
  const work = todo.filter((s) => keysOf.get(s.id)!.length);
  console.log(`walk-forward : ${work.length} marchés, ${threads} fils`);
  let next = 0, busy = 0;
  await new Promise<void>((done) => {
    const feed = (w: Worker) => {
      if (next >= work.length) { w.postMessage(null); if (--busy === 0) done(); return; }
      const spec = work[next++];
      w.postMessage({ spec, keys: keysOf.get(spec.id), active: process.argv.includes('--active') });
    };
    for (let i = 0; i < Math.min(threads, work.length); i++) {
      const w = new Worker(new URL(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
      busy++;
      w.on('message', (m: { id: string; skipped?: boolean; steps?: { year: number; R: number; trades: number }[] }) => {
        if (!m.skipped) {
          fs.writeFileSync(path.join(OUT, `${m.id}.json`), JSON.stringify(m));
          const total = m.steps!.reduce((a, s) => a + s.R, 0);
          console.log(`${m.id} : ${m.steps!.map((s) => `${s.year} ${s.R.toFixed(1)} R (${s.trades})`).join(' · ')} · total ${total.toFixed(1)} R`);
        }
        feed(w);
      });
      w.on('error', (e) => { console.log(`erreur : ${e.message}`); if (--busy === 0) done(); });
      feed(w);
    }
    if (!work.length) done();
  });
  console.log('fini');
}
