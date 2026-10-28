import type { IndicatorConfig, Symbol } from '../types';
import type { BacktestResult, Trade } from '../strategy/types';
import { pricePrecision } from '../components/chartUtils';
import { Features, resample, toBars } from './features';
import { simulate, type LegTrade } from './engine';
import { WARMUP } from './search';
import { robotSpec } from './robotIndicator';
import { familyOf } from '../data/indexFamilies';
import { EM_COST, emBacktest, vixReader, type EmBtTrade } from './emBacktest';
import { dowBars, dowRobotTrades } from './dowBacktest';
import type { DowTrade } from './dow';

// The strategy tester's view of a lab robot: the lab's engine (3 entries per signal,
// costs per side, the forex rollover left out of HistData's bid prices), on the lab's
// own history when the robot comes from the report (the very bars and period it was
// measured on, so the trades are the report's), else on the chart's bars. Money as in
// the report: 10 000 € and 0.3 % of the capital risked on each entry.

const CAPITAL = 10_000;
const RISK = 0.003;
const PAGE = 100_000;
const LEG_NAMES = ['A fixe', 'B suiveur', 'C paliers'];
const EXIT_NAMES: Record<LegTrade['reason'], string> = { stop: 'Stop', target: 'Objectif', opposite: 'Signal contraire', end: 'Fin de l’historique' };
const REASON: Record<LegTrade['reason'], Trade['exitReason']> = { stop: 'stop', target: 'target', opposite: 'reverse', end: 'end' };

// a lab file's bars from one time to another, read by pages from the newest; Yahoo's 4h
// bars are built from its 1h file, as the lab does
export async function loadLabBars(dataset: string, from: number, to: number): Promise<number[][]> {
  const derived = /^yahoo_.*_4h$/.test(dataset);
  const id = derived ? dataset.replace(/_4h$/, '_1h') : dataset;
  const pages: Float64Array[] = [];
  let before = to + 1;
  for (let guard = 0; guard < 100; guard++) {
    const r = await fetch(`/api/data/lab/page?id=${encodeURIComponent(id)}&before=${before}&limit=${PAGE}`);
    if (!r.ok) throw new Error(`historique du labo indisponible (${r.status})`);
    const rows = new Float64Array(await r.arrayBuffer());
    if (!rows.length) break;
    pages.unshift(rows);
    if (rows[0] <= from || rows.length < PAGE * 6) break;
    before = rows[0];
  }
  const out: number[][] = [];
  for (const p of pages) for (let k = 0; k < p.length; k += 6) if (p[k] >= from && p[k] <= to) out.push(Array.from(p.subarray(k, k + 6)));
  return derived ? resample(out, 4 * 3600) : out;
}

export type RobotRunContext = { symbol: Symbol; timeframe: string; source: string; skipRollover: boolean };

export function runRobot(cfg: IndicatorConfig, rows: number[][], ctx: RobotRunContext): BacktestResult {
  const b = toBars(rows);
  const f = new Features(b);
  const sp = robotSpec(cfg);
  const allow = sp.filter.make(f), stop = sp.stop.make(f, sp.signal.id);
  const legs = simulate(b, {
    sig: sp.signal.make(f), allowLong: allow.long, allowShort: allow.short, stopLong: stop.long, stopShort: stop.short,
    dir: sp.dir, legs: sp.legs, cost: sp.cost, atr: f.atr(14), warmup: Math.min(WARMUP, Math.floor(b.n / 4)),
    skip: ctx.skipRollover ? f.rollover() : undefined,
  });

  const n = b.n;
  const booked = new Float64Array(n);
  // position changes, summed below into the position held on each bar
  const moves = new Float64Array(n + 1);
  const trades: Trade[] = [];
  let eq = CAPITAL;
  for (let k = 0; k < legs.length;) {
    const g = legs[k].group;
    // the 3 entries of a signal risk the same amount, set when it fires
    const risk = eq * RISK;
    for (; k < legs.length && legs[k].group === g; k++) {
      const t = legs[k];
      const qty = risk / t.stopDist;
      const pnl = t.r * risk;
      let best = 0, worst = 0;
      for (let j = t.entryIdx; j <= t.exitIdx; j++) {
        best = Math.max(best, (t.side > 0 ? b.h[j] - t.entry : t.entry - b.l[j]));
        worst = Math.min(worst, (t.side > 0 ? b.l[j] - t.entry : t.entry - b.h[j]));
      }
      trades.push({
        id: trades.length + 1, side: t.side > 0 ? 'long' : 'short', qty,
        entryBar: t.entryIdx, entryTime: b.t[t.entryIdx], entryPrice: t.entry, entryLabel: `${t.side > 0 ? 'Achat' : 'Vente'} ${LEG_NAMES[t.leg]}`,
        exitBar: t.exitIdx, exitTime: b.t[t.exitIdx], exitPrice: t.exit, exitLabel: EXIT_NAMES[t.reason], exitReason: REASON[t.reason],
        pnl, pricePct: ((t.exit - t.entry) / t.entry) * t.side * 100, unitGain: (t.exit - t.entry) * t.side,
        bars: t.exitIdx - t.entryIdx, mfe: best * qty, mae: worst * qty, commission: 2 * sp.cost * t.entry * qty,
      });
      booked[t.exitIdx] += pnl;
      moves[t.entryIdx] += t.side * qty;
      moves[t.exitIdx] -= t.side * qty;
      eq += pnl;
    }
  }
  // the capital of the closed entries (as the report counts it), and the position held
  const equity: number[] = new Array(n);
  const position: number[] = new Array(n);
  for (let i = 0, e = CAPITAL, p = 0; i < n; i++) {
    e += booked[i];
    p += moves[i];
    equity[i] = e;
    position[i] = Math.abs(p) < 1e-12 ? 0 : p;
  }
  return {
    strategyId: `robot:${cfg.id}`,
    strategyName: cfg.robot?.name ?? `Robot · ${sp.signal.label}`,
    ticker: ctx.symbol.ticker, timeframe: ctx.timeframe, source: ctx.source, currency: '€',
    precision: pricePrecision(ctx.symbol, n ? b.c[n - 1] : 1),
    candles: b.candles, trades, openTrade: null, equity, position, initialCapital: CAPITAL,
    warnings: [], ranAt: Date.now(),
  };
}

// The Expected Move robot (src/robots/emBacktest.ts): one entry per signal, 0.3 % of the capital,
// out at its stop, its 3 R target or the session's close; the VIX's daily bars give the regime
const EM_EXIT: Record<EmBtTrade['reason'], [string, Trade['exitReason']]> = {
  stop: ['Stop', 'stop'], objectif: ['Objectif 3 R', 'target'], 'clôture': ['Clôture de la séance', 'signal'], 'en cours': ['En cours', 'end'],
};
export function runEmRobot(cfg: IndicatorConfig, rows: number[][], vixRows: number[][], ctx: RobotRunContext): BacktestResult {
  const b = toBars(rows);
  const n = b.n;
  const fam = familyOf(ctx.symbol.ticker)?.family;
  const legs = fam ? emBacktest(b, fam, vixReader(vixRows, fam.tz === 'America/New_York')) : [];
  const booked = new Float64Array(n);
  const moves = new Float64Array(n + 1);
  const trades: Trade[] = [];
  let eq = CAPITAL;
  for (const t of legs) {
    const risk = eq * RISK, stopDist = Math.abs(t.entry - t.stop);
    const qty = risk / stopDist, pnl = t.net * risk;
    let best = 0, worst = 0;
    for (let j = t.entryBar; j <= t.exitBar; j++) {
      best = Math.max(best, t.side > 0 ? b.h[j] - t.entry : t.entry - b.l[j]);
      worst = Math.min(worst, t.side > 0 ? b.l[j] - t.entry : t.entry - b.h[j]);
    }
    const [exitLabel, exitReason] = EM_EXIT[t.reason];
    trades.push({
      id: trades.length + 1, side: t.side > 0 ? 'long' : 'short', qty,
      entryBar: t.entryBar, entryTime: b.t[t.entryBar], entryPrice: t.entry, entryLabel: t.side > 0 ? 'Achat EM' : 'Vente EM',
      exitBar: t.exitBar, exitTime: b.t[t.exitBar], exitPrice: t.exit, exitLabel, exitReason,
      pnl, pricePct: ((t.exit - t.entry) / t.entry) * t.side * 100, unitGain: (t.exit - t.entry) * t.side,
      bars: t.exitBar - t.entryBar, mfe: best * qty, mae: worst * qty, commission: 2 * EM_COST * t.entry * qty,
    });
    booked[t.exitBar] += pnl;
    moves[t.entryBar] += t.side * qty;
    moves[t.exitBar] -= t.side * qty;
    eq += pnl;
  }
  const equity: number[] = new Array(n);
  const position: number[] = new Array(n);
  for (let i = 0, e = CAPITAL, p = 0; i < n; i++) {
    e += booked[i];
    p += moves[i];
    equity[i] = e;
    position[i] = Math.abs(p) < 1e-12 ? 0 : p;
  }
  return {
    strategyId: `robot:${cfg.id}`,
    strategyName: cfg.robot?.name ?? 'Robot Expected Move',
    ticker: ctx.symbol.ticker, timeframe: ctx.timeframe, source: ctx.source, currency: '€',
    precision: pricePrecision(ctx.symbol, n ? b.c[n - 1] : 1),
    candles: b.candles, trades, openTrade: null, equity, position, initialCapital: CAPITAL,
    warnings: fam ? [] : [`${ctx.symbol.ticker} : pas un indice suivi par le robot Expected Move`], ranAt: Date.now(),
  };
}

// A Dow structure robot of the study (src/robots/dowBacktest.ts): one entry per setup, 0.3 % of
// the capital, out at its stop, its target or when the structure turns
const DOW_EXIT: Record<DowTrade['reason'], [string, Trade['exitReason']]> = {
  stop: ['Stop', 'stop'], objectif: ['Objectif', 'target'], retournement: ['Retournement de structure', 'reverse'], fin: ['En cours', 'end'],
};
export function runDowRobot(cfg: IndicatorConfig, rows: number[][], ctx: RobotRunContext & { market: string }): BacktestResult {
  const db = dowBars(rows, ctx.source, ctx.market, ctx.timeframe);
  const list = dowRobotTrades(db, cfg);
  const n = db.n;
  const candles = Array.from({ length: n }, (_, i) => ({ time: db.t[i], open: db.o[i], high: db.h[i], low: db.l[i], close: db.c[i], volume: 0 }));
  const cost = (Number(cfg.inputs?.cost) || 0) / 100;
  const booked = new Float64Array(n);
  const moves = new Float64Array(n + 1);
  const trades: Trade[] = [];
  let eq = CAPITAL;
  for (const t of list) {
    const side = t.up ? 1 : -1;
    const risk = eq * RISK, qty = risk / Math.abs(t.entry - t.stop), pnl = t.r * risk;
    let best = 0, worst = 0;
    for (let j = t.entryIdx; j <= t.exitIdx; j++) {
      best = Math.max(best, side > 0 ? db.h[j] - t.entry : t.entry - db.l[j]);
      worst = Math.min(worst, side > 0 ? db.l[j] - t.entry : t.entry - db.h[j]);
    }
    const [exitLabel, exitReason] = DOW_EXIT[t.reason];
    trades.push({
      id: trades.length + 1, side: side > 0 ? 'long' : 'short', qty,
      entryBar: t.entryIdx, entryTime: db.t[t.entryIdx], entryPrice: t.entry, entryLabel: side > 0 ? 'Achat Dow' : 'Vente Dow',
      exitBar: t.exitIdx, exitTime: db.t[t.exitIdx], exitPrice: t.exit, exitLabel, exitReason,
      pnl, pricePct: ((t.exit - t.entry) / t.entry) * side * 100, unitGain: (t.exit - t.entry) * side,
      bars: t.exitIdx - t.entryIdx, mfe: best * qty, mae: worst * qty, commission: cost * (t.entry + t.exit) * qty,
    });
    booked[t.exitIdx] += pnl;
    moves[t.entryIdx] += side * qty;
    moves[t.exitIdx] -= side * qty;
    eq += pnl;
  }
  const equity: number[] = new Array(n);
  const position: number[] = new Array(n);
  for (let i = 0, e = CAPITAL, p = 0; i < n; i++) {
    e += booked[i];
    p += moves[i];
    equity[i] = e;
    position[i] = Math.abs(p) < 1e-12 ? 0 : p;
  }
  return {
    strategyId: `robot:${cfg.id}`, strategyName: cfg.robot?.name ?? 'Robot Structure Dow',
    ticker: ctx.symbol.ticker, timeframe: ctx.timeframe, source: ctx.source, currency: '€',
    precision: pricePrecision(ctx.symbol, n ? db.c[n - 1] : 1),
    candles, trades, openTrade: null, equity, position, initialCapital: CAPITAL, warnings: [], ranAt: Date.now(),
  };
}
