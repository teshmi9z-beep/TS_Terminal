import type { Symbol } from '../types';
import { SYMBOLS } from './symbols';
import { yahooTicker } from './stockScreener';

// Helpers around TradingView's public screener (relayed as /tvscan) shared by the tool pages.

export type ScanRow = { s: string; d: unknown[] };

export async function tvScan(market: string, body: object, signal?: AbortSignal): Promise<{ total: number; rows: ScanRow[] }> {
  const res = await fetch(`/tvscan/${market}/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw new Error(`données indisponibles (${res.status})`);
  const json = (await res.json()) as { totalCount?: number; data?: ScanRow[] | null; error?: string };
  if (json.error) throw new Error(json.error);
  return { total: json.totalCount ?? 0, rows: json.data ?? [] };
}

export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const str = (v: unknown) => (typeof v === 'string' ? v : '');
export const tvLogo = (logoid: string) => `https://s3-symbol-logo.tradingview.com/${logoid}.svg`;

// TradingView symbols that match a built-in symbol of the platform
const BUILT_IN: Record<string, string> = {
  'SP:SPX': 'SPX500', 'NASDAQ:NDX': 'NDX100', 'DJ:DJI': 'DJI', 'XETR:DAX': 'DAX40', 'EURONEXT:PX1': 'CAC40', 'TVC:UKX': 'FTSE100',
  'TVC:NI225': 'NIKKEI', 'TVC:RUT': 'RUT2000', 'TVC:GOLD': 'XAUUSD', 'TVC:SILVER': 'XAGUSD', 'OANDA:XAUUSD': 'XAUUSD',
  'NYMEX:CL1!': 'WTI', 'NYMEX:NG1!': 'NATGAS', 'COMEX:HG1!': 'COPPER', 'CBOT:ZC1!': 'CORN',
  'SP:MID': 'SP400', 'SP:OEX': 'SP100', 'NASDAQ:IXIC': 'NASDAQ', 'NYSE:NYA': 'NYSE', 'TVC:NYA': 'NYSE', 'TVC:RUI': 'RUT1000', 'TVC:RUA': 'RUT3000',
  'DJ:DJT': 'DJTRANS', 'TVC:VIX': 'VIX', 'CBOE:VIX': 'VIX', 'TVC:DXY': 'DXY',
  'EURONEXT:PX4': 'SBF120', 'EURONEXT:CACMD': 'CACMID60', 'EURONEXT:CN20': 'CACNEXT20', 'XETR:MDAX': 'MDAX', 'XETR:TDXP': 'TECDAX',
  'EURONEXT:N100': 'EURONEXT100', 'EURONEXT:AEX': 'AEX', 'EURONEXT:AMX': 'AMXNL', 'EURONEXT:BEL20': 'BEL20', 'EURONEXT:PSI20': 'PSI20',
  'EURONEXT:ISEQ': 'ISEQ', 'OSL:OBX': 'OBX', 'TVC:SX5E': 'STOXX50', 'TVC:SXXP': 'STOXX600', 'STOXX:SXXP': 'STOXX600', 'BME:IBC': 'IBEX35',
  'SIX:SMI': 'SMI20', 'FTSE:MCX': 'FTSE250', 'FTSE:NMX': 'FTSE350', 'FTSE:ASX': 'FTSEALL', 'FTSE:SMX': 'FTSESMALL', 'FTSE:AXX': 'FTSEAIM',
  'SSE:000001': 'SHCOMP', 'SZSE:399001': 'SZCOMP', 'SSE:000300': 'CSI300', 'SSE:000905': 'CSI500', 'SSE:000852': 'CSI1000',
  'SSE:000016': 'SSE50', 'SZSE:399006': 'CHINEXT', 'FTSE:XIN9': 'CHINAA50', 'TVC:HSI': 'HSI', 'HSI:HSI': 'HSI', 'HSI:HSCEI': 'HSCEI',
  'HSI:HSTECH': 'HSTECH', 'ASX:XJO': 'ASX200',
  // the round-the-clock indices: Capital.com's CFDs open Interactive Brokers' (same kind, same level),
  // the CME futures open the futures
  'CAPITALCOM:US30': 'IBUS30', 'CAPITALCOM:US500': 'IBUS500', 'CAPITALCOM:US100': 'IBUST100', 'CAPITALCOM:RTY': 'US2000', 'CAPITALCOM:J225': 'IBJP225',
  'EURONEXT:BITC': 'BITC', 'EURONEXT:CETH': 'CETH', 'EURONEXT:SLNC': 'SLNC', 'EURONEXT:XRPL': 'XRPL',
  'CAPITALCOM:DE40': 'IBDE40', 'CAPITALCOM:FR40': 'IBFR40', 'CAPITALCOM:HK50': 'IBHK50',
  'CBOT_MINI:YM1!': 'US30', 'CME_MINI:ES1!': 'US500', 'CME_MINI:NQ1!': 'US100', 'CME_MINI:RTY1!': 'US2000', 'CME:NIY1!': 'J225',
};
// indices / futures only on Yahoo Finance
const YAHOO_ONLY: Record<string, [string, Symbol['category']]> = {
  'COMEX:GC1!': ['GC=F', 'Matieres premieres'], 'COMEX:SI1!': ['SI=F', 'Matieres premieres'],
  'NYMEX:PL1!': ['PL=F', 'Matieres premieres'], 'CBOT:ZW1!': ['ZW=F', 'Matieres premieres'],
  'TVC:US10Y': ['^TNX', 'Indices'], 'TVC:US05Y': ['^FVX', 'Indices'], 'TVC:US30Y': ['^TYX', 'Indices'],
};
const CRYPTO_EX = new Set(['BINANCE', 'BITSTAMP', 'COINBASE', 'CRYPTO', 'BYBIT', 'KRAKEN', 'OKX', 'BITFINEX', 'CRYPTOCAP']);
const FOREX_EX = new Set(['FX', 'FX_IDC', 'OANDA', 'FOREXCOM', 'SAXO', 'PEPPERSTONE', 'ICMARKETS']);

// the platform symbol of a TradingView symbol ("EXCHANGE:TICKER"), for the chart's feeds
export function tvToSymbol(id: string, name = ''): Symbol {
  const [ex, tk = id] = id.includes(':') ? id.split(':') : ['', id];
  const known = BUILT_IN[id] ? SYMBOLS.find((s) => s.ticker === BUILT_IN[id]) : undefined;
  if (known) return known;
  const yahooOnly = YAHOO_ONLY[id];
  if (yahooOnly) return { ticker: tk, name: name || tk, basePrice: 100, category: yahooOnly[1], exchange: ex, yahoo: yahooOnly[0] };
  if (CRYPTO_EX.has(ex)) {
    const ticker = tk.replace(/USDT$|USDC$/, 'USD');
    return SYMBOLS.find((s) => s.ticker === ticker) ?? { ticker, name: name || ticker, basePrice: 1, category: 'Crypto', exchange: 'Crypto' };
  }
  if (FOREX_EX.has(ex) && /^[A-Z]{6}$/.test(tk)) {
    return SYMBOLS.find((s) => s.ticker === tk) ?? { ticker: tk, name: name || tk, basePrice: 1, category: 'Forex', exchange: 'Forex', yahoo: `${tk}=X` };
  }
  const builtIn = SYMBOLS.find((s) => s.ticker === tk && s.category === 'Actions' && ['NASDAQ', 'NYSE', 'AMEX'].includes(ex));
  if (builtIn) return builtIn;
  return { ticker: tk, name: name || tk, basePrice: 100, category: 'Actions', exchange: ex, yahoo: yahooTicker(ex, tk) };
}

// "AAPL", "OR", "NASDAQ:AAPL" -> the main listing of that ticker (largest company first)
export async function resolveTv(text: string, markets = 'global'): Promise<{ id: string; name: string; logoid: string | null } | null> {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  if (t.includes(':')) return { id: t, name: t, logoid: null };
  const { rows } = await tvScan(markets, {
    filter: [{ left: 'name', operation: 'equal', right: t }, { left: 'is_primary', operation: 'equal', right: true }],
    symbols: { query: { types: ['stock', 'dr', 'fund'] } },
    columns: ['description', 'logoid', 'market_cap_basic'],
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    range: [0, 1],
  });
  const r = rows[0];
  return r ? { id: r.s, name: str(r.d[0]), logoid: str(r.d[1]) || null } : null;
}

// the TradingView symbol of a built-in platform symbol (the first TradingView name mapped to it)
export function tvIdOfBuiltin(ticker: string): string | null {
  for (const [id, t] of Object.entries(BUILT_IN)) if (t === ticker) return id;
  return null;
}
