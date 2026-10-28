import { hhmm, zoned, type IndexFamily } from '../data/indexFamilies';
import { EM_RULE, emLevels, emRegimeOk, emTrades, type EmDay, type EmTrade } from './emRule';

// The Expected Move robot (src/robots/emRule.ts) over a whole history of 15-minute bars, as the
// study measured it (scripts/robots/em-study.ts, em-check.ts "A"): the cash sessions of the
// bars, each calibrated on the sessions before it, traded when the VIX at its open is 20 or more.
// Shared by the report (scripts/robots/em-publish.ts) and the strategy tester, so both list the
// same trades.

export type EmBtBars = { t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; n: number };
export type EmSession = { day: string; first: number; o: number[]; h: number[]; l: number[]; c: number[]; O: number; H: number; L: number; C: number; full: boolean };
// a trade with its bars in the whole history, net of costs
export type EmBtTrade = EmTrade & { day: string; entryBar: number; exitBar: number; net: number; costR: number };

// the cash sessions of the bars: the ones inside the exchange's hours, by its calendar day; a
// session counts only when its first bar starts at the open, and is "full" when it ran to the
// last hour (half days are left out, as in the study)
export function emSessions(b: EmBtBars, f: IndexFamily): EmSession[] {
  const open = hhmm(f.open), close = hhmm(f.close);
  const cache = new Map<number, { day: string; minutes: number }>();
  const local = (t: number) => {
    const hk = Math.floor(t / 3600);
    let z = cache.get(hk);
    if (!z) { z = zoned(hk * 3600, f.tz); cache.set(hk, z); }
    return { day: z.day, minutes: z.minutes + Math.floor((t % 3600) / 60) };
  };
  const out: (EmSession & { lastMin: number; ok: boolean })[] = [];
  for (let i = 0; i < b.n; i++) {
    const z = local(b.t[i]);
    if (z.minutes < open || z.minutes >= close) continue;
    let s = out[out.length - 1];
    if (!s || s.day !== z.day) {
      s = { day: z.day, first: i, o: [], h: [], l: [], c: [], O: b.o[i], H: b.h[i], L: b.l[i], C: b.c[i], full: false, lastMin: z.minutes, ok: z.minutes === open };
      out.push(s);
    }
    s.o.push(b.o[i]); s.h.push(b.h[i]); s.l.push(b.l[i]); s.c.push(b.c[i]);
    s.H = Math.max(s.H, b.h[i]); s.L = Math.min(s.L, b.l[i]); s.C = b.c[i]; s.lastMin = z.minutes;
  }
  for (const s of out) s.full = s.lastMin >= close - 60 && s.o.length >= 8;
  return out.filter((s) => s.ok).map(({ lastMin: _l, ok: _o, ...s }) => s);
}

// the VIX read at a session's open, from daily bars: its own open for the US sessions (the
// 9:30 quote), else the last close before (the European and Asian sessions open first)
export function vixReader(rows: number[][], us: boolean): (day: string) => number {
  const days = rows.map((r) => new Date(r[0] * 1000).toISOString().slice(0, 10));
  return (day) => {
    let lo = 0, hi = days.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] <= day) { at = m; lo = m + 1; } else hi = m - 1; }
    if (at < 0) return NaN;
    if (us && days[at] === day && rows[at][1] > 0) return rows[at][1];
    const prev = days[at] === day ? at - 1 : at;
    return prev >= 0 ? rows[prev][4] : NaN;
  };
}

// the robot trades from mid-2020 on: its calibration needs 141 sessions before (120 + 21 for the
// volatility), loaded from September 2019
export const EM_TRADE_FROM = Date.UTC(2020, 6, 1) / 1000;
export const EM_LOAD_FROM = Date.UTC(2019, 8, 1) / 1000;
// CME future, per side: a tick of slippage and the fees
export const EM_COST = 0.00005;

// the trades of the robot from `from` on; cost: per side, as a fraction of the price
export function emBacktest(b: EmBtBars, f: IndexFamily, vixAt: (day: string) => number, from = EM_TRADE_FROM, cost = EM_COST, rule = EM_RULE): EmBtTrade[] {
  const ss = emSessions(b, f);
  const days: EmDay[] = ss.map((s) => ({ day: s.day, o: s.O, h: s.H, l: s.L, c: s.C, full: s.full }));
  const out: EmBtTrade[] = [];
  for (let k = 0; k < ss.length; k++) {
    const s = ss[k];
    if (b.t[s.first] < from || !s.full) continue;
    if (!emRegimeOk(vixAt(s.day), rule)) continue;
    const lv = emLevels(days.slice(0, k), s.O, rule);
    if (!lv) continue;
    for (const t of emTrades({ t: [], o: s.o, h: s.h, l: s.l, c: s.c }, lv, true, rule)) {
      const costR = (2 * cost * t.entry) / Math.abs(t.entry - t.stop);
      out.push({ ...t, day: s.day, entryBar: s.first + t.entryIdx, exitBar: s.first + t.exitIdx, net: t.r - costR, costR });
    }
  }
  return out.sort((a, z) => a.entryBar - z.entryBar);
}
