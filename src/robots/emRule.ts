// The Expected Move robot (scripts/robots/em-study.ts, robots/em/EM.txt): the one rule of the
// study that held a little, shared by the "Expected Move calibré" indicator (its signals on the
// chart), the automatic mode (the virtual account) and the study's check, so all three take the
// same trades. NOT PROVEN: +0.06 R a trade on the walk-forward of 5 indices at CME costs, 4 years
// out of 5 positive, fading since 2023, not significant on the check part (t 0.8), losing at CFD
// costs.
//
// The rule: at the cash open, EM = open × realized volatility (20 sessions) / 100 / √252 and the
// average excursions above / below the open over the last 120 sessions, in EM (fu, fd). When a
// 15-minute bar of the session closes beyond open + EM × fu (or below open − EM × fd), enter with
// it at the next bar's open; stop 20 % of the EM behind the level, target 3 R, out at the session's
// close. Once per side and session, and only when the VIX at the open is 20 or more.

export const EM_RULE = { lookback: 120, rvLen: 20, stopEm: 0.2, targetR: 3, vixMin: 20 };

// a past cash session: its open, high, low, close; `full` when it ran to the usual close
export type EmDay = { day: string; o: number; h: number; l: number; c: number; full: boolean };
export type EmLevels = { em: number; vol: number; fu: number; fd: number; up: number; dn: number };
// a session's 15-minute bars, from the open
export type EmBars = { t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number> };
export type EmTrade = {
  side: 1 | -1;
  // bar indices in the session: the bar that closed beyond the level, the entry bar, the exit bar
  trigger: number; entryIdx: number; exitIdx: number;
  level: number; entry: number; stop: number; target: number; exit: number;
  reason: 'stop' | 'objectif' | 'clôture' | 'en cours';
  // gross, in R (costs left to the caller)
  r: number;
};

const SQ252 = Math.sqrt(252);
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

// realized volatility (annualized %) of the `len` returns ending with the close of days[end - 1]
function realizedAt(days: EmDay[], end: number, len: number): number {
  if (end < len + 1) return NaN;
  const r: number[] = [];
  for (let i = end - len; i < end; i++) r.push(Math.log(days[i].c / days[i - 1].c));
  return sd(r) * SQ252 * 100;
}

// the levels frozen at the open of the session that follows `days` (oldest first), opening at
// `open`; null while the history is short
export function emLevels(days: EmDay[], open: number, rule = EM_RULE): EmLevels | null {
  const vol = realizedAt(days, days.length, rule.rvLen);
  if (!(vol > 0) || !(open > 0)) return null;
  // each past session's excursions in its own EM (the volatility known at its open)
  const up: number[] = [], dn: number[] = [];
  for (let k = days.length - 1; k >= 0 && up.length < rule.lookback; k--) {
    const d = days[k];
    if (!d.full) continue;
    const v = realizedAt(days, k, rule.rvLen);
    const em = (d.o * v) / 100 / SQ252;
    if (!(em > 0)) continue;
    up.push((d.h - d.o) / em); dn.push((d.o - d.l) / em);
  }
  if (up.length < rule.lookback) return null;
  const em = (open * vol) / 100 / SQ252;
  const fu = mean(up), fd = mean(dn);
  return { em, vol, fu, fd, up: open + em * fu, dn: open - em * fd };
}

// the session's trades (one per side at most), on its bars so far: a trade still open at the
// last bar is 'en cours' when `closed` is false (the session still running)
export function emTrades(b: EmBars, lv: EmLevels, closed = true, rule = EM_RULE): EmTrade[] {
  const out: EmTrade[] = [];
  const nb = b.c.length;
  for (const u of [1, -1] as const) {
    const P = u > 0 ? lv.up : lv.dn;
    let j = 0;
    while (j < nb && !((b.c[j] - P) * u > 0)) j++;
    if (j + 1 >= nb) continue;
    const e = j + 1, entry = b.o[e], d = u;
    const stop = P - u * lv.em * rule.stopEm;
    const risk = d * (entry - stop);
    if (!(risk > 0)) continue;
    const target = entry + d * rule.targetR * risk;
    // the stop first (on the entry bar too), the target on the entry bar only if the close is past it
    let x = nb - 1, px = b.c[nb - 1], reason: EmTrade['reason'] = closed ? 'clôture' : 'en cours';
    for (let i = e; i < nb; i++) {
      if (d > 0 ? b.l[i] <= stop : b.h[i] >= stop) { x = i; px = i === e ? stop : d > 0 ? Math.min(b.o[i], stop) : Math.max(b.o[i], stop); reason = 'stop'; break; }
      if (i > e && (d > 0 ? b.h[i] >= target : b.l[i] <= target)) { x = i; px = d > 0 ? Math.max(b.o[i], target) : Math.min(b.o[i], target); reason = 'objectif'; break; }
      if (i === e && (d > 0 ? b.c[i] >= target : b.c[i] <= target)) { x = i; px = b.c[i]; reason = 'objectif'; break; }
    }
    out.push({ side: d, trigger: j, entryIdx: e, exitIdx: x, level: P, entry, stop, target, exit: px, reason, r: (d * (px - entry)) / risk });
  }
  return out;
}

// whether the robot may trade a session given the VIX read at its open
export const emRegimeOk = (vix: number, rule = EM_RULE) => vix >= rule.vixMin;
