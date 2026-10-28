import type { Symbol } from '../../types';
import type { FeedRef } from './types';
import { bnFetch, FAPI_REST } from './binance';
import { SYMBOLS } from '../symbols';

// built-in tickers whose Yahoo symbol can't be derived from the ticker itself
const YAHOO_MAP: Record<string, string> = {
  XAUUSD: 'GC=F', XAGUSD: 'SI=F', WTI: 'CL=F', NATGAS: 'NG=F', COPPER: 'HG=F', CORN: 'ZC=F',
  NDX100: '^NDX', SPX500: '^GSPC', DAX40: '^GDAXI', CAC40: '^FCHI', DJI: '^DJI',
  RUT2000: '^RUT', NIKKEI: '^N225', FTSE100: '^FTSE',
};

// the Interactive Brokers contract; a built-in symbol's current definition wins over the copy
// saved in a watchlist or a workspace (an older id)
export function ibId(sym: Symbol): string | null {
  return SYMBOLS.find((s) => s.ticker === sym.ticker)?.ib ?? sym.ib ?? null;
}

export function binanceId(sym: Symbol): string | null {
  if (sym.binance) return sym.binance;
  if (sym.category === 'Crypto' && /USD$/.test(sym.ticker)) return sym.ticker.replace(/USD$/, 'USDT');
  return null;
}

export function yahooId(sym: Symbol): string | null {
  if (sym.yahoo) return sym.yahoo;
  if (YAHOO_MAP[sym.ticker]) return YAHOO_MAP[sym.ticker];
  switch (sym.category) {
    case 'Forex': return `${sym.ticker}=X`;
    case 'Actions': return sym.ticker;
    case 'Crypto': return /USD$/.test(sym.ticker) ? sym.ticker.replace(/USD$/, '-USD') : null;
    default: return null;
  }
}

// ordered list of feeds to try; the simulator is always the last resort
export function feedChain(sym: Symbol): FeedRef[] {
  const chain: FeedRef[] = [];
  const ib = ibId(sym);
  if (ib) chain.push({ source: 'ib', id: ib });
  const bn = binanceId(sym);
  if (bn) chain.push({ source: 'binance', id: bn });
  const yf = yahooId(sym);
  if (yf) chain.push({ source: 'yahoo', id: yf });
  chain.push({ source: 'sim', id: sym.ticker });
  return chain;
}

// Binance's "TradFi" perpetual futures follow gold, oil and US stocks. They trade
// around the clock, so their price can drift from the underlying while its market
// is closed, but they are the only free source of real trades (ticks) for these.
const PERP_MAP: Record<string, string> = {
  XAUUSD: 'XAUUSDT', XAGUSD: 'XAGUSDT', WTI: 'CLUSDT', NATGAS: 'NATGASUSDT', COPPER: 'COPPERUSDT',
};

let tradFi: Promise<Set<string>> | null = null;
function tradFiPerps(): Promise<Set<string>> {
  tradFi ??= bnFetch<{ symbols: { symbol: string; status: string; underlyingSubType?: string[] }[] }>('/fapi/v1/exchangeInfo', FAPI_REST)
    .then((j) => new Set(j.symbols.filter((s) => s.status === 'TRADING' && s.underlyingSubType?.includes('TradFi')).map((s) => s.symbol)))
    .catch(() => { tradFi = null; return new Set<string>(); });
  return tradFi;
}

// the TradFi perpetual matching a commodity or a US stock / ETF, if Binance lists one
export async function tradFiPerp(sym: Symbol): Promise<string | null> {
  let id: string | undefined = PERP_MAP[sym.ticker];
  const y = sym.category === 'Actions' ? yahooId(sym) : null;
  // US listings only: no exchange suffix like .PA (BRK-B / BRK.B become BRKB)
  if (!id && y && /^[A-Z]+([.-][A-Z])?$/.test(y)) id = `${y.replace(/[.-]/, '')}USDT`;
  if (!id) return null;
  return (await tradFiPerps()).has(id) ? id : null;
}
