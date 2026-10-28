import { SYMBOLS } from './symbols';
import type { AssetCategory, Symbol, Timeframe } from '../types';

// The robot lab names markets its own way (the data sources' names, see
// scripts/robots/fetch-data.mjs): these map them to the platform's symbols.

export type LabMarket = 'Crypto' | 'Forex' | 'Commodity' | 'Index' | 'Stock';
export const LAB_MARKETS: LabMarket[] = ['Crypto', 'Forex', 'Commodity', 'Index', 'Stock'];
export const MARKET_LABEL: Record<string, string> = { Crypto: 'Crypto', Forex: 'Forex', Commodity: 'Matières premières', Index: 'Indices', Stock: 'Actions' };
export const LAB_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export const TF_LABEL: Record<string, string> = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 h', '4h': '4 h', '1d': 'Jour' };

// the lab's names (and common broker names, for imported files) -> the platform's tickers
const ALIAS: Record<string, string> = {
  GOLD: 'XAUUSD', SILVER: 'XAGUSD', NDX: 'NDX100', SPX: 'SPX500', DAX: 'DAX40',
  XAUUSDT: 'XAUUSD', XAGUSDT: 'XAGUSD', CLUSDT: 'WTI', SPYUSDT: 'SPY', QQQUSDT: 'QQQ', TSLAUSDT: 'TSLA', NVDAUSDT: 'NVDA',
  NAS100: 'NDX100', US100: 'NDX100', USTEC: 'NDX100', USTECH: 'NDX100', NQ: 'NDX100',
  US500: 'SPX500', SP500: 'SPX500', SPX500USD: 'SPX500', ES: 'SPX500',
  US30: 'DJI', DJ30: 'DJI', WS30: 'DJI', DOW: 'DJI', YM: 'DJI',
  GER40: 'DAX40', GER30: 'DAX40', DE40: 'DAX40', DE30: 'DAX40', DEU40: 'DAX40',
  FRA40: 'CAC40', FR40: 'CAC40', UK100: 'FTSE100', JPN225: 'NIKKEI', JP225: 'NIKKEI', US2000: 'RUT2000',
  XTIUSD: 'WTI', USOIL: 'WTI', WTICOUSD: 'WTI', CL: 'WTI', XNGUSD: 'NATGAS', NATGASUSD: 'NATGAS', NGAS: 'NATGAS',
  GDAXI: 'DAX40', GSPC: 'SPX500', FCHI: 'CAC40', N225: 'NIKKEI', FTSE: 'FTSE100', RUT: 'RUT2000',
  XAU: 'XAUUSD', XAG: 'XAGUSD', GC: 'XAUUSD', SI: 'XAGUSD', COPPERUSD: 'COPPER', XCUUSD: 'COPPER',
  // HistData.com
  SPXUSD: 'SPX500', NSXUSD: 'NDX100', GRXEUR: 'DAX40', FRXEUR: 'CAC40', UKXGBP: 'FTSE100', JPXJPY: 'NIKKEI', WTIUSD: 'WTI',
  ETXEUR: 'STOXX50', HKXHKD: 'HSI', AUXAUD: 'ASX200', UDXUSD: 'DXY',
  // the other indices under broker names
  EU50: 'STOXX50', EUSTX50: 'STOXX50', STOXX50E: 'STOXX50', SX5E: 'STOXX50', HK50: 'HSI', HK33: 'HSI', AUS200: 'ASX200', USDX: 'DXY', DX: 'DXY',
  ESP35: 'IBEX35', SPAIN35: 'IBEX35', SWI20: 'SMI20', CH20: 'SMI20', SMI: 'SMI20', IT40: 'FTSEMIB', ITA40: 'FTSEMIB',
  NETH25: 'AEX', NL25: 'AEX', CHINA50: 'CHINAA50', CN50: 'CHINAA50', CHINAH: 'HSCEI', US400: 'SP400', UK250: 'FTSE250',
};

export const CATEGORY_OF: Record<LabMarket, AssetCategory> = { Crypto: 'Crypto', Forex: 'Forex', Commodity: 'Matieres premieres', Index: 'Indices', Stock: 'Actions' };
export const MARKET_OF: Record<AssetCategory, LabMarket> = { Crypto: 'Crypto', Forex: 'Forex', 'Matieres premieres': 'Commodity', Indices: 'Index', Actions: 'Stock' };

// the platform ticker of a lab or broker name (the name itself when unknown)
export function platformTicker(name: string): string {
  const n = name.toUpperCase();
  if (ALIAS[n]) return ALIAS[n];
  if (SYMBOLS.some((s) => s.ticker === n)) return n;
  // BTCUSDT -> BTCUSD
  if (/USDT$/.test(n) && SYMBOLS.some((s) => s.ticker === n.slice(0, -1))) return n.slice(0, -1);
  // broker suffixes: EURUSD.RAW, XAUUSD.PRO
  const dot = n.indexOf('.');
  if (dot > 0 && !SYMBOLS.some((s) => s.ticker === n)) { const base = platformTicker(n.slice(0, dot)); if (base !== n.slice(0, dot) || SYMBOLS.some((s) => s.ticker === base)) return base; }
  return n;
}

export function platformSymbol(name: string, market?: string): Symbol {
  const ticker = platformTicker(name);
  return SYMBOLS.find((x) => x.ticker === ticker)
    ?? { ticker, name: ticker, basePrice: 100, category: CATEGORY_OF[market as LabMarket] ?? guessCategory(ticker) };
}

// for names the platform doesn't list
export function guessCategory(ticker: string): AssetCategory {
  if (/USDT$|^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|LTC|DOT|LINK)/.test(ticker)) return 'Crypto';
  if (/^(EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD|SEK|NOK|PLN|TRY|ZAR|MXN|HKD|SGD|CNH)(EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD|SEK|NOK|PLN|TRY|ZAR|MXN|HKD|SGD|CNH)$/.test(ticker)) return 'Forex';
  if (/^X(AU|AG|PT|PD)/.test(ticker)) return 'Matieres premieres';
  return 'Actions';
}

// lab timeframe names <-> the platform's
export const platformTf = (tf: string): Timeframe => (tf === '1d' ? '1D' : tf === '1w' ? '1W' : tf) as Timeframe;
export const labTf = (tf: Timeframe): string => (tf === '1D' ? '1d' : tf === '1W' ? '1w' : tf);
