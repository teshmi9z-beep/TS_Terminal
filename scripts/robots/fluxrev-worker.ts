import { parentPort } from 'node:worker_threads';
import { markets } from './flux-lib';
import { revSettings, runRevMarket } from './fluxrev-lib';

// One market / timeframe of the flux reversal study, on its own thread (see fluxrev-study.ts).
parentPort!.on('message', (job: { id: string; tf: string; extra: boolean }) => {
  try {
    const m = markets([job.tf], job.extra).find((x) => x.id === job.id)!;
    parentPort!.postMessage({ ok: true, result: runRevMarket(m, revSettings(job.tf)) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: String((e as Error).stack ?? e) });
  }
});
