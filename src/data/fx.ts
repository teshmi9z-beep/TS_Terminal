import type { Symbol } from '../types';
import { yahooId } from './feeds/resolve';
import { useQuotes, type Quote } from './feeds/quotes';

// Amounts of the virtual account shown in euros: the currency a symbol is
// quoted in, and the live EURxxx rate that converts it.

const INDEX_CCY: Record<string, string> = {
  '^GDAXI': 'EUR', '^FCHI': 'EUR', '^STOXX50E': 'EUR', '^AEX': 'EUR', '^IBEX': 'EUR', 'FTSEMIB.MI': 'EUR',
  '^FTSE': 'GBP', '^SSMI': 'CHF', '^N225': 'JPY', '^HSI': 'HKD',
};
// stock listings by their Yahoo suffix (no suffix: a US listing)
const SUFFIX_CCY: [RegExp, string][] = [
  [/\.(PA|DE|F|AS|MI|MC|BR|LS|VI|HE|IR)$/, 'EUR'], [/\.L$/, 'GBp'], [/\.SW$/, 'CHF'], [/\.T$/, 'JPY'],
  [/\.HK$/, 'HKD'], [/\.TO$/, 'CAD'], [/\.AX$/, 'AUD'],
];

// the currency the symbol's price is in ('GBp': London prices in pence)
export function quoteCurrency(sym: Symbol, quotes: Record<string, Quote> = useQuotes.getState().quotes): string {
  const meta = quotes[sym.ticker]?.currency;
  if (meta) return /^USD[TC]$/.test(meta) ? 'USD' : meta;
  const t = sym.ticker.toUpperCase();
  if (sym.category === 'Forex' && /^[A-Z]{6}$/.test(t)) return t.slice(3);
  if (sym.category === 'Crypto') return /EUR$/.test(t) ? 'EUR' : 'USD';
  const y = yahooId(sym) ?? '';
  if (INDEX_CCY[y]) return INDEX_CCY[y];
  for (const [re, c] of SUFFIX_CCY) if (re.test(y)) return c;
  return 'USD';
}

const pence = (cur: string) => cur === 'GBp' || cur === 'GBX';

// the pair quoted in that currency per euro (EURUSD: dollars for one euro); none for the euro
export function fxSymbol(cur: string): Symbol | null {
  const base = pence(cur) ? 'GBP' : cur.toUpperCase();
  if (base === 'EUR') return null;
  return { ticker: `EUR${base}`, name: `Euro / ${base}`, basePrice: 1, category: 'Forex' };
}

// euros for one unit of `cur`, from the live EURxxx quote; null until that quote is in
export function eurPerUnit(cur: string, quotes: Record<string, Quote> = useQuotes.getState().quotes): number | null {
  const fx = fxSymbol(cur);
  if (!fx) return 1;
  const r = quotes[fx.ticker]?.last;
  if (r == null || !(r > 0)) return null;
  return (pence(cur) ? 0.01 : 1) / r;
}

// how an amount in that currency is written when the rate is not known yet
export const currencySign = (cur: string) =>
  ({ USD: '$', EUR: '€', GBP: '£', GBp: 'p', JPY: '¥', CHF: 'CHF' } as Record<string, string>)[cur] ?? cur;
