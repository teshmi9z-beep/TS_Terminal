import { SYMBOLS } from './symbols';

function pick(...tickers: string[]) {
  return tickers.map((t) => SYMBOLS.find((s) => s.ticker === t)!).filter(Boolean);
}

export type Preset = { id: string; label: string; symbols: ReturnType<typeof pick> };

export const PRESETS: Preset[] = [
  {
    // full 40 constituents
    id: 'cac40', label: 'CAC 40',
    symbols: pick(
      'MC.PA', 'OR.PA', 'TTE.PA', 'SAN.PA', 'AIR.PA', 'BNP.PA', 'DG.PA', 'CAP.PA', 'SU.PA', 'RMS.PA',
      'EL.PA', 'KER.PA', 'DSY.PA', 'BN.PA', 'ENGI.PA', 'ORA.PA', 'VIE.PA', 'STLA.PA', 'SGO.PA', 'ML.PA',
      'CS.PA', 'AI.PA', 'PUB.PA', 'LR.PA', 'RI.PA', 'SAF.PA', 'HO.PA', 'EN.PA', 'CA.PA', 'ACA.PA',
      'GLE.PA', 'RNO.PA', 'TEP.PA', 'URW.PA', 'EDEN.PA', 'ERF.PA', 'MT.PA', 'STM.PA', 'AMUN.PA', 'VIV.PA',
    ),
  },
  {
    // full 40 constituents
    id: 'dax', label: 'DAX',
    symbols: pick(
      'SAP.DE', 'SIE.DE', 'ALV.DE', 'DTE.DE', 'BAS.DE', 'VOW3.DE', 'BMW.DE', 'MBG.DE', 'DBK.DE', 'IFX.DE',
      'MUV2.DE', 'ADS.DE', 'HEN3.DE', 'RWE.DE', 'EOAN.DE', 'CON.DE', 'HEI.DE', 'FRE.DE', 'MTX.DE', 'DHL.DE',
      'BAYN.DE', 'DB1.DE', 'MRK.DE', 'BEI.DE', 'P911.DE', 'SRT3.DE', 'ZAL.DE', 'SY1.DE', 'BNR.DE', 'FME.DE',
      'HNR1.DE', 'RHM.DE', 'CBK.DE', 'VNA.DE', 'QIA.DE', 'SHL.DE', 'ENR.DE', 'PUM.DE', 'PAH3.DE', 'TLX.DE',
    ),
  },
  {
    // full 30 constituents
    id: 'dowjones', label: 'Dow Jones',
    symbols: pick(
      'AAPL', 'MSFT', 'UNH', 'V', 'HD', 'KO', 'DIS', 'JPM', 'XOM', 'PG',
      'CVX', 'WMT', 'MCD', 'CRM', 'AMGN', 'AXP', 'AMZN', 'BA', 'CAT', 'CSCO',
      'DOW', 'GS', 'HON', 'IBM', 'JNJ', 'MRK', 'NKE', 'SHW', 'TRV', 'VZ',
    ),
  },
  {
    // large representative slice of the Nasdaq 100, not the full 100
    id: 'nasdaq', label: 'Nasdaq (echantillon large)',
    symbols: pick(
      'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'ADBE', 'COST',
      'PEP', 'CRM', 'INTC', 'CMCSA', 'TXN', 'QCOM', 'AMD', 'INTU', 'AMAT', 'BKNG',
      'ISRG', 'VRTX', 'REGN', 'PANW', 'SBUX', 'GILD', 'MDLZ', 'ADP', 'LRCX', 'MU',
    ),
  },
  {
    // large representative slice of the S&P 500, not the full 500
    id: 'sp500', label: 'S&P 500 (echantillon large)',
    symbols: pick(
      'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'NVDA', 'META', 'JPM', 'V', 'XOM', 'PG',
      'MA', 'LLY', 'CVX', 'PEP', 'COST', 'WMT', 'NFLX', 'ORCL', 'GE', 'MS',
      'WFC', 'C', 'NEE', 'LIN', 'T', 'JNJ', 'HD', 'UNH', 'DIS', 'BA',
    ),
  },
  { id: 'smallcap', label: 'Small Cap', symbols: pick('PLTR', 'RIOT', 'SOFI', 'UPST', 'IONQ', 'SMCI') },
  { id: 'midcap', label: 'Mid Cap', symbols: pick('DKNG', 'ETSY', 'ROKU', 'PINS', 'CHWY', 'DOCU') },
  { id: 'russell2000', label: 'Russell 2000', symbols: pick('RUT2000', 'PLTR', 'RIOT', 'SOFI', 'UPST', 'IONQ') },
  {
    id: 'indices', label: 'Indices principaux',
    symbols: pick('SPX500', 'NDX100', 'DJI', 'RUT2000', 'CAC40', 'DAX40', 'FTSE100', 'STOXX50', 'NIKKEI', 'HSI', 'SHCOMP', 'CSI300'),
  },
  {
    id: 'indices_us', label: 'Indices US',
    symbols: pick('SPX500', 'NDX100', 'DJI', 'NASDAQ', 'SP100', 'NYSE', 'RUT1000', 'RUT3000', 'SP400', 'SP600', 'RUT2000', 'DJTRANS', 'VIX', 'DXY'),
  },
  {
    id: 'indices_europe', label: 'Indices Europe (Euronext, Londres, Allemagne)',
    symbols: pick(
      'CAC40', 'SBF120', 'CACNEXT20', 'CACMID60', 'DAX40', 'MDAX', 'SDAX', 'TECDAX', 'EURONEXT100', 'NEXT150', 'AEX', 'AMXNL', 'BEL20',
      'PSI20', 'ISEQ', 'OBX', 'FTSE100', 'FTSE250', 'FTSE350', 'FTSEALL', 'FTSESMALL', 'FTSEAIM', 'STOXX50', 'STOXX600', 'IBEX35', 'FTSEMIB', 'SMI20',
    ),
  },
  {
    id: 'indices_asia', label: 'Indices Asie (Japon, Chine)',
    symbols: pick(
      'NIKKEI', 'NIKKEI300', 'TOPIX', 'TSEGROWTH', 'SHCOMP', 'SZCOMP', 'CSI300', 'CSI500', 'CSI1000', 'SSE50', 'STAR50', 'CHINEXT', 'CHINAA50',
      'HSI', 'HSCEI', 'HSTECH', 'ASX200',
    ),
  },
  {
    id: 'indices_smallmid', label: 'Indices small & mid caps',
    symbols: pick(
      'SP400', 'SP600', 'RUT2000', 'CACMID60', 'MDAX', 'SDAX', 'NEXT150', 'AMXNL', 'FTSE250', 'FTSESMALL', 'FTSEAIM', 'TSEGROWTH',
      'CSI500', 'CSI1000', 'CHINEXT',
    ),
  },
  { id: 'commodities', label: 'Commodities', symbols: pick('XAUUSD', 'XAGUSD', 'WTI', 'NATGAS', 'COPPER', 'CORN') },
  { id: 'forex_major', label: 'Forex majeurs', symbols: pick('EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD') },
  {
    id: 'forex_cross', label: 'Forex croisements',
    symbols: pick(
      'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'EURNZD', 'GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPCAD',
      'GBPNZD', 'AUDJPY', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'NZDJPY', 'NZDCHF', 'CADJPY', 'CADCHF', 'CHFJPY',
    ),
  },
  {
    id: 'forex_exotic', label: 'Forex exotiques',
    symbols: pick(
      'USDTRY', 'USDZAR', 'USDMXN', 'USDSEK', 'USDNOK', 'USDDKK', 'USDPLN', 'USDSGD', 'USDHKD', 'USDILS', 'USDTHB',
      'EURPLN', 'EURNOK', 'EURSEK', 'EURZAR', 'EURTRY', 'EURSGD', 'GBPNOK', 'GBPSEK', 'GBPZAR', 'GBPSGD', 'NOKJPY', 'SEKJPY', 'ZARJPY',
    ),
  },
  { id: 'crypto_top', label: 'Crypto top 10', symbols: pick('BTCUSD', 'ETHUSD', 'XRPUSD', 'BNBUSD', 'SOLUSD', 'DOGEUSD', 'TRXUSD', 'ADAUSD', 'HYPEUSD', 'LINKUSD') },
  {
    id: 'crypto_l1', label: 'Crypto blockchains (L1 / L2)',
    symbols: pick(
      'ETHUSD', 'SOLUSD', 'ADAUSD', 'AVAXUSD', 'DOTUSD', 'NEARUSD', 'SUIUSD', 'APTUSD', 'TONUSD', 'ATOMUSD', 'ALGOUSD',
      'ICPUSD', 'HBARUSD', 'SEIUSD', 'TIAUSD', 'EGLDUSD', 'ARBUSD', 'OPUSD', 'POLUSD',
    ),
  },
  { id: 'crypto_defi', label: 'Crypto DeFi', symbols: pick('LINKUSD', 'UNIUSD', 'AAVEUSD', 'CRVUSD', 'PENDLEUSD', 'ENAUSD', 'ONDOUSD', 'JUPUSD', 'INJUSD', 'HYPEUSD') },
  { id: 'crypto_meme', label: 'Crypto memes', symbols: pick('DOGEUSD', 'SHIBUSD', 'PEPEUSD', 'BONKUSD', 'WIFUSD', 'FLOKIUSD', 'TRUMPUSD') },
];
