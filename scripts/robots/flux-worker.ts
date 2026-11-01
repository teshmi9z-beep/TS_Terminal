import { parentPort } from 'node:worker_threads';
import { markets, runMarket, specs } from './flux-lib';

// One market / timeframe of the flux study, on its own thread (see flux-study.ts).
parentPort!.on('message', (job: { id: string; tf: string; extra: boolean; kind: string }) => {
  try {
    const m = markets([job.tf], job.extra).find((x) => x.id === job.id)!;
    parentPort!.postMessage({ ok: true, result: runMarket(m, specs(job.tf, job.kind)) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, error: String((e as Error).stack ?? e) });
  }
});
