// Per side, fraction of the price: what a tight venue takes today (a micro future, or a CFD at
// a broker like IG in the market's main hours): half the spread + commission + a little slippage.
// From the brokers' published minimum spreads, to be checked on the account before any real money.
export const TIGHT: Record<string, number> = {
  SPX500: 0.00004, NDX100: 0.00004, DJI: 0.00005, DAX40: 0.00005, CAC40: 0.00008, FTSE100: 0.00008, NIKKEI: 0.0001,
  EURUSD: 0.00004, USDJPY: 0.00004, GBPUSD: 0.00005, AUDUSD: 0.00006, USDCAD: 0.00006, USDCHF: 0.0001, NZDUSD: 0.00016,
  XAUUSD: 0.00008, XAGUSD: 0.0002, BRENT: 0.0002,
};
