import fs from 'node:fs';
import path from 'node:path';
import { COLS, readDataset } from './dataset';
import { nyOffset, parisOffset } from '../../src/robots/features';

// The price-action study of 2026-11-11: ideas the earlier studies had not tried, on indices,
// the major forex pairs and commodities, since 2020 at real costs:
//   - intraday momentum out of the "noise band" (the usual move from the open at that time of
//     day, Zarattini / Aziz / Barbon 2024), per session;
//   - daily trend following (Donchian breakouts, both sides) as a portfolio;
//   - relative strength of the 8 major currencies.
// Tuning 2020-01 → 2024-08, check 2024-09 → now. Results in robots/pa.

export const DATA = path.resolve('robots/data');
export const FROM = Date.UTC(2020, 0, 1) / 1000;
export const SPLIT = Date.UTC(2024, 8, 1) / 1000;
const WARM = 400 * 86400;

export type Cls = 'Index' | 'Forex' | 'Commodity';
export type Market = { sym: string; cls: Cls; file: string; histdata: boolean; cost: number; costFut?: number };
const M = (sym: string, cls: Cls, prefix = 'histdata', costFut?: number): Market => ({
  sym, cls, file: path.join(DATA, `${prefix}_${sym}_15m.bin`), histdata: prefix === 'histdata',
  cost: cls === 'Forex' ? 0.0001 : cls === 'Index' ? 0.0002 : 0.0003, costFut,
});
// a CME / Eurex micro future costs about 0.005 % a side (commission + half a tick), a CFD 0.02 %
export const MARKETS: Market[] = [
  M('SPX500', 'Index', 'histdata', 0.00005), M('NDX100', 'Index', 'histdata', 0.00005), M('DJI', 'Index', 'dl_ibkr', 0.00005),
  M('DAX40', 'Index', 'dl_ibkr', 0.00005), M('CAC40', 'Index'), M('FTSE100', 'Index'), M('NIKKEI', 'Index'), M('HSI', 'Index'),
  ...['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'].map((s) => M(s, 'Forex')),
  M('XAUUSD', 'Commodity', 'histdata', 0.00008), M('XAGUSD', 'Commodity'), M('BRENT', 'Commodity'),
].filter((m) => fs.existsSync(m.file));

export type Bars = { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number; roll: Uint8Array };
export function load15(m: Market): Bars {
  const { rows } = readDataset(m.file);
  const all = rows.length / COLS;
  let s = 0;
  while (s < all && rows[s * COLS] < FROM - WARM) s++;
  const n = all - s;
  const b: Bars = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), n, roll: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const k = (s + i) * COLS;
    b.t[i] = rows[k]; b.o[i] = rows[k + 1]; b.h[i] = rows[k + 2]; b.l[i] = rows[k + 3]; b.c[i] = rows[k + 4];
    // HistData's bid dips at the forex rollover: bars touching 16:45-18:15 New York are not used
    if (m.histdata) {
      const sec = (((b.t[i] + nyOffset(b.t[i])) % 86400) + 86400) % 86400;
      if (sec < 18.25 * 3600 && sec + 900 > 16.75 * 3600) b.roll[i] = 1;
    }
  }
  return b;
}

// ---------------------------------------------------------------- daily bars, cut at 17:00 New York
export type Daily = { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number; atr: Float64Array };
export function daily(b: Bars): Daily {
  const T: number[] = [], O: number[] = [], H: number[] = [], L: number[] = [], C: number[] = [];
  let day = -1, k = -1, bars = 0;
  const counts: number[] = [];
  for (let i = 0; i < b.n; i++) {
    if (b.roll[i]) continue;
    const d = Math.floor((b.t[i] + nyOffset(b.t[i]) + 7 * 3600) / 86400);
    if (d !== day) { day = d; k++; T.push(d * 86400); O.push(b.o[i]); H.push(b.h[i]); L.push(b.l[i]); C.push(b.c[i]); counts.push(bars = 0); }
    H[k] = Math.max(H[k], b.h[i]); L[k] = Math.min(L[k], b.l[i]); C[k] = b.c[i]; counts[k] = ++bars;
  }
  // Sunday evening stubs and holidays with a few bars join the next day
  const med = [...counts].sort((a, z) => a - z)[counts.length >> 1];
  const keep: number[] = [];
  for (let i = 0; i < T.length; i++) {
    if (counts[i] < med / 4 && i + 1 < T.length) { O[i + 1] = O[i]; H[i + 1] = Math.max(H[i + 1], H[i]); L[i + 1] = Math.min(L[i + 1], L[i]); continue; }
    keep.push(i);
  }
  const n = keep.length, f = (a: number[]) => Float64Array.from(keep.map((i) => a[i]));
  const d: Daily = { t: f(T), o: f(O), h: f(H), l: f(L), c: f(C), n, atr: new Float64Array(n) };
  let v = 0;
  for (let i = 0; i < n; i++) {
    const tr = i ? Math.max(d.h[i] - d.l[i], Math.abs(d.h[i] - d.c[i - 1]), Math.abs(d.l[i] - d.c[i - 1])) : d.h[i] - d.l[i];
    v = i < 20 ? (v * i + tr) / (i + 1) : (v * 19 + tr) / 20;
    d.atr[i] = v;
  }
  return d;
}

// ---------------------------------------------------------------- sessions for the noise band
export type SessionDef = { key: string; off: (t: number) => number; open: number; close: number };
const H = 3600;
export const SESSIONS: Record<string, SessionDef> = {
  us: { key: 'us', off: nyOffset, open: 9.5 * H, close: 16 * H },
  eu: { key: 'eu', off: parisOffset, open: 9 * H, close: 17.5 * H },
  jp: { key: 'jp', off: () => 9 * H, open: 9 * H, close: 15 * H },
  hk: { key: 'hk', off: () => 8 * H, open: 9.5 * H, close: 16 * H },
  // the 24-hour markets: from the London open or from the New York morning, to 16:00 New York
  ldn: { key: 'ldn', off: nyOffset, open: 3 * H, close: 16 * H },
  nym: { key: 'nym', off: nyOffset, open: 8 * H, close: 16 * H },
};
export const SESSIONS_OF = (m: Market): string[] =>
  m.cls !== 'Index' ? ['ldn', 'nym'] : ['SPX500', 'NDX100', 'DJI'].includes(m.sym) ? ['us'] : m.sym === 'NIKKEI' ? ['jp'] : m.sym === 'HSI' ? ['hk'] : ['eu'];

// each session day: its bars by slot (-1 when missing), the previous session's close
export type Sess = { def: SessionDef; slots: number; days: { date: number; idx: Int32Array; prevC: number }[] };
export function sessions(b: Bars, def: SessionDef): Sess {
  const slots = Math.round((def.close - def.open) / 900);
  const days: Sess['days'] = [];
  let cur: Sess['days'][0] | undefined, lastC = NaN;
  for (let i = 0; i < b.n; i++) {
    const local = b.t[i] + def.off(b.t[i]);
    const sec = ((local % 86400) + 86400) % 86400;
    if (sec < def.open || sec >= def.close) continue;
    const date = Math.floor(local / 86400);
    if (!cur || cur.date !== date) {
      if (cur) { const li = lastIdx(cur.idx); if (li >= 0) lastC = b.c[li]; }
      cur = { date, idx: new Int32Array(slots).fill(-1), prevC: lastC };
      days.push(cur);
    }
    cur.idx[Math.round((sec - def.open) / 900)] = i;
  }
  // full sessions only: the first and last bars present, 90 % of the bars
  return { def, slots, days: days.filter((d) => d.idx[0] >= 0 && d.idx[slots - 1] >= 0 && d.idx.filter((x) => x >= 0).length >= 0.9 * slots && Number.isFinite(d.prevC)) };
}
const lastIdx = (a: Int32Array) => { for (let j = a.length - 1; j >= 0; j--) if (a[j] >= 0) return a[j]; return -1; };

// ---------------------------------------------------------------- trades and their statistics
// r: the result in risk units, costs paid; t: the entry time; day: the day it counts in
export type Trade = { t: number; dir: number; r: number; costR: number; day: number; sym?: string };
export type Stat = { n: number; sum: number; avg: number; win: number; payoff: number; t: number };
export function stat(ts: Trade[]): Stat {
  const n = ts.length;
  if (!n) return { n: 0, sum: 0, avg: 0, win: 0, payoff: 0, t: 0 };
  let sum = 0, w = 0, gw = 0, gl = 0;
  const byDay = new Map<number, number>();
  for (const x of ts) {
    sum += x.r;
    if (x.r > 0) { w++; gw += x.r; } else gl -= x.r;
    byDay.set(x.day, (byDay.get(x.day) ?? 0) + x.r);
  }
  // t on the days' sums: trades of one day (several markets, several entries) are one draw
  const v = [...byDay.values()], m = v.reduce((a, z) => a + z, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, z) => a + (z - m) ** 2, 0) / Math.max(1, v.length - 1));
  return { n, sum, avg: sum / n, win: (100 * w) / n, payoff: w && n - w ? gw / w / (gl / (n - w)) : 0, t: sd ? (m / sd) * Math.sqrt(v.length) : 0 };
}
export const isOf = (ts: Trade[]) => ts.filter((x) => x.t < SPLIT);
export const oosOf = (ts: Trade[]) => ts.filter((x) => x.t >= SPLIT);
export function years(ts: Trade[]): string {
  const y = new Map<number, number>();
  for (const x of ts) { const k = new Date(x.t * 1000).getUTCFullYear(); y.set(k, (y.get(k) ?? 0) + x.r); }
  return [...y.keys()].sort().map((k) => `${k} ${y.get(k)! >= 0 ? '+' : ''}${y.get(k)!.toFixed(0)}`).join(' · ');
}
export const fmt = (s: Stat) => `${String(s.n).padStart(5)} tr ${(s.avg >= 0 ? '+' : '') + s.avg.toFixed(3)} R  ${s.win.toFixed(0)}% gain ${s.payoff.toFixed(2)}  t ${s.t.toFixed(1)}  somme ${s.sum.toFixed(0)}`;

export function rng(seed: number) {
  let v = seed >>> 0;
  return () => { v = (v * 1664525 + 1013904223) >>> 0; return v / 4294967296; };
}

// ---------------------------------------------------------------- the noise band (intraday momentum)
export type NbSet = { k: number; step: number; exit: 'band' | 'open' | 'eod'; side: 0 | 1 | -1; look: number; from?: number };
export const nbKey = (s: NbSet) => `k${s.k}|pas${s.step * 15}|${s.exit}|${s.side === 0 ? 'LS' : s.side > 0 ? 'L' : 'S'}|${s.look}j${s.from ? `|dès${s.from}` : ''}`;

// the average |close / open - 1| per slot over the `look` sessions before each day
export function noise(b: Bars, se: Sess, look: number): Float64Array[] {
  const { slots, days } = se;
  const out: Float64Array[] = [];
  const sum = new Float64Array(slots), cnt = new Float64Array(slots);
  const hist: Float64Array[] = [];
  for (let d = 0; d < days.length; d++) {
    const sig = new Float64Array(slots).fill(NaN);
    if (hist.length >= look) for (let j = 0; j < slots; j++) if (cnt[j] >= look * 0.8) sig[j] = sum[j] / cnt[j];
    out.push(sig);
    const mv = new Float64Array(slots).fill(NaN), O = b.o[days[d].idx[0]];
    for (let j = 0; j < slots; j++) { const i = days[d].idx[j]; if (i >= 0) { mv[j] = Math.abs(b.c[i] / O - 1); sum[j] += mv[j]; cnt[j]++; } }
    hist.push(mv);
    if (hist.length > look) { const old = hist.shift()!; for (let j = 0; j < slots; j++) if (!Number.isNaN(old[j])) { sum[j] -= old[j]; cnt[j]--; } }
  }
  return out;
}

// the trades of one market and session; `rand`: entries at random instead of at the band (the twins),
// drawn at the same slots and sides as `like`
export function nbTrades(b: Bars, se: Sess, sig: Float64Array[], s: NbSet, cost: number, like?: { slot: number; dir: number }[], rand?: () => number): Trade[] {
  const { slots, days } = se;
  const out: Trade[] = [];
  let li = 0;
  const order = like && rand ? shuffleDays(days.length, like.length, rand) : undefined;
  for (let d = 0; d < days.length; d++) {
    const D = days[d], sg = sig[d];
    const unit = 1.25 * sg[slots - 1];
    const O = b.o[D.idx[0]];
    if (!(unit > 0) || b.t[D.idx[0]] < FROM) continue;
    const up = Math.max(O, D.prevC), dn = Math.min(O, D.prevC);
    let pos = 0, entry = 0, et = 0;
    const close = (px: number) => {
      const ret = pos * (px / entry - 1) - 2 * cost;
      out.push({ t: et, dir: pos, r: ret / unit, costR: (2 * cost) / unit, day: D.date });
      pos = 0;
    };
    // the twin's entry of the day, if any
    let twin: { slot: number; dir: number } | undefined;
    if (order) { if (order[d]) twin = like![li++ % like!.length]; }
    for (let j = 0; j < slots; j++) {
      const i = D.idx[j];
      if (i < 0) continue;
      const c = b.c[i];
      if (j === slots - 1) { if (pos) close(c); break; }
      if (order) {
        if (twin && j === twin.slot && !pos) { pos = twin.dir; entry = c; et = b.t[i] + 900; }
        continue;
      }
      if ((j + 1) % s.step || Number.isNaN(sg[j])) continue;
      const U = up * (1 + s.k * sg[j]), Lo = dn * (1 - s.k * sg[j]);
      if (pos > 0 && (s.exit === 'band' ? c < U : s.exit === 'open' ? c < up : c < Lo)) close(c);
      else if (pos < 0 && (s.exit === 'band' ? c > Lo : s.exit === 'open' ? c > dn : c > U)) close(c);
      if (!pos && j >= (s.from ?? 0)) {
        if (c > U && s.side >= 0) { pos = 1; entry = c; et = b.t[i] + 900; }
        else if (c < Lo && s.side <= 0) { pos = -1; entry = c; et = b.t[i] + 900; }
        if (pos) lastSlots.push({ slot: j, dir: pos });
      }
    }
  }
  return out;
}
// the slots and sides of the last real run (for the twins)
export let lastSlots: { slot: number; dir: number }[] = [];
export const resetSlots = () => { const v = lastSlots; lastSlots = []; return v; };
function shuffleDays(nDays: number, nTrades: number, rand: () => number): Uint8Array {
  const pick = new Uint8Array(nDays);
  const p = Math.min(1, nTrades / nDays);
  for (let d = 0; d < nDays; d++) if (rand() < p) pick[d] = 1;
  return pick;
}

// ---------------------------------------------------------------- daily trend following (Donchian)
export type TrSet = { n: number; exit: 'half' | 'trail3' | 'trail5'; side: 0 | 1 | -1 };
export const trKey = (s: TrSet) => `don${s.n}|${s.exit}|${s.side === 0 ? 'LS' : s.side > 0 ? 'L' : 'S'}`;
// a CFD's overnight financing: an index, a metal or oil bought pays about 6.8 % a year (a sale 0),
// forex about 1 % a year both ways (flux-check.ts)
export const nightRate = (cls: Cls, dir: number) => (cls === 'Forex' ? 0.01 / 365 : dir > 0 ? 0.068 / 365 : 0);

// one trade from an entry at the close of day i: initial stop 2.5 ATR (the risk unit), then the
// setting's exit; returns the trade and the exit day
export function trendTrade(d: Daily, i: number, dir: number, s: TrSet, m: Market, cost: number, fin = true): { tr: Trade; x: number } | undefined {
  const entry = d.c[i], risk = 2.5 * d.atr[i];
  if (!(risk > 0)) return;
  let stop = entry - dir * risk, best = entry, px = NaN, x = -1;
  const half = Math.max(5, s.n >> 1);
  for (let q = i + 1; q < d.n; q++) {
    if (dir > 0 ? d.l[q] <= stop : d.h[q] >= stop) { x = q; px = dir > 0 ? Math.min(d.o[q], stop) : Math.max(d.o[q], stop); break; }
    if (s.exit === 'half') {
      let ext = dir > 0 ? Infinity : -Infinity;
      for (let j = q - half; j < q; j++) ext = dir > 0 ? Math.min(ext, d.l[j]) : Math.max(ext, d.h[j]);
      if (dir > 0 ? d.c[q] < ext : d.c[q] > ext) { x = q; px = d.c[q]; break; }
    } else {
      best = dir > 0 ? Math.max(best, d.c[q]) : Math.min(best, d.c[q]);
      const ts = best - dir * (s.exit === 'trail3' ? 3 : 5) * d.atr[q];
      if (dir > 0 ? ts > stop : ts < stop) stop = ts;
    }
  }
  if (x < 0) { x = d.n - 1; px = d.c[x]; }
  const costR = (2 * cost * entry) / risk + (fin ? ((d.t[x] - d.t[i]) / 86400) * nightRate(m.cls, dir) * entry / risk : 0);
  return { tr: { t: d.t[i] + 86400, dir, r: (dir * (px - entry)) / risk - costR, costR, day: d.t[i] / 86400, sym: m.sym }, x };
}
export function trendTrades(d: Daily, s: TrSet, m: Market, cost: number): Trade[] {
  const out: Trade[] = [];
  let free = 0;
  for (let i = s.n + 1; i < d.n - 1; i++) {
    if (i < free || d.t[i] < FROM) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - s.n; j < i; j++) { hi = Math.max(hi, d.h[j]); lo = Math.min(lo, d.l[j]); }
    const dir = d.c[i] > hi ? 1 : d.c[i] < lo ? -1 : 0;
    if (!dir || (s.side && dir !== s.side)) continue;
    const r = trendTrade(d, i, dir, s, m, cost);
    if (!r) continue;
    out.push(r.tr); free = r.x;
  }
  return out;
}

// ---------------------------------------------------------------- fading the noise band
// the opposite trade: a close out of the band is sold (bought under it), once a session, out at
// the session's end, or earlier when the price is back at the reference (exit 'open'), or on a
// close `stop` risk units against the entry
export type FadeSet = { k: number; exit: 'eod' | 'open'; stop: number; look: number };
export const fadeKey = (s: FadeSet) => `contre|k${s.k}|${s.exit}|stop${s.stop}`;
export function fadeTrades(b: Bars, se: Sess, sig: Float64Array[], s: FadeSet, cost: number): Trade[] {
  const { slots, days } = se;
  const out: Trade[] = [];
  for (let d = 0; d < days.length; d++) {
    const D = days[d], sg = sig[d];
    const unit = 1.25 * sg[slots - 1];
    const O = b.o[D.idx[0]];
    if (!(unit > 0) || b.t[D.idx[0]] < FROM) continue;
    const up = Math.max(O, D.prevC), dn = Math.min(O, D.prevC);
    let pos = 0, entry = 0, et = 0, done = false;
    for (let j = 0; j < slots && !done; j++) {
      const i = D.idx[j];
      if (i < 0) continue;
      const c = b.c[i];
      const last = j === slots - 1;
      if (pos) {
        const gain = pos * (c / entry - 1);
        if (last || gain <= -s.stop * unit || (s.exit === 'open' && (pos > 0 ? c >= dn : c <= up))) {
          out.push({ t: et, dir: pos, r: (gain - 2 * cost) / unit, costR: (2 * cost) / unit, day: D.date });
          done = true;
        }
        continue;
      }
      if (last || (j + 1) % 2 || Number.isNaN(sg[j])) continue;
      if (c > up * (1 + s.k * sg[j])) pos = -1; else if (c < dn * (1 - s.k * sg[j])) pos = 1;
      if (pos) { entry = c; et = b.t[i] + 900; lastSlots.push({ slot: j, dir: pos }); }
    }
  }
  return out;
}
