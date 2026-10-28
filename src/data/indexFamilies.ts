// The main list's indices as three instruments each: the cash index, its future (front month)
// and a CFD quoted round the clock at the cash level. Used by the "Base" and "Gap d'ouverture"
// indicators to find the other instruments of the chart's index.

// the futures' last trading days:
// q3F: third Friday of March, June, September, December (CME E-minis, Eurex DAX)
// m3F: third Friday of every month (Euronext CAC 40)
// q2F: the business day before the second Friday of March, June, September, December (CME Nikkei)
// hsi: the second-last business day of every month (HKFE Hang Seng)
export type ExpiryRule = 'q3F' | 'm3F' | 'q2F' | 'hsi';

export type IndexFamily = {
  id: string;
  name: string;
  cash: string;
  future: string;
  cfd?: string;
  // default carry inputs, % a year (the rate of the index's currency, the dividend yield
  // taken off the index: none for the DAX, a performance index that reinvests them)
  rate: number;
  div: number;
  expiry: ExpiryRule;
  // the cash session, in the exchange's time zone
  tz: string;
  open: string;
  close: string;
};

export const INDEX_FAMILIES: IndexFamily[] = [
  { id: 'spx', name: 'S&P 500', cash: 'SPX500', future: 'US500', cfd: 'IBUS500', rate: 3.9, div: 1.2, expiry: 'q3F', tz: 'America/New_York', open: '09:30', close: '16:00' },
  { id: 'ndx', name: 'Nasdaq 100', cash: 'NDX100', future: 'US100', cfd: 'IBUST100', rate: 3.9, div: 0.7, expiry: 'q3F', tz: 'America/New_York', open: '09:30', close: '16:00' },
  { id: 'dji', name: 'Dow Jones', cash: 'DJI', future: 'US30', cfd: 'IBUS30', rate: 3.9, div: 1.6, expiry: 'q3F', tz: 'America/New_York', open: '09:30', close: '16:00' },
  { id: 'rut', name: 'Russell 2000', cash: 'RUT2000', future: 'US2000', rate: 3.9, div: 1.3, expiry: 'q3F', tz: 'America/New_York', open: '09:30', close: '16:00' },
  { id: 'dax', name: 'DAX 40', cash: 'DAX40', future: 'DE40', cfd: 'IBDE40', rate: 2.3, div: 0, expiry: 'q3F', tz: 'Europe/Berlin', open: '09:00', close: '17:30' },
  { id: 'cac', name: 'CAC 40', cash: 'CAC40', future: 'FR40', cfd: 'IBFR40', rate: 2.3, div: 3.0, expiry: 'm3F', tz: 'Europe/Paris', open: '09:00', close: '17:30' },
  { id: 'nikkei', name: 'Nikkei 225', cash: 'NIKKEI', future: 'J225', cfd: 'IBJP225', rate: 0.75, div: 1.8, expiry: 'q2F', tz: 'Asia/Tokyo', open: '09:00', close: '15:30' },
  { id: 'hsi', name: 'Hang Seng', cash: 'HSI', future: 'HK50', cfd: 'IBHK50', rate: 3.5, div: 3.5, expiry: 'hsi', tz: 'Asia/Hong_Kong', open: '09:30', close: '16:00' },
];

export type FamilyRole = 'cash' | 'future' | 'cfd';

export function familyOf(ticker: string): { family: IndexFamily; role: FamilyRole } | null {
  for (const family of INDEX_FAMILIES) {
    if (family.cash === ticker) return { family, role: 'cash' };
    if (family.future === ticker) return { family, role: 'future' };
    if (family.cfd === ticker) return { family, role: 'cfd' };
  }
  return null;
}

const DAY = 86400;
const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m, d) / 1000;
const weekday = (t: number) => new Date(t * 1000).getUTCDay();

// the n-th Friday of a month (UTC midnight)
function nthFriday(y: number, m: number, n: number): number {
  const first = utcDay(y, m, 1);
  return first + (((5 - weekday(first) + 7) % 7) + 7 * (n - 1)) * DAY;
}

// the last trading day of the contract of month `m` (UTC midnight; holidays ignored)
function lastTradingDay(rule: ExpiryRule, y: number, m: number): number | null {
  const quarterly = rule === 'q3F' || rule === 'q2F';
  if (quarterly && m % 3 !== 2) return null;
  if (rule === 'q3F' || rule === 'm3F') return nthFriday(y, m, 3);
  if (rule === 'q2F') return nthFriday(y, m, 2) - DAY;
  // hsi: second-last weekday of the month
  let t = utcDay(y, m + 1, 1) - DAY, seen = 0;
  for (;;) {
    const w = weekday(t);
    if (w !== 0 && w !== 6 && ++seen === 2) return t;
    t -= DAY;
  }
}

// the front contract's last trading day at time `t` (it rolls at 00:00 UTC that day, like the
// stitched Interactive Brokers futures)
export function nextExpiry(rule: ExpiryRule, t: number): number {
  const d = new Date(t * 1000);
  for (let k = 0; k < 15; k++) {
    const y = d.getUTCFullYear() + Math.floor((d.getUTCMonth() + k) / 12), m = (d.getUTCMonth() + k) % 12;
    const e = lastTradingDay(rule, y, m);
    if (e != null && e > t) return e;
  }
  return t + 90 * DAY;
}

// minutes since midnight of a time in a time zone, and that zone's calendar day ("2026-09-28")
const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function zoned(t: number, tz: string): { day: string; minutes: number; weekday: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: wd };
}

export const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

// a zone's offset from UTC (minutes) on the UTC day of `t`, looked up once per day (Intl is
// slow to run on every bar)
const offsets = new Map<string, number>();
function offsetOf(tz: string, t: number): number {
  const day = Math.floor(t / 86400);
  const key = `${tz}|${day}`;
  let off = offsets.get(key);
  if (off == null) {
    off = zoned(day * 86400 + 43200, tz).minutes - 720;
    if (offsets.size > 5000) offsets.clear();
    offsets.set(key, off);
  }
  return off;
}

// whether a bar starting at `t` lies inside the cash session (the closing auction's own bar,
// stamped at the close, is out)
export function inCashSession(f: IndexFamily, t: number): boolean {
  const m = ((Math.floor((t % 86400) / 60) + offsetOf(f.tz, t)) % 1440 + 1440) % 1440;
  return m >= hhmm(f.open) && m < hhmm(f.close);
}

// the exchange's calendar day of a time ("2026-09-28")
export const localDay = (f: IndexFamily, t: number) => new Date((t + offsetOf(f.tz, t) * 60) * 1000).toISOString().slice(0, 10);
