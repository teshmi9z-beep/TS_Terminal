// number formatting shared by the tool pages (French or English style, see i18n/lang)

import { LOCALE, LANG } from '../i18n/lang';

export const fr = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });

export function big(v: number | null | undefined, cur = ''): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const [u, k] = a >= 1e12 ? ['T', 1e12] : a >= 1e9 ? ['B', 1e9] : a >= 1e6 ? ['M', 1e6] : a >= 1e3 ? ['K', 1e3] : ['', 1];
  return `${fr(v / k)}${u ? ` ${u}` : ''}${cur ? ` ${cur}` : ''}`;
}

export const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${fr(v, d)}%`);
export const signCls = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

// adaptive decimals for a price
export function price(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return fr(v, a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
}

const DAYS = LANG === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = LANG === 'en' ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] : ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export function dayTitle(t: number): string {
  const d = new Date(t * 1000);
  const s = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export const dayKey = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
export const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
export const shortDay = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

// "il y a 5 min", "il y a 3 h", else the date
export function ago(t: number): string {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}
