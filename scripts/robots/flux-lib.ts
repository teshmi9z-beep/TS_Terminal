import fs from 'node:fs';
import path from 'node:path';
import { costOf } from '../../src/robots/search';
import { fluxAverage } from '../../src/indicators/custom/flux';
import {
  acc, add, loadBars, makeCtx, MAX_COST_R, simulate, swings, SPLIT, TF_SEC,
  type Acc, type Bars, type Cls, type Ctx, type Mkt, type Order, type Trade,
} from './night-lib';

// The flux study (2026-10-29): the "Flux MM20 / MM50" indicator (src/indicators/custom/flux.ts)
// as a trend filter, the trades always in its direction, entered on a pullback to the cloud,
// a Fibonacci retracement of the last leg, an order block or an imbalance (fair value gap).
// The flux is read on 1 hour, 4 hours or the day, the entries on 5 minutes to the day, on
// the 5 indices, forex, gold, oil and gas since 2020 at real costs. simulateLive() below fills
// the orders bar after bar (night-lib's simulate() favours old limits, see there): one
// position at a time, stop first, the rollover skipped. Nothing held: see robots/flux/FLUX.md.

export const DATA = path.resolve('robots/data');

// the user's 5 indices (S&P 500, Nasdaq 100, Dow Jones, DAX, Nikkei), forex (their list and
// the other majors), gold, oil, gas; `extra` markets only serve as a later check.
// HistData has holes: no DAX from 2020-06 to 2023-12 (the DAX comes from IBKR), no WTI from
// 2023-12 to 2026-06 (Yahoo's CL=F, 1 hour since 2024-09, fills in as "WTI-Y")
type Src = { sym: string; cls: Cls; prefix: string; extra?: boolean; file?: string; tfs?: string[] };
const LIST: Src[] = [
  ...['SPX500', 'NDX100', 'NIKKEI'].map((sym): Src => ({ sym, cls: 'Index', prefix: 'histdata' })),
  { sym: 'DAX40', cls: 'Index', prefix: 'dl_ibkr' },
  { sym: 'DJI', cls: 'Index', prefix: 'dl_ibkr' },
  ...['EURUSD', 'USDJPY', 'AUDUSD', 'EURCHF', 'EURGBP', 'GBPUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURJPY', 'GBPJPY']
    .map((sym): Src => ({ sym, cls: 'Forex', prefix: 'histdata' })),
  { sym: 'XAUUSD', cls: 'Commodity', prefix: 'histdata' },
  { sym: 'WTI', cls: 'Commodity', prefix: 'histdata' },
  { sym: 'WTI-Y', cls: 'Commodity', prefix: 'yahoo', file: 'WTI', tfs: ['1h', '4h'] },
  { sym: 'NATGAS', cls: 'Commodity', prefix: 'yahoo', tfs: ['1h', '4h', '1d'] },
  ...['CAC40', 'FTSE100', 'HSI'].map((sym): Src => ({ sym, cls: 'Index', prefix: 'histdata', extra: true })),
  ...['AUDJPY', 'EURAUD', 'GBPCHF', 'CADJPY', 'AUDCAD', 'EURCAD'].map((sym): Src => ({ sym, cls: 'Forex', prefix: 'histdata', extra: true })),
  ...['XAGUSD', 'BRENT'].map((sym): Src => ({ sym, cls: 'Commodity', prefix: 'histdata', extra: true })),
];

// a market at a timeframe; `from` + `sec`: built from that file's bars (no file at this timeframe)
export type FMkt = Mkt & { extra: boolean; from?: string };
const TF_DOWN: Record<string, string[]> = { '1h': ['30m', '15m'], '4h': ['1h', '30m', '15m'], '1d': ['4h', '1h', '30m', '15m'] };
export function markets(tfs: string[], extra = false): FMkt[] {
  const out: FMkt[] = [];
  for (const tf of tfs) {
    for (const s of LIST) {
      if (!!s.extra !== extra || (s.tfs && !s.tfs.includes(tf))) continue;
      const fileOf = (t: string) => ['bin', 'json'].map((e) => path.join(DATA, `${s.prefix}_${s.file ?? s.sym}_${t}.${e}`)).find((f) => fs.existsSync(f));
      let file = fileOf(tf), from: string | undefined;
      if (!file) for (const t of TF_DOWN[tf] ?? []) if ((file = fileOf(t))) { from = file; break; }
      if (!file) continue;
      const cost = costOf({ id: `${s.prefix}_${s.file ?? s.sym}`, market: s.cls, symbol: s.file ?? s.sym });
      out.push({ id: `${s.prefix}_${s.sym}_${tf}`, sym: s.sym, cls: s.cls, tf, file, cost, histdata: s.prefix === 'histdata', extra: !!s.extra, from });
    }
  }
  return out;
}

// higher bars from lower ones (UTC buckets, like the chart's flux)
function aggregate(b: Bars, sec: number): Bars {
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  let bk = NaN;
  for (let i = 0; i < b.n; i++) {
    const k = Math.floor(b.t[i] / sec);
    if (k !== bk) { bk = k; t.push(k * sec); o.push(b.o[i]); h.push(b.h[i]); l.push(b.l[i]); c.push(b.c[i]); continue; }
    const j = t.length - 1;
    h[j] = Math.max(h[j], b.h[i]); l[j] = Math.min(l[j], b.l[i]); c[j] = b.c[i];
  }
  const f = (a: number[]) => Float64Array.from(a);
  return { t: f(t), o: f(o), h: f(h), l: f(l), c: f(c), n: t.length };
}
export const barsOf = (m: FMkt): Bars => (m.from ? aggregate(loadBars(m.from), TF_SEC[m.tf]) : loadBars(m.file));

// ---------------------------------------------------------------- the flux on the entry bars
export type Flux = {
  fast: Float64Array; slow: Float64Array;
  // +1 green (MM20 above MM50), -1 red, 0 not known yet
  st: Int8Array;
  // the first later bar where the flux is no longer this one (n - 1 if none)
  flip: Int32Array;
};
export const FLUX_TFS: Record<string, string[]> = { '5m': ['1h'], '15m': ['1h', '4h'], '1h': ['1h', '4h', '1d'], '4h': ['4h', '1d'], '1d': ['1d'] };

export function fluxOf(x: Ctx, fluxTf: string, kind = 'SMA', fastLen = 20, slowLen = 50): Flux {
  const key = `flux:${fluxTf}:${kind}:${fastLen}:${slowLen}`;
  const hit = x.cache.get(key) as Flux | undefined;
  if (hit) return hit;
  const { b, n } = x;
  const fsec = TF_SEC[fluxTf], seconds = fsec > x.tfSec ? fsec : 0;
  const fast = Float64Array.from(fluxAverage(b.t, b.c, fastLen, kind, seconds));
  const slow = Float64Array.from(fluxAverage(b.t, b.c, slowLen, kind, seconds));
  const st = new Int8Array(n);
  for (let i = 0; i < n; i++) st[i] = Number.isFinite(fast[i]) && Number.isFinite(slow[i]) ? (fast[i] >= slow[i] ? 1 : -1) : 0;
  const flip = new Int32Array(n);
  let next = n - 1;
  for (let i = n - 1; i >= 0; i--) {
    flip[i] = next;
    if (i > 0 && st[i - 1] !== st[i]) next = i;
  }
  const r = { fast, slow, st, flip };
  x.cache.set(key, r);
  return r;
}

// ---------------------------------------------------------------- the entries
// target: R multiple, or 0 for none (out when the flux turns, as every trade is)
export type Spec = {
  fam: 'flip' | 'pb' | 'fib' | 'ob' | 'fvg';
  fluxTf: string; kind?: string;
  // flip: stop in ATR; pb: 'fc' close back over the MM20 after touching it, 'sc' the same with
  // the MM50, 'lim' a limit on the MM20 once the price ran 1 ATR away; first: first pullback only
  stopAtr?: number; pb?: 'fc' | 'sc' | 'lim'; first?: boolean;
  // fib / ob: swing size; fib: retracement ratio; ob / fvg: entry at the zone's edge or middle
  k?: number; ratio?: number; at?: 'top' | 'mid'; gap?: number;
  target: number;
  // fvg, for the neighbours' check (flux-grid.ts): entry depth in the gap (0 its near edge,
  // 0.5 its middle), bars the limit waits, stop margin in ATR
  depth?: number; expire?: number; buf?: number;
};

export function keyOf(s: Spec): string {
  const p = [s.fam, `F${s.fluxTf}`];
  if (s.kind && s.kind !== 'SMA') p.push(s.kind);
  if (s.fam === 'flip') p.push(`s${s.stopAtr}`);
  if (s.fam === 'pb') p.push(s.pb!, s.first ? 'first' : 'all');
  if (s.fam === 'fib') p.push(`k${s.k}`, `r${s.ratio}`);
  if (s.fam === 'ob') p.push(`k${s.k}`, s.at!);
  if (s.fam === 'fvg') p.push(`g${s.gap}`, s.at!);
  p.push(s.target ? `${s.target}R` : 'flux');
  return p.join('|');
}

const FAM_FR: Record<Spec['fam'], string> = {
  flip: 'Entrée au changement de flux', pb: 'Retour sur le nuage', fib: 'Retracement de Fibonacci', ob: 'Order block', fvg: 'Imbalance (FVG)',
};
export function labelOf(s: Spec): string {
  const parts = [`${FAM_FR[s.fam]}, flux ${s.fluxTf}${s.kind && s.kind !== 'SMA' ? ` ${s.kind}` : ''}`];
  if (s.fam === 'flip') parts.push(`stop ${s.stopAtr} ATR`);
  if (s.fam === 'pb') parts.push(s.pb === 'fc' ? 'mèche sur la MM20, clôture au-dessus' : s.pb === 'sc' ? 'mèche sur la MM50, clôture au-dessus' : 'limite sur la MM20 après 1 ATR d’écart', s.first ? '1er retour seulement' : 'tous les retours');
  if (s.fam === 'fib') parts.push(`swing ${s.k}`, `${s.ratio! * 100} %`);
  if (s.fam === 'ob') parts.push(`swing ${s.k}`, s.at === 'top' ? 'entrée au bord' : 'entrée au milieu');
  if (s.fam === 'fvg') parts.push(`trou ≥ ${s.gap} ATR`, s.at === 'top' ? 'entrée au bord' : 'entrée au milieu');
  parts.push(s.target ? `objectif ${s.target} R` : 'sortie au changement de flux');
  return parts.join(' · ');
}

export function specs(tf: string, kind = 'SMA'): Spec[] {
  const out: Spec[] = [];
  const targets = [1, 2, 3, 0];
  for (const fluxTf of FLUX_TFS[tf]) {
    for (const stopAtr of [1.5, 3]) for (const target of [2, 3, 0]) out.push({ fam: 'flip', fluxTf, kind, stopAtr, target });
    for (const pb of ['fc', 'sc', 'lim'] as const) for (const first of [true, false]) for (const target of targets) out.push({ fam: 'pb', fluxTf, kind, pb, first, target });
    for (const k of [3, 6]) for (const ratio of [0.5, 0.618]) for (const target of targets) out.push({ fam: 'fib', fluxTf, kind, k, ratio, target });
    for (const k of [3, 6]) for (const at of ['top', 'mid'] as const) for (const target of targets) out.push({ fam: 'ob', fluxTf, kind, k, at, target });
    for (const gap of [0.1, 0.3]) for (const at of ['top', 'mid'] as const) for (const target of targets) out.push({ fam: 'fvg', fluxTf, kind, gap, at, target });
  }
  return out;
}

const tgt = (entry: number, stop: number, R: number) => (R ? entry + R * (entry - stop) : NaN);

// FLUX_THROUGH=0.05: limits fill only once the price trades 0.05 ATR past them (a check
// that the results don't come from fills on a mere touch, the bid / ask spread included)
const THROUGH = Number(process.env.FLUX_THROUGH ?? 0);
// FLUX_MODE=none: the imbalances of both sides, the flux ignored; =against: against the flux
// (what the flux brings to the imbalance entries)
const MODE = process.env.FLUX_MODE ?? 'with';
// FLUX_SIM=queue: night-lib's order-by-order fills (biased for limits, see simulateLive)
export const SIM = (x: Ctx, orders: Order[]) => (process.env.FLUX_SIM === 'queue' ? simulate(x, orders) : simulateLive(x, orders));

// the orders of a setting on these bars
export function ordersOf(x: Ctx, s: Spec): Order[] {
  const out = rawOrders(x, s);
  for (const o of out) {
    if (o.entry === undefined) continue;
    o.sized = true;
    if (THROUGH) o.through = THROUGH * x.atr[o.i];
  }
  return out;
}

function rawOrders(x: Ctx, s: Spec): Order[] {
  const { b, n, atr } = x;
  const f = fluxOf(x, s.fluxTf, s.kind);
  const { fast, slow, st, flip } = f;
  const out: Order[] = [];
  const start = Math.max(x.start, 3);
  if (s.fam === 'flip') {
    for (let i = start; i < n - 1; i++) {
      const d = st[i];
      if (!d || st[i - 1] === d || !st[i - 1]) continue;
      const stop = b.c[i] - d * s.stopAtr! * atr[i];
      out.push({ i, dir: d as 1 | -1, stop, target: tgt(b.c[i], stop, s.target), exitAt: flip[i] });
    }
    return out;
  }
  if (s.fam === 'pb') {
    let count = 0;
    for (let i = start; i < n - 1; i++) {
      const d = st[i];
      if (st[i - 1] !== d) count = 0;
      if (!d) continue;
      const buf = 0.2 * atr[i];
      // the prices seen from the flux's side: lows for a green flux, highs (negated) for a red one
      const lo = (j: number) => (d > 0 ? b.l[j] : -b.h[j]), cl = (j: number) => d * b.c[j];
      const fa = (j: number) => d * fast[j], sl = (j: number) => d * slow[j];
      let o: Order | null = null;
      if (s.pb === 'fc' && lo(i) <= fa(i) && cl(i) > fa(i) && lo(i - 1) > fa(i - 1)) {
        const stop = d * (Math.min(lo(i), sl(i)) - buf);
        o = { i, dir: d as 1 | -1, stop, target: tgt(b.c[i], stop, s.target), exitAt: flip[i] };
      } else if (s.pb === 'sc' && lo(i) <= sl(i) && cl(i) > sl(i) && lo(i - 1) > sl(i - 1)) {
        const stop = d * (lo(i) - buf);
        o = { i, dir: d as 1 | -1, stop, target: tgt(b.c[i], stop, s.target), exitAt: flip[i] };
      } else if (s.pb === 'lim' && cl(i) - fa(i) > atr[i] && !(cl(i - 1) - fa(i - 1) > atr[i - 1])) {
        const entry = fast[i], stop = d * (Math.min(sl(i), fa(i) - atr[i]) - buf);
        o = { i, dir: d as 1 | -1, entry, stop, target: tgt(entry, stop, s.target), expire: 20, exitAt: flip[i] };
      }
      if (!o) continue;
      count++;
      if (s.first && count > 1) continue;
      out.push(o);
    }
    return out;
  }
  if (s.fam === 'fib' || s.fam === 'ob') {
    const { hiAt, loAt } = swings(x, s.k!);
    for (let i = start; i < n - 1; i++) {
      const d = st[i];
      if (!d) continue;
      if (s.fam === 'fib') {
        // a new swing confirmed in the flux's direction: the leg from the last opposite swing
        const newHi = d > 0 && hiAt[i] >= 0 && hiAt[i] !== hiAt[i - 1];
        const newLo = d < 0 && loAt[i] >= 0 && loAt[i] !== loAt[i - 1];
        if (!newHi && !newLo) continue;
        const end = d > 0 ? hiAt[i] : loAt[i], origin = d > 0 ? loAt[i] : hiAt[i];
        if (origin < 0 || origin >= end) continue;
        const top = d > 0 ? b.h[end] : b.l[end], bottom = d > 0 ? b.l[origin] : b.h[origin];
        const leg = d * (top - bottom);
        if (!(leg >= atr[i])) continue;
        const entry = top - d * s.ratio! * leg;
        if (d * (b.c[i] - entry) <= 0) continue;
        const stop = bottom - d * 0.1 * atr[i];
        out.push({ i, dir: d as 1 | -1, entry, stop, target: tgt(entry, stop, s.target), expire: 30, exitAt: flip[i] });
      } else {
        // a break of structure: the first close beyond the last swing in the flux's direction
        const sw = d > 0 ? hiAt[i] : loAt[i];
        if (sw < 0) continue;
        const level = d > 0 ? b.h[sw] : b.l[sw];
        if (!(d * (b.c[i] - level) > 0 && d * (b.c[i - 1] - level) <= 0)) continue;
        // the leg's extreme since that swing, and the last opposite candle at or just before it
        let m = sw + 1;
        for (let j = sw + 1; j <= i; j++) if (d > 0 ? b.l[j] < b.l[m] : b.h[j] > b.h[m]) m = j;
        let ob = -1;
        for (let j = m; j >= Math.max(sw, m - 5); j--) if (d * (b.c[j] - b.o[j]) < 0) { ob = j; break; }
        if (ob < 0) continue;
        const far = d > 0 ? Math.min(b.l[ob], b.l[m]) : Math.max(b.h[ob], b.h[m]);
        const near = d > 0 ? b.h[ob] : b.l[ob];
        const entry = s.at === 'top' ? near : (near + far) / 2;
        if (d * (b.c[i] - entry) <= 0) continue;
        const stop = far - d * 0.1 * atr[i];
        out.push({ i, dir: d as 1 | -1, entry, stop, target: tgt(entry, stop, s.target), expire: 50, exitAt: flip[i] });
      }
    }
    return out;
  }
  // fvg: three bars, the third's low above the first's high (green flux), the middle one in the flux's direction
  for (let i = start; i < n - 1; i++) {
    const dirs = MODE === 'none' ? [1, -1] : st[i] ? [MODE === 'against' ? -st[i] : st[i]] : [];
    for (const d of dirs) {
      const gapLo = d > 0 ? b.h[i - 2] : b.l[i - 2], gapHi = d > 0 ? b.l[i] : b.h[i];
      if (!(d * (gapHi - gapLo) >= s.gap! * atr[i]) || d * (b.c[i - 1] - b.o[i - 1]) <= 0) continue;
      const entry = gapHi - (s.depth ?? (s.at === 'top' ? 0 : 0.5)) * (gapHi - gapLo);
      const far = d > 0 ? Math.min(b.l[i - 2], b.l[i - 1]) : Math.max(b.h[i - 2], b.h[i - 1]);
      const stop = far - d * (s.buf ?? 0.1) * atr[i];
      out.push({ i, dir: d as 1 | -1, entry, stop, target: tgt(entry, stop, s.target), expire: s.expire ?? 30, exitAt: MODE === 'none' ? undefined : flip[i] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the fills, bar after bar
// night-lib's simulate() takes the orders one after the other: an old limit that fills late
// keeps its turn, and a newer one that the price reached first (and that would often have
// lost, the price going on to the old one) is skipped, which is knowing the future. Here the
// bars run in time: while flat, every live order may fill, the first reached wins (a buy's
// highest limit, a sale's lowest, a market order at the open first) and the others are
// cancelled; orders given while a position is open are dropped. Same exits as simulate().
export function simulateLive(x: Ctx, orders: Order[]): Trade[] {
  const { b, n, roll } = x;
  const out: Trade[] = [];
  const lastOf = (od: Order) => (od.entry === undefined ? od.i + 1 : Math.min(n - 1, od.i + (od.expire ?? 1), od.exitAt ?? n - 1));
  let live: Order[] = [];
  let k = 0, free = 0;
  for (let j = 1; j < n; j++) {
    // the orders given up to the previous bar, while flat
    while (k < orders.length && orders[k].i < j) {
      const od = orders[k++];
      if (od.i >= free && od.i >= x.start && od.i + 1 < n) live.push(od);
    }
    if (live.length) live = live.filter((od) => j <= lastOf(od));
    if (!live.length || roll[j]) continue;
    // the order filled on this bar
    const hits: { od: Order; entry: number }[] = [];
    for (const od of live) {
      const d = od.dir;
      if (od.entry === undefined) { hits.push({ od, entry: b.o[j] }); continue; }
      const past = od.through ?? 0;
      if (d > 0 ? b.l[j] <= od.entry - past : b.h[j] >= od.entry + past) hits.push({ od, entry: d > 0 ? Math.min(b.o[j], od.entry) : Math.max(b.o[j], od.entry) });
    }
    hits.sort((a, z) => (a.od.entry === undefined ? -1 : 0) - (z.od.entry === undefined ? -1 : 0) || z.od.dir * (z.od.entry! - a.od.entry!));
    for (const { od, entry } of hits) {
      const d = od.dir, e = j;
      live = live.filter((o) => o !== od);
      const sized = od.sized && od.entry !== undefined;
      const risk = sized ? d * (od.entry! - od.stop) : d * (entry - od.stop);
      if (!(risk > 0)) continue;
      const costR = (2 * x.m.cost * entry) / risk;
      if (sized && !(d * (entry - od.stop) > 0)) {
        if (costR > MAX_COST_R) continue;
        out.push({ e, x: e, t: b.t[e], dir: d, r: -costR, costR });
        live = []; free = e;
        break;
      }
      if (costR > MAX_COST_R) continue;
      if (!Number.isNaN(od.target) && d * (od.target - entry) <= 0) continue;
      const end = Math.min(n - 1, od.exitAt ?? n - 1, od.maxBars ? e + od.maxBars - 1 : n - 1);
      let xi = -1, px = NaN, stop = od.stop, best = entry;
      for (let q = e; q <= n - 1; q++) {
        if (roll[q]) continue;
        if (d > 0 ? b.l[q] <= stop : b.h[q] >= stop) { xi = q; px = q === e ? stop : d > 0 ? Math.min(b.o[q], stop) : Math.max(b.o[q], stop); break; }
        if (!Number.isNaN(od.target)) {
          if (q > e && (d > 0 ? b.h[q] >= od.target : b.l[q] <= od.target)) { xi = q; px = d > 0 ? Math.max(b.o[q], od.target) : Math.min(b.o[q], od.target); break; }
          if (q === e && (d > 0 ? b.c[q] >= od.target : b.c[q] <= od.target)) { xi = q; px = b.c[q]; break; }
        }
        if (q >= end) { xi = q; px = b.c[q]; break; }
        if (od.trail) {
          best = d > 0 ? Math.max(best, b.h[q]) : Math.min(best, b.l[q]);
          const ts = best - d * od.trail * x.atr[q];
          if (d > 0 ? ts > stop : ts < stop) stop = ts;
        }
      }
      if (xi < 0) return out;
      out.push({ e, x: xi, t: b.t[e], dir: d, r: (d * (px - entry)) / risk - costR, costR });
      // the others cancelled; the next orders come from the exit bar on
      live = []; free = xi; j = xi;
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- one market
export type Res = { is: Acc; oos: Acc; years: Record<number, Acc> };
export type FResult = { id: string; sym: string; cls: Cls; tf: string; extra: boolean; res: Record<string, Res> };

export function tally(trades: Trade[]): Res {
  const r: Res = { is: acc(), oos: acc(), years: {} };
  for (const tr of trades) {
    add(tr.t < SPLIT ? r.is : r.oos, tr.r);
    add((r.years[new Date(tr.t * 1000).getUTCFullYear()] ??= acc()), tr.r);
  }
  return r;
}

export function runMarket(m: FMkt, list: Spec[]): FResult {
  const x = makeCtx(m, barsOf(m));
  const res: FResult['res'] = {};
  for (const s of list) res[keyOf(s)] = tally(SIM(x, ordersOf(x, s)));
  return { id: m.id, sym: m.sym, cls: m.cls, tf: m.tf, extra: m.extra, res };
}
