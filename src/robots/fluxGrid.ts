import { fluxAverage } from '../indicators/custom/flux';
import { nyOffset } from './features';

// "Grille sur le flux" (2026-11-03, the user's idea). The Flux MM20 / MM50 read on 1 hour gives
// the only side: green, buys only; red, sales only. The entries are taken on 5 or 15 minutes.
// When the price, gone away from the flux, corrects back toward it, a grid of limit orders
// waits between the leg's extreme and the MM20, each order as big as or bigger than the one
// before (martingale). The basket is closed all at once at its target (the leg's extreme, or
// half-way to it) or when the flux turns to the other colour (or, as an option, at a stop
// past the cloud).
// Reversal guards (the user's second message, "on ne vend pas des supports"): no grid when the
// leg ended on a big level of the day or the week (pivot, previous day / week extreme: a
// support under sales, a resistance over buys), and none after a big wick or hammer at the
// leg's extreme on the entry bars, 1 hour or 4 hours; such a wick also stops the adding.
// Shared by the lab (scripts/robots/fluxgrid-*.ts) and the chart.

export type GridSetting = {
  // orders spread evenly from the leg's extreme to the MM20, the last one on it
  levels: number;
  // order sizes: all the same, 1-2-3-4…, or doubled each time (1-2-4-8…)
  size: 'flat' | 'lin' | 'mart';
  // target of the whole basket: the leg's extreme, or half-way from the average entry to it
  tp: 'low' | 'mid';
  // invalidation: the flux turning (the user's rule), or a stop past the cloud
  stop: 'flip' | 'cloud';
  // reversal guards: big levels of the day / week, big wicks, both
  guard: 'none' | 'level' | 'wick' | 'both';
  // where the first order sits, as a part of the way from the extreme to the MM20 (the others
  // evenly up to the MM20; default 1 / levels), and the smallest leg in 1-hour ATRs
  from?: number; zone?: number;
};

// the user's rule: 5 orders doubled each time, out at the end of the leg or when the flux turns, both guards
export const GRID_DEFAULT: GridSetting = { levels: 5, size: 'mart', tp: 'low', stop: 'flip', guard: 'both' };
// the smallest leg traded, in 1-hour ATRs between its extreme and the MM20
export const GRID_ZONE = 1;

export type GridBars = { t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number> };

export type GridPrep = {
  n: number; t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>;
  fast: number[]; slow: number[];
  // +1 green (MM20 above MM50), -1 red, 0 not known yet
  st: Int8Array;
  // ATR 14 of the entry bars, and of the finished 1-hour candles
  atr: Float64Array; atrH: Float64Array;
  // this bar's low sits on a support of the day / week (or pierced it by a little), its high
  // on a resistance; the big level's price (NaN if none)
  onSup: Float64Array; onRes: Float64Array;
  // a big lower wick finished on this bar (entry bar, 1 h or 4 h candle): its low; an upper
  // one: its high (NaN if none)
  wickLo: Float64Array; wickHi: Float64Array;
  // the same from the 1 h and 4 h candles only
  wickLoH: Float64Array; wickHiH: Float64Array;
  // bars not to trade (the lab's forex rollover)
  skip?: ArrayLike<number>;
  start: number;
};

type Cdl = { end: number; o: number; h: number; l: number; c: number };

// the higher candles, each given at the entry bar that finishes it (its last bar; or, when the
// bars have a hole, the first bar after it); the one still forming is left out
function candles(b: GridBars, n: number, step: number, key: (t: number) => number): Cdl[] {
  const out: Cdl[] = [];
  let bk = NaN, cur: Cdl | null = null;
  for (let i = 0; i < n; i++) {
    const k = key(b.t[i]);
    if (k !== bk) {
      if (cur && cur.end < 0) cur.end = i;
      cur = { end: -1, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i] };
      out.push(cur);
      bk = k;
    } else {
      cur!.h = Math.max(cur!.h, b.h[i]); cur!.l = Math.min(cur!.l, b.l[i]); cur!.c = b.c[i];
    }
    if (key(b.t[i] + step) !== k) cur!.end = i;
  }
  if (cur && cur.end < 0) out.pop();
  return out;
}

// the trading day (from 17:00 New York) and its week (from Sunday 17:00)
const dayKey = (t: number) => Math.floor((t + nyOffset(t) + 7 * 3600) / 86400);
const weekKey = (t: number) => Math.floor((dayKey(t) + 3) / 7);

function chartStep(t: ArrayLike<number>, n: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(n, 300); i++) gaps.push(t[i] - t[i - 1]);
  gaps.sort((a, z) => a - z);
  return gaps[gaps.length >> 1] || 300;
}

// fluxSec: the flux's timeframe (1 hour unless told; the chart's own bars at or above it). On
// bars of 1 hour or more, the "1-hour" ATR and candles are the bars' own
export function prepGrid(b: GridBars, opts: { skip?: ArrayLike<number>; start?: number; fluxSec?: number } = {}): GridPrep {
  const n = b.t.length, step = chartStep(b.t, n);
  const fsec = opts.fluxSec ?? 3600;
  const fast = fluxAverage(b.t, b.c, 20, 'SMA', step < fsec ? fsec : 0);
  const slow = fluxAverage(b.t, b.c, 50, 'SMA', step < fsec ? fsec : 0);
  const st = new Int8Array(n);
  for (let i = 0; i < n; i++) st[i] = Number.isFinite(fast[i]) && Number.isFinite(slow[i]) ? (fast[i] >= slow[i] ? 1 : -1) : 0;

  const atr = new Float64Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const tr = i ? Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) : b.h[i] - b.l[i];
    v = i < 14 ? (v * i + tr) / (i + 1) : (v * 13 + tr) / 14;
    atr[i] = v;
  }

  // the 1-hour ATR, known at the close of each hour
  const h1 = candles(b, n, step, (t) => Math.floor(t / 3600));
  const atrH = new Float64Array(n).fill(NaN);
  {
    let a = NaN, prev = NaN, k = 0, cur = NaN;
    for (let j = 0; j < h1.length; j++) {
      const x = h1[j];
      const tr = Number.isFinite(prev) ? Math.max(x.h - x.l, Math.abs(x.h - prev), Math.abs(x.l - prev)) : x.h - x.l;
      a = j < 14 ? ((Number.isFinite(a) ? a : 0) * j + tr) / (j + 1) : (a * 13 + tr) / 14;
      prev = x.c;
      for (; k < x.end && k < n; k++) atrH[k] = cur;
      cur = j >= 13 ? a : NaN;
    }
    for (; k < n; k++) atrH[k] = cur;
  }

  // big wicks: half the candle at least, and 0.6 hourly ATR (1.2 on 4 hours)
  const wickLo = new Float64Array(n).fill(NaN), wickHi = new Float64Array(n).fill(NaN);
  const wickLoH = new Float64Array(n).fill(NaN), wickHiH = new Float64Array(n).fill(NaN);
  const lower = (a: Float64Array, i: number, v: number) => { a[i] = Number.isFinite(a[i]) ? Math.min(a[i], v) : v; };
  const upper = (a: Float64Array, i: number, v: number) => { a[i] = Number.isFinite(a[i]) ? Math.max(a[i], v) : v; };
  const wick = (i: number, x: { o: number; h: number; l: number; c: number }, k: number, htf = false) => {
    const a = atrH[i], range = x.h - x.l;
    if (!(a > 0) || !(range > 0)) return;
    const lw = Math.min(x.o, x.c) - x.l, uw = x.h - Math.max(x.o, x.c);
    if (lw >= 0.5 * range && lw >= k * a) { lower(wickLo, i, x.l); if (htf) lower(wickLoH, i, x.l); }
    if (uw >= 0.5 * range && uw >= k * a) { upper(wickHi, i, x.h); if (htf) upper(wickHiH, i, x.h); }
  };
  for (let i = 0; i < n; i++) wick(i, { o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i] }, 0.6);
  for (const x of h1) if (x.end < n) wick(x.end, x, 0.6, true);
  for (const x of candles(b, n, step, (t) => Math.floor(t / 14400))) if (x.end < n) wick(x.end, x, 1.2, true);

  // the big levels: pivots of the day (3 days each side, kept 120 days) and of the week (2
  // weeks each side, kept 2 years), the previous day's and week's extremes; each known from
  // the close of the bar that confirms it
  type Lvl = { at: number; p: number; exp: number; side: 1 | -1 };
  const lv: Lvl[] = [];
  const days = candles(b, n, step, dayKey), weeks = candles(b, n, step, weekKey);
  const pivots = (cs: Cdl[], k: number, keep: number) => {
    for (let d = k; d + k < cs.length; d++) {
      let lo = true, hi = true;
      for (let j = 1; j <= k; j++) {
        if (!(cs[d].l < cs[d - j].l && cs[d].l <= cs[d + j].l)) lo = false;
        if (!(cs[d].h > cs[d - j].h && cs[d].h >= cs[d + j].h)) hi = false;
      }
      const at = cs[d + k].end;
      if (lo) lv.push({ at, p: cs[d].l, exp: b.t[Math.min(at, n - 1)] + keep, side: -1 });
      if (hi) lv.push({ at, p: cs[d].h, exp: b.t[Math.min(at, n - 1)] + keep, side: 1 });
    }
  };
  pivots(days, 3, 120 * 86400);
  pivots(weeks, 2, 730 * 86400);
  // the previous day / week: valid until the next one is known
  for (const cs of [days, weeks]) {
    for (let d = 0; d < cs.length; d++) {
      const until = d + 1 < cs.length ? b.t[Math.min(cs[d + 1].end, n - 1)] : Infinity;
      lv.push({ at: cs[d].end, p: cs[d].l, exp: until, side: -1 }, { at: cs[d].end, p: cs[d].h, exp: until, side: 1 });
    }
  }
  lv.sort((a, z) => a.at - z.at);
  const onSup = new Float64Array(n).fill(NaN), onRes = new Float64Array(n).fill(NaN);
  {
    let sup: Lvl[] = [], res: Lvl[] = [], k = 0, lastPrune = 0;
    for (let i = 0; i < n; i++) {
      const a = atrH[i], t = b.t[i];
      if (a > 0) {
        // the low on the support or through it by up to 1.5 ATR (a liquidity sweep)
        for (const s of sup) if (s.exp > t && s.p >= b.l[i] - 0.5 * a && s.p <= b.l[i] + 1.5 * a) { onSup[i] = s.p; break; }
        for (const r of res) if (r.exp > t && r.p <= b.h[i] + 0.5 * a && r.p >= b.h[i] - 1.5 * a) { onRes[i] = r.p; break; }
      }
      // the levels known from this bar's close on
      for (; k < lv.length && lv[k].at <= i; k++) (lv[k].side < 0 ? sup : res).push(lv[k]);
      if (t - lastPrune > 86400) { sup = sup.filter((s) => s.exp > t); res = res.filter((r) => r.exp > t); lastPrune = t; }
    }
  }

  let start = Math.max(opts.start ?? 0, 60);
  while (start < n && !st[start]) start++;
  return { n, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, fast, slow, st, atr, atrH, onSup, onRes, wickLo, wickHi, wickLoH, wickHiH, skip: opts.skip, start };
}

export function sizesOf(s: GridSetting): number[] {
  return Array.from({ length: s.levels }, (_, k) => (s.size === 'flat' ? 1 : s.size === 'lin' ? k + 1 : 2 ** k));
}

export type Basket = {
  dir: 1 | -1;
  // first fill and exit bars, their times
  i0: number; i1: number; t0: number; t1: number;
  // the grid's prices and sizes (NaN: a level the price had already passed), the orders filled
  levels: number[]; qty: number[]; fills: { i: number; k: number; p: number }[];
  // the leg's extreme, the reference invalidation price (past the cloud), the target at the exit
  ext: number; ref: number; tp: number;
  avg: number; exit: number; why: 'tp' | 'stop' | 'flip' | 'end';
  // a big wick stopped the adding
  cut: boolean;
  // R: the basket's result over what it loses if every order fills and the price reaches `ref`
  r: number; costR: number;
};

// what the robot does after the last bar: the orders waiting, the basket open, why it waits
export type GridLive = { dir: number; levels: number[]; ext: number; basket: Basket | null; blocked: '' | 'level' | 'wick' | 'zone' | 'side'; at: number };
// a leg the guards kept out: its extreme's bar and price, and why (for the chart)
export type GridBlock = { i: number; price: number; why: 'level' | 'wick'; dir: number };

// the grid traded bar after bar; cost: the venue's cost a side, as a fraction of the price
export function runGrid(p: GridPrep, s: GridSetting, cost: number, through = 0.05): { baskets: Basket[]; live: GridLive; blocks: GridBlock[] } {
  const { n, o, h, l, c, fast, slow, st, atr, atrH, skip } = p;
  const Q = sizesOf(s), N = s.levels;
  const useLevel = s.guard === 'level' || s.guard === 'both', useWick = s.guard === 'wick' || s.guard === 'both';
  const out: Basket[] = [], blocks: GridBlock[] = [];
  const block = (why: GridBlock['why']) => {
    blocked = why;
    const last = blocks[blocks.length - 1];
    if (!last || last.i !== extBar) blocks.push({ i: extBar, price: ext, why, dir: d });
  };
  let d = 0, ext = NaN, extBar = -1, wickBlock = NaN;
  let pend: { levels: number[]; ext: number; ref: number } | null = null;
  let bk: Basket | null = null;
  let blocked: GridLive['blocked'] = '';
  const close = (x: Basket, i: number, px: number, why: Basket['why']) => {
    x.i1 = i; x.t1 = p.t[i]; x.exit = px; x.why = why;
    let pnl = 0, fees = 0;
    for (const f of x.fills) { pnl += x.qty[f.k] * x.dir * (px - f.p); fees += x.qty[f.k] * cost * (f.p + px); }
    let risk = 0;
    for (let k = 0; k < N; k++) if (Number.isFinite(x.levels[k])) risk += x.qty[k] * Math.abs(x.ref - x.levels[k]);
    x.r = (pnl - fees) / risk; x.costR = fees / risk;
    out.push(x);
    bk = null;
  };
  const avgOf = (x: Basket) => {
    let q = 0, v = 0;
    for (const f of x.fills) { q += x.qty[f.k]; v += x.qty[f.k] * f.p; }
    return v / q;
  };
  const tpOf = (x: Basket) => (s.tp === 'low' ? x.ext : (x.avg + x.ext) / 2);
  // the orders of the basket the price reached on bar i (sales on the way up, buys on the way down)
  const fillLevels = (x: Basket, i: number, thr: number) => {
    for (let k = 0; k < N; k++) {
      const lv = x.levels[k];
      if (!Number.isFinite(lv) || x.fills.some((f) => f.k === k)) continue;
      if (x.dir < 0 ? h[i] >= lv + thr : l[i] <= lv - thr) x.fills.push({ i, k, p: x.dir < 0 ? Math.max(o[i], lv) : Math.min(o[i], lv) });
    }
    x.avg = avgOf(x);
  };

  for (let i = p.start; i < n; i++) {
    const sk = skip ? skip[i] : 0;
    const thr = through * atr[i - 1];
    // ---- during the bar: the orders given at the previous close
    if (!sk) {
      if (bk) {
        const x: Basket = bk;
        if (s.stop === 'cloud' && (x.dir < 0 ? h[i] >= x.ref : l[i] <= x.ref)) {
          // on its way to the stop the price takes the orders left below it
          if (!x.cut) fillLevels(x, i, 0);
          close(x, i, x.dir < 0 ? Math.max(o[i], x.ref) : Math.min(o[i], x.ref), 'stop');
        } else {
          const tp = tpOf(x);
          if (x.dir < 0 ? l[i] <= tp - thr : h[i] >= tp + thr) close(x, i, x.dir < 0 ? Math.min(o[i], tp) : Math.max(o[i], tp), 'tp');
          else if (!x.cut) fillLevels(x, i, thr);
        }
      } else if (pend) {
        const x: Basket = {
          dir: d as 1 | -1, i0: i, i1: -1, t0: p.t[i], t1: 0, levels: pend.levels, qty: Q, fills: [],
          ext: pend.ext, ref: pend.ref, tp: NaN, avg: NaN, exit: NaN, why: 'end', cut: false, r: 0, costR: 0,
        };
        fillLevels(x, i, thr);
        if (x.fills.length) {
          bk = x; pend = null;
          if (s.stop === 'cloud' && (x.dir < 0 ? h[i] >= x.ref : l[i] <= x.ref)) {
            fillLevels(x, i, 0);
            close(x, i, x.dir < 0 ? Math.max(o[i], x.ref) : Math.min(o[i], x.ref), 'stop');
          }
        }
      }
    }
    // ---- at the close: the flux, the leg, the guards, the grid for the next bar
    const now = st[i];
    if (bk && now !== bk.dir && !sk) close(bk, i, c[i], 'flip');
    const hadBasket = !bk && out.length && out[out.length - 1].i1 === i;
    if (now !== d) { d = now; ext = NaN; extBar = -1; wickBlock = NaN; }
    pend = null;
    blocked = '';
    if (!d || sk) continue;
    if (bk) {
      // a big wick against the basket (a lower one under sales): no more adding
      if (useWick && Number.isFinite(d < 0 ? p.wickLo[i] : p.wickHi[i])) bk.cut = true;
      continue;
    }
    const F = fast[i];
    // the leg: from the price's side of the MM20 only; a new one after each basket
    if (d * (c[i] - F) <= 0) { ext = NaN; extBar = -1; wickBlock = NaN; blocked = 'side'; continue; }
    const xi = d < 0 ? l[i] : h[i];
    if (hadBasket || !Number.isFinite(ext) || d * (xi - ext) > 0) {
      ext = xi; extBar = i;
      if (Number.isFinite(wickBlock) && d * (xi - wickBlock) > 0) wickBlock = NaN;
    }
    const w = d < 0 ? p.wickLo[i] : p.wickHi[i];
    if (useWick && Number.isFinite(w) && Math.abs(w - ext) <= 0.5 * atrH[i]) wickBlock = Number.isFinite(wickBlock) ? (d < 0 ? Math.min(wickBlock, w) : Math.max(wickBlock, w)) : w;
    const zone = d * (ext - F);
    if (!(zone >= (s.zone ?? GRID_ZONE) * atrH[i])) { blocked = 'zone'; continue; }
    if (useWick && Number.isFinite(wickBlock)) { block('wick'); continue; }
    if (useLevel && Number.isFinite(d < 0 ? p.onSup[extBar] : p.onRes[extBar])) { block('level'); continue; }
    // the orders: from the extreme to the MM20; those the price already passed are left out
    const levels: number[] = [], from = s.from ?? 1 / N;
    for (let k = 0; k < N; k++) {
      const lv = ext - d * zone * (N > 1 ? from + ((1 - from) * k) / (N - 1) : 1);
      levels.push(d * (c[i] - lv) > 0 ? lv : NaN);
    }
    if (!levels.some(Number.isFinite)) continue;
    const ref = d < 0 ? Math.max(F, slow[i]) + 0.5 * atrH[i] : Math.min(F, slow[i]) - 0.5 * atrH[i];
    pend = { levels, ext, ref };
  }
  const live: GridLive = { dir: d, levels: pend?.levels ?? [], ext, basket: bk, blocked, at: n - 1 };
  if (bk) {
    const x: Basket = bk;
    x.tp = tpOf(x);
  }
  return { baskets: out, live, blocks };
}
