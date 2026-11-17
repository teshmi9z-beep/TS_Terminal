import { prepGrid, type GridPrep } from '../../src/robots/fluxGrid';
import { barsOf, simulateLive, tally, type FMkt, type Res } from './flux-lib';
import { makeCtx, SPLIT, type Ctx, type Order, type Trade } from './night-lib';

// The inverse of the flux grid (2026-11-07). Where the grid's guards keep it out (the end of a
// leg on a big level of the day / week, or a big wick or hammer there), trade the turn against
// the flux: a buy at the next open in a red flux, a sale in a green one. Stop 0.1 or 0.5 hourly ATR
// past the leg's extreme; out at the MM20 (back to the flux) or at 1 to 3 R, at the latest after
// 3 days. Each setting is checked against random entries at the same place of a leg (near its
// extreme, the close off it, the leg as big) without the signal: what the candle or the level
// adds. One position at a time (flux-lib's simulateLive), real costs, rollover bars skipped.
// 2026-11-07, later: also on 4 h and daily entries, the flux read on 4 h or the day (the
// "hourly" ATR is then the bars' own), held 10 bars at most; and every run pays a CFD's
// overnight financing, as flux-check.ts counts it.

export type RevSetting = {
  // the signal: a big wick at the leg's end, the leg's end on a big level then a close back
  // off it, a big wick on a big level, or either
  trig: 'wick' | 'level' | 'both' | 'either';
  // the wicks counted: any (5 / 15 min, 1 h, 4 h) or the 1 h and 4 h candles only
  src: 'any' | 'htf';
  // R multiple, or 0: back to the MM20
  target: number;
  // the smallest leg, in hourly ATRs from its extreme to the MM20
  zone: number;
  // the stop's margin past the leg's extreme, in hourly ATRs (wider: the costs weigh less in R)
  buf: number;
  // the flux's timeframe (1 hour unless set)
  fluxTf?: string;
};

// the flux read for each entry timeframe
const FLUX_OF: Record<string, string[]> = { '5m': ['1h'], '15m': ['1h'], '1h': ['1h'], '4h': ['4h', '1d'], '1d': ['1d'] };
const SEC: Record<string, number> = { '1h': 3600, '4h': 14400, '1d': 86400 };

export function revSettings(tf = '15m'): RevSetting[] {
  const out: RevSetting[] = [];
  for (const fluxTf of FLUX_OF[tf] ?? ['1h']) for (const trig of ['wick', 'level', 'both', 'either'] as const) for (const src of ['any', 'htf'] as const) {
    if (trig === 'level' && src === 'htf') continue;
    for (const target of [0, 1, 2, 3]) for (const zone of [1, 2]) for (const buf of [0.1, 0.5]) out.push({ trig, src, target, zone, buf, ...(fluxTf !== '1h' ? { fluxTf } : {}) });
  }
  return out;
}
export const revKey = (s: RevSetting) => `${s.trig}|${s.src}|${s.target ? `${s.target}R` : 'flux'}|z${s.zone}|s${s.buf}${s.fluxTf ? `|F${s.fluxTf}` : ''}`;
const TRIG_FR = { wick: 'grande mèche au bout de la jambe', level: 'bout de la jambe sur un gros niveau, clôture revenue au-dessus', both: 'grande mèche sur un gros niveau', either: 'grande mèche ou gros niveau' };
export function revLabel(s: RevSetting): string {
  return [
    TRIG_FR[s.trig],
    ...(s.trig === 'level' ? [] : [s.src === 'any' ? 'mèches 5 / 15 min, 1 h, 4 h' : 'mèches 1 h et 4 h seulement']),
    s.target ? `objectif ${s.target} R` : 'objectif : retour au flux (MM20)',
    `jambe d’au moins ${s.zone} ATR 1 h`,
    `stop ${String(s.buf).replace('.', ',')} ATR 1 h sous le bout de la jambe`,
    ...(s.fluxTf ? [`flux ${s.fluxTf}`] : []),
  ].join(' · ');
}

// the signals' orders and, for the random twins, the same place of a leg without a signal
export function revOrders(p: GridPrep, x: Ctx, s: RevSetting): { orders: Order[]; twins: Order[] } {
  const { n, h, l, c, fast, st, atrH, skip } = p;
  const orders: Order[] = [], twins: Order[] = [];
  const maxBars = Math.max(10, Math.round((3 * 86400) / x.tfSec));
  let d = 0, ext = NaN, extBar = -1, used = -1;
  for (let i = Math.max(p.start, x.start); i < n - 1; i++) {
    if (skip && skip[i]) continue;
    const now = st[i];
    if (now !== d) { d = now; ext = NaN; extBar = -1; }
    if (!d) continue;
    const F = fast[i];
    if (d * (c[i] - F) <= 0) { ext = NaN; extBar = -1; continue; }
    const xi = d < 0 ? l[i] : h[i];
    if (!Number.isFinite(ext) || d * (xi - ext) > 0) { ext = xi; extBar = i; }
    const a = atrH[i];
    if (!(a > 0) || !(d * (ext - F) >= s.zone * a)) continue;
    // the place: the bar went near the extreme and closed 0.25 ATR off it
    if (!(Math.abs(xi - ext) <= 0.5 * a && -d * (c[i] - ext) >= 0.25 * a)) continue;
    const dir = -d as 1 | -1;
    const stop = ext + d * s.buf * a;
    const target = s.target ? c[i] + dir * s.target * Math.abs(c[i] - stop) : F;
    const od: Order = { i, dir, stop, target, maxBars };
    const wk = s.src === 'htf' ? (d < 0 ? p.wickLoH[i] : p.wickHiH[i]) : (d < 0 ? p.wickLo[i] : p.wickHi[i]);
    const wick = Number.isFinite(wk) && Math.abs(wk - ext) <= 0.5 * a;
    const lvl = d < 0 ? p.onSup[extBar] : p.onRes[extBar];
    // the level: the close back past it (a swept support reclaimed), within 12 bars of the extreme
    const level = Number.isFinite(lvl) && i - extBar <= 12 && -d * (c[i] - lvl) >= 0;
    const sig = s.trig === 'wick' ? wick : s.trig === 'level' ? level : s.trig === 'both' ? wick && Number.isFinite(lvl) : wick || level;
    if (sig && extBar !== used) { used = extBar; orders.push(od); continue; }
    if (!wick && !Number.isFinite(lvl)) twins.push(od);
  }
  return { orders, twins };
}

// a small seeded generator (the same draws on every run)
function rng(seed: number) {
  let v = seed >>> 0;
  return () => { v = (v * 1664525 + 1013904223) >>> 0; return v / 4294967296; };
}
export const DRAWS = 30;
// per draw: R summed and count, on the tuning and the check periods
// and the costs in R summed, tuning and check
export type RevRes = Res & { rIS: [number, number][]; rOOS: [number, number][]; cost: [number, number] };
export type RevResult = { id: string; sym: string; cls: string; tf: string; extra: boolean; res: Record<string, RevRes> };

const sums = (ts: Trade[], is: boolean): [number, number] => {
  let s = 0, k = 0;
  for (const t of ts) if ((t.t < SPLIT) === is) { s += t.r; k++; }
  return [s, k];
};

// a CFD's overnight financing (flux-check.ts): per night held, the benchmark rate + 2.5 % a year
// for an index, a metal or oil bought (a sale counted as 0), about 1 % a year on forex both ways;
// taken off each trade's R, and returned in R
const NIGHT = (cls: string) => (cls === 'Forex' ? 0.01 / 365 : 0.068 / 365);
function finance(x: Ctx, trades: Trade[]): number[] {
  return trades.map((t) => {
    if (t.dir < 0 && x.m.cls !== 'Forex') return 0;
    const held = Math.floor((x.b.t[t.x] - 79200) / 86400) - Math.floor((x.b.t[t.e] - 79200) / 86400);
    const fin = (held * NIGHT(x.m.cls) * t.costR) / (2 * x.m.cost);
    t.r -= fin;
    return fin;
  });
}

export function runRevMarket(m: FMkt, list: RevSetting[]): RevResult {
  const b = barsOf(m);
  const x = makeCtx(m, b);
  const preps = new Map<string, GridPrep>();
  const prepOf = (f: string) => preps.get(f) ?? preps.set(f, prepGrid(b, { skip: x.roll, start: x.start, fluxSec: SEC[f] })).get(f)!;
  const res: RevResult['res'] = {};
  for (const s of list) {
    const p = prepOf(s.fluxTf ?? '1h');
    const { orders, twins } = revOrders(p, x, s);
    const trades = simulateLive(x, orders);
    const fin = finance(x, trades);
    const r = tally(trades) as RevRes;
    // the costs before the result: trading and financing
    r.cost = [0, 0];
    trades.forEach((t, k) => { r.cost[t.t < SPLIT ? 0 : 1] += t.costR + fin[k]; });
    r.rIS = []; r.rOOS = [];
    // random twins: as many as signals, drawn among the same places without a signal, kept in time order
    const next = rng(12345);
    for (let k = 0; k < DRAWS; k++) {
      const pick: Order[] = [];
      if (twins.length) for (let j = 0; j < orders.length; j++) pick.push(twins[Math.floor(next() * twins.length)]);
      pick.sort((u, z) => u.i - z.i);
      const ts = simulateLive(x, pick.filter((o, j) => j === 0 || o !== pick[j - 1]));
      finance(x, ts);
      r.rIS.push(sums(ts, true)); r.rOOS.push(sums(ts, false));
    }
    res[revKey(s)] = r;
  }
  return { id: m.id, sym: m.sym, cls: m.cls, tf: m.tf, extra: m.extra, res };
}
