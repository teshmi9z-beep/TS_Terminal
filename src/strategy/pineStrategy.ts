import type { Candle } from '../types';
import type { InputDef } from '../indicators/types';
import { parsePine, PineError } from '../pine/parser';
import { analyze } from '../pine/compile';
import { PineRuntime, type StrategyHooks, type Value } from '../pine/runtime';
import { Broker } from './broker';
import type { BrokerSettings, CommissionType } from './types';

// TradingView strategy scripts (strategy.entry / exit / close...) run bar by bar
// by the Pine interpreter, their orders going to the shared broker.

export type PineStrategyInfo = {
  error: string | null;
  warnings: string[];
  title: string;
  isStrategy: boolean;
  inputs: InputDef[];
  settings: BrokerSettings;
};

const QTY_TYPES: Record<string, BrokerSettings['qtyMode']> = {
  'strategy.fixed': 'fixed', 'strategy.percent_of_equity': 'percent', 'strategy.cash': 'cash',
};
const COMMISSIONS: Record<string, CommissionType> = {
  'strategy.commission.percent': 'percent',
  'strategy.commission.cash_per_order': 'per_order',
  'strategy.commission.cash_per_contract': 'per_contract',
};

function prepare(source: string) {
  const prog = parsePine(source);
  const meta = analyze(prog);
  const a = meta.strategyArgs ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const settings: BrokerSettings = {
    // TradingView's defaults
    initialCapital: num(a.initial_capital, 1_000_000),
    qtyMode: QTY_TYPES[String(a.default_qty_type)] ?? 'fixed',
    qtyValue: num(a.default_qty_value, 1),
    commissionType: COMMISSIONS[String(a.commission_type)] ?? 'percent',
    commissionValue: num(a.commission_value, 0),
    fillOnClose: a.process_orders_on_close === true,
  };
  const warnings = meta.warnings.filter((w) => !w.includes('strategy') && !w.includes('Script « strategy »'));
  if (num(a.pyramiding, 1) > 1) warnings.push('pyramiding > 1 non pris en charge : une seule position à la fois.');
  return { prog, meta, settings, warnings };
}

export function inspectPineStrategy(source: string): PineStrategyInfo {
  try {
    const { meta, settings, warnings } = prepare(source);
    return { error: null, warnings, title: meta.title, isStrategy: meta.strategyArgs != null, inputs: meta.inputs, settings };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e), warnings: [], title: 'Stratégie', isStrategy: false, inputs: [],
      settings: { initialCapital: 100000, qtyMode: 'fixed', qtyValue: 1, commissionType: 'percent', commissionValue: 0, fillOnClose: false },
    };
  }
}

export type PineStrategyRun = { broker: Broker | null; error: string | null; warnings: string[]; title: string; initialCapital: number };

export function runPineStrategy(
  source: string, candles: Candle[],
  ctx: { timeframe: string; ticker: string; mintick: number },
  inputs: Record<string, number | boolean | string> = {},
): PineStrategyRun {
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(source);
  } catch (e) {
    return { broker: null, error: e instanceof Error ? e.message : String(e), warnings: [], title: 'Stratégie', initialCapital: 0 };
  }
  const { prog, meta, settings } = prepared;
  const warnings = new Set(prepared.warnings);
  if (!meta.strategyArgs) {
    return { broker: null, error: 'Ce script est un indicateur : il faut une déclaration strategy("…") et des ordres strategy.entry.', warnings: [...warnings], title: meta.title, initialCapital: 0 };
  }
  const broker = new Broker(candles, settings);
  // values at the end of each bar, for strategy.position_size[1]...
  const hist = new Map<string, number[]>();
  const HIST = ['strategy.position_size', 'strategy.position_avg_price', 'strategy.equity', 'strategy.netprofit', 'strategy.openprofit', 'strategy.closedtrades', 'strategy.opentrades'];

  const now = (name: string): Value | undefined => {
    switch (name) {
      case 'strategy.long': return 'long';
      case 'strategy.short': return 'short';
      case 'strategy.position_size': return broker.positionSize;
      case 'strategy.position_avg_price': return broker.avgPrice;
      case 'strategy.equity': return broker.equityNow;
      case 'strategy.netprofit': return broker.netProfit;
      case 'strategy.openprofit': return broker.openProfit;
      case 'strategy.initial_capital': return broker.initialCapital;
      case 'strategy.closedtrades': return broker.trades.length;
      case 'strategy.opentrades': return broker.positionSize !== 0 ? 1 : 0;
      case 'strategy.wintrades': return broker.wins;
      case 'strategy.losstrades': return broker.losses;
      case 'strategy.eventrades': return broker.trades.length - broker.wins - broker.losses;
      case 'strategy.grossprofit': return broker.grossProfit;
      case 'strategy.grossloss': return -broker.grossLoss;
      default:
        // enum-like constants (strategy.fixed, strategy.commission.percent, strategy.direction.long...)
        return /^strategy\.(fixed|cash|percent_of_equity|commission\.|direction\.|oca\.)/.test(name) ? name : undefined;
    }
  };

  const hooks: StrategyHooks = {
    beginBar: (i) => broker.beginBar(i),
    endBar: (i) => {
      broker.endBar(i);
      for (const h of HIST) {
        let arr = hist.get(h);
        if (!arr) { arr = []; hist.set(h, arr); }
        arr[i] = Number(now(h));
      }
    },
    value: (name, off) => {
      if (off > 0) {
        const arr = hist.get(name);
        if (arr) return arr[broker.bar - off] ?? NaN;
      }
      return now(name);
    },
    call: (fn, pos, named, line) => {
      const arg = (idx: number, name: string): Value | undefined => (named[name] !== undefined ? named[name] : pos[idx]);
      const num = (v: Value | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const str = (v: Value | undefined) => (v == null || (typeof v === 'number' && isNaN(v)) ? undefined : String(v));
      // Pine v4 style `when=` argument
      if (named.when !== undefined && !named.when) return null;
      switch (fn) {
        case 'strategy.entry':
        case 'strategy.order': {
          if (fn === 'strategy.order') warnings.add('strategy.order est traité comme strategy.entry.');
          const dir = String(arg(1, 'direction'));
          broker.entry({
            id: String(arg(0, 'id')), side: dir.includes('short') ? 'short' : 'long',
            qty: num(arg(2, 'qty')), limitPrice: num(arg(3, 'limit')), stopPrice: num(arg(4, 'stop')),
            comment: str(arg(7, 'comment')),
          });
          return null;
        }
        case 'strategy.exit': {
          const qtyPct = num(arg(3, 'qty_percent'));
          if ((qtyPct != null && qtyPct < 100) || num(arg(2, 'qty')) != null) warnings.add(`Sorties partielles (ligne ${line}) : la position est sortie en entier.`);
          if (arg(8, 'trail_price') != null || arg(9, 'trail_points') != null) warnings.add(`Stop suiveur trail_* (ligne ${line}) non pris en charge.`);
          const profit = num(arg(4, 'profit')), loss = num(arg(6, 'loss'));
          broker.exit({
            id: String(arg(0, 'id')), fromEntry: str(arg(1, 'from_entry')) ?? '',
            limit: num(arg(5, 'limit')), stop: num(arg(7, 'stop')),
            limitOffset: profit != null ? profit * ctx.mintick : undefined,
            stopOffset: loss != null ? loss * ctx.mintick : undefined,
            comment: str(arg(12, 'comment')),
          });
          return null;
        }
        case 'strategy.close': broker.close(String(arg(0, 'id')), str(arg(1, 'comment'))); return null;
        case 'strategy.close_all': broker.close(null, str(arg(0, 'comment'))); return null;
        case 'strategy.cancel': broker.cancel(String(arg(0, 'id'))); return null;
        case 'strategy.cancel_all': broker.cancel(null); return null;
        default:
          warnings.add(`${fn} (ligne ${line}) n’est pas pris en charge : ignoré.`);
          return null;
      }
    },
  };

  try {
    const defaults: Record<string, number | boolean | string> = {};
    for (const inp of meta.inputs) defaults[inp.key] = inp.default;
    const rt = new PineRuntime(prog, {
      inputs: { ...defaults, ...inputs }, inputKeyOf: meta.inputKeyOf, plotKeyOf: meta.plotKeyOf,
      timeframe: ctx.timeframe, ticker: ctx.ticker, mintick: ctx.mintick, strategy: hooks,
    });
    rt.run(candles);
  } catch (e) {
    return { broker: null, error: e instanceof PineError ? e.message : String(e), warnings: [...warnings], title: meta.title, initialCapital: settings.initialCapital };
  }
  for (const w of broker.warnings) warnings.add(w);
  return { broker, error: null, warnings: [...warnings], title: meta.title, initialCapital: settings.initialCapital };
}
