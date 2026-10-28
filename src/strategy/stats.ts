import type { BacktestResult, Side, Trade } from './types';

export type TradeFilter = 'all' | Side;

export type Stats = {
  trades: Trade[];
  total: number;
  wins: number;
  losses: number;
  neutral: number;
  winRate: number;
  netProfit: number;
  netPct: number;
  grossProfit: number;
  grossLoss: number;
  // gross profit / gross loss
  profitFactor: number;
  avgTrade: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  maxDrawdown: number;
  maxRunup: number;
  timeInMarket: number;
  ordersPerDay: number;
  commission: number;
  avgBars: number;
  startTime: number;
  endTime: number;
  startEquity: number;
  endEquity: number;
};

export function filterTrades(trades: Trade[], f: TradeFilter) {
  return f === 'all' ? trades : trades.filter((t) => t.side === f);
}

// largest fall from a peak / rise from a trough of a value sequence
export function extremes(values: number[]) {
  let peak = -Infinity, trough = Infinity, dd = 0, ru = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    peak = Math.max(peak, v);
    trough = Math.min(trough, v);
    dd = Math.min(dd, v - peak);
    ru = Math.max(ru, v - trough);
  }
  return { dd, ru };
}

export function computeStats(res: BacktestResult, filter: TradeFilter): Stats {
  const trades = filterTrades(res.trades, filter);
  const k = res.candles;
  const total = trades.length;
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl < 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losers.reduce((s, t) => s + t.pnl, 0);
  const netProfit = grossProfit + grossLoss;

  // all trades: bar-by-bar equity (open trades valued at each close); one side: closed-trade equity
  let curve: number[];
  if (filter === 'all') curve = [res.initialCapital, ...res.equity];
  else {
    curve = [res.initialCapital];
    let eq = res.initialCapital;
    for (const t of trades) { eq += t.pnl; curve.push(eq); }
  }
  const { dd, ru } = extremes(curve);

  const inMarket = res.position.filter((p) => (filter === 'all' ? p !== 0 : filter === 'long' ? p > 0 : p < 0)).length;
  const days = k.length > 1 ? Math.max(1, (k[k.length - 1].time - k[0].time) / 86400) : 1;
  const open = res.openTrade && (filter === 'all' || res.openTrade.side === filter) ? 1 : 0;

  return {
    trades, total,
    wins: winners.length,
    losses: losers.length,
    neutral: total - winners.length - losers.length,
    winRate: total ? (winners.length / total) * 100 : 0,
    netProfit,
    netPct: (netProfit / res.initialCapital) * 100,
    grossProfit, grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : grossProfit > 0 ? Infinity : 0,
    avgTrade: total ? netProfit / total : 0,
    avgWin: winners.length ? grossProfit / winners.length : 0,
    avgLoss: losers.length ? grossLoss / losers.length : 0,
    maxWin: winners.length ? Math.max(...winners.map((t) => t.pnl)) : 0,
    maxLoss: losers.length ? Math.min(...losers.map((t) => t.pnl)) : 0,
    maxDrawdown: dd,
    maxRunup: ru,
    timeInMarket: k.length ? (inMarket / k.length) * 100 : 0,
    ordersPerDay: (total * 2 + open) / days,
    commission: trades.reduce((s, t) => s + t.commission, 0),
    avgBars: total ? trades.reduce((s, t) => s + t.bars, 0) / total : 0,
    startTime: k[0]?.time ?? 0,
    endTime: k[k.length - 1]?.time ?? 0,
    startEquity: res.initialCapital,
    endEquity: res.equity[res.equity.length - 1] ?? res.initialCapital,
  };
}

export type Period = 'day' | 'week' | 'month';

// start (UTC seconds) of the day / week (monday) / month containing t
export function periodStart(t: number, p: Period): number {
  const d = new Date(t * 1000);
  if (p === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  if (p === 'day') return day;
  return day - ((d.getUTCDay() + 6) % 7) * 86400;
}

// net P&L of the trades closed in each period ("Performance brute"), with what the
// bar's tooltip tells: its trades, winners and losers, best and worst, and the running total
export type PeriodPnl = { time: number; value: number; trades: number; wins: number; losses: number; best: number; worst: number; total: number };
export function pnlByPeriod(trades: Trade[], p: Period): PeriodPnl[] {
  const m = new Map<number, PeriodPnl>();
  for (const t of trades) {
    const key = periodStart(t.exitTime, p);
    let b = m.get(key);
    if (!b) m.set(key, (b = { time: key, value: 0, trades: 0, wins: 0, losses: 0, best: -Infinity, worst: Infinity, total: 0 }));
    b.value += t.pnl;
    b.trades++;
    if (t.pnl > 0) b.wins++; else if (t.pnl < 0) b.losses++;
    b.best = Math.max(b.best, t.pnl);
    b.worst = Math.min(b.worst, t.pnl);
  }
  const out = [...m.values()].sort((a, b) => a.time - b.time);
  let run = 0;
  for (const b of out) { run += b.value; b.total = run; }
  return out;
}

// "Performance calendaire": P&L of the trades closed each month, in % of the
// equity at the start of that month; yearly totals compounded
export function calendar(res: BacktestResult, trades: Trade[]) {
  const k = res.candles;
  // equity at the start of a month = equity at the close of the last bar before it
  const equityBefore = (t: number) => {
    let lo = 0, hi = k.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (k[mid].time < t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 ? res.equity[best] : res.initialCapital;
  };
  const months = new Map<string, { year: number; month: number; pnl: number }>();
  for (const t of trades) {
    const d = new Date(t.exitTime * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const cur = months.get(key) ?? { year: d.getUTCFullYear(), month: d.getUTCMonth(), pnl: 0 };
    cur.pnl += t.pnl;
    months.set(key, cur);
  }
  const years = new Map<number, { months: (number | null)[]; total: number }>();
  const firstYear = k.length ? new Date(k[0].time * 1000).getUTCFullYear() : new Date().getUTCFullYear();
  const lastYear = k.length ? new Date(k[k.length - 1].time * 1000).getUTCFullYear() : firstYear;
  for (let y = firstYear; y <= lastYear; y++) years.set(y, { months: new Array(12).fill(null), total: 0 });
  for (const m of months.values()) {
    const start = Date.UTC(m.year, m.month, 1) / 1000;
    const base = equityBefore(start);
    const pct = base ? (m.pnl / base) * 100 : 0;
    const y = years.get(m.year);
    if (y) y.months[m.month] = pct;
  }
  for (const y of years.values()) {
    const filled = y.months.filter((v): v is number => v != null);
    y.total = filled.length ? (filled.reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100 : 0;
  }
  return [...years.entries()].sort((a, b) => b[0] - a[0]).map(([year, v]) => ({ year, ...v }));
}
