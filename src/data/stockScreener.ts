import type { Symbol } from '../types';

// Stock screener data: TradingView's public screener (the same rows as its
// "Screener d'actions"), relayed by the Vite server as /tvscan.

export type MarketId = 'france' | 'america' | 'germany' | 'uk' | 'italy' | 'spain' | 'switzerland' | 'netherlands' | 'belgium' | 'canada' | 'japan';

export const MARKETS: { id: MarketId; label: string; flag: string }[] = [
  { id: 'france', label: 'France', flag: 'fr' },
  { id: 'america', label: 'États-Unis', flag: 'us' },
  { id: 'germany', label: 'Allemagne', flag: 'de' },
  { id: 'uk', label: 'Royaume-Uni', flag: 'gb' },
  { id: 'italy', label: 'Italie', flag: 'it' },
  { id: 'spain', label: 'Espagne', flag: 'es' },
  { id: 'switzerland', label: 'Suisse', flag: 'ch' },
  { id: 'netherlands', label: 'Pays-Bas', flag: 'nl' },
  { id: 'belgium', label: 'Belgique', flag: 'be' },
  { id: 'canada', label: 'Canada', flag: 'ca' },
  { id: 'japan', label: 'Japon', flag: 'jp' },
];

export type StockRow = {
  id: string; // EURONEXT:OR
  ticker: string;
  name: string;
  logoid: string | null;
  exchange: string;
  currency: string;
  close: number | null;
  change: number | null;
  volume: number | null;
  relVolume: number | null;
  marketCap: number | null;
  sector: string;
  industry: string;
  pe: number | null;
  eps: number | null;
  divYield: number | null;
  perfW: number | null;
  perf1M: number | null;
  perf3M: number | null;
  perf6M: number | null;
  perfYTD: number | null;
  perfY: number | null;
  rsi: number | null;
  recommend: number | null;
  volatility: number | null;
};

const COLUMNS = [
  'name', 'description', 'logoid', 'exchange', 'currency', 'close', 'change', 'volume', 'relative_volume_10d_calc', 'market_cap_basic',
  'sector', 'industry', 'price_earnings_ttm', 'earnings_per_share_diluted_ttm', 'dividend_yield_recent',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'RSI', 'Recommend.All', 'Volatility.D',
];

// TradingView's French sector names
export const SECTORS_FR: Record<string, string> = {
  'Commercial Services': 'Services commerciaux',
  Communications: 'Communications',
  'Consumer Durables': 'Biens de consommation durables',
  'Consumer Non-Durables': 'Produits de consommation non durables',
  'Consumer Services': 'Services aux consommateurs',
  'Distribution Services': 'Services de distribution',
  'Electronic Technology': 'Technologie électronique',
  'Energy Minerals': 'Minéraux énergétiques',
  Finance: 'Finance',
  Government: 'Gouvernement',
  'Health Services': 'Services de santé',
  'Health Technology': 'Technologie de la santé',
  'Industrial Services': 'Services industriels',
  Miscellaneous: 'Divers',
  'Non-Energy Minerals': 'Minéraux non énergétiques',
  'Process Industries': 'Industries de transformation',
  'Producer Manufacturing': 'Fabrication de produits',
  'Retail Trade': 'Commerce de détail',
  'Technology Services': 'Services technologiques',
  Transportation: 'Transport',
  Utilities: 'Services publics',
};
export const sectorFr = (s: string) => SECTORS_FR[s] ?? (s || 'Autre');

export const logoUrl = (logoid: string) => `https://s3-symbol-logo.tradingview.com/${logoid}.svg`;

// how many rows a market returns (the largest companies first)
const LIMIT = 2000;

export async function fetchStocks(market: MarketId, signal?: AbortSignal): Promise<{ rows: StockRow[]; total: number }> {
  const res = await fetch(`/tvscan/${market}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      markets: [market],
      symbols: { query: { types: ['stock', 'dr'] } },
      filter: [{ left: 'is_primary', operation: 'equal', right: true }],
      columns: COLUMNS,
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [0, LIMIT],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`screener indisponible (${res.status})`);
  const json = (await res.json()) as { totalCount?: number; data?: { s: string; d: (string | number | null)[] }[] };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const rows = (json.data ?? []).map((r): StockRow => {
    const d = r.d;
    return {
      id: r.s, ticker: str(d[0]), name: str(d[1]), logoid: str(d[2]) || null, exchange: str(d[3]), currency: str(d[4]),
      close: num(d[5]), change: num(d[6]), volume: num(d[7]), relVolume: num(d[8]), marketCap: num(d[9]),
      sector: str(d[10]), industry: str(d[11]), pe: num(d[12]), eps: num(d[13]), divYield: num(d[14]),
      perfW: num(d[15]), perf1M: num(d[16]), perf3M: num(d[17]), perf6M: num(d[18]), perfYTD: num(d[19]), perfY: num(d[20]),
      rsi: num(d[21]), recommend: num(d[22]), volatility: num(d[23]),
    };
  });
  return { rows, total: json.totalCount ?? rows.length };
}

// Yahoo Finance suffix of each exchange, for the chart's data feed
const YAHOO_SUFFIX: Record<string, string> = {
  EURONEXT: '.PA', XETR: '.DE', FWB: '.F', LSE: '.L', MIL: '.MI', BME: '.MC', SIX: '.SW', TSE: '.T', TSX: '.TO', TSXV: '.V',
  NASDAQ: '', NYSE: '', AMEX: '', NYSE_ARCA: '', OTC: '',
};
const EURONEXT_BY_MARKET: Partial<Record<MarketId, string>> = { france: '.PA', netherlands: '.AS', belgium: '.BR' };

// Yahoo Finance id of a stock listed on a TradingView exchange
export function yahooTicker(exchange: string, ticker: string, market?: MarketId): string {
  const suffix = exchange === 'EURONEXT' ? (market && EURONEXT_BY_MARKET[market]) ?? '.PA' : YAHOO_SUFFIX[exchange] ?? '';
  const base = suffix === '' ? ticker.replace(/\./g, '-') : ticker.replace(/\//g, '-');
  return `${base}${suffix}`;
}

// the chart symbol of a screener row (quotes through Yahoo Finance)
export function stockSymbol(r: StockRow, market: MarketId): Symbol {
  return { ticker: r.ticker, name: r.name, basePrice: r.close ?? 100, category: 'Actions', exchange: r.exchange, yahoo: yahooTicker(r.exchange, r.ticker, market) };
}

// TradingView's rating from Recommend.All (-1..1)
export function ratingLabel(v: number | null): { text: string; cls: string } | null {
  if (v == null) return null;
  if (v > 0.5) return { text: 'Achat fort', cls: 'up' };
  if (v > 0.1) return { text: 'Achat', cls: 'up' };
  if (v >= -0.1) return { text: 'Neutre', cls: '' };
  if (v >= -0.5) return { text: 'Vente', cls: 'down' };
  return { text: 'Vente forte', cls: 'down' };
}
