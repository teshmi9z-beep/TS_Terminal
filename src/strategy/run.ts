import type { Candle, Symbol, Timeframe } from '../types';
import { openFeed } from '../data/feeds';
import { useQuotes } from '../data/feeds/quotes';
import { pricePrecision } from '../components/chartUtils';
import type { StrategyDoc } from './doc';
import { runRules } from './rules';
import { runPineStrategy } from './pineStrategy';
import type { BacktestResult } from './types';
import type { Broker } from './broker';

const CURRENCY_SIGNS: Record<string, string> = { USD: '$', USDT: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF', CAD: 'CA$', AUD: 'AU$' };

// currency of the P&L: the quote currency of a forex pair, dollars for crypto,
// else what the data feed reported
export function currencyOf(sym: Symbol): string {
  if (sym.category === 'Forex' && sym.ticker.length === 6) {
    const q = sym.ticker.slice(3);
    return CURRENCY_SIGNS[q] ?? q;
  }
  if (sym.category === 'Crypto') return '$';
  const c = useQuotes.getState().quotes[sym.ticker]?.currency;
  return c ? CURRENCY_SIGNS[c] ?? c : '$';
}

export type LoadedHistory = { candles: Candle[]; label: string; simulated: boolean };

// the strategy tester loads its own history (deeper than the chart's)
export async function loadHistory(sym: Symbol, tf: Timeframe, bars: number, onProgress?: (n: number) => void): Promise<LoadedHistory> {
  const { session, candles } = await openFeed(sym, tf);
  let k = candles;
  onProgress?.(k.length);
  for (let guard = 0; guard < 80 && k.length < bars && session.hasMore; guard++) {
    const older = await session.loadOlder();
    const first = k[0]?.time ?? Infinity;
    const add = older.filter((c) => c.time < first);
    if (!add.length) break;
    k = [...add, ...k];
    onProgress?.(k.length);
  }
  return { candles: k.slice(-bars), label: session.label, simulated: session.source === 'sim' };
}

export type RunContext = { symbol: Symbol; timeframe: Timeframe; source: string };

export function runStrategy(doc: StrategyDoc, candles: Candle[], ctx: RunContext): { result: BacktestResult | null; error: string | null } {
  if (candles.length < 2) return { result: null, error: 'Pas assez de barres pour le backtest.' };
  const precision = pricePrecision(ctx.symbol, candles[candles.length - 1].close);
  let broker: Broker | null;
  let warnings: string[] = [];
  let initialCapital: number;
  let name = doc.name;
  if (doc.mode === 'assisted') {
    const r = doc.rules;
    if (!r.longEntry.conditions.length && !r.shortEntry.conditions.length) {
      return { result: null, error: 'Aucune condition d’entrée : ajoutez une condition « Acheter » ou « Vendre à découvert ».' };
    }
    broker = runRules(r, candles);
    warnings = [...broker.warnings];
    initialCapital = r.initialCapital;
  } else {
    const run = runPineStrategy(doc.code, candles, { timeframe: ctx.timeframe, ticker: ctx.symbol.ticker, mintick: 10 ** -precision }, doc.inputs);
    if (!run.broker) return { result: null, error: run.error ?? 'Erreur inconnue' };
    broker = run.broker;
    warnings = run.warnings;
    initialCapital = run.initialCapital;
    name = doc.name || run.title;
  }
  return {
    error: null,
    result: {
      strategyId: doc.id,
      strategyName: name,
      ticker: ctx.symbol.ticker,
      timeframe: ctx.timeframe,
      source: ctx.source,
      currency: currencyOf(ctx.symbol),
      precision,
      candles,
      trades: broker.trades,
      openTrade: broker.openTrade(),
      equity: broker.equity,
      position: broker.position,
      initialCapital,
      warnings,
      ranAt: Date.now(),
    },
  };
}
