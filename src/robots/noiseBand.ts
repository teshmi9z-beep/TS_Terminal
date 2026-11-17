import { nyOffset } from './features';

// The noise band (Zarattini, Aziz, Barbon 2024), the one idea of the price-action study of
// 2026-11-11 that held a little (robots/pa/PRICE-ACTION.md): intraday momentum out of the usual
// move from the open. Shared by the "Bande de bruit" indicator, the strategy tester, the
// automatic mode (the virtual account) and the report, so all take the same trades.
// NOT PROVEN: +0.03 R a trade on the walk-forward 2022-2026 (t 1.8), 2025 negative, and only
// at tight costs (a micro future, or a CFD in the market's main hours).
//
// The rule: for each bar of the session, the noise is the average |close / open - 1| at that
// time of day over the 14 full sessions before. The band is the reference (the session's open
// or the previous session's close, whichever is further out) ± k × noise. Every 30 minutes,
// the first close out of the band is followed at the next bar's open, once a session. The unit
// is the session's usual move (1.25 × the average |open → close| of those sessions). The stop
// sits 2 units behind the entry (1 R: tighter stops cost more than they save); two entries:
// A out at +1 unit (+0.5 R), B at the session's end. Nothing is held overnight.

export const NB_RULE = { look: 14, k: 1.25, decision: 1800, targetU: 1, stopU: 2 };
export type NbRule = typeof NB_RULE;

// the sessions, in New York time (seconds of the day)
export type NbSessionKey = 'us' | 'nym' | 'ldn';
export const NB_SESSIONS: Record<NbSessionKey, { label: string; open: number; close: number }> = {
  us: { label: 'Wall Street, 9 h 30 – 16 h New York', open: 9.5 * 3600, close: 16 * 3600 },
  nym: { label: 'New York, 8 h – 16 h', open: 8 * 3600, close: 16 * 3600 },
  ldn: { label: 'Londres → New York, 3 h – 16 h New York', open: 3 * 3600, close: 16 * 3600 },
};

// the markets the walk-forward kept longest, each with its session, its lab file and what a
// tight venue takes per side (scripts/robots/pa-check-costs.ts, to be checked on the account)
export type NbMarket = { id: string; name: string; symbol: string; tickers: string[]; live: string; market: string; dataset: string; source: string; session: NbSessionKey; cost: number };
export const NB_MARKETS: NbMarket[] = [
  { id: 'nb_NDX100', name: 'Nasdaq 100', symbol: 'NDX100', tickers: ['NDX100', 'US100', 'QQQ'], live: 'US100', market: 'Index', dataset: 'histdata_NDX100_15m', source: 'HistData', session: 'us', cost: 0.00004 },
  { id: 'nb_SPX500', name: 'S&P 500', symbol: 'SPX500', tickers: ['SPX500', 'US500', 'SPY'], live: 'US500', market: 'Index', dataset: 'histdata_SPX500_15m', source: 'HistData', session: 'us', cost: 0.00004 },
  { id: 'nb_XAUUSD', name: 'Or', symbol: 'XAUUSD', tickers: ['XAUUSD', 'GOLD'], live: 'XAUUSD', market: 'Commodity', dataset: 'histdata_XAUUSD_15m', source: 'HistData', session: 'nym', cost: 0.00008 },
  { id: 'nb_USDJPY', name: 'USDJPY', symbol: 'USDJPY', tickers: ['USDJPY'], live: 'USDJPY', market: 'Forex', dataset: 'histdata_USDJPY_15m', source: 'HistData', session: 'ldn', cost: 0.00004 },
];
export const nbMarketOf = (ticker: string) => NB_MARKETS.find((m) => m.tickers.includes(ticker));

export type NbBars = { t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; n: number };

// a session day: its bars by slot (-1 when missing), the previous session's last close, and
// whether it ran from the first bar to the last with 90 % of its bars
export type NbDay = { date: number; idx: Int32Array; prevC: number; full: boolean };
export type NbSess = { slots: number; step: number; days: NbDay[] };

// the sessions of the bars; step: the bars' length in seconds (300, 900 or 1800)
export function nbSessions(b: NbBars, key: NbSessionKey, step = 900): NbSess {
  const def = NB_SESSIONS[key];
  const slots = Math.round((def.close - def.open) / step);
  const days: NbDay[] = [];
  let cur: NbDay | undefined, lastC = NaN, off = 0, offUntil = -1;
  const close = (d: NbDay) => {
    let got = 0, last = -1;
    for (let j = 0; j < slots; j++) if (d.idx[j] >= 0) { got++; last = d.idx[j]; }
    d.full = d.idx[0] >= 0 && d.idx[slots - 1] >= 0 && got >= 0.9 * slots;
    if (last >= 0) lastC = b.c[last];
  };
  for (let i = 0; i < b.n; i++) {
    const t = b.t[i];
    // the New York offset changes twice a year: read once an hour
    if (t >= offUntil) { off = nyOffset(t); offUntil = (Math.floor(t / 3600) + 1) * 3600; }
    const local = t + off;
    const sec = ((local % 86400) + 86400) % 86400;
    if (sec < def.open || sec >= def.close) continue;
    const date = Math.floor(local / 86400);
    if (!cur || cur.date !== date) {
      if (cur) close(cur);
      cur = { date, idx: new Int32Array(slots).fill(-1), prevC: lastC, full: false };
      days.push(cur);
    }
    const j = Math.round((sec - def.open) / step);
    if (j < slots) cur.idx[j] = i;
  }
  if (cur) close(cur);
  return { slots, step, days };
}

// the noise of each day: per slot, the average |close / open - 1| over the `look` full sessions
// before it (NaN while the history is short)
export function nbNoise(b: NbBars, se: NbSess, look = NB_RULE.look): Float64Array[] {
  const { slots, days } = se;
  const out: Float64Array[] = [];
  const sum = new Float64Array(slots), cnt = new Float64Array(slots);
  const hist: Float64Array[] = [];
  for (const D of days) {
    const sig = new Float64Array(slots).fill(NaN);
    if (hist.length >= look) for (let j = 0; j < slots; j++) if (cnt[j] >= look * 0.8) sig[j] = sum[j] / cnt[j];
    out.push(sig);
    if (!D.full) continue;
    const mv = new Float64Array(slots).fill(NaN), O = b.o[D.idx[0]];
    for (let j = 0; j < slots; j++) { const i = D.idx[j]; if (i >= 0) { mv[j] = Math.abs(b.c[i] / O - 1); sum[j] += mv[j]; cnt[j]++; } }
    hist.push(mv);
    if (hist.length > look) { const old = hist.shift()!; for (let j = 0; j < slots; j++) if (!Number.isNaN(old[j])) { sum[j] -= old[j]; cnt[j]--; } }
  }
  return out;
}

// a day's band: the two references and, per slot, the upper and lower edges
export type NbBand = { up: number; dn: number; unit: number; hi: Float64Array; lo: Float64Array };
export function nbBand(b: NbBars, se: NbSess, D: NbDay, sig: Float64Array, k = NB_RULE.k): NbBand | null {
  if (D.idx[0] < 0 || !Number.isFinite(D.prevC)) return null;
  const unit = 1.25 * sig[se.slots - 1];
  if (!(unit > 0)) return null;
  const O = b.o[D.idx[0]];
  const up = Math.max(O, D.prevC), dn = Math.min(O, D.prevC);
  const hi = new Float64Array(se.slots), lo = new Float64Array(se.slots);
  for (let j = 0; j < se.slots; j++) { hi[j] = up * (1 + k * sig[j]); lo[j] = dn * (1 - k * sig[j]); }
  return { up, dn, unit, hi, lo };
}

// one of the two entries of a signal; r: gross, in R (costs left to the caller)
export type NbLeg = { leg: 0 | 1; exitBar: number; exit: number; reason: 'stop' | 'objectif' | 'clôture' | 'en cours'; r: number };
export type NbTrade = {
  side: 1 | -1; date: number;
  // bars in the whole history: the bar that closed out of the band, the entry bar
  trigger: number; entryBar: number;
  entry: number; risk: number; stop: number; target: number;
  legs: [NbLeg, NbLeg];
};

// the day's trade, if any, on its bars so far; `closed`: the session is over (else a leg
// still open at the last bar is 'en cours')
export function nbDayTrade(b: NbBars, se: NbSess, D: NbDay, band: NbBand, closed = true, rule: NbRule = NB_RULE): NbTrade | null {
  const { slots, step } = se;
  const every = Math.max(1, Math.round(rule.decision / step));
  for (let j = 0; j < slots - 1; j++) {
    const i = D.idx[j];
    if (i < 0 || (j + 1) % every || Number.isNaN(band.hi[j])) continue;
    const c = b.c[i];
    const side = c > band.hi[j] ? 1 : c < band.lo[j] ? -1 : 0;
    if (!side) continue;
    // the entry: the next bar of the session, at its open
    let e = -1, ej = j + 1;
    for (; ej < slots; ej++) if (D.idx[ej] >= 0) { e = D.idx[ej]; break; }
    if (e < 0) return null;
    const entry = b.o[e], risk = rule.stopU * band.unit * entry;
    const stop = entry - side * risk;
    const target = entry + side * rule.targetU * band.unit * entry;
    let lastBar = e;
    for (let q = slots - 1; q >= ej; q--) if (D.idx[q] >= 0) { lastBar = D.idx[q]; break; }
    const legs = ([0, 1] as const).map((leg): NbLeg => {
      for (let q = ej; q < slots; q++) {
        const x = D.idx[q];
        if (x < 0) continue;
        // the stop first, then the target (leg A only)
        if (side > 0 ? b.l[x] <= stop : b.h[x] >= stop) {
          const px = x === e ? stop : side > 0 ? Math.min(b.o[x], stop) : Math.max(b.o[x], stop);
          return { leg, exitBar: x, exit: px, reason: 'stop', r: (side * (px - entry)) / risk };
        }
        if (leg === 0 && (side > 0 ? b.h[x] >= target : b.l[x] <= target)) {
          const px = x === e ? target : side > 0 ? Math.max(b.o[x], target) : Math.min(b.o[x], target);
          return { leg, exitBar: x, exit: px, reason: 'objectif', r: (side * (px - entry)) / risk };
        }
      }
      const px = b.c[lastBar];
      return { leg, exitBar: lastBar, exit: px, reason: closed ? 'clôture' : 'en cours', r: (side * (px - entry)) / risk };
    }) as [NbLeg, NbLeg];
    return { side, date: D.date, trigger: i, entryBar: e, entry, risk, stop, target, legs };
  }
  return null;
}

// the robot trades from 2020 on; its noise needs 14 sessions before, loaded from November 2019
export const NB_TRADE_FROM = Date.UTC(2020, 0, 1) / 1000;
export const NB_LOAD_FROM = Date.UTC(2019, 10, 1) / 1000;

// a trade over a whole history, with its cost in R (per entry) taken off each leg's net
export type NbBtTrade = NbTrade & { costR: number; net: [number, number] };
export function nbBacktest(b: NbBars, key: NbSessionKey, cost: number, from = NB_TRADE_FROM, rule: NbRule = NB_RULE, step = 900): NbBtTrade[] {
  const se = nbSessions(b, key, step);
  const noise = nbNoise(b, se, rule.look);
  const out: NbBtTrade[] = [];
  for (let d = 0; d < se.days.length; d++) {
    const D = se.days[d];
    if (!D.full || b.t[D.idx[0]] < from) continue;
    const band = nbBand(b, se, D, noise[d], rule.k);
    if (!band) continue;
    const t = nbDayTrade(b, se, D, band, true, rule);
    if (!t) continue;
    const costR = (2 * cost * t.entry) / t.risk;
    out.push({ ...t, costR, net: [t.legs[0].r - costR, t.legs[1].r - costR] });
  }
  return out;
}

// ---------------------------------------------------------------- settings shared by the indicator, the tester and the automatic mode
export const NB_AUTO = 'Auto (selon le marché)';
export const NB_SESSION_LABELS = [NB_AUTO, ...Object.values(NB_SESSIONS).map((s) => s.label)];
// the session of a chart: the one chosen, else the market's (its study's, else by its class)
export function nbSessionOf(label: unknown, ticker: string, category?: string): NbSessionKey {
  const hit = (Object.keys(NB_SESSIONS) as NbSessionKey[]).find((k) => NB_SESSIONS[k].label === label);
  if (hit) return hit;
  return nbMarketOf(ticker)?.session ?? (category === 'Indices' ? 'us' : category === 'Forex' ? 'ldn' : 'nym');
}
// the rule with an indicator's settings
export function nbRuleOf(inputs: Record<string, number | string | boolean> | undefined): NbRule {
  const num = (key: string, d: number, lo: number, hi: number) => { const v = Number(inputs?.[key]); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
  return { ...NB_RULE, k: num('k', NB_RULE.k, 0.1, 5), look: Math.round(num('look', NB_RULE.look, 5, 60)), stopU: num('stopU', NB_RULE.stopU, 0.25, 10), targetU: num('targetU', NB_RULE.targetU, 0.1, 10) };
}
// the cost per side (fraction of the price) from the setting in % (the market's tight cost when unset)
export function nbCostOf(inputs: Record<string, number | string | boolean> | undefined, ticker: string): number {
  const v = Number(inputs?.cost);
  return Number.isFinite(v) && v >= 0 ? v / 100 : nbMarketOf(ticker)?.cost ?? 0.00005;
}
