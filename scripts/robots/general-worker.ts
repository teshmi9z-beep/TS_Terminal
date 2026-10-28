import { parentPort } from 'node:worker_threads';
import { derive4h, Lab, type DatasetFile } from '../../src/robots/search';
import { statsOf } from '../../src/robots/engine';
import { between, readDataset, toBarList } from './dataset';
import { NF, specsOf, type Spec } from './general-grid';

// One market at a time for general.mjs. 'grid': every setting of the timeframe's grid,
// its stats packed in a Float32Array; 'specs': the given settings with their full stats
// (the report's candidates).
type Msg = { file: string; derive?: '4h'; maxBars: number; from: number; mode: 'grid' | 'specs'; grid?: string; specs?: Spec[] };

parentPort!.on('message', (msg: Msg) => {
  try {
    const { meta, rows } = readDataset(msg.file, msg.derive ? Infinity : msg.maxBars);
    let ds: DatasetFile = { id: meta.id, market: meta.market, source: meta.source, symbol: meta.symbol, tf: meta.tf, bars: toBarList(between(rows, msg.from, Infinity)) };
    if (msg.derive === '4h') ds = derive4h(ds);
    if (ds.bars.length > msg.maxBars) ds.bars = ds.bars.slice(-msg.maxBars);
    const t0 = Date.now();
    const lab = new Lab(ds);
    const { b } = lab;
    const summary = { id: ds.id, symbol: ds.symbol, tf: ds.tf, market: ds.market, source: ds.source, bars: b.n, from: b.t[0], to: b.t[b.n - 1] };
    if (msg.mode === 'grid') {
      const specs = specsOf(ds.tf, msg.grid);
      const stats = new Float32Array(specs.length * NF);
      specs.forEach((s, k) => {
        // the specs come signal by signal: what the last one needed can go
        if (k && specs[k - 1].signal !== s.signal && specs[k - 1].signal.startsWith('hr_')) lab.forget(specs[k - 1].signal);
        const trades = lab.run(s);
        const is = statsOf(trades, 0, lab.split), oos = statsOf(trades, lab.split), full = statsOf(trades);
        stats.set([is.trades, is.winRate, is.ratio, is.totalR, oos.trades, oos.winRate, oos.ratio, oos.totalR, full.totalR, full.maxDDR], k * NF);
      });
      parentPort!.postMessage({ ok: true, summary: { ...summary, ms: Date.now() - t0 }, stats }, [stats.buffer]);
    } else {
      const candidates = (msg.specs ?? []).map((s) => {
        const trades = lab.run(s);
        return { ds: ds.id, ...s, is: statsOf(trades, 0, lab.split), oos: statsOf(trades, lab.split), full: statsOf(trades) };
      });
      parentPort!.postMessage({ ok: true, summary, candidates });
    }
  } catch (e) {
    parentPort!.postMessage({ ok: false, file: msg.file, error: e instanceof Error ? e.stack : String(e) });
  }
});
