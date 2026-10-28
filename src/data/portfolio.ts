import type { Candle, Symbol } from '../types';
import type { Portfolio, PortfolioTx } from '../store/store';
import { openFeed } from './feeds';

// Holdings of a portfolio from its transactions (average cost method), and its value over time.

export type Holding = { symbol: Symbol; qty: number; avgCost: number; cost: number; realized: number; fees: number };

const byDate = (a: PortfolioTx, b: PortfolioTx) => a.date - b.date;

export function holdingsOf(p: Portfolio, until = Infinity): Holding[] {
  const map = new Map<string, Holding>();
  for (const t of [...p.transactions].sort(byDate)) {
    if (t.date > until) break;
    const h = map.get(t.symbol.ticker) ?? { symbol: t.symbol, qty: 0, avgCost: 0, cost: 0, realized: 0, fees: 0 };
    h.fees += t.fee;
    if (t.side === 'buy') {
      h.cost += t.qty * t.price + t.fee;
      h.qty += t.qty;
      h.avgCost = h.qty > 0 ? h.cost / h.qty : 0;
    } else {
      const q = Math.min(t.qty, h.qty);
      h.realized += (t.price - h.avgCost) * q - t.fee;
      h.cost -= h.avgCost * q;
      h.qty -= q;
      if (h.qty <= 1e-12) { h.qty = 0; h.cost = 0; }
    }
    map.set(t.symbol.ticker, h);
  }
  return [...map.values()];
}

// daily bars of each symbol, kept for the session
const daily = new Map<string, Promise<Candle[]>>();
function dailyBars(sym: Symbol): Promise<Candle[]> {
  let p = daily.get(sym.ticker);
  if (!p) {
    p = openFeed(sym, '1D').then(async ({ session, candles }) => {
      let k = candles;
      // enough history for old transactions
      for (let i = 0; i < 4 && session.hasMore; i++) {
        const older = await session.loadOlder();
        const add = older.filter((c) => c.time < (k[0]?.time ?? Infinity));
        if (!add.length) break;
        k = [...add, ...k];
      }
      return k;
    });
    daily.set(sym.ticker, p);
    p.catch(() => daily.delete(sym.ticker));
  }
  return p;
}

export type ValuePoint = { time: number; value: number; invested: number };

// value of the holdings at each daily close since the first transaction (and the money put in)
export async function valueHistory(p: Portfolio): Promise<ValuePoint[]> {
  const txs = [...p.transactions].sort(byDate);
  if (!txs.length) return [];
  const syms = [...new Map(txs.map((t) => [t.symbol.ticker, t.symbol])).values()];
  const bars = await Promise.all(syms.map((s) => dailyBars(s).catch(() => [] as Candle[])));
  const first = Math.floor(txs[0].date / 1000 / 86400) * 86400;
  const times = [...new Set(bars.flat().map((c) => c.time).filter((t) => t >= first))].sort((a, b) => a - b);
  const idx = syms.map(() => 0);
  const out: ValuePoint[] = [];
  for (const t of times) {
    // transactions up to the end of that day
    const hs = holdingsOf(p, (t + 86400) * 1000 - 1);
    let value = 0, invested = 0;
    syms.forEach((s, i) => {
      const k = bars[i];
      while (idx[i] + 1 < k.length && k[idx[i] + 1].time <= t) idx[i]++;
      const close = k[idx[i]] && k[idx[i]].time <= t ? k[idx[i]].close : NaN;
      const h = hs.find((x) => x.symbol.ticker === s.ticker);
      if (h && h.qty > 0) {
        invested += h.cost;
        value += Number.isFinite(close) ? h.qty * close : h.cost;
      }
    });
    out.push({ time: t, value, invested });
  }
  return out;
}
