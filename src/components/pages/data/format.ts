// numbers and dates of the "Développeur · Data" tab

import { LOCALE } from '../../../i18n/lang';

export const n0 = (v: number) => Math.round(v).toLocaleString(LOCALE);

export const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} Go`
  : bytes >= 1e6 ? `${(bytes / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: bytes < 1e7 ? 1 : 0 })} Mo` : `${Math.max(1, Math.round(bytes / 1e3))} Ko`);

export const day = (t: number) => (Number.isFinite(t) ? new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
export const dayTime = (t: number) => (Number.isFinite(t) ? new Date(t * 1000).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

const DAY = 86400, YEAR = 365.25 * DAY;
// how long a history covers: 5 h, 12 j, 8 mois, 1,5 an, 23 ans
export function span(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 2 * DAY) return `${Math.max(1, Math.round(seconds / 3600))} h`;
  if (seconds < 60 * DAY) return `${Math.round(seconds / DAY)} j`;
  if (seconds < 0.96 * YEAR) return `${Math.round(seconds / (YEAR / 12))} mois`;
  const y = Math.round((seconds / YEAR) * (seconds < 10 * YEAR ? 10 : 1)) / (seconds < 10 * YEAR ? 10 : 1);
  return `${y.toLocaleString(LOCALE)} an${y >= 2 ? 's' : ''}`;
}
