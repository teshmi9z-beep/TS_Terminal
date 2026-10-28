import { tvScan, num, str } from './tv';

// Calendars of the "Calendrier" page.
// - economic: ForexFactory's public weekly feed (current week only), relayed as /ffcal;
//   it gives the forecast and previous values, not the actual one;
// - earnings / dividends / IPO: TradingView's screener, for any week.

// ---------------------------------------------------------------- countries

export type Country = { code: string; name: string; market: string | null; region: 'Amériques' | 'Europe' | 'Asie-Pacifique' | 'Moyen-Orient et Afrique' };
export const COUNTRIES: Country[] = [
  { code: 'us', name: 'États-Unis', market: 'america', region: 'Amériques' },
  { code: 'ca', name: 'Canada', market: 'canada', region: 'Amériques' },
  { code: 'br', name: 'Brésil', market: 'brazil', region: 'Amériques' },
  { code: 'mx', name: 'Mexique', market: 'mexico', region: 'Amériques' },
  { code: 'eu', name: 'Zone euro', market: null, region: 'Europe' },
  { code: 'fr', name: 'France', market: 'france', region: 'Europe' },
  { code: 'de', name: 'Allemagne', market: 'germany', region: 'Europe' },
  { code: 'gb', name: 'Royaume-Uni', market: 'uk', region: 'Europe' },
  { code: 'it', name: 'Italie', market: 'italy', region: 'Europe' },
  { code: 'es', name: 'Espagne', market: 'spain', region: 'Europe' },
  { code: 'nl', name: 'Pays-Bas', market: 'netherlands', region: 'Europe' },
  { code: 'be', name: 'Belgique', market: 'belgium', region: 'Europe' },
  { code: 'ch', name: 'Suisse', market: 'switzerland', region: 'Europe' },
  { code: 'tr', name: 'Turquie', market: 'turkey', region: 'Europe' },
  { code: 'jp', name: 'Japon', market: 'japan', region: 'Asie-Pacifique' },
  { code: 'cn', name: 'Chine', market: 'china', region: 'Asie-Pacifique' },
  { code: 'hk', name: 'Hong Kong', market: 'hongkong', region: 'Asie-Pacifique' },
  { code: 'in', name: 'Inde', market: 'india', region: 'Asie-Pacifique' },
  { code: 'kr', name: 'Corée du Sud', market: 'korea', region: 'Asie-Pacifique' },
  { code: 'au', name: 'Australie', market: 'australia', region: 'Asie-Pacifique' },
  { code: 'nz', name: 'Nouvelle-Zélande', market: 'newzealand', region: 'Asie-Pacifique' },
  { code: 'za', name: 'Afrique du Sud', market: 'rsa', region: 'Moyen-Orient et Afrique' },
  { code: 'sa', name: 'Arabie saoudite', market: 'ksa', region: 'Moyen-Orient et Afrique' },
];
export const G20 = ['us', 'ca', 'br', 'mx', 'eu', 'fr', 'de', 'gb', 'it', 'tr', 'jp', 'cn', 'in', 'kr', 'au', 'za', 'sa'];
export const countryName = (code: string) => COUNTRIES.find((c) => c.code === code)?.name ?? code.toUpperCase();
export const flagUrl = (code: string) => `https://flagcdn.com/w40/${code}.png`;
const MARKET_COUNTRY = new Map(COUNTRIES.filter((c) => c.market).map((c) => [c.market!, c.code]));
export const countryOfMarket = (market: string) => MARKET_COUNTRY.get(market) ?? null;

// ---------------------------------------------------------------- economic events

export type EcoCategory = 'labor' | 'prices' | 'bank' | 'growth' | 'business' | 'consumer' | 'housing' | 'trade' | 'energy' | 'bonds' | 'holiday' | 'other';
export const ECO_CATEGORIES: [EcoCategory, string][] = [
  ['labor', 'Travail'], ['prices', 'Prix'], ['bank', 'Banque centrale'], ['growth', 'PIB'], ['business', 'Activité'],
  ['consumer', 'Consommation'], ['housing', 'Immobilier'], ['trade', 'Commerce'], ['energy', 'Énergie'], ['bonds', 'Obligations'],
  ['holiday', 'Jours fériés'], ['other', 'Autres'],
];
const CATEGORY_RULES: [RegExp, EcoCategory][] = [
  [/Holiday/i, 'holiday'],
  [/Auction|Bond|Bill|Note Auction/i, 'bonds'],
  [/Employment|Unemployment|Jobless|Payroll|Claims|Earnings|Wage|JOLTS|ADP|Labor|Jobs/i, 'labor'],
  [/CPI|PPI|PCE|Inflation|Price Index|Prices/i, 'prices'],
  [/Rate|Speaks|Speech|FOMC|ECB|BOE|BOJ|Fed|Monetary|Minutes|Policy|Governor|President|Lagarde|Powell/i, 'bank'],
  [/GDP/i, 'growth'],
  [/PMI|ISM|Production|Factory|Orders|Ifo|ZEW|Business|Industrial|Manufacturing|Tankan/i, 'business'],
  [/Retail|Consumer|Spending|Sentiment|Confidence/i, 'consumer'],
  [/Home|Housing|Building|Permits|Starts|House|Mortgage/i, 'housing'],
  [/Trade|Current Account|Export|Import/i, 'trade'],
  [/Crude|Oil|Natural Gas|Inventories/i, 'energy'],
];
const categoryOf = (title: string): EcoCategory => CATEGORY_RULES.find(([re]) => re.test(title))?.[1] ?? 'other';

const CURRENCY_COUNTRY: Record<string, string> = { USD: 'us', EUR: 'eu', GBP: 'gb', JPY: 'jp', CHF: 'ch', CAD: 'ca', AUD: 'au', NZD: 'nz', CNY: 'cn' };
// euro area events of one country are prefixed with it ("German Ifo Business Climate")
const EURO_PREFIX: [RegExp, string][] = [[/^German /, 'de'], [/^French /, 'fr'], [/^Italian /, 'it'], [/^Spanish /, 'es']];

export type EcoEvent = {
  title: string; country: string; category: EcoCategory; time: number;
  impact: 'Low' | 'Medium' | 'High' | 'Holiday'; forecast: string; previous: string; actual: string;
};

let ecoCache: { at: number; events: EcoEvent[] } | null = null;

export async function fetchEconomic(): Promise<EcoEvent[]> {
  if (ecoCache && Date.now() - ecoCache.at < 10 * 60_000) return ecoCache.events;
  const r = await fetch('/ffcal/ff_calendar_thisweek.json');
  if (!r.ok) throw new Error(`calendrier économique indisponible (${r.status})`);
  const json = (await r.json()) as { title: string; country: string; date: string; impact: string; forecast: string; previous: string; actual?: string }[];
  const events = json.map((e): EcoEvent => {
    let country = CURRENCY_COUNTRY[e.country] ?? e.country.toLowerCase();
    let title = e.title;
    if (e.country === 'EUR') {
      const p = EURO_PREFIX.find(([re]) => re.test(title));
      if (p) { country = p[1]; title = title.replace(p[0], ''); }
    }
    return {
      title: eventFr(title), country, category: categoryOf(e.title), time: Date.parse(e.date) / 1000,
      impact: (['Low', 'Medium', 'High', 'Holiday'].includes(e.impact) ? e.impact : 'Low') as EcoEvent['impact'],
      forecast: e.forecast ?? '', previous: e.previous ?? '', actual: e.actual ?? '',
    };
  }).sort((a, b) => a.time - b.time);
  ecoCache = { at: Date.now(), events };
  return events;
}

// French names of the most common events
const EVENT_FR: [RegExp, string][] = [
  [/^Non-Farm Employment Change/, 'Créations d’emplois non agricoles'],
  [/^Unemployment Rate/, 'Taux de chômage'],
  [/^Unemployment Claims/, 'Inscriptions au chômage'],
  [/^CPI m\/m/, 'IPC m/m'], [/^CPI y\/y/, 'IPC a/a'], [/^Core CPI m\/m/, 'IPC de base m/m'], [/^Core CPI y\/y/, 'IPC de base a/a'],
  [/^Prelim CPI m\/m/, 'IPC m/m (préliminaire)'], [/^Flash CPI y\/y/, 'IPC a/a (flash)'],
  [/^PPI m\/m/, 'IPP m/m'], [/^Core PPI m\/m/, 'IPP de base m/m'],
  [/^Retail Sales m\/m/, 'Ventes au détail m/m'], [/^Core Retail Sales m\/m/, 'Ventes au détail de base m/m'],
  [/^GDP q\/q/, 'PIB t/t'], [/^Prelim GDP q\/q/, 'PIB t/t (préliminaire)'], [/^Final GDP q\/q/, 'PIB t/t (final)'],
  [/^Federal Funds Rate/, 'Taux des fonds fédéraux'], [/^FOMC Statement/, 'Communiqué du FOMC'], [/^FOMC Meeting Minutes/, 'Compte rendu du FOMC'],
  [/^FOMC Press Conference/, 'Conférence de presse du FOMC'], [/^Main Refinancing Rate/, 'Taux de refinancement BCE'],
  [/^Monetary Policy Statement/, 'Déclaration de politique monétaire'], [/^ECB Press Conference/, 'Conférence de presse de la BCE'],
  [/^Official Bank Rate/, 'Taux directeur BoE'], [/^BOJ Policy Rate/, 'Taux directeur BoJ'],
  [/^Flash Manufacturing PMI/, 'PMI manufacturier (flash)'], [/^Flash Services PMI/, 'PMI des services (flash)'],
  [/Manufacturing PMI/, 'PMI manufacturier'], [/Services PMI/, 'PMI des services'], [/^ISM Manufacturing PMI/, 'PMI manufacturier ISM'],
  [/^ISM Services PMI/, 'PMI des services ISM'], [/^Crude Oil Inventories/, 'Stocks de pétrole brut'], [/^Natural Gas Storage/, 'Stocks de gaz naturel'],
  [/^Consumer Confidence/, 'Confiance des consommateurs'], [/Consumer Sentiment/, 'Sentiment des consommateurs'],
  [/^Trade Balance/, 'Balance commerciale'], [/^Industrial Production m\/m/, 'Production industrielle m/m'],
  [/^Building Permits/, 'Permis de construire'], [/^Housing Starts/, 'Mises en chantier'], [/^Existing Home Sales/, 'Ventes de logements existants'],
  [/^New Home Sales/, 'Ventes de logements neufs'], [/^Pending Home Sales/, 'Promesses de ventes de logements'],
  [/^Durable Goods Orders m\/m/, 'Commandes de biens durables m/m'], [/^Core Durable Goods Orders m\/m/, 'Commandes de biens durables de base m/m'],
  [/^Core PCE Price Index m\/m/, 'Indice des prix PCE de base m/m'], [/^Average Hourly Earnings m\/m/, 'Salaire horaire moyen m/m'],
  [/^JOLTS Job Openings/, 'Offres d’emploi JOLTS'], [/^ADP Non-Farm Employment Change/, 'Emploi privé ADP'],
  [/^Ifo Business Climate/, 'Climat des affaires Ifo'], [/^ZEW Economic Sentiment/, 'Sentiment économique ZEW'],
  [/^Bank Holiday/, 'Jour férié'], [/Speaks$/, ''],
];
export function eventFr(title: string): string {
  for (const [re, fr] of EVENT_FR) {
    if (re.test(title)) return fr ? title.replace(re, fr) : title.replace(/ Speaks$/, ' (discours)');
  }
  return title;
}

// ---------------------------------------------------------------- earnings / dividends / IPO

const scanBase = (markets: string[] | null) => ({
  ...(markets?.length ? { markets } : {}),
  symbols: { query: { types: ['stock', 'dr'] } },
  sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
});

export type EarningsRow = {
  id: string; ticker: string; name: string; logoid: string | null; marketCap: number | null; currency: string; country: string | null;
  date: number; when: 'before' | 'after' | null;
  epsEstimate: number | null; epsActual: number | null; revenueEstimate: number | null; revenueActual: number | null;
};

// companies reporting in [from, to): the past ones (reported) and the coming ones
export async function fetchEarnings(from: number, to: number, markets: string[] | null, signal?: AbortSignal): Promise<EarningsRow[]> {
  const query = (past: boolean) => tvScan('global', {
    ...scanBase(markets),
    filter: [{ left: past ? 'earnings_release_date' : 'earnings_release_next_date', operation: 'in_range', right: [from, to] }, { left: 'is_primary', operation: 'equal', right: true }],
    columns: past
      ? ['name', 'description', 'logoid', 'market_cap_basic', 'currency', 'market', 'earnings_release_date', 'earnings_release_time', 'earnings_per_share_forecast_fq', 'earnings_per_share_fq', 'revenue_forecast_fq', 'total_revenue_fq']
      : ['name', 'description', 'logoid', 'market_cap_basic', 'currency', 'market', 'earnings_release_next_date', 'earnings_release_next_time', 'earnings_per_share_forecast_next_fq', 'earnings_per_share_fq', 'revenue_forecast_next_fq', 'total_revenue_fq'],
    range: [0, 1500],
  }, signal).then((r) => r.rows.map((x): EarningsRow => {
    const d = x.d;
    const t = num(d[7]);
    return {
      id: x.s, ticker: str(d[0]), name: str(d[1]), logoid: str(d[2]) || null, marketCap: num(d[3]), currency: str(d[4]), country: countryOfMarket(str(d[5])),
      date: num(d[6]) ?? 0, when: t === -1 ? 'before' : t === 1 ? 'after' : null,
      epsEstimate: num(d[8]), epsActual: past ? num(d[9]) : null, revenueEstimate: num(d[10]), revenueActual: past ? num(d[11]) : null,
    };
  }));
  const [past, next] = await Promise.all([query(true), query(false)]);
  const seen = new Set(past.map((r) => r.id));
  return [...past, ...next.filter((r) => !seen.has(r.id))];
}

export type DividendRow = {
  id: string; ticker: string; name: string; logoid: string | null; currency: string; country: string | null;
  exDate: number; payDate: number | null; amount: number | null; yieldPct: number | null; close: number | null;
};

export async function fetchDividends(from: number, to: number, markets: string[] | null, signal?: AbortSignal): Promise<DividendRow[]> {
  const query = (past: boolean) => tvScan('global', {
    ...scanBase(markets),
    filter: [{ left: past ? 'ex_dividend_date_recent' : 'ex_dividend_date_upcoming', operation: 'in_range', right: [from, to] }, { left: 'is_primary', operation: 'equal', right: true }],
    columns: past
      ? ['name', 'description', 'logoid', 'currency', 'market', 'ex_dividend_date_recent', 'dividend_payment_date_recent', 'dividend_amount_recent', 'dividends_yield_current', 'close']
      : ['name', 'description', 'logoid', 'currency', 'market', 'ex_dividend_date_upcoming', 'dividend_payment_date_upcoming', 'dividend_amount_upcoming', 'dividends_yield_current', 'close'],
    range: [0, 1500],
  }, signal).then((r) => r.rows.map((x): DividendRow => {
    const d = x.d;
    return {
      id: x.s, ticker: str(d[0]), name: str(d[1]), logoid: str(d[2]) || null, currency: str(d[3]), country: countryOfMarket(str(d[4])),
      exDate: num(d[5]) ?? 0, payDate: num(d[6]), amount: num(d[7]), yieldPct: num(d[8]), close: num(d[9]),
    };
  }));
  const [past, next] = await Promise.all([query(true), query(false)]);
  const seen = new Set(past.map((r) => `${r.id}|${r.exDate}`));
  return [...past, ...next.filter((r) => !seen.has(`${r.id}|${r.exDate}`))];
}

export type IpoRow = {
  id: string; ticker: string; name: string; logoid: string | null; exchange: string; country: string | null;
  date: number; price: number | null; rangeLo: number | null; rangeHi: number | null; shares: number | null; amount: number | null; cap: number | null; status: string;
};

export async function fetchIpos(from: number, to: number, markets: string[] | null, signal?: AbortSignal): Promise<IpoRow[]> {
  const { rows } = await tvScan('global', {
    ...(markets?.length ? { markets } : {}),
    filter: [{ left: 'ipo_offer_date', operation: 'in_range', right: [from, to] }],
    columns: ['name', 'description', 'logoid', 'exchange', 'market', 'ipo_offer_date', 'ipo_offer_price_usd', 'ipo_price_range_usd_min', 'ipo_price_range_usd_max', 'ipo_offered_shares', 'ipo_deal_amount_usd', 'ipo_market_cap_usd', 'ipo_offer_status'],
    sort: { sortBy: 'ipo_deal_amount_usd', sortOrder: 'desc' },
    range: [0, 500],
  }, signal);
  return rows.map((x): IpoRow => {
    const d = x.d;
    return {
      id: x.s, ticker: str(d[0]), name: str(d[1]), logoid: str(d[2]) || null, exchange: str(d[3]), country: countryOfMarket(str(d[4])),
      date: num(d[5]) ?? 0, price: num(d[6]), rangeLo: num(d[7]), rangeHi: num(d[8]), shares: num(d[9]), amount: num(d[10]), cap: num(d[11]), status: str(d[12]),
    };
  });
}
