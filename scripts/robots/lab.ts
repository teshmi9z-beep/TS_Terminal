import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PLANS, type Candidate, type DatasetSummary } from '../../src/robots/search';
import { datasetFiles, fromArg, idOfFile, readHeader } from './dataset';

// Runs the search on every downloaded dataset (and 4h built from Yahoo's 1h) with
// one worker per core, then writes robots/results/<round>.json. Each search uses the
// last --max-bars bars of its history (200 000 by default: years of 1-minute bars
// would take hours per market).
// Usage: node robots/.build/lab.mjs [--plan r1|r2] [--only <text>] [--workers N] [--round name] [--skip-done] [--max-bars N] [--from 2020-01-01|all]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const only = arg('--only');
const plan = arg('--plan') ?? 'r1';
if (!PLANS[plan]) throw new Error(`plan inconnu : ${plan}`);
const round = arg('--round') ?? `round-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
const nWorkers = Number(arg('--workers') ?? Math.max(1, os.cpus().length - 2));
const maxBars = Number(arg('--max-bars') ?? 200_000);
// only the bars since --from (2020 by default)
const FROM = fromArg();

const DATA = path.resolve('robots/data');
const OUT = path.resolve('robots/results');
fs.mkdirSync(OUT, { recursive: true });

type Task = { file: string; derive?: '4h'; size: number; id: string };
const tasks: Task[] = [];
// size: about how many bars the search will go through (the biggest go first)
for (const f of datasetFiles(DATA)) {
  const file = path.join(DATA, f), id = idOfFile(f);
  const size = Math.min(maxBars, f.endsWith('.bin') ? readHeader(file).meta.bars : fs.statSync(file).size / 50);
  tasks.push({ file, id, size });
  if (id.startsWith('yahoo_') && id.endsWith('_1h')) tasks.push({ file, derive: '4h', id: id.replace(/_1h$/, '_4h'), size: size / 4 });
}
// --skip-done: leave out the datasets some earlier round already searched
const done0 = new Set<string>();
if (process.argv.includes('--skip-done')) {
  for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.json'))) {
    for (const s of (JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) as { summaries: DatasetSummary[] }).summaries) done0.add(s.id);
  }
}
const tfOf = (id: string) => id.split('_').pop()!;
const todo = tasks.filter((t) => (!only || t.id.includes(only)) && !done0.has(t.id) && PLANS[plan].tfs(tfOf(t.id))).sort((a, b) => b.size - a.size);

const summaries: DatasetSummary[] = [];
const candidates: Candidate[] = [];
const t0 = Date.now();
let next = 0, done = 0;

await new Promise<void>((resolve) => {
  if (!todo.length) { resolve(); return; }
  const workers = Array.from({ length: Math.min(nWorkers, todo.length) }, () => new Worker(new URL('./worker.mjs', import.meta.url)));
  let alive = workers.length;
  const feed = (w: Worker) => {
    const t = todo[next++];
    if (!t) { void w.terminate(); if (--alive === 0) resolve(); return; }
    w.postMessage({ file: t.file, derive: t.derive, plan, maxBars, from: FROM });
  };
  for (const w of workers) {
    w.on('message', (m: { ok: boolean; summary?: DatasetSummary; candidates?: Candidate[]; error?: string; file?: string }) => {
      done++;
      if (m.ok && m.summary) {
        summaries.push(m.summary);
        candidates.push(...(m.candidates ?? []));
        const s = m.summary;
        console.log(`[${done}/${todo.length}] ${s.id.padEnd(28)} ${String(s.bars).padStart(6)} barres  ${String(s.tested).padStart(6)} testés  ${String(s.passIS).padStart(5)} bons en réglage  ${String(s.passBoth).padStart(4)} confirmés  ${(s.ms / 1000).toFixed(0)} s`);
      } else console.log(`[${done}/${todo.length}] ERREUR ${m.file}: ${m.error}`);
      feed(w);
    });
    w.on('error', (e) => console.log('worker:', e));
    feed(w);
  }
});

const tested = summaries.reduce((a, s) => a + s.tested, 0);
fs.writeFileSync(path.join(OUT, `${round}.json`), JSON.stringify({ round, ranAt: Date.now(), tested, summaries, candidates }));
console.log(`\n${round}: ${tested} stratégies testées sur ${summaries.length} marchés/unités, ${candidates.length} gardées, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
