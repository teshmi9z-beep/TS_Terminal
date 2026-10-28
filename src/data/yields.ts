// Government bond yields for the "Courbes de rendement" panel.
// Source: TradingView's public screener (the same TVC:xxYY symbols as its yield
// curves), relayed by the Vite server as /tvscan (see vite.config.ts). The past
// curves (1 month ago...) are derived from each symbol's performance over the period.

import { DEC } from '../i18n/lang';

export type YieldPeriod = 'current' | '1W' | '1M' | '3M' | '6M' | 'YTD' | '1Y';

export const YIELD_PERIODS: { id: YieldPeriod; label: string; field: string | null }[] = [
  { id: 'current', label: 'Actuel', field: null },
  { id: '1W', label: 'Il y a 1 semaine', field: 'Perf.W' },
  { id: '1M', label: 'Il y a 1 mois', field: 'Perf.1M' },
  { id: '3M', label: 'Il y a 3 mois', field: 'Perf.3M' },
  { id: '6M', label: 'Il y a 6 mois', field: 'Perf.6M' },
  { id: 'YTD', label: 'Début d’année', field: 'Perf.YTD' },
  { id: '1Y', label: 'Il y a 1 an', field: 'Perf.Y' },
];

export const periodLabel = (p: YieldPeriod) => YIELD_PERIODS.find((x) => x.id === p)?.label ?? p;

// the maturities shown by TradingView's yield curves
export const MATURITIES = [
  { key: '01M', label: '1M', long: '1 mois', years: 1 / 12 },
  { key: '03M', label: '3M', long: '3 mois', years: 0.25 },
  { key: '06M', label: '6M', long: '6 mois', years: 0.5 },
  { key: '01Y', label: '1Y', long: '1 an', years: 1 },
  { key: '02Y', label: '2Y', long: '2 ans', years: 2 },
  { key: '03Y', label: '3Y', long: '3 ans', years: 3 },
  { key: '05Y', label: '5Y', long: '5 ans', years: 5 },
  { key: '07Y', label: '7Y', long: '7 ans', years: 7 },
  { key: '10Y', label: '10Y', long: '10 ans', years: 10 },
  { key: '20Y', label: '20Y', long: '20 ans', years: 20 },
  { key: '30Y', label: '30Y', long: '30 ans', years: 30 },
] as const;
export type MaturityKey = (typeof MATURITIES)[number]['key'];

const NAMES: Record<string, string> = {
  AT: 'Autriche', AU: 'Australie', BE: 'Belgique', BR: 'Brésil', CA: 'Canada', CH: 'Suisse', CL: 'Chili',
  CN: 'Chine', CO: 'Colombie', CZ: 'Tchéquie', DE: 'Allemagne', DK: 'Danemark', ES: 'Espagne', EU: 'Zone euro',
  FI: 'Finlande', FR: 'France', GB: 'Royaume-Uni', GR: 'Grèce', HK: 'Hong Kong', HU: 'Hongrie', ID: 'Indonésie',
  IE: 'Irlande', IL: 'Israël', IN: 'Inde', IS: 'Islande', IT: 'Italie', JP: 'Japon', KR: 'Corée du Sud',
  LT: 'Lituanie', MX: 'Mexique', MY: 'Malaisie', NL: 'Pays-Bas', NO: 'Norvège', NZ: 'Nouvelle-Zélande',
  PE: 'Pérou', PH: 'Philippines', PL: 'Pologne', PT: 'Portugal', RO: 'Roumanie', RU: 'Russie', SE: 'Suède',
  SG: 'Singapour', SK: 'Slovaquie', TH: 'Thaïlande', TR: 'Turquie', TW: 'Taïwan', UA: 'Ukraine',
  US: 'États-Unis', VN: 'Viêt Nam', ZA: 'Afrique du Sud',
};

export type YieldPoint = { symbol: string; close: number; perf: Partial<Record<YieldPeriod, number>> };

export type CountryYields = {
  // ISO 3166 alpha-2 ('EU' for the euro area)
  code: string;
  name: string;
  points: Partial<Record<string, YieldPoint>>;
};

export type YieldSnapshot = { countries: Map<string, CountryYields>; at: number };

export const countryName = (code: string, snap?: YieldSnapshot | null) => NAMES[code] ?? snap?.countries.get(code)?.name ?? code;

export const flagUrl = (code: string) => `https://flagcdn.com/w40/${code.toLowerCase()}.png`;

const PERF_FIELDS = YIELD_PERIODS.filter((p) => p.field);
const COLUMNS = ['name', 'description', 'close', ...PERF_FIELDS.map((p) => p.field!)];

export async function fetchYields(signal?: AbortSignal): Promise<YieldSnapshot> {
  const res = await fetch('/tvscan/bonds/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: [{ left: 'description', operation: 'match', right: 'Government Bonds Yield' }],
      columns: COLUMNS,
      range: [0, 3000],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`taux indisponibles (${res.status})`);
  const json = (await res.json()) as { data?: { s: string; d: (string | number | null)[] }[] };
  const countries = new Map<string, CountryYields>();
  for (const row of json.data ?? []) {
    const [name, description, close] = row.d;
    // FR10Y, FR01MY, US03MY...
    const m = /^([A-Z]{2})(\d\d)([MY])Y?$/.exec(String(name));
    if (!m || typeof close !== 'number') continue;
    const code = m[1];
    const key = `${m[2]}${m[3]}`;
    let c = countries.get(code);
    if (!c) {
      const english = String(description).replace(/\s+\d+\s+(Year|Month).*$/, '').replace(/\s+LPS$/, '');
      c = { code, name: NAMES[code] ?? english, points: {} };
      countries.set(code, c);
    }
    const perf: YieldPoint['perf'] = {};
    PERF_FIELDS.forEach((p, i) => {
      const v = row.d[3 + i];
      if (typeof v === 'number') perf[p.id] = v;
    });
    c.points[key] = { symbol: row.s, close, perf };
  }
  if (!countries.size) throw new Error('aucun taux reçu');
  return { countries, at: Date.now() };
}

// yield (in %) of a maturity, now or at the start of a period:
// performance = (now - then) / then, so then = now / (1 + performance)
export function yieldAt(c: CountryYields | undefined, maturity: string, period: YieldPeriod): number | null {
  const p = c?.points[maturity];
  if (!p) return null;
  if (period === 'current') return p.close;
  const perf = p.perf[period];
  if (perf == null) return null;
  const k = 1 + perf / 100;
  if (Math.abs(k) < 1e-6) return null;
  const v = p.close / k;
  return Number.isFinite(v) ? v : null;
}

export const formatYield = (v: number) => `${v.toFixed(3).replace('.', DEC)}%`;
