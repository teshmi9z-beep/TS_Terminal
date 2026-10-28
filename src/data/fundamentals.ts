import { num, str, tvScan } from './tv';

// Annual and quarterly history of a few financial metrics (TradingView screener, *_fy_h / *_fq_h columns).

export type MetricId = 'total_revenue' | 'gross_profit' | 'ebitda' | 'net_income' | 'earnings_per_share_diluted'
  | 'free_cash_flow' | 'total_debt' | 'total_assets' | 'dps_common_stock_prim_issue' | 'gross_margin' | 'net_margin';

export const METRICS: { id: MetricId; label: string; kind: 'money' | 'per_share' | 'pct'; fyOnly?: boolean }[] = [
  { id: 'total_revenue', label: 'Chiffre d’affaires', kind: 'money' },
  { id: 'gross_profit', label: 'Bénéfice brut', kind: 'money' },
  { id: 'ebitda', label: 'EBITDA', kind: 'money' },
  { id: 'net_income', label: 'Résultat net', kind: 'money' },
  { id: 'earnings_per_share_diluted', label: 'BPA dilué', kind: 'per_share' },
  { id: 'free_cash_flow', label: 'Flux de trésorerie disponible', kind: 'money' },
  { id: 'total_debt', label: 'Dette totale', kind: 'money' },
  { id: 'total_assets', label: 'Total de l’actif', kind: 'money' },
  { id: 'dps_common_stock_prim_issue', label: 'Dividende par action', kind: 'per_share', fyOnly: true },
  { id: 'gross_margin', label: 'Marge brute', kind: 'pct' },
  { id: 'net_margin', label: 'Marge nette', kind: 'pct' },
];

const RAW: MetricId[] = ['total_revenue', 'gross_profit', 'ebitda', 'net_income', 'earnings_per_share_diluted', 'free_cash_flow', 'total_debt', 'total_assets'];

export type Series = { labels: string[]; values: Partial<Record<MetricId, (number | null)[]>> };
export type Fundamentals = { id: string; name: string; logoid: string | null; current: string; fy: Series; fq: Series };

const arr = (v: unknown) => (Array.isArray(v) ? v.map(num) : null);

// "2026-Q3" -> labels of the quarters before it, newest first ("T3 2026", "T2 2026"...)
function quarterLabels(current: string, n: number): string[] {
  const m = /^(\d{4})-Q([1-4])$/.exec(current);
  if (!m) return [];
  let y = +m[1], q = +m[2];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`T${q} ${y}`);
    if (--q === 0) { q = 4; y--; }
  }
  return out;
}

const cache = new Map<string, Promise<Fundamentals | null>>();

async function load(id: string): Promise<Fundamentals | null> {
  const cols = ['description', 'logoid', 'fiscal_period_current', 'fiscal_period_fy_h', 'dps_common_stock_prim_issue_fy_h',
    ...RAW.map((m) => `${m}_fy_h`), ...RAW.map((m) => `${m}_fq_h`)];
  const { rows } = await tvScan('global', { symbols: { tickers: [id] }, columns: cols });
  const d = rows[0]?.d;
  if (!d) return null;
  const years = (Array.isArray(d[3]) ? d[3] : []).map((y) => String(y));
  const fy: Series = { labels: years, values: { dps_common_stock_prim_issue: arr(d[4]) ?? undefined } };
  const fqRaw = RAW.map((_, i) => arr(d[5 + RAW.length + i]));
  const nq = Math.max(0, ...fqRaw.map((a) => a?.length ?? 0));
  const fq: Series = { labels: quarterLabels(str(d[2]), nq), values: {} };
  RAW.forEach((m, i) => {
    fy.values[m] = arr(d[5 + i]) ?? undefined;
    fq.values[m] = fqRaw[i] ?? undefined;
  });
  for (const s of [fy, fq]) {
    const rev = s.values.total_revenue;
    const ratio = (a?: (number | null)[]) => (a && rev ? a.map((v, i) => (v != null && rev[i] ? (v / rev[i]!) * 100 : null)) : undefined);
    s.values.gross_margin = ratio(s.values.gross_profit);
    s.values.net_margin = ratio(s.values.net_income);
  }
  return { id, name: str(d[0]), logoid: str(d[1]) || null, current: str(d[2]), fy, fq };
}

export function fetchFundamentals(id: string): Promise<Fundamentals | null> {
  let p = cache.get(id);
  if (!p) {
    p = load(id);
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

export function cachedFundamentals(id: string): Fundamentals | null | undefined {
  return resolved.get(id);
}
const resolved = new Map<string, Fundamentals | null>();
export async function loadFundamentals(id: string): Promise<void> {
  resolved.set(id, await fetchFundamentals(id));
}

// the symbol the fundamentals page opens on next (a chart's earnings card), read once
let target: string | null = null;
export const setFundamentalsTarget = (id: string) => { target = id; };
export function takeFundamentalsTarget(): string | null {
  const t = target;
  target = null;
  return t;
}
