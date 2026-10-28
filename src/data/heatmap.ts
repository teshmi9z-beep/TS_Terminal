import { num, str, tvScan } from './tv';
import { sectorFr } from './stockScreener';

// Data of TradingView's heatmaps ("Carte thermique"): the stocks of an index or a market,
// or the largest cryptocurrencies, with their size and performance fields.

export type HeatKind = 'stocks' | 'crypto';
export type HeatSource = { id: string; label: string; flag: string; kind: HeatKind; set?: string; market?: string; group: 'Indices' | 'Marchés' | 'Crypto' };

export const SOURCES: HeatSource[] = [
  { id: 'SPX', label: 'Indice S&P 500', flag: 'us', kind: 'stocks', set: 'SYML:SP;SPX', group: 'Indices' },
  { id: 'NDX', label: 'Nasdaq 100', flag: 'us', kind: 'stocks', set: 'SYML:NASDAQ;NDX', group: 'Indices' },
  { id: 'DJI', label: 'Dow Jones 30', flag: 'us', kind: 'stocks', set: 'SYML:DJ;DJI', group: 'Indices' },
  { id: 'RUT', label: 'Russell 2000', flag: 'us', kind: 'stocks', set: 'SYML:TVC;RUT', group: 'Indices' },
  { id: 'PX1', label: 'CAC 40', flag: 'fr', kind: 'stocks', set: 'SYML:EURONEXT;PX1', group: 'Indices' },
  { id: 'DAX', label: 'DAX 40', flag: 'de', kind: 'stocks', set: 'SYML:XETR;DAX', group: 'Indices' },
  { id: 'UKX', label: 'FTSE 100', flag: 'gb', kind: 'stocks', set: 'SYML:TVC;UKX', group: 'Indices' },
  { id: 'SX5E', label: 'Euro Stoxx 50', flag: 'eu', kind: 'stocks', set: 'SYML:TVC;SX5E', group: 'Indices' },
  { id: 'IBC', label: 'IBEX 35', flag: 'es', kind: 'stocks', set: 'SYML:BME;IBC', group: 'Indices' },
  { id: 'SMI', label: 'SMI 20', flag: 'ch', kind: 'stocks', set: 'SYML:SIX;SMI', group: 'Indices' },
  { id: 'NI225', label: 'Nikkei 225', flag: 'jp', kind: 'stocks', set: 'SYML:TVC;NI225', group: 'Indices' },
  { id: 'm-america', label: 'Toutes les actions américaines', flag: 'us', kind: 'stocks', market: 'america', group: 'Marchés' },
  { id: 'm-france', label: 'Toutes les actions françaises', flag: 'fr', kind: 'stocks', market: 'france', group: 'Marchés' },
  { id: 'm-germany', label: 'Toutes les actions allemandes', flag: 'de', kind: 'stocks', market: 'germany', group: 'Marchés' },
  { id: 'm-uk', label: 'Toutes les actions britanniques', flag: 'gb', kind: 'stocks', market: 'uk', group: 'Marchés' },
  { id: 'm-japan', label: 'Toutes les actions japonaises', flag: 'jp', kind: 'stocks', market: 'japan', group: 'Marchés' },
  { id: 'crypto', label: 'Toutes les cryptos', flag: '', kind: 'crypto', group: 'Crypto' },
];

export type SizeBy = 'cap' | 'value' | 'employees' | 'same';
export const SIZES: [SizeBy, string][] = [['cap', 'Capitalisation boursière'], ['value', 'Volume échangé 1J'], ['employees', 'Nombre d’employés'], ['same', 'Taille identique']];

export type ColorBy = 'change' | 'perfW' | 'perf1M' | 'perf3M' | 'perf6M' | 'perfYTD' | 'perfY' | 'premarket' | 'gap';
// label, and the move at which the color is the deepest
export const COLORS: [ColorBy, string, number][] = [
  ['change', 'Changement 1D, %', 3], ['perfW', 'Performance 1S, %', 6], ['perf1M', 'Performance 1M, %', 10], ['perf3M', 'Performance 3M, %', 20],
  ['perf6M', 'Performance 6M, %', 30], ['perfYTD', 'Performance YTD, %', 30], ['perfY', 'Performance 1A, %', 40],
  ['premarket', 'Changement pré-marché, %', 3], ['gap', 'Écart d’ouverture, %', 3],
];

export type GroupBy = 'sector' | 'industry' | 'none';

export type HeatRow = {
  id: string; ticker: string; name: string; logoid: string | null; sector: string; industry: string;
  close: number | null; currency: string;
  cap: number | null; value: number | null; employees: number | null;
  perf: Partial<Record<ColorBy, number | null>>;
};

const cache = new Map<string, { at: number; rows: HeatRow[] }>();

export async function fetchHeat(src: HeatSource, signal?: AbortSignal): Promise<HeatRow[]> {
  const hit = cache.get(src.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  let rows: HeatRow[];
  if (src.kind === 'crypto') {
    const r = await tvScan('coin', {
      columns: ['base_currency', 'base_currency_desc', 'base_currency_logoid', 'market_cap_calc', '24h_vol_cmc', '24h_close_change|5',
        'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'close', 'crypto_common_categories.tr'],
      sort: { sortBy: 'crypto_total_rank', sortOrder: 'asc' }, range: [0, 150],
    }, signal);
    rows = r.rows.map((x): HeatRow => {
      const d = x.d;
      const cats = Array.isArray(d[13]) ? (d[13] as string[]) : [];
      const cat = cats.find((c) => c !== 'Cryptocurrencies') ?? cats[0] ?? 'Crypto';
      return {
        id: x.s, ticker: str(d[0]), name: str(d[1]), logoid: str(d[2]) || null, sector: cat, industry: cat,
        close: num(d[12]), currency: 'USD', cap: num(d[3]), value: num(d[4]), employees: null,
        perf: { change: num(d[5]), perfW: num(d[6]), perf1M: num(d[7]), perf3M: num(d[8]), perf6M: num(d[9]), perfYTD: num(d[10]), perfY: num(d[11]) },
      };
    });
  } else {
    const body: Record<string, unknown> = {
      columns: ['name', 'description', 'logoid', 'sector', 'industry', 'market_cap_basic', 'Value.Traded', 'number_of_employees', 'close', 'currency',
        'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'premarket_change', 'gap'],
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [0, src.set ? 600 : 500],
    };
    if (src.set) body.symbols = { symbolset: [src.set] };
    else body.filter = [{ left: 'is_primary', operation: 'equal', right: true }, { left: 'type', operation: 'equal', right: 'stock' }];
    const r = await tvScan(src.market ?? 'global', body, signal);
    rows = r.rows.map((x): HeatRow => {
      const d = x.d;
      return {
        id: x.s, ticker: str(d[0]), name: str(d[1]), logoid: str(d[2]) || null, sector: sectorFr(str(d[3])) || 'Autre', industry: str(d[4]) || 'Autre',
        cap: num(d[5]), value: num(d[6]), employees: num(d[7]), close: num(d[8]), currency: str(d[9]),
        perf: { change: num(d[10]), perfW: num(d[11]), perf1M: num(d[12]), perf3M: num(d[13]), perf6M: num(d[14]), perfYTD: num(d[15]), perfY: num(d[16]), premarket: num(d[17]), gap: num(d[18]) },
      };
    });
    // one tile per company, like TradingView (GOOGL, not also GOOG): rows come largest first
    const seen = new Set<string>();
    rows = rows.filter((r) => { const k = r.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  cache.set(src.id, { at: Date.now(), rows });
  return rows;
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const x = hex(a), y = hex(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
};

// TradingView's scale: deep red, red, light red, grey at 0, light green, green, deep green
export function heatColor(v: number | null | undefined, max: number, dark: boolean): string {
  const zero = dark ? '#434651' : '#c1c4cd';
  if (v == null || !Number.isFinite(v)) return dark ? '#2a2e39' : '#e0e3eb';
  const stops = ['#991f29', '#f23645', '#f77c80', zero, '#42bd7f', '#089981', '#056656'];
  const t = Math.max(-3, Math.min(3, (v / max) * 3)) + 3;
  const i = Math.min(5, Math.floor(t));
  return mix(stops[i], stops[i + 1], t - i);
}
