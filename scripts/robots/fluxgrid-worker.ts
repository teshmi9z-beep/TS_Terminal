import { parentPort } from 'node:worker_threads';
import { markets } from './flux-lib';
import { fromKey, runGridMarket, settings } from './fluxgrid-lib';

// One market / timeframe of the flux grid study, on its own thread (see fluxgrid-study.ts).
parentPort!.on('message', (job: { id: string; tf: string; extra: boolean; keys?: string[] }) => {
  try {
    const m = markets([job.tf], job.extra).find((x) => x.id === job.id)!;
    parentPort!.postMessage({ ok: true, result: runGridMarket(m, job.keys ? job.keys.map(fromKey) : settings()) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: String((e as Error).stack ?? e) });
  }
});
