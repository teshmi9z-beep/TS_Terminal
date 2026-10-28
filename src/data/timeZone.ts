// Display time zones of the charts and the clock. Real zones (Europe/Paris, America/New_York...)
// rather than fixed offsets, so the bar times follow summer / winter time like TradingView:
// Paris is UTC+2 in summer and UTC+1 in winter, New York UTC-4 / UTC-5, on their own dates.

export const TIME_ZONES: { zone: string; label: string }[] = [
  { zone: 'UTC', label: 'UTC' },
  { zone: 'Europe/London', label: 'Londres' },
  { zone: 'Europe/Paris', label: 'Paris / Berlin / Madrid' },
  { zone: 'Europe/Athens', label: 'Athenes' },
  { zone: 'Africa/Cairo', label: 'Le Caire' },
  { zone: 'Europe/Moscow', label: 'Moscou' },
  { zone: 'Asia/Dubai', label: 'Dubai' },
  { zone: 'Asia/Kolkata', label: 'Bombay' },
  { zone: 'Asia/Hong_Kong', label: 'Hong Kong / Singapour' },
  { zone: 'Asia/Tokyo', label: 'Tokyo / Seoul' },
  { zone: 'Australia/Sydney', label: 'Sydney' },
  { zone: 'America/New_York', label: 'New York / Toronto' },
  { zone: 'America/Chicago', label: 'Chicago' },
  { zone: 'America/Denver', label: 'Denver' },
  { zone: 'America/Los_Angeles', label: 'Los Angeles' },
  { zone: 'America/Sao_Paulo', label: 'Sao Paulo' },
];

export const DEFAULT_TIME_ZONE = 'Europe/Paris';

// saves from before the real zones kept a fixed offset in hours (2 = Paris in summer)
const ZONE_OF_OFFSET: Record<number, string> = {
  0: 'UTC', 1: 'Europe/London', 2: 'Europe/Paris', 3: 'Europe/Athens', 4: 'Asia/Dubai', 5.5: 'Asia/Kolkata',
  8: 'Asia/Hong_Kong', 9: 'Asia/Tokyo', 11: 'Australia/Sydney', [-3]: 'America/Sao_Paulo',
  [-4]: 'America/New_York', [-5]: 'America/Chicago', [-6]: 'America/Denver', [-7]: 'America/Los_Angeles',
};
export function zoneOfOffset(hours: number | undefined): string {
  return (hours != null && ZONE_OF_OFFSET[hours]) || DEFAULT_TIME_ZONE;
}

const formats = new Map<string, Intl.DateTimeFormat>();
// offset in seconds by zone and hour: a chart asks for the same few hours over and over
const offsets = new Map<string, number>();

// seconds to add to a UTC instant (epoch seconds) to read the zone's wall clock
export function zoneOffsetSec(zone: string, t: number): number {
  if (zone === 'UTC') return 0;
  const hour = Math.floor(t / 3600);
  const key = `${zone}|${hour}`;
  const cached = offsets.get(key);
  if (cached != null) return cached;
  let f = formats.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    }
    formats.set(zone, f);
  }
  // every zone changes its clock on a whole hour (or half hour), so the hour's start tells
  const at = hour * 3600;
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(at * 1000))) if (x.type !== 'literal') p[x.type] = +x.value;
  const off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 1000 - at;
  if (offsets.size > 100_000) offsets.clear();
  offsets.set(key, off);
  return off;
}

// "UTC+1", "UTC-4", "UTC+5:30"
export function utcLabel(offsetSec: number): string {
  const m = Math.round(offsetSec / 60);
  const a = Math.abs(m);
  return `UTC${m >= 0 ? '+' : '-'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}
