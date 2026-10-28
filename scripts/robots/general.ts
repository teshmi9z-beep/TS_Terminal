import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CRITERIA, SPLIT, type Candidate, type DatasetSummary } from '../../src/robots/search';
import type { Stats } from '../../src/robots/engine';
import { datasetFiles, fromArg, idOfFile, readHeader } from './dataset';
import { GRIDS, NF, specsOf, type Spec } from './general-grid';

// "General" round: every setting of general-grid.ts on every market with years of
// history, then the settings that pass the criteria on many markets of the same class
// and timeframe (forex 1 hour, crypto 4 hours...). Their passing markets become the
// round's candidates (robots/results/<round>.json, read by report.mjs like any round),
// and the whole ranking goes to robots/general/<round>.json.
// Usage: node robots/.build/general.mjs [--round night-s2] [--grid s2|s3] [--markets Forex,Index] [--tfs 1h,4h]
//   [--workers N] [--max-bars N] [--min-years 3] [--top 12] [--min-pass 3] [--min-share 0.2] [--dump] [--from 2020-01-01|all]
// Only the bars since --from count (2020 by default).
// --dump: every market's stats of every setting kept in robots/general/<round>/<market>.f32
// (NF floats per setting, in specsOf order), for hour-report.mjs

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const round = arg('--round') ?? `general-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
const nWorkers = Number(arg('--workers') ?? Math.max(1, os.cpus().length - 2));
const maxBars = Number(arg('--max-bars') ?? 200_000);
const FROM = fromArg();
const minYears = Number(arg('--min-years') ?? 3);
const TOP = Number(arg('--top') ?? 12);
// a setting is kept when it passes on at least --min-pass markets and --min-share of its group
const MIN_PASS = Number(arg('--min-pass') ?? 3);
const MIN_SHARE = Number(arg('--min-share') ?? 0.2);
const only = arg('--only');
const grid = arg('--grid') ?? 's2';
if (!GRIDS[grid]) throw new Error(`grille inconnue : ${grid}`);
const GRID = GRIDS[grid];
const TFS = arg('--tfs')?.split(',') ?? ['15m', '30m', '1h', '4h', '1d'];
const MARKETS = arg('--markets')?.split(',');
const DUMP = process.argv.includes('--dump');
const YEAR = 365.25 * 86400;

const DATA = path.resolve('robots/data');
const OUT = path.resolve('robots/results');
const GEN = path.resolve('robots/general');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(GEN, { recursive: true });

type Task = { file: string; id: string; tf: string; size: number; derive?: '4h' };
const tasks: Task[] = [];
for (const f of datasetFiles(DATA)) {
  const file = path.join(DATA, f), id = idOfFile(f), tf = id.split('_').pop()!;
  // the perpetuals and imports: too short or one-off
  if (!f.endsWith('.bin') || /^(bnfut|import)_/.test(id) || !TFS.includes(tf) || (only && !id.includes(only))) continue;
  const { meta } = readHeader(file);
  if (MARKETS && !MARKETS.includes(meta.market)) continue;
  // the part of the history the search goes through (its last maxBars bars since FROM)
  const span = meta.to - Math.max(meta.from, FROM);
  const inWindow = meta.bars * Math.max(0, span) / Math.max(1, meta.to - meta.from);
  const years = (Math.max(0, span) / YEAR) * Math.min(1, maxBars / Math.max(1, inWindow));
  if (years >= minYears) tasks.push({ file, id, tf, size: Math.min(maxBars, meta.bars) });
}
tasks.sort((a, b) => b.size - a.size);

const passes = (trades: number, win: number, ratio: number, r: number, min: number) => trades >= min && win > CRITERIA.winRate && ratio > CRITERIA.ratio && r > 0;

// dispatches messages to a pool of workers, one market each
async function pool<T>(items: T[], message: (t: T) => object, onDone: (m: any, t: T) => void) {
  let next = 0, done = 0;
  await new Promise<void>((resolve) => {
    if (!items.length) { resolve(); return; }
    const workers = Array.from({ length: Math.min(nWorkers, items.length) }, () => new Worker(new URL('./general-worker.mjs', import.meta.url)));
    let alive = workers.length;
    const feed = (w: Worker) => {
      const t = items[next++];
      if (!t) { void w.terminate(); if (--alive === 0) resolve(); return; }
      w.once('message', (m) => { done++; onDone(m, t); feed(w); });
      w.postMessage(message(t));
    };
    for (const w of workers) { w.on('error', (e) => console.log('worker:', e)); feed(w); }
  });
  return done;
}

// ---- phase 1: the whole grid on every market
type Group = { specs: Spec[]; ds: string[]; n: Float64Array; pass: Float64Array; posOOS: Float64Array; oosRY: Float64Array; fullRY: Float64Array };
const groups = new Map<string, Group>();
const passing = new Map<string, Int32Array>();
const summaries = new Map<string, DatasetSummary>();
const t0 = Date.now();
let tested = 0, k = 0;
await pool(tasks, (t) => ({ file: t.file, derive: t.derive, maxBars, from: FROM, mode: 'grid', grid }), (m, t) => {
  k++;
  if (!m.ok) { console.log(`[${k}/${tasks.length}] ERREUR ${t.id}: ${m.error}`); return; }
  const s = m.summary, st = m.stats as Float32Array;
  const key = `${s.market}|${s.tf}`;
  let g = groups.get(key);
  if (!g) {
    const specs = specsOf(s.tf, grid), n = specs.length;
    g = { specs, ds: [], n: new Float64Array(n), pass: new Float64Array(n), posOOS: new Float64Array(n), oosRY: new Float64Array(n), fullRY: new Float64Array(n) };
    groups.set(key, g);
  }
  g.ds.push(s.id);
  const years = Math.max(0.25, (s.to - s.from) / YEAR);
  const pass: number[] = [];
  for (let i = 0; i < g.specs.length; i++) {
    const o = i * NF;
    g.n[i]++;
    const ok = passes(st[o], st[o + 1], st[o + 2], st[o + 3], CRITERIA.minTradesIS) && passes(st[o + 4], st[o + 5], st[o + 6], st[o + 7], CRITERIA.minTradesOOS);
    if (ok) { g.pass[i]++; pass.push(i); }
    if (st[o + 7] > 0) g.posOOS[i]++;
    g.oosRY[i] += st[o + 7] / (years * (1 - SPLIT));
    g.fullRY[i] += st[o + 8] / years;
  }
  passing.set(s.id, Int32Array.from(pass));
  if (DUMP) {
    fs.mkdirSync(path.join(GEN, round), { recursive: true });
    fs.writeFileSync(path.join(GEN, round, `${s.id}.f32`), Buffer.from(st.buffer, st.byteOffset, st.byteLength));
  }
  tested += g.specs.length;
  summaries.set(s.id, {
    ...s, tested: g.specs.length, passIS: 0, passBoth: pass.length, ms: s.ms, best: null,
    families: { 'Stoch Price Envelope': { tested: g.specs.length, passed: pass.length } },
  });
  console.log(`[${k}/${tasks.length}] ${s.id.padEnd(28)} ${String(s.bars).padStart(6)} barres  ${years.toFixed(1)} ans  ${String(pass.length).padStart(5)} réglages validés  ${(s.ms / 1000).toFixed(0)} s`);
});
console.log(`\nphase 1 : ${tested} tests sur ${summaries.size} marchés en ${((Date.now() - t0) / 60000).toFixed(1)} min`);

// ---- selection: per class and timeframe, the settings passing on the largest share of its markets
const specKey = (s: Spec) => `${s.signal}|${s.filter}|${s.dir}`;
type Pick = { group: string; idx: number; spec: Spec; markets: number; passed: number; share: number; posOOS: number; oosRY: number; fullRY: number; on: string[] };
const ranking: Pick[] = [];
const chosen: Pick[] = [];
for (const [key, g] of groups) {
  const nDs = g.ds.length;
  if (nDs < 3) continue;
  const order = [...g.specs.keys()]
    .filter((i) => g.pass[i] >= MIN_PASS && g.pass[i] / nDs >= MIN_SHARE && g.oosRY[i] > 0)
    .sort((a, b) => g.pass[b] - g.pass[a] || g.fullRY[b] - g.fullRY[a]);
  const rows = order.map((i): Pick => ({
    group: key, idx: i, spec: g.specs[i], markets: nDs, passed: g.pass[i], share: g.pass[i] / nDs, posOOS: g.posOOS[i] / nDs,
    oosRY: g.oosRY[i] / nDs, fullRY: g.fullRY[i] / nDs, on: g.ds.filter((d) => passing.get(d)!.includes(i)),
  }));
  ranking.push(...rows.slice(0, 60));
  // the best stop / exits of each signal + filter + side, at most 3 per signal
  const seen = new Set<string>(), perSignal = new Map<string, number>();
  for (const r of rows) {
    if (chosen.filter((c) => c.group === key).length >= TOP) break;
    if (seen.has(specKey(r.spec)) || (perSignal.get(r.spec.signal) ?? 0) >= 3) continue;
    seen.add(specKey(r.spec)); perSignal.set(r.spec.signal, (perSignal.get(r.spec.signal) ?? 0) + 1);
    chosen.push(r);
  }
}
fs.writeFileSync(path.join(GEN, `${round}.json`), JSON.stringify({ round, ranAt: Date.now(), from: FROM, grid: GRID, criteria: CRITERIA, groups: [...groups].map(([k, g]) => ({
  group: k, markets: g.ds,
  // every setting passing on 2 markets or more: index in specsOf(tf, grid), markets passed, positive checks, R a year
  passes: [...g.specs.keys()].filter((i) => g.pass[i] >= 2).map((i) => [i, g.pass[i], g.posOOS[i], +(g.fullRY[i] / g.ds.length).toFixed(2)]),
})), ranking, chosen }));
console.log('\nréglages qui passent sur le plus de marchés (par classe et unité) :');
for (const c of chosen) console.log(`  ${c.group.padEnd(14)} ${c.passed}/${c.markets} (${(c.share * 100).toFixed(0)} %)  OOS>0 ${(c.posOOS * 100).toFixed(0)} %  ${c.fullRY.toFixed(1)} R/an  ${c.spec.signal} | ${c.spec.filter} | ${c.spec.dir} | ${c.spec.stop} | ${c.spec.legs.tpR}/${c.spec.legs.trailK}`);

// ---- phase 2: full stats of the chosen settings on the markets where they pass
const perDs = new Map<string, Pick[]>();
for (const c of chosen) for (const d of c.on) { const l = perDs.get(d) ?? []; l.push(c); perDs.set(d, l); }
const candidates: Candidate[] = [];
const byId = new Map(tasks.map((t) => [t.id, t]));
await pool([...perDs.keys()], (id) => ({ file: byId.get(id)!.file, derive: byId.get(id)!.derive, maxBars, from: FROM, mode: 'specs', grid, specs: perDs.get(id)!.map((c) => c.spec) }), (m, id) => {
  if (!m.ok) { console.log(`ERREUR ${id}: ${m.error}`); return; }
  const g = groups.get(`${m.summary.market}|${m.summary.tf}`)!;
  const pass = passing.get(id)!;
  for (const c of m.candidates as (Spec & { ds: string; is: Stats; oos: Stats; full: Stats })[]) {
    // neighbours: the other stops and exits of the same signal, filter and side on this market
    const robust = [...pass].filter((i) => specKey(g.specs[i]) === specKey(c)).length;
    candidates.push({ ...c, robust, robustTotal: GRID.stops.length * GRID.legs.length });
  }
});
fs.writeFileSync(path.join(OUT, `${round}.json`), JSON.stringify({ round, ranAt: Date.now(), tested, summaries: [...summaries.values()], candidates }));
console.log(`\n${round}: ${tested} stratégies testées sur ${summaries.size} marchés/unités, ${chosen.length} réglages généraux, ${candidates.length} robots gardés, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
