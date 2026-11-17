import { runGrid, GRID_DEFAULT, type GridSetting } from '../../src/robots/fluxGrid';
import { markets } from './flux-lib';
import { prepOf, fromKey } from './fluxgrid-lib';

// One market of the flux grid, basket by basket: node robots/.build/fluxgrid-inspect.mjs <id> [setting key]
const id = process.argv[2] ?? 'histdata_EURUSD_15m';
const tf = id.split('_').pop()!;
const m = markets([tf]).find((x) => x.id === id)!;
const p = prepOf(m);
const s: GridSetting = process.argv[3] ? fromKey(process.argv[3]) : GRID_DEFAULT;
const cnt = (a: ArrayLike<number>) => { let k = 0; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) k++; return k; };
console.log(m.id, 'bars', p.n, 'start', p.start, 'atrH', cnt(p.atrH), 'onSup', cnt(p.onSup), 'onRes', cnt(p.onRes), 'wickLo', cnt(p.wickLo), 'wickHi', cnt(p.wickHi), 'st+', Array.from(p.st).filter((v) => v > 0).length, 'st-', Array.from(p.st).filter((v) => v < 0).length);
const { baskets, live } = runGrid(p, s, m.cost);
console.log('baskets', baskets.length, 'live', JSON.stringify({ ...live, basket: !!live.basket }));
for (const b of baskets.slice(0, 10)) console.log(new Date(b.t0 * 1000).toISOString(), b.dir, b.fills.length, b.why, b.r.toFixed(2), b.levels.map((v) => v.toFixed(5)).join(' '), 'ext', b.ext.toFixed(5), 'ref', b.ref.toFixed(5), 'exit', b.exit.toFixed(5));
