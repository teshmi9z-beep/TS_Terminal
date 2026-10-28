// Macro-economic data for the "Macro Maps" panel.
// - latest values: TradingView's public screener (ECONOMICS:xxIRYY... symbols,
//   observation date included), relayed by the Vite server as /tvscan;
// - history for the time slider: World Bank (annual) and, for policy rates, the
//   Bank for International Settlements (monthly). Both allow direct browser calls.

import { LANG } from '../i18n/lang';

export type MacroId = 'IRYY' | 'INTR' | 'GDP' | 'GDPYY' | 'UR' | 'GDG' | 'CAG' | 'POP';

export type MacroDef = {
  id: MacroId;
  label: string;
  unit: 'pct' | 'usd' | 'people';
  // 5 bucket boundaries -> 6 colors; the legend labels boundaries 1, 3 and 5
  thresholds: number[];
  palette: string[];
  worldBank: string | null;
  bis?: boolean;
};

const WARM = ['#3a2b1d', '#5c3d1f', '#8a5626', '#e8912d', '#f6b76e', '#fad7ab'];
const BLUE = ['#1a2940', '#1d3e6a', '#235a9c', '#2f7fd1', '#5aa4ea', '#a5cff5'];
const GREEN = ['#1a3a2a', '#0d5b36', '#0a7a45', '#069a52', '#3dbd83', '#7ad8ad'];
const DIVERGING = ['#8e2b2b', '#c0504d', '#6d6d6d', '#4f9a6f', '#2f9e59', '#7ad8ad'];
const PURPLE = ['#2a2140', '#3f2d6b', '#5a3d9c', '#7e57c2', '#a585e0', '#d0bff5'];
const RED = ['#3d1d1d', '#6b2626', '#9c3030', '#d14040', '#ea7a7a', '#f5b5b5'];

export const MACROS: MacroDef[] = [
  { id: 'IRYY', label: 'Taux de l’inflation', unit: 'pct', thresholds: [3, 5, 7, 15, 30], palette: WARM, worldBank: 'FP.CPI.TOTL.ZG' },
  { id: 'INTR', label: 'Taux d’intérêt', unit: 'pct', thresholds: [1, 3, 5, 10, 20], palette: BLUE, worldBank: null, bis: true },
  { id: 'GDP', label: 'PIB', unit: 'usd', thresholds: [1e10, 1e11, 5e11, 1e12, 5e12], palette: GREEN, worldBank: 'NY.GDP.MKTP.CD' },
  { id: 'GDPYY', label: 'Croissance du PIB', unit: 'pct', thresholds: [-2, 0, 2, 4, 6], palette: DIVERGING, worldBank: 'NY.GDP.MKTP.KD.ZG' },
  { id: 'UR', label: 'Taux de chômage', unit: 'pct', thresholds: [3, 5, 7, 10, 15], palette: PURPLE, worldBank: 'SL.UEM.TOTL.ZS' },
  { id: 'GDG', label: 'Dette publique / PIB', unit: 'pct', thresholds: [30, 60, 90, 120, 150], palette: RED, worldBank: 'GC.DOD.TOTL.GD.ZS' },
  { id: 'CAG', label: 'Balance courante / PIB', unit: 'pct', thresholds: [-5, -2, 0, 2, 5], palette: DIVERGING, worldBank: 'BN.CAB.XOKA.GD.ZS' },
  { id: 'POP', label: 'Population', unit: 'people', thresholds: [5e6, 2e7, 5e7, 1e8, 5e8], palette: BLUE, worldBank: 'SP.POP.TOTL' },
];

export const macroDef = (id: string) => MACROS.find((m) => m.id === id) ?? MACROS[0];

export const bucketOf = (def: MacroDef, v: number) => def.thresholds.filter((t) => v >= t).length;

export const GROUPS: { id: string; label: string; codes: string[] | null }[] = [
  { id: 'G20', label: 'G20', codes: ['AR', 'AU', 'BR', 'CA', 'CN', 'FR', 'DE', 'IN', 'ID', 'IT', 'JP', 'KR', 'MX', 'RU', 'SA', 'ZA', 'TR', 'GB', 'US', 'EU'] },
  { id: 'G7', label: 'G7', codes: ['CA', 'FR', 'DE', 'IT', 'JP', 'GB', 'US'] },
  { id: 'UE', label: 'Union européenne', codes: ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'] },
  { id: 'WORLD', label: 'Monde', codes: null },
];

// one observation: value and the start of its period (UTC seconds)
export type MacroObs = { v: number; t: number; annual: boolean };
export type MacroCurrent = { code: string; symbol: string; obs: MacroObs };

const MONTHS = LANG === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] : ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];
export function obsLabel(o: Pick<MacroObs, 't' | 'annual'>): string {
  const d = new Date(o.t * 1000);
  return o.annual ? String(d.getUTCFullYear()) : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function monthLabel(t: number): string {
  const d = new Date(t * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function compact(v: number, unit: string) {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T${unit}`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B${unit}`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M${unit}`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K${unit}`;
  return `${v.toFixed(0)}${unit}`;
}

// TradingView's style: "33.5%", "30.77T USD", "342.28M"
export function formatMacro(def: MacroDef, v: number): string {
  if (def.unit === 'usd') return compact(v, ' USD');
  if (def.unit === 'people') return compact(v, '');
  return `${+v.toFixed(2)}%`;
}

export function thresholdLabel(def: MacroDef, v: number): string {
  if (def.unit === 'usd') return compact(v, '').replace('.00', '');
  if (def.unit === 'people') return compact(v, '').replace('.00', '');
  return `${v}%`;
}

// ---------------------------------------------------------------- latest values

export async function fetchMacroCurrent(id: MacroId, signal?: AbortSignal): Promise<Map<string, MacroCurrent>> {
  const res = await fetch('/tvscan/global/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: [
        { left: 'exchange', operation: 'equal', right: 'ECONOMICS' },
        { left: 'name', operation: 'match', right: `^[A-Z]{2}${id}$` },
      ],
      columns: ['name', 'close', 'time', 'logoid'],
      range: [0, 500],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`données indisponibles (${res.status})`);
  const json = (await res.json()) as { data?: { s: string; d: (string | number | null)[] }[] };
  const out = new Map<string, MacroCurrent>();
  for (const row of json.data ?? []) {
    const [name, close, time, logoid] = row.d;
    if (typeof close !== 'number' || typeof time !== 'number') continue;
    const fromLogo = typeof logoid === 'string' && logoid.startsWith('country/') ? logoid.slice(8).toUpperCase() : null;
    const code = fromLogo ?? String(name).slice(0, 2);
    // the bar time is the end of the observed period: keep the start of its month
    const d = new Date(time * 1000);
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    out.set(code, { code, symbol: String(name), obs: { v: close, t, annual: false } });
  }
  if (!out.size) throw new Error('aucune donnée reçue');
  return out;
}

// ---------------------------------------------------------------- history

export type MacroHistory = { series: Map<string, MacroObs[]>; start: number; end: number; source: string };

async function worldBankHistory(code: string, signal?: AbortSignal): Promise<MacroHistory> {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=20000&date=1960:${new Date().getUTCFullYear()}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Banque mondiale (${res.status})`);
  const json = (await res.json()) as [unknown, { country: { id: string }; date: string; value: number | null }[] | null];
  const series = new Map<string, MacroObs[]>();
  for (const r of json[1] ?? []) {
    if (r.value == null) continue;
    // XC = euro area in the World Bank's codes (its "EU" is the European Union)
    const c = r.country.id === 'XC' ? 'EU' : r.country.id === 'EU' ? '' : r.country.id;
    if (!/^[A-Z]{2}$/.test(c)) continue;
    const t = Date.UTC(parseInt(r.date), 0, 1) / 1000;
    let arr = series.get(c);
    if (!arr) { arr = []; series.set(c, arr); }
    arr.push({ v: r.value, t, annual: true });
  }
  return finish(series, 'Banque mondiale (annuel)');
}

async function bisPolicyRates(signal?: AbortSignal): Promise<MacroHistory> {
  const res = await fetch('https://stats.bis.org/api/v1/data/WS_CBPOL/M../all?detail=dataonly&format=csv', { signal });
  if (!res.ok) throw new Error(`BRI (${res.status})`);
  const text = await res.text();
  const series = new Map<string, MacroObs[]>();
  for (const line of text.split('\n').slice(1)) {
    const [, area, period, value] = line.split(',');
    if (!area || !period || value == null || value.trim() === '') continue;
    const v = parseFloat(value);
    const [y, m] = period.split('-').map((x) => parseInt(x));
    if (isNaN(v) || isNaN(y) || isNaN(m)) continue;
    const c = area === 'XM' ? 'EU' : area;
    let arr = series.get(c);
    if (!arr) { arr = []; series.set(c, arr); }
    arr.push({ v, t: Date.UTC(y, m - 1, 1) / 1000, annual: false });
  }
  return finish(series, 'BRI, taux directeurs (mensuel)');
}

function finish(series: Map<string, MacroObs[]>, source: string): MacroHistory {
  let start = Infinity, end = -Infinity;
  for (const arr of series.values()) {
    arr.sort((a, b) => a.t - b.t);
    start = Math.min(start, arr[0].t);
    end = Math.max(end, arr[arr.length - 1].t);
  }
  if (!series.size) throw new Error('historique vide');
  return { series, start, end, source };
}

const historyCache = new Map<MacroId, Promise<MacroHistory>>();
export function fetchMacroHistory(def: MacroDef): Promise<MacroHistory> {
  let p = historyCache.get(def.id);
  if (!p) {
    p = def.bis ? bisPolicyRates() : def.worldBank ? worldBankHistory(def.worldBank) : Promise.reject(new Error('pas d’historique'));
    historyCache.set(def.id, p);
    p.catch(() => historyCache.delete(def.id));
  }
  return p;
}

// last observation at or before t, if not too old (1 year of a monthly series, 2 of an annual one)
export function obsAt(hist: MacroHistory, code: string, t: number): MacroObs | null {
  const arr = hist.series.get(code);
  if (!arr?.length) return null;
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  if (best < 0) return null;
  const o = arr[best];
  const maxAge = (o.annual ? 2 : 1) * 366 * 86400;
  return t - o.t <= maxAge ? o : null;
}
