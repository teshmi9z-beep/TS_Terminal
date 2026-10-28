import type { PaperTrade } from '../store/store';
import type { Trade } from '../strategy/types';
import { extremes, type Stats, type TradeFilter } from '../strategy/stats';

// The strategy tester's statistics for trades of the virtual account (the replay
// sessions): same figures, so the same dashboard shows them. Times are the
// replayed bars' times; P&L in euros, costs included.

// a replayed period: first bar traded to last bar seen (s)
export type Span = { from: number | null; to: number | null };

const REASON: Record<PaperTrade['reason'], Trade['exitReason']> = { stop: 'stop', objectif: 'target', manuel: 'signal', robot: 'signal', fin: 'end' };
const EXIT_LABEL: Record<PaperTrade['reason'], string> = { stop: 'Stop', objectif: 'Objectif', manuel: 'Manuelle', robot: 'Robot', fin: 'Fin de session' };

// in the tester's trade shape, oldest first (`ordered`: already in the order wanted)
export function toTrades(list: PaperTrade[], ordered = false): Trade[] {
  const sorted = ordered ? list : [...list].sort((a, b) => a.closedAt - b.closedAt || a.openedAt - b.openedAt);
  return sorted.map((t, i) => {
    const s = t.side === 'long' ? 1 : -1;
    return {
      id: i + 1, side: t.side, qty: t.qty,
      entryBar: 0, entryTime: t.openedAt / 1000, entryPrice: t.entry, entryLabel: t.ticker,
      exitBar: 0, exitTime: t.closedAt / 1000, exitPrice: t.exit, exitLabel: EXIT_LABEL[t.reason], exitReason: REASON[t.reason],
      pnl: t.pnl, pricePct: t.entry ? ((t.exit - t.entry) / t.entry) * 100 * s : 0, unitGain: (t.exit - t.entry) * s,
      bars: 0, mfe: 0, mae: 0, commission: 0,
    };
  });
}

// the capital after each trade, from `initial`
export function equityAfter(trades: Trade[], initial: number): number[] {
  let eq = initial;
  return [initial, ...trades.map((t) => (eq += t.pnl))];
}

// `ordered`: the trades are already in the order the capital moved (several sessions one after the other)
export function paperStats(list: PaperTrade[], initial: number, spans: Span[], filter: TradeFilter, ordered = false): Stats {
  const trades = toTrades(filter === 'all' ? list : list.filter((t) => t.side === filter), ordered);
  const total = trades.length;
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl < 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = losers.reduce((s, t) => s + t.pnl, 0);
  const netProfit = grossProfit + grossLoss;
  const curve = equityAfter(trades, initial);
  const { dd, ru } = extremes(curve);

  // time in the market: the time some position was open, over the replayed time
  const replayed = spans.reduce((s, x) => s + (x.from != null && x.to != null ? Math.max(0, x.to - x.from) : 0), 0);
  const intervals = trades.map((t) => [t.entryTime, Math.max(t.entryTime, t.exitTime)] as const).sort((a, b) => a[0] - b[0]);
  let inMarket = 0, end = -Infinity;
  for (const [a, b] of intervals) {
    if (b <= end) continue;
    inMarket += b - Math.max(a, end);
    end = b;
  }
  const days = Math.max(1, replayed / 86400);
  const froms = spans.map((x) => x.from).filter((v): v is number => v != null);
  const tos = spans.map((x) => x.to).filter((v): v is number => v != null);

  return {
    trades, total,
    wins: winners.length,
    losses: losers.length,
    neutral: total - winners.length - losers.length,
    winRate: total ? (winners.length / total) * 100 : 0,
    netProfit,
    netPct: initial ? (netProfit / initial) * 100 : 0,
    grossProfit, grossLoss,
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : grossProfit > 0 ? Infinity : 0,
    avgTrade: total ? netProfit / total : 0,
    avgWin: winners.length ? grossProfit / winners.length : 0,
    avgLoss: losers.length ? grossLoss / losers.length : 0,
    maxWin: winners.length ? Math.max(...winners.map((t) => t.pnl)) : 0,
    maxLoss: losers.length ? Math.min(...losers.map((t) => t.pnl)) : 0,
    maxDrawdown: dd,
    maxRunup: ru,
    timeInMarket: replayed > 0 ? Math.min(100, (inMarket / replayed) * 100) : total ? 100 : 0,
    ordersPerDay: (total * 2) / days,
    commission: 0,
    avgBars: 0,
    startTime: froms.length ? Math.min(...froms) : (trades[0]?.entryTime ?? 0),
    endTime: tos.length ? Math.max(...tos) : (trades[trades.length - 1]?.exitTime ?? 0),
    startEquity: initial,
    endEquity: curve[curve.length - 1],
  };
}
