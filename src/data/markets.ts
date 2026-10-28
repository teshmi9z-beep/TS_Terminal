import { num, str, tvScan } from './tv';

// Market overview (TradingView screener): indices, top stocks, crypto, forex, commodities, bonds.

export type MarketRow = { id: string; name: string; logos: string[]; last: number | null; change: number | null; extra?: number | null };

const QUOTE_COLS = ['description', 'logoid', 'close', 'change'];
const toRow = (s: string, d: unknown[]): MarketRow => ({
  id: s, name: str(d[0]), logos: str(d[1]) ? [str(d[1])] : [], last: num(d[2]), change: num(d[3]),
});

export const INDICES = ['SP:SPX', 'NASDAQ:NDX', 'DJ:DJI', 'TVC:RUT', 'EURONEXT:PX1', 'XETR:DAX', 'TVC:UKX', 'TVC:SX5E', 'TVC:NI225', 'TVC:HSI', 'TVC:DXY', 'TVC:VIX'];
export const FOREX = ['FX:EURUSD', 'FX:GBPUSD', 'FX:USDJPY', 'FX:USDCHF', 'FX:AUDUSD', 'FX:USDCAD', 'FX:EURGBP', 'FX:EURJPY'];
export const COMMODITIES = ['TVC:GOLD', 'TVC:SILVER', 'NYMEX:CL1!', 'NYMEX:NG1!', 'COMEX:HG1!', 'NYMEX:PL1!', 'CBOT:ZW1!', 'CBOT:ZC1!'];
export const BONDS = ['TVC:US02Y', 'TVC:US10Y', 'TVC:US30Y', 'TVC:DE10Y', 'TVC:FR10Y', 'TVC:IT10Y', 'TVC:GB10Y', 'TVC:JP10Y'];

// quotes of a fixed list, in the list's order
export async function fetchList(tickers: string[], signal?: AbortSignal): Promise<MarketRow[]> {
  const { rows } = await tvScan('global', { symbols: { tickers }, columns: QUOTE_COLS }, signal);
  const by = new Map(rows.map((r) => [r.s, toRow(r.s, r.d)]));
  return tickers.flatMap((t) => by.get(t) ?? []);
}

// forex pairs with the flags of both currencies
export async function fetchForex(signal?: AbortSignal): Promise<MarketRow[]> {
  const { rows } = await tvScan('forex', { symbols: { tickers: FOREX }, columns: ['description', 'base_currency_logoid', 'close', 'change', 'currency_logoid'] }, signal);
  const by = new Map(rows.map((r) => [r.s, { ...toRow(r.s, r.d), logos: [str(r.d[1]), str(r.d[4])].filter(Boolean) }]));
  return FOREX.flatMap((t) => by.get(t) ?? []);
}

export type StockList = 'gainers' | 'losers' | 'active' | 'largest';

export async function fetchStocks(market: string, list: StockList, signal?: AbortSignal): Promise<MarketRow[]> {
  const filter: object[] = [{ left: 'is_primary', operation: 'equal', right: true }, { left: 'type', operation: 'equal', right: 'stock' }];
  if (list !== 'largest') filter.push({ left: 'market_cap_basic', operation: 'greater', right: 1e9 });
  const sort = list === 'gainers' ? { sortBy: 'change', sortOrder: 'desc' }
    : list === 'losers' ? { sortBy: 'change', sortOrder: 'asc' }
      : list === 'active' ? { sortBy: 'Value.Traded', sortOrder: 'desc' }
        : { sortBy: 'market_cap_basic', sortOrder: 'desc' };
  const { rows } = await tvScan(market, {
    filter, columns: ['description', 'logoid', 'close', 'change', list === 'active' ? 'Value.Traded' : 'market_cap_basic', 'name'], sort, range: [0, 10],
  }, signal);
  return rows.map((r) => ({ ...toRow(r.s, r.d), extra: num(r.d[4]) }));
}

export async function fetchCrypto(signal?: AbortSignal): Promise<MarketRow[]> {
  const { rows } = await tvScan('coin', {
    columns: ['base_currency_desc', 'base_currency_logoid', 'close', '24h_close_change|5', 'market_cap_calc', 'base_currency'],
    sort: { sortBy: 'crypto_total_rank', sortOrder: 'asc' }, range: [0, 10],
  }, signal);
  // CRYPTO:BTCUSD etc.
  return rows.map((r) => ({ ...toRow(r.s, r.d), extra: num(r.d[4]) }));
}
