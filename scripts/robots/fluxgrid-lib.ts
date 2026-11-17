import { prepGrid, runGrid, type Basket, type GridSetting } from '../../src/robots/fluxGrid';
import { barsOf, type FMkt } from './flux-lib';
import { acc, add, makeCtx, SPLIT, type Acc } from './night-lib';

// The flux grid study (2026-11-03): src/robots/fluxGrid.ts on the flux study's markets (the 5
// indices, forex, gold, oil; robots/flux), entries on 5 and 15 minutes, the flux on 1 hour,
// since 2020 at real costs. Every basket is one trade, in R: its result over what it loses
// if every order fills and the price goes 0.5 hourly ATR past the cloud.

export function settings(): GridSetting[] {
  const out: GridSetting[] = [];
  for (const levels of [3, 5]) for (const size of ['flat', 'lin', 'mart'] as const) for (const tp of ['low', 'mid'] as const)
    for (const stop of ['flip', 'cloud'] as const) for (const guard of ['none', 'level', 'wick', 'both'] as const) out.push({ levels, size, tp, stop, guard });
  return out;
}

// the variants: 5 orders, the first one half-way to the flux or not, legs of 1, 2 or 3 hourly
// ATRs, with and without the guards
export function variants(): GridSetting[] {
  const out: GridSetting[] = [];
  for (const from of [undefined, 0.5]) for (const zone of [undefined, 2, 3]) for (const guard of ['none', 'both'] as const)
    for (const size of ['lin', 'mart'] as const) for (const tp of ['low', 'mid'] as const) for (const stop of ['flip', 'cloud'] as const)
      out.push({ levels: 5, size, tp, stop, guard, ...(from ? { from } : {}), ...(zone ? { zone } : {}) });
  return out;
}

// options after the 5 choices: f<first order's place>, z<smallest leg>
export const keyOf = (s: GridSetting) => `${s.levels}|${s.size}|${s.tp}|${s.stop}|${s.guard}${s.from ? `|f${s.from}` : ''}${s.zone ? `|z${s.zone}` : ''}`;
export const fromKey = (k: string): GridSetting => {
  const [levels, size, tp, stop, guard, ...opt] = k.split('|');
  const s: GridSetting = { levels: Number(levels), size: size as GridSetting['size'], tp: tp as GridSetting['tp'], stop: stop as GridSetting['stop'], guard: guard as GridSetting['guard'] };
  for (const o of opt) {
    if (o[0] === 'f') s.from = Number(o.slice(1));
    if (o[0] === 'z') s.zone = Number(o.slice(1));
  }
  return s;
};

const SIZE_FR = { flat: 'tailles égales', lin: 'tailles 1-2-3…', mart: 'tailles doublées 1-2-4…' };
const GUARD_FR = { none: 'sans garde-fou', level: 'pas sur gros niveau jour / semaine', wick: 'pas après grande mèche', both: 'ni gros niveau, ni grande mèche' };
export function labelOf(s: GridSetting): string {
  return [
    `${s.levels} entrées, ${SIZE_FR[s.size]}`,
    s.tp === 'low' ? 'objectif : retour au bout de la jambe' : 'objectif : mi-chemin vers le bout de la jambe',
    s.stop === 'flip' ? 'invalidation : flux qui change de couleur' : 'invalidation : stop au-delà du nuage',
    GUARD_FR[s.guard],
  ].join(' · ');
}

// a period's baskets: the R accumulator, plus the worst basket, the deepest drawdown (R), the
// orders filled and the baskets whose adding a wick stopped
export type GAcc = { a: Acc; worst: number; dd: number; peak: number; cum: number; fills: number; cut: number; cost: number; why: Record<string, number> };
export const gacc = (): GAcc => ({ a: acc(), worst: 0, dd: 0, peak: 0, cum: 0, fills: 0, cut: 0, cost: 0, why: {} });
export function gadd(g: GAcc, b: Basket) {
  add(g.a, b.r);
  g.cost += b.costR;
  g.worst = Math.min(g.worst, b.r);
  g.cum += b.r; g.peak = Math.max(g.peak, g.cum); g.dd = Math.max(g.dd, g.peak - g.cum);
  g.fills += b.fills.length;
  if (b.cut) g.cut++;
  g.why[b.why] = (g.why[b.why] ?? 0) + 1;
}

export type GRes = { is: GAcc; oos: GAcc; years: Record<number, Acc> };
export type GResult = { id: string; sym: string; cls: string; tf: string; extra: boolean; res: Record<string, GRes> };

export function tallyGrid(baskets: Basket[]): GRes {
  const r: GRes = { is: gacc(), oos: gacc(), years: {} };
  for (const b of baskets) {
    if (b.why === 'end') continue;
    gadd(b.t0 < SPLIT ? r.is : r.oos, b);
    add((r.years[new Date(b.t0 * 1000).getUTCFullYear()] ??= acc()), b.r);
  }
  return r;
}

export function prepOf(m: FMkt) {
  const b = barsOf(m);
  const x = makeCtx(m, b);
  return prepGrid(b, { skip: x.roll, start: x.start });
}

export function runGridMarket(m: FMkt, list: GridSetting[]): GResult {
  const p = prepOf(m);
  const res: GResult['res'] = {};
  for (const s of list) res[keyOf(s)] = tallyGrid(runGrid(p, s, m.cost).baskets);
  return { id: m.id, sym: m.sym, cls: m.cls, tf: m.tf, extra: m.extra, res };
}
