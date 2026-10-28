import { dowRun } from '../../src/robots/dow';
import { allowFor, load, luckTest, specs, variantOf } from './dow-lib';

// Does the box entry add anything? A robot of the Dow structure study against random
// entries in the direction of the same Dow trend (see luckTest in dow-lib.ts). If the robot
// doesn't beat most runs, the trend did the work, not the entry.
// Usage: node robots/.build/dow-luck.mjs <market id> "<setting key>" [runs]

const [id, k, runsArg] = process.argv.slice(2);
const spec = specs().find((s) => s.id === id);
if (!spec) throw new Error(`marché inconnu : ${id}`);
const b = load(spec)!;
const v = variantOf(k);
const res = dowRun(b, { ...v, cost: spec.cost }, allowFor(b, spec, v));
const l = luckTest(b, spec, v, res.trades, Number(runsArg ?? 200));
const pc = (x: number) => (Number.isNaN(x) ? '—' : `${Math.round(x * 100)} %`);
console.log(`${id} · ${k} : le robot bat ${pc(l.is)} des tirages en réglage, ${pc(l.oos)} en validation, ${pc(l.all)} sur tout`);
