import type { Symbol } from '../../types';
import { SYMBOLS } from '../symbols';
import { yahooId } from './resolve';
import { yahooSearch } from './yahoo';

// turns a Yahoo search hit into one of our symbols, reusing a built-in entry
// when it's the same instrument (so ^GSPC opens SPX500, EURUSD=X opens EURUSD...)
export function fromYahoo(hit: { symbol: string; name: string; type: string; exchange: string }): Symbol | null {
  const builtIn = SYMBOLS.find((s) => yahooId(s) === hit.symbol);
  if (builtIn) return builtIn;
  switch (hit.type) {
    case 'EQUITY': case 'ETF': case 'MUTUALFUND':
      return { ticker: hit.symbol, name: hit.name, basePrice: 100, category: 'Actions', exchange: hit.exchange, yahoo: hit.symbol };
    case 'INDEX':
      return { ticker: hit.symbol, name: hit.name, basePrice: 1000, category: 'Indices', exchange: hit.exchange, yahoo: hit.symbol };
    case 'CURRENCY':
      return { ticker: hit.symbol.replace('=X', ''), name: hit.name, basePrice: 1, category: 'Forex', exchange: 'Forex', yahoo: hit.symbol };
    case 'FUTURE':
      return { ticker: hit.symbol, name: hit.name, basePrice: 100, category: 'Matieres premieres', exchange: hit.exchange, yahoo: hit.symbol };
    case 'CRYPTOCURRENCY': {
      const base = hit.symbol.replace(/-USD$/, '');
      return { ticker: `${base}USD`, name: hit.name, basePrice: 1, category: 'Crypto', exchange: 'Crypto', yahoo: hit.symbol };
    }
    default:
      return null;
  }
}

// built-in symbols matching the text, then Yahoo Finance's search
export async function searchSymbols(q: string, extra: Symbol[] = []): Promise<Symbol[]> {
  const t = q.trim().toUpperCase();
  if (!t) return [];
  const local = [...extra, ...SYMBOLS].filter((s, i, a) => a.findIndex((x) => x.ticker === s.ticker) === i)
    .filter((s) => s.ticker.includes(t) || s.name.toUpperCase().includes(t)).slice(0, 8);
  const remote = await yahooSearch(q).catch(() => []);
  const out = [...local];
  for (const h of remote) {
    const s = fromYahoo(h);
    if (s && !out.some((x) => x.ticker === s.ticker)) out.push(s);
  }
  return out.slice(0, 15);
}
