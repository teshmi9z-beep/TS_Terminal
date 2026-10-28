import { parentPort } from 'node:worker_threads';
import { FAMILIES } from './night-families';
import { marketList, runMarket } from './night-lib';

// One market / timeframe of a night-lab family, on its own thread (see night.ts).
parentPort!.on('message', (job: { fam: string; id: string; tf: string }) => {
  try {
    const m = marketList([job.tf]).find((x) => x.id === job.id)!;
    parentPort!.postMessage({ ok: true, result: runMarket(FAMILIES[job.fam], m) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: String((e as Error).stack ?? e) });
  }
});
