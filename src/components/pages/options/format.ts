import { fr } from '../../../data/format';
import { LANG } from '../../../i18n/lang';

// labels of the options pages

const MONTHS = LANG === 'en' ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] : ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

// 20260924 -> "24 septembre" (with the year when it isn't this year)
export function expLabel(e: number, short = false): string {
  const y = Math.floor(e / 10000), m = Math.floor(e / 100) % 100 - 1, d = e % 100;
  const label = `${d} ${(short ? MONTHS_SHORT : MONTHS)[m]}`;
  return y === new Date().getFullYear() ? label : `${label} ${short ? String(y).slice(2) : y}`;
}

export const strikeLabel = (k: number) => fr(k, k % 1 ? (Math.round(k * 100) % 10 ? 2 : 1) : 0);
export const n2 = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : fr(v, d));
export const compact = (v: number | null | undefined) => {
  if (v == null) return '—';
  if (v >= 1e6) return `${fr(v / 1e6, 1)}M`;
  if (v >= 1e4) return `${fr(v / 1e3, 1)}K`;
  if (v >= 1e3) return `${fr(v / 1e3, 1)}K`;
  return String(v);
};


export type Side = 'calls' | 'puts' | 'both';
export type ColId = 'delta' | 'be' | 'iv' | 'theo' | 'bidask' | 'dist' | 'oi' | 'volume' | 'gamma' | 'theta' | 'vega' | 'rho';
export const COLUMNS: { id: ColId; label: string }[] = [
  { id: 'delta', label: 'Delta' }, { id: 'gamma', label: 'Gamma' }, { id: 'theta', label: 'Theta' }, { id: 'vega', label: 'Vega' },
  { id: 'rho', label: 'Rho' }, { id: 'be', label: 'BE' }, { id: 'iv', label: 'IV' }, { id: 'theo', label: 'Théorique' },
  { id: 'bidask', label: 'Bid × Ask' }, { id: 'dist', label: 'Distance' }, { id: 'oi', label: 'OI' }, { id: 'volume', label: 'Volume' },
];
export const DEFAULT_COLS: ColId[] = ['delta', 'be', 'iv', 'theo', 'bidask', 'dist', 'oi', 'volume'];

// what a click on a price adds to the strategy: one option, or the two of a spread
export type Pick = { type: 'call' | 'put'; strike: number; qty: 1 | -1; price: number; iv: number }[];

