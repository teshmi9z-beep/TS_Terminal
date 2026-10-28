import type { Bars } from './features';

// Robot backtest: every signal opens THREE positions (legs), each risking the same
// amount, with its own exit:
//   A "fixe"     stop and target fixed at the entry (target = tpR x the risk R)
//   B "suiveur"  trailing take profit: each time the price reaches k R the stop
//                jumps to (k-1) R (break-even first) and the target moves 1 R further;
//                the stop also follows trailK x ATR under the close
//   C "paliers"  a third closed at 1 R, 2 R and 3 R; stop to break-even after 1 R,
//                to +1 R after 2 R
// One signal (group) at a time; an opposite signal closes what is still open at the
// next open and reverses. Inside a bar the price goes open -> nearest extreme ->
// other extreme -> close (TradingView's assumption). Fees and spread are a cost per
// side as a fraction of the price. Results are in R (1 R = the leg's risk), so any
// money management can be applied afterwards.

export type LegParams = { tpR: number; trailK: number };

export type RunSpec = {
  sig: Int8Array;
  allowLong: Uint8Array; allowShort: Uint8Array;
  stopLong: Float64Array; stopShort: Float64Array;
  // 0: long and short, 1: long only, -1: short only
  dir: 0 | 1 | -1;
  legs: LegParams;
  // per side, fraction of the price
  cost: number;
  atr: Float64Array;
  warmup: number;
  // bars to ignore: no entry on them, and their prices neither stop nor fill a leg (the
  // forex rollover of bid-only histories, whose spread spike no one could trade)
  skip?: Uint8Array;
};

export type LegTrade = {
  leg: 0 | 1 | 2; group: number; side: 1 | -1;
  entryIdx: number; exitIdx: number; entry: number; stopDist: number;
  // average exit price (partial exits included), before costs
  exit: number;
  // the leg's stop when it closed (still open at the last bar: its current stop)
  stop: number;
  // net of costs, in R
  r: number;
  reason: 'stop' | 'target' | 'opposite' | 'end';
};

// ---------------------------------------------------------------- one leg

type Leg = {
  kind: 0 | 1 | 2; side: number; entry: number; R: number; stop: number;
  remaining: number; realized: number; tIdx: number; bK: number;
  closed: boolean; reason: LegTrade['reason'];
};

const C_TARGETS = [1, 2, 3];
const LEG_KINDS = [0, 1, 2] as const;

function favorable(g: Leg, p: number, tpR: number, beCost: number) {
  const { side, entry, R } = g;
  if (g.kind === 0) {
    const t = entry + side * tpR * R;
    if ((p - t) * side >= 0) { g.realized += g.remaining * tpR; g.remaining = 0; g.closed = true; g.reason = 'target'; }
  } else if (g.kind === 2) {
    while (g.tIdx < 3) {
      const k = C_TARGETS[g.tIdx];
      if ((p - (entry + side * k * R)) * side < 0) break;
      g.realized += k / 3;
      g.remaining -= 1 / 3;
      g.tIdx++;
      // break-even covers the fees
      const ns = g.tIdx === 1 ? entry + side * beCost : g.tIdx === 2 ? entry + side * R : g.stop;
      if ((ns - g.stop) * side > 0) g.stop = ns;
      if (g.tIdx === 3) { g.remaining = 0; g.closed = true; g.reason = 'target'; return; }
    }
  } else {
    while ((p - (entry + side * g.bK * R)) * side >= 0) {
      const ns = g.bK === 1 ? entry + side * beCost : entry + side * (g.bK - 1) * R;
      if ((ns - g.stop) * side > 0) g.stop = ns;
      g.bK++;
    }
  }
}

function adverse(g: Leg, p: number) {
  if ((p - g.stop) * g.side <= 0) {
    g.realized += (g.remaining * (g.stop - g.entry) * g.side) / g.R;
    g.remaining = 0; g.closed = true; g.reason = 'stop';
  }
}

// one leg of the path inside a bar; true once the leg is closed
function move(g: Leg, from: number, to: number, tpR: number, beCost: number): boolean {
  if ((to - from) * g.side > 0) favorable(g, to, tpR, beCost); else adverse(g, to);
  return g.closed;
}

// runs a leg from its entry bar; returns the exit bar (the leg object holds the result)
function runLeg(b: Bars, g: Leg, e: number, oppBar: number, lp: LegParams, atr: Float64Array, beCost: number, skip?: Uint8Array): number {
  const { o, h, l, c, n } = b;
  for (let j = e; j < n; j++) {
    const op = o[j];
    if (j === oppBar) {
      g.realized += (g.remaining * (op - g.entry) * g.side) / g.R;
      g.remaining = 0; g.closed = true; g.reason = 'opposite';
      return j;
    }
    if (skip?.[j] && j > e) continue;
    if (j > e) {
      // a gap through the stop fills at the open
      if ((op - g.stop) * g.side <= 0) {
        g.realized += (g.remaining * (op - g.entry) * g.side) / g.R;
        g.remaining = 0; g.closed = true; g.reason = 'stop';
        return j;
      }
      favorable(g, op, lp.tpR, beCost);
      if (g.closed) return j;
    }
    const highFirst = h[j] - op <= op - l[j];
    const p1 = highFirst ? h[j] : l[j], p2 = highFirst ? l[j] : h[j];
    if (move(g, op, p1, lp.tpR, beCost) || move(g, p1, p2, lp.tpR, beCost) || move(g, p2, c[j], lp.tpR, beCost)) return j;
    if (g.kind === 1) {
      const ns = c[j] - g.side * lp.trailK * atr[j];
      if (Number.isFinite(ns) && (ns - g.stop) * g.side > 0) g.stop = ns;
    }
  }
  const last = n - 1;
  g.realized += (g.remaining * (c[last] - g.entry) * g.side) / g.R;
  g.remaining = 0; g.closed = true; g.reason = 'end';
  return last;
}

// ---------------------------------------------------------------- a whole run

// index of the next bar (after i) with a signal of the given side
function nextSignal(sig: Int8Array, side: number): Int32Array {
  const n = sig.length, out = new Int32Array(n).fill(-1);
  let next = -1;
  for (let i = n - 1; i >= 0; i--) { out[i] = next; if (sig[i] === side) next = i; }
  return out;
}

const nextCache = new WeakMap<Int8Array, { up: Int32Array; dn: Int32Array }>();
function nextOf(sig: Int8Array) {
  let v = nextCache.get(sig);
  if (!v) { v = { up: nextSignal(sig, 1), dn: nextSignal(sig, -1) }; nextCache.set(sig, v); }
  return v;
}

// the legs' trades, three per signal, in time order
export function simulate(b: Bars, s: RunSpec): LegTrade[] {
  const out: LegTrade[] = [];
  const { sig, allowLong, allowShort, stopLong, stopShort, dir, legs, cost, atr } = s;
  const nx = nextOf(sig);
  let group = 0;
  for (let i = Math.max(1, s.warmup); i < b.n - 1; i++) {
    const side = sig[i];
    if (!side || (dir && side !== dir)) continue;
    if (side > 0 ? !allowLong[i] : !allowShort[i]) continue;
    const R = side > 0 ? stopLong[i] : stopShort[i];
    const e = i + 1;
    if (s.skip?.[e]) continue;
    const entry = b.o[e];
    if (!(R > 0) || !(entry > 0) || R < entry * 1e-4) continue;
    const opp = side > 0 ? nx.dn[i] : nx.up[i];
    const oppBar = opp >= 0 ? opp + 1 : -1;
    // costs in R for the round trip, and the break-even offset that pays them
    const costR = (2 * cost * entry) / R;
    const beCost = 2 * cost * entry;
    let end = e, oppHit = false;
    for (const k of LEG_KINDS) {
      const g: Leg = { kind: k, side, entry, R, stop: entry - side * R, remaining: 1, realized: 0, tIdx: 0, bK: 1, closed: false, reason: 'end' };
      const x = runLeg(b, g, e, oppBar, legs, atr, beCost, s.skip);
      out.push({ leg: k, group, side: side as 1 | -1, entryIdx: e, exitIdx: x, entry, stopDist: R, exit: entry + side * g.realized * R, stop: g.stop, r: g.realized - costR, reason: g.reason });
      if (x > end) end = x;
      if (g.reason === 'opposite') oppHit = true;
    }
    group++;
    // the opposite signal's bar opens the next group (reversal), else the bar where the last leg closed
    i = oppHit ? oppBar - 2 : end - 1;
  }
  return out;
}

// ---------------------------------------------------------------- statistics

export type Stats = {
  trades: number; groups: number; wins: number; winRate: number;
  avgWin: number; avgLoss: number; ratio: number; profitFactor: number;
  totalR: number; expectancy: number; maxDDR: number;
};

export function statsOf(trades: LegTrade[], from = 0, to = Infinity): Stats {
  let n = 0, wins = 0, sw = 0, sl = 0, cum = 0, peak = 0, dd = 0, lastGroup = -1, groups = 0;
  for (const t of trades) {
    if (t.entryIdx < from || t.entryIdx >= to) continue;
    n++;
    if (t.group !== lastGroup) { groups++; lastGroup = t.group; }
    if (t.r > 0) { wins++; sw += t.r; } else if (t.r < 0) sl += t.r;
    cum += t.r;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  const losses = n - wins;
  const avgWin = wins ? sw / wins : 0, avgLoss = losses ? -sl / losses : 0;
  return {
    trades: n, groups, wins, winRate: n ? (wins / n) * 100 : 0,
    avgWin, avgLoss, ratio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0,
    profitFactor: sl < 0 ? sw / -sl : sw > 0 ? 99 : 0,
    totalR: cum, expectancy: n ? cum / n : 0, maxDDR: dd,
  };
}

// ---------------------------------------------------------------- money management

export type MoneyMgmt = 'fixed' | 'fixedCash' | 'antiMartingale' | 'drawdown' | 'kelly' | 'equityCurve';

export const MM_LABELS: Record<MoneyMgmt, string> = {
  fixed: '0,3 % du capital par entrée',
  fixedCash: '30 € fixes par entrée',
  antiMartingale: 'Anti-martingale : 0,2 % puis +0,05 % par gain (max 0,33 %)',
  drawdown: '0,3 %, divisé par 2 sous −5 % du plus haut',
  kelly: 'Kelly ¼ sur les 30 derniers trades (0,07 à 0,33 %)',
  equityCurve: '0,3 %, 0,1 % sous la moyenne de la courbe de capital',
};

export type MoneyResult = {
  mm: MoneyMgmt; finalEquity: number; netProfit: number; netPct: number;
  maxDDPct: number; winRate: number; ratio: number; profitFactor: number; trades: number;
  // equity after each group, with its time index
  curve: [number, number][];
  pnl: number[];
};

// applies a money management rule to the legs' R results; each entry of a signal
// risks the same share of the capital
export function applyMoney(trades: LegTrade[], mm: MoneyMgmt, capital = 10_000): MoneyResult {
  let eq = capital, peak = capital, maxDD = 0, riskPct = mm === 'antiMartingale' ? 0.2 : 0.3;
  const curve: [number, number][] = [];
  const pnl: number[] = [];
  const recentR: number[] = [];
  const groupEq: number[] = [];
  let wins = 0, sw = 0, sl = 0, n = 0;
  for (let k = 0; k < trades.length;) {
    const g = trades[k].group;
    let risk: number;
    switch (mm) {
      case 'fixedCash': risk = 30; break;
      case 'antiMartingale': risk = (eq * riskPct) / 100; break;
      case 'drawdown': risk = (eq * (eq < peak * 0.95 ? 0.15 : 0.3)) / 100; break;
      case 'kelly': {
        let pct = 0.3;
        if (recentR.length >= 30) {
          const w = recentR.filter((r) => r > 0), lo = recentR.filter((r) => r <= 0);
          const W = w.length / recentR.length;
          const rr = lo.length && w.length ? (w.reduce((a, r) => a + r, 0) / w.length) / (-lo.reduce((a, r) => a + r, 0) / lo.length || 1) : 1;
          const kelly = W - (1 - W) / Math.max(0.01, rr);
          pct = Math.min(1 / 3, Math.max(0.2 / 3, (kelly * 100) / 4 / 3));
        }
        risk = (eq * pct) / 100;
        break;
      }
      case 'equityCurve': {
        const ma = groupEq.length >= 10 ? groupEq.slice(-10).reduce((a, v) => a + v, 0) / 10 : 0;
        risk = (eq * (groupEq.length >= 10 && eq < ma ? 0.1 : 0.3)) / 100;
        break;
      }
      default: risk = (eq * 0.3) / 100;
    }
    let groupPnl = 0;
    for (; k < trades.length && trades[k].group === g; k++) {
      const t = trades[k];
      const p = t.r * risk;
      pnl.push(p);
      groupPnl += p;
      eq += p;
      n++;
      if (p > 0) { wins++; sw += p; } else if (p < 0) sl += p;
      recentR.push(t.r);
      if (recentR.length > 30) recentR.shift();
      if (eq > peak) peak = eq;
      const dd = ((peak - eq) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }
    groupEq.push(eq);
    curve.push([trades[k - 1].exitIdx, eq]);
    if (mm === 'antiMartingale') riskPct = groupPnl > 0 ? Math.min(1 / 3, riskPct + 0.05) : 0.2;
  }
  const losses = n - wins;
  const avgWin = wins ? sw / wins : 0, avgLoss = losses ? -sl / losses : 0;
  return {
    mm, finalEquity: eq, netProfit: eq - capital, netPct: ((eq - capital) / capital) * 100, maxDDPct: maxDD,
    winRate: n ? (wins / n) * 100 : 0, ratio: avgLoss > 0 ? avgWin / avgLoss : 0,
    profitFactor: sl < 0 ? sw / -sl : 0, trades: n, curve, pnl,
  };
}
