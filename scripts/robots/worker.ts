import { parentPort } from 'node:worker_threads';
import { derive4h, Lab, PLANS, type DatasetFile } from '../../src/robots/search';
import { between, readDataset, toBarList } from './dataset';

// one dataset at a time: load it (its last maxBars bars since `from`), search, send back the summary and the candidates
parentPort!.on('message', (msg: { file: string; derive?: '4h'; plan?: string; maxBars?: number; from?: number }) => {
  try {
    const max = msg.maxBars ?? Infinity;
    const { meta, rows } = readDataset(msg.file, msg.derive ? Infinity : max);
    let ds: DatasetFile = { id: meta.id, market: meta.market, source: meta.source, symbol: meta.symbol, tf: meta.tf, bars: toBarList(between(rows, msg.from ?? 0, Infinity)) };
    if (msg.derive === '4h') ds = derive4h(ds);
    if (ds.bars.length > max) ds.bars = ds.bars.slice(-max);
    const lab = new Lab(ds);
    const res = lab.search(PLANS[msg.plan ?? 'r1']);
    parentPort!.postMessage({ ok: true, ...res });
  } catch (e) {
    parentPort!.postMessage({ ok: false, file: msg.file, error: e instanceof Error ? e.stack : String(e) });
  }
});
