import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { dowRun, DOW_DEFAULTS } from '../../src/robots/dow';
import {
  activeOnly, allowMask, groupOf, hourProfile, hoursMask, htfTrend, key, load, specs, SPLIT, stats, variantOf,
  type Spec, type Stats, type Variant,
} from './dow-lib';

// Measures the Dow structure method (src/robots/dow.ts) on the lab's markets since 2020:
// time bars (1 minute to 1 hour) from robots/data and tick bars (150 to 1000 ticks) from
// robots/dow/ticks. Every setting of the grid runs on every market; the first 70 % of the
// period tunes, the last 30 % checks (never used to choose). Real costs of each venue,
// both sides, in R. The active hours (Paris time) are measured on the tuning part only.
// Writes robots/dow/results/<plan>/<market>.json.
// Usage: node robots/.build/dow-study.mjs <plan> [--only EURUSD,BTCUSDT] [--tf 1m,500T] [--threads 20]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);


function grid(plan: string, spec?: Spec): Variant[] {
  const out: Variant[] = [];
  const P = (o: Partial<Variant>) => out.push({ ...DOW_DEFAULTS, hours: 'all', htf: 0, ...o } as Variant);
  // stage 1: the structure, the box, the entry, the exit, and stops the costs don't eat
  // q1: stage 1 on the active hours' bars only (see activeOnly)
  if (plan === 's1' || plan === 't1' || plan === 'q1') {
    for (const swing of [2, 3, 5, 8]) for (const box of ['candle', 'fib', 'range'] as const) for (const entry of ['contact', 'reject'] as const)
      for (const [target, targetR] of [['liq', 1], ['fixed', 2], ['none', 1]] as const) for (const maxCostR of [0.25, 0.1])
        P({ swing, box, entry, target, targetR, maxCostR });
  }
  // stage 2: the best structures of stage 1 (chosen on the tuning part), with the
  // liquidity filters, the active hours and the clean close's body
  if (plan === 's2' || plan === 't2') {
    const base = JSON.parse(fs.readFileSync(path.resolve(`robots/dow/${plan}-base.json`), 'utf8')) as Record<string, string[]>;
    for (const k of base[groupOf(spec!.tf)] ?? []) {
      const v = variantOf(k);
      for (const liq of ['none', 'guard', 'sweep'] as const) for (const hours of ['all', 'med', 'top'] as const) for (const htf of [0, 1] as const)
        for (const body of [0.5, 0.7]) P({ ...v, liq, hours, htf, body });
    }
  }
  // stage 3: the exits (target, Dow's trailing stop, break-even) and the leg's size, on the
  // best settings of stage 2 (chosen on the tuning part)
  if (plan === 's3' || plan === 't3') {
    const base = JSON.parse(fs.readFileSync(path.resolve(`robots/dow/${plan}-base.json`), 'utf8')) as Record<string, string[]>;
    const g = groupOf(spec!.tf);
    // the class's own bases, then the group's (without repeats)
    const keys = [...new Set([...(base[`${spec!.market}|${g}`] ?? []), ...(base[g] ?? []).slice(0, 4)])];
    for (const k of keys) {
      const v = variantOf(k);
      for (const [target, targetR] of [['liq', 1], ['liq', 2], ['fixed', 3], ['none', 1], ['trail', 1]] as const) for (const be of [false, true])
        for (const minLeg of [0, 2, 4]) P({ ...v, target, targetR, be, minLeg });
    }
  }
  // the sweep entries: liquidity taken by a wick, the close back on the other side
  if (plan === 'w1') {
    for (const mode of ['sweep', 'sweepeq'] as const) for (const swing of [2, 3, 5, 8])
      for (const [target, targetR] of [['liq', 1], ['liq', 2], ['fixed', 1.5], ['fixed', 2], ['none', 1]] as const)
        for (const maxCostR of [0.25, 0.1]) for (const hours of ['all', 'top'] as const) for (const htf of [0, 1] as const)
          P({ mode, swing, target, targetR, maxCostR, hours, htf });
  }
  // the ranges: stage 1's settings, no entry while the price sits inside a range
  if (plan === 'r1') {
    for (const swing of [2, 3, 5, 8]) for (const box of ['candle', 'fib', 'range'] as const) for (const entry of ['contact', 'reject'] as const)
      for (const [target, targetR] of [['liq', 1], ['fixed', 2], ['none', 1]] as const) for (const maxCostR of [0.25, 0.1])
        P({ swing, box, entry, target, targetR, maxCostR, noRange: true });
  }
  if (plan === 'speed') for (const box of ['candle', 'fib', 'range'] as const) for (const hours of ['all', 'top'] as const) P({ box, hours });
  if (!out.length) throw new Error(`plan inconnu : ${plan}`);
  return out;
}

// ---------------------------------------------------------------- worker: one market, every setting
if (!isMainThread) {
  parentPort!.on('message', (msg: { spec: Spec; keys: string[]; plan: string } | null) => {
    if (!msg) { process.exit(0); }
    const { spec, keys } = msg!;
    const t0 = Date.now();
    const loaded = load(spec);
    if (!loaded) { parentPort!.postMessage({ id: spec.id, skipped: true }); return; }
    const b = msg!.plan === 'q1' ? activeOnly(loaded) : loaded;
    const split = Math.floor(b.n * SPLIT);
    const profile = hourProfile(b, split);
    const hours: Record<string, Uint8Array | undefined> = { all: undefined, med: hoursMask(b, profile, 'med'), top: hoursMask(b, profile, 'top') };
    const trend = keys.some((k) => variantOf(k).htf) ? htfTrend(b, spec.tf) : undefined;
    const masks = new Map<string, Uint8Array | undefined>();
    const maskOf = (v: Variant) => {
      const mk = `${v.hours}|${v.htf}`;
      if (!masks.has(mk)) masks.set(mk, allowMask(hours[v.hours], v.htf ? trend : undefined, b.n));
      return masks.get(mk);
    };
    const rows: [string, Stats, Stats][] = [];
    for (const k of keys) {
      const v = variantOf(k);
      const res = dowRun(b, { ...v, cost: spec.cost }, maskOf(v));
      rows.push([k, stats(res.trades, b, 0, split, spec.cost), stats(res.trades, b, split, b.n, spec.cost)]);
    }
    parentPort!.postMessage({ id: spec.id, rows, bars: b.n, from: b.t[0], to: b.t[b.n - 1], split: b.t[split], profile, ms: Date.now() - t0 });
  });
} else {
  const plan = process.argv[2];
  const only = arg('--only')?.toUpperCase().split(',');
  const tfs = arg('--tf')?.split(',');
  const threads = Number(arg('--threads') ?? Math.max(1, os.cpus().length - 4));
  const out = path.resolve('robots/dow/results', plan);
  fs.mkdirSync(out, { recursive: true });
  const todo = specs().filter((s) => (!only || only.includes(s.symbol)) && (!tfs || tfs.includes(s.tf)) && !fs.existsSync(path.join(out, `${s.id}.json`)));
  // the big ones first (1 minute, 150 ticks)
  const weight = (s: Spec) => (s.tf === '1m' || s.tf === '150T' ? 0 : s.tf === '250T' ? 1 : s.tf === '5m' || s.tf === '500T' ? 2 : 3);
  todo.sort((a, z) => weight(a) - weight(z));
  const keysOf = new Map(todo.map((s) => [s.id, grid(plan, s).map(key)]));
  console.log(`${plan} : ${keysOf.get(todo[0]?.id)?.length ?? 0} réglages × ${todo.length} marchés, ${threads} fils`);
  let next = 0, busy = 0;
  const t0 = Date.now();
  await new Promise<void>((done) => {
    const feed = (w: Worker) => {
      if (next >= todo.length) { w.postMessage(null); if (--busy === 0) done(); return; }
      const spec = todo[next++];
      w.postMessage({ spec, keys: keysOf.get(spec.id), plan });
    };
    for (let i = 0; i < Math.min(threads, todo.length); i++) {
      const w = new Worker(new URL(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 4096 } });
      busy++;
      w.on('message', (m: { id: string; skipped?: boolean; rows?: unknown; bars?: number; ms?: number }) => {
        if (!m.skipped) {
          const spec = todo.find((s) => s.id === m.id)!;
          fs.writeFileSync(path.join(out, `${m.id}.json`), JSON.stringify({ ...m, spec: { ...spec, file: undefined } }));
          console.log(`${m.id} : ${m.bars} barres, ${((m.ms ?? 0) / 1000).toFixed(0)} s (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
        } else console.log(`${m.id} : pas assez de barres`);
        feed(w);
      });
      w.on('error', (e) => { console.log(`erreur : ${e.message}`); if (--busy === 0) done(); });
      feed(w);
    }
    if (!todo.length) done();
  });
  console.log('fini');
}
