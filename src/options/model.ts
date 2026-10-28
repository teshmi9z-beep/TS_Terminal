import type { Candle } from '../types';
import { zoned } from '../data/indexFamilies';
import { LOCALE, DEC } from '../i18n/lang';

// Options on the CME index futures, priced from the replayed future and the day's volatility
// index: no free history of real option prices exists, so each bar the chain is what a market
// maker's model would quote (Black-76 on the future, a volatility smile, a bid / ask spread).
// Prices behave like the real ones (time decay, delta, the 0DTE melting in the afternoon)
// without being the prices that traded that day.

export type Root = {
  // the platform's future and its option root on the CME
  future: string;
  root: string;
  name: string;
  // US$ per point
  mult: number;
  strikeStep: number;
  // the one-day and 30-day volatility indices (the 1-day one is brought from the 30-day one
  // × VIX1D / VIX when the index has none of its own)
  vol30: string;
  // option price tick: small premiums / the rest
  tickSmall: number;
  tick: number;
};

export const ROOTS: Root[] = [
  { future: 'US500', root: 'ES', name: 'E-mini S&P 500', mult: 50, strikeStep: 5, vol30: 'VIX', tickSmall: 0.05, tick: 0.25 },
  { future: 'US100', root: 'NQ', name: 'E-mini Nasdaq 100', mult: 20, strikeStep: 25, vol30: 'VXN', tickSmall: 0.05, tick: 0.25 },
  { future: 'US30', root: 'YM', name: 'E-mini Dow ($5)', mult: 5, strikeStep: 50, vol30: 'VXD', tickSmall: 1, tick: 1 },
];
export const rootOf = (ticker: string) => ROOTS.find((r) => r.future === ticker) ?? null;

// commission per contract and side (Interactive Brokers, futures options), US$
export const FEE_USD = 2.5;

const NY = 'America/New_York';
const OPEN = 570, CLOSE = 960; // 9:30, 16:00 New York
const DAY = 86400;

// the New York time zone's UTC offset (s) on a day
function nyOffset(t: number): number {
  const z = zoned(t, NY);
  const utcMin = Math.floor((t % DAY) / 60);
  let d = z.minutes - utcMin;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d * 60;
}
// 16:00 New York on the New York calendar day "YYYY-MM-DD"
function closeOn(day: string): number {
  const mid = Date.parse(`${day}T16:00:00Z`) / 1000;
  return mid - nyOffset(mid);
}
const dayOf = (t: number) => zoned(t, NY).day;
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY * 1000).toISOString().slice(0, 10);
const isBusiness = (day: string) => { const w = weekdayOf(day); return w !== 0 && w !== 6; };

export type Expiry = { time: number; day: string; label: string; kind: '0DTE' | 'jour' | 'hebdo' | 'mensuelle' };

// the expiries listed at time t (holidays ignored): every business day of the coming week
// (the CME's daily options, 0DTE on the day itself), then the Fridays up to five weeks, then
// the next two monthly ones (third Friday)
export function expiriesAt(t: number): Expiry[] {
  const today = dayOf(t);
  const out = new Map<string, Expiry['kind']>();
  for (let i = 0, n = 0; n < 5 && i < 10; i++) {
    const d = addDays(today, i);
    if (!isBusiness(d) || closeOn(d) <= t) continue;
    out.set(d, d === today ? '0DTE' : 'jour');
    n++;
  }
  for (let i = 0; i < 36; i++) {
    const d = addDays(today, i);
    if (weekdayOf(d) === 5 && closeOn(d) > t && !out.has(d)) out.set(d, 'hebdo');
  }
  const [y, m] = today.split('-').map(Number);
  for (let k = 0, found = 0; found < 2 && k < 4; k++) {
    const first = new Date(Date.UTC(y, m - 1 + k, 1));
    const fri = ((5 - first.getUTCDay() + 7) % 7) + 15;
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), fri)).toISOString().slice(0, 10);
    if (closeOn(d) <= t) continue;
    out.set(d, 'mensuelle');
    found++;
  }
  const fr = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, kind]) => ({
    day, kind, time: closeOn(day),
    label: kind === '0DTE' ? `0DTE · ${fr(day)}` : `${fr(day)}${kind === 'mensuelle' ? ' · mensuelle' : kind === 'hebdo' ? ' · hebdo' : ''}`,
  }));
}

// time left in trading days: what is left of today's session (all of it before the open), plus
// one per business day up to the expiry (the night counts for nothing: the volatility indices
// are quoted that way, an expected move of σ / √252 a session)
export function tradingDaysLeft(t: number, expiry: number): number {
  if (expiry <= t) return 0;
  const today = dayOf(t), last = dayOf(expiry);
  const m = zoned(t, NY).minutes;
  let days = isBusiness(today) ? Math.min(1, Math.max(0, (CLOSE - Math.max(m, OPEN)) / (CLOSE - OPEN))) : 0;
  for (let d = addDays(today, 1); d <= last; d = addDays(d, 1)) if (isBusiness(d)) days++;
  return days;
}

// standard normal cumulative distribution
function N(x: number): number {
  const a = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * a);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-a * a);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// Black-76 on a future, no discounting (a few cents on these horizons)
export function black(F: number, K: number, years: number, iv: number, call: boolean): number {
  if (years <= 0 || iv <= 0) return Math.max(0, call ? F - K : K - F);
  const s = iv * Math.sqrt(years);
  const d1 = (Math.log(F / K) + (s * s) / 2) / s, d2 = d1 - s;
  return call ? F * N(d1) - K * N(d2) : K * N(-d2) - F * N(-d1);
}
export function delta(F: number, K: number, years: number, iv: number, call: boolean): number {
  if (years <= 0 || iv <= 0) return call ? (F > K ? 1 : 0) : (F < K ? -1 : 0);
  const s = iv * Math.sqrt(years);
  const d1 = (Math.log(F / K) + (s * s) / 2) / s;
  return call ? N(d1) : N(d1) - 1;
}

// the smile: the puts below the price dearer, the calls above a little cheaper (index skew)
export function smile(atm: number, F: number, K: number, years: number): number {
  const z = Math.max(-3, Math.min(3, Math.log(K / F) / (atm * Math.sqrt(Math.max(years, 1 / 252 / 26)))));
  return atm * Math.max(0.5, 1 - 0.12 * z + 0.035 * z * z);
}

// the at-the-money volatility for an expiry: the one-day index for a day or less, the 30-day
// one from 21 trading days, in between a mix of both
export function atmVol(v1d: number, v30: number, days: number): number {
  if (!Number.isFinite(v1d)) return v30 / 100;
  if (!Number.isFinite(v30)) return v1d / 100;
  const w = Math.max(0, Math.min(1, (days - 1) / 20));
  return ((1 - w) * v1d + w * v30) / 100;
}

export type Quote = { mid: number; bid: number; ask: number; delta: number; iv: number };

export function quote(r: Root, F: number, K: number, days: number, atm: number, call: boolean): Quote {
  const years = days / 252;
  const iv = smile(atm, F, K, years);
  const mid = black(F, K, years, iv, call);
  const tick = mid < 5 ? r.tickSmall : r.tick;
  const spread = Math.max(tick, mid * 0.02);
  const bid = Math.max(0, Math.floor((mid - spread / 2) / tick + 1e-9) * tick);
  const ask = Math.max(tick, Math.ceil((mid + spread / 2) / tick - 1e-9) * tick);
  return { mid, bid, ask, delta: delta(F, K, years, iv, call), iv };
}

// a volatility index's level at time t, without looking ahead: the day's open once the session
// opened, else the previous day's close (daily bars, stamped at midnight UTC of their date)
export function volAt(bars: Candle[], t: number): number {
  const day = dayOf(t);
  const opened = zoned(t, NY).minutes >= OPEN && isBusiness(day);
  for (let i = bars.length - 1; i >= 0; i--) {
    const d = new Date(bars[i].time * 1000).toISOString().slice(0, 10);
    if (d > day) continue;
    if (d === day) { if (opened) return bars[i].open; continue; }
    return bars[i].close;
  }
  return NaN;
}

// how much of the session a trading-day count covers, for the texts: "2 h 15 de séance"
export function daysText(days: number): string {
  if (days >= 1.05) return `${days.toFixed(1).replace('.', DEC)} séance${days >= 2 ? 's' : ''}`;
  const min = Math.round(days * (CLOSE - OPEN));
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} de séance` : `${min} min de séance`;
}
