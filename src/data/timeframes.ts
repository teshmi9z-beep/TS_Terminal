import type { TfUnit, Timeframe } from '../types';
import { LANG } from '../i18n/lang';

const UNIT_SECONDS: Record<Exclude<TfUnit, 'T'>, number> = {
  s: 1, m: 60, h: 3600, D: 86400, W: 604800, M: 2592000,
};

export function parseTf(tf: Timeframe): { n: number; unit: TfUnit } {
  const unit = tf.slice(-1) as TfUnit;
  return { n: Math.max(1, parseInt(tf) || 1), unit };
}

export const isTickTf = (tf: Timeframe) => tf.endsWith('T');
export const isDailyTf = (tf: Timeframe) => /[DWM]$/.test(tf);

// bar duration in seconds (months approximated to 30 days); null for tick bars
export function tfSeconds(tf: Timeframe): number | null {
  const { n, unit } = parseTf(tf);
  return unit === 'T' ? null : n * UNIT_SECONDS[unit];
}

// day / week letters: J / S in French, D / W in English
const [DAY, WEEK] = LANG === 'en' ? ['D', 'W'] : ['J', 'S'];
export function tfShortLabel(tf: Timeframe): string {
  const { n, unit } = parseTf(tf);
  switch (unit) {
    case 'T': return `${n}T`;
    case 's': return `${n}s`;
    case 'm': return `${n}m`;
    case 'h': return `${n}H`;
    case 'D': return n === 1 ? DAY : `${n}${DAY}`;
    case 'W': return n === 1 ? WEEK : `${n}${WEEK}`;
    case 'M': return n === 1 ? 'M' : `${n}M`;
  }
}

const LONG: Record<TfUnit, [string, string]> = LANG === 'en' ? {
  T: ['tick', 'ticks'], s: ['second', 'seconds'], m: ['minute', 'minutes'], h: ['hour', 'hours'],
  D: ['day', 'days'], W: ['week', 'weeks'], M: ['month', 'months'],
} : {
  T: ['tick', 'ticks'], s: ['seconde', 'secondes'], m: ['minute', 'minutes'], h: ['heure', 'heures'],
  D: ['jour', 'jours'], W: ['semaine', 'semaines'], M: ['mois', 'mois'],
};
export function tfLongLabel(tf: Timeframe): string {
  const { n, unit } = parseTf(tf);
  return `${n} ${LONG[unit][n > 1 ? 1 : 0]}`;
}

export type TfSectionId = 'ticks' | 'seconds' | 'minutes' | 'hours' | 'days';

export const TF_SECTIONS: { id: TfSectionId; title: string; items: Timeframe[] }[] = [
  { id: 'ticks', title: 'Ticks', items: ['1T', '10T', '100T', '1000T'] },
  { id: 'seconds', title: 'Secondes', items: ['1s', '5s', '10s', '15s', '30s', '45s'] },
  { id: 'minutes', title: 'Minutes', items: ['1m', '3m', '5m', '15m', '30m', '45m'] },
  { id: 'hours', title: 'Heures', items: ['1h', '2h', '3h', '4h'] },
  { id: 'days', title: 'Jours', items: ['1D', '1W', '1M'] },
];

export function sectionOf(tf: Timeframe): TfSectionId {
  switch (parseTf(tf).unit) {
    case 'T': return 'ticks';
    case 's': return 'seconds';
    case 'm': return 'minutes';
    case 'h': return 'hours';
    default: return 'days';
  }
}

// ticks first (by count), then time intervals by duration
export function sortTfs(list: Timeframe[]): Timeframe[] {
  const key = (tf: Timeframe) => (isTickTf(tf) ? parseTf(tf).n : 1e9 + (tfSeconds(tf) ?? 0));
  return [...new Set(list)].sort((a, b) => key(a) - key(b));
}
