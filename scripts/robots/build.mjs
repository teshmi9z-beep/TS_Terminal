// Bundles the robot lab (TypeScript, reusing the app's indicator code) for Node.
import { build } from 'rolldown';

await build({
  input: { lab: 'scripts/robots/lab.ts', worker: 'scripts/robots/worker.ts', report: 'scripts/robots/report.ts', history: 'scripts/robots/fetch-history.ts',
    general: 'scripts/robots/general.ts', 'general-worker': 'scripts/robots/general-worker.ts',
    'hour-study': 'scripts/robots/hour-study.ts',
    'dow-ticks': 'scripts/robots/dow-ticks.ts',
    'dow-study': 'scripts/robots/dow-study.ts',
    'dow-report': 'scripts/robots/dow-report.ts',
    'dow-inspect': 'scripts/robots/dow-inspect.ts',
    'dow-publish': 'scripts/robots/dow-publish.ts',
    'dow-luck': 'scripts/robots/dow-luck.ts',
    'dow-wf': 'scripts/robots/dow-wf.ts',
    'index-study': 'scripts/robots/index-study.ts',
    'index-inspect': 'scripts/robots/index-inspect.ts',
    night: 'scripts/robots/night.ts',
    'night-worker': 'scripts/robots/night-worker.ts',
    'night-inspect': 'scripts/robots/night-inspect.ts',
    'night-portfolio': 'scripts/robots/night-portfolio.ts',
    'night-wf': 'scripts/robots/night-wf.ts',
    'gap-study': 'scripts/robots/gap-study.ts',
    'em-study': 'scripts/robots/em-study.ts',
    'em-check': 'scripts/robots/em-check.ts',
    'em-publish': 'scripts/robots/em-publish.ts',
    'dow-robots': 'scripts/robots/dow-robots.ts',
  },
  platform: 'node',
  output: { dir: 'robots/.build', format: 'esm', entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' },
  logLevel: 'warn',
});
console.log('labo compilé dans robots/.build');
