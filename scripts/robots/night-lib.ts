import fs from 'node:fs';
import path from 'node:path';
import { COLS, readDataset, TEST_FROM } from './dataset';
import { costOf } from '../../src/robots/search';
import { nyOffset } from '../../src/robots/features';

// The night lab (2026-09-27): intraday and swing setups built on levels (pivots, the
// previous day / week, session ranges), ICT timing (kill zones, silver bullet, Judas
// swing) and candle ranges, traded with a stop, a target and a time exit, on forex,
// commodities, indices, Bitcoin and Ether since 2020, at real costs. What is found on
// 2020-01 → 2024-08 is checked on 2024-09 → now. See robots/night/NUIT.md.

export const DATA = path.resolve('robots/data');
export const SPLIT = Date.UTC(2024, 8, 1) / 1000;
// bars before 2020 load too, for the indicators' warm-up (the trades start in 2020)
const WARM = 90 * 86400;

export type Cls = 'Forex' | 'Commodity' | 'Index' | 'Crypto';
export const CLASSES: Cls[] = ['Forex', 'Commodity', 'Index', 'Crypto'];
export const CLS_FR: Record<Cls, string> = { Forex: 'forex', Commodity: 'matières premières', Index: 'indices', Crypto: 'crypto' };
const LIST: [string, Cls, string][] = [
  ...['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY'].map((s): [string, Cls, string] => [s, 'Forex', 'histdata']),
  ...['XAUUSD', 'XAGUSD', 'WTI', 'BRENT'].map((s): [string, Cls, string] => [s, 'Commodity', 'histdata']),
  ...['SPX500', 'NDX100', 'DAX40', 'CAC40', 'FTSE100', 'NIKKEI', 'HSI'].map((s): [string, Cls, string] => [s, 'Index', 'histdata']),
  ...['BTCUSDT', 'ETHUSDT'].map((s): [string, Cls, string] => [s, 'Crypto', 'binance']),
];

export type Mkt = { id: string; sym: string; cls: Cls; tf: string; file: string; cost: number; histdata: boolean };
export function marketList(tfs: string[], classes: Cls[] = CLASSES): Mkt[] {
  const out: Mkt[] = [];
  for (const tf of tfs) {
    for (const [sym, cls, prefix] of LIST) {
      if (!classes.includes(cls)) continue;
      const file = path.join(DATA, `${prefix}_${sym}_${tf}.bin`);
      if (!fs.existsSync(file)) continue;
      // Bitcoin and Ether on the perpetuals (shorts included): their costs
      const cost = prefix === 'binance' ? costOf({ id: `bnfut_${sym}`, market: cls, symbol: sym }) : costOf({ id: `${prefix}_${sym}`, market: cls, symbol: sym });
      out.push({ id: `${prefix}_${sym}_${tf}`, sym, cls, tf, file, cost, histdata: prefix === 'histdata' });
    }
  }
  return out;
}

export type Bars = { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number };
export function loadBars(file: string): Bars {
  const { rows } = readDataset(file);
  const all = rows.length / COLS;
  let s = 0;
  while (s < all && rows[s * COLS] < TEST_FROM - WARM) s++;
  const n = all - s;
  const b: Bars = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), n };
  for (let i = 0; i < n; i++) {
    const k = (s + i) * COLS;
    b.t[i] = rows[k]; b.o[i] = rows[k + 1]; b.h[i] = rows[k + 2]; b.l[i] = rows[k + 3]; b.c[i] = rows[k + 4];
  }
  return b;
}

export const TF_SEC: Record<string, number> = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

// ---------------------------------------------------------------- the context of each bar
export type Ctx = {
  m: Mkt; b: Bars; n: number; tfSec: number;
  atr: Float64Array;
  // New York seconds of the day at the bar's open, the New York date, the trading day
  // (from 17:00 New York; UTC days for crypto), its weekday (1 = Monday) and week
  ny: Int32Array; nyDate: Int32Array; day: Int32Array; wday: Int8Array; week: Int32Array;
  // the last bar of the bar's trading day
  dayEnd: Int32Array;
  // HistData bars in the forex rollover: no entry, stop or target there
  roll: Uint8Array;
  start: number;
  // the previous trading day's and week's high, low, close; this day's open
  pdh: Float64Array; pdl: Float64Array; pdc: Float64Array; pwh: Float64Array; pwl: Float64Array; dOpen: Float64Array;
  // the open of the first bar at or after 00:00 New York (ICT's midnight open)
  midOpen: Float64Array;
  cache: Map<string, unknown>;
};

export function makeCtx(m: Mkt, b: Bars): Ctx {
  const n = b.n, tfSec = TF_SEC[m.tf];
  const atr = new Float64Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const tr = i ? Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) : b.h[i] - b.l[i];
    v = i < 14 ? (v * i + tr) / (i + 1) : (v * 13 + tr) / 14;
    atr[i] = v;
  }
  const ny = new Int32Array(n), nyDate = new Int32Array(n), day = new Int32Array(n), wday = new Int8Array(n), week = new Int32Array(n), roll = new Uint8Array(n);
  // NIGHT_CRYPTO_DAY=ny: crypto's days cut at 17:00 New York like the other markets (a robustness check)
  const crypto = m.cls === 'Crypto' && process.env.NIGHT_CRYPTO_DAY !== 'ny';
  for (let i = 0; i < n; i++) {
    const t = b.t[i], off = nyOffset(t);
    const local = t + off;
    ny[i] = ((local % 86400) + 86400) % 86400;
    nyDate[i] = Math.floor(local / 86400);
    day[i] = crypto ? Math.floor(t / 86400) : Math.floor((local + 7 * 3600) / 86400);
    // 1970-01-01 was a Thursday
    wday[i] = ((day[i] + 4) % 7) as number;
    week[i] = Math.floor((day[i] + 3) / 7);
    if (m.histdata && tfSec < 86400) {
      const s = ny[i];
      roll[i] = tfSec <= 3600 ? (s < 18.25 * 3600 && s + tfSec > 16.75 * 3600 ? 1 : 0) : (s >= 16.75 * 3600 && s <= 17.75 * 3600 ? 1 : 0);
    }
  }
  const dayEnd = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) dayEnd[i] = i === n - 1 || day[i + 1] !== day[i] ? i : dayEnd[i + 1];

  const nan = () => new Float64Array(n).fill(NaN);
  const pdh = nan(), pdl = nan(), pdc = nan(), pwh = nan(), pwl = nan(), dOpen = nan(), midOpen = nan();
  let dh = -Infinity, dl = Infinity, dc = NaN, lastH = NaN, lastL = NaN, lastC = NaN, open = NaN;
  let wh = -Infinity, wl = Infinity, lastWH = NaN, lastWL = NaN, mid = NaN;
  for (let i = 0; i < n; i++) {
    if (i && day[i] !== day[i - 1]) { lastH = dh; lastL = dl; lastC = dc; dh = -Infinity; dl = Infinity; }
    if (i === 0 || day[i] !== day[i - 1]) open = b.o[i];
    if (i && week[i] !== week[i - 1]) { lastWH = wh; lastWL = wl; wh = -Infinity; wl = Infinity; }
    if (i === 0 || nyDate[i] !== nyDate[i - 1]) mid = b.o[i];
    pdh[i] = lastH; pdl[i] = lastL; pdc[i] = lastC; pwh[i] = lastWH; pwl[i] = lastWL; dOpen[i] = open; midOpen[i] = mid;
    dh = Math.max(dh, b.h[i]); dl = Math.min(dl, b.l[i]); dc = b.c[i];
    wh = Math.max(wh, b.h[i]); wl = Math.min(wl, b.l[i]);
  }
  let start = 0;
  while (start < n && b.t[start] < TEST_FROM) start++;
  start = Math.max(start, 30);
  return { m, b, n, tfSec, atr, ny, nyDate, day, wday, week, dayEnd, roll, start, pdh, pdl, pdc, pwh, pwl, dOpen, midOpen, cache: new Map() };
}

// a session's range, from `from` to `to` New York hours (wrapping midnight when to <= from),
// known from the end of the session until the next one starts: its high and low per bar
export function sessionRange(x: Ctx, from: number, to: number): { hi: Float64Array; lo: Float64Array } {
  const key = `range:${from}:${to}`;
  const hit = x.cache.get(key) as { hi: Float64Array; lo: Float64Array } | undefined;
  if (hit) return hit;
  const { b, n, ny, tfSec } = x;
  const hi = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN);
  const inWin = (s: number) => (to > from ? s >= from * 3600 && s + tfSec <= to * 3600 : s >= from * 3600 || s + tfSec <= to * 3600);
  let rh = -Infinity, rl = Infinity, doneH = NaN, doneL = NaN, open = false, bars = 0;
  for (let i = 0; i < n; i++) {
    const w = tfSec < 86400 && inWin(ny[i]);
    if (w) {
      if (!open) { open = true; rh = -Infinity; rl = Infinity; bars = 0; doneH = NaN; doneL = NaN; }
      rh = Math.max(rh, b.h[i]); rl = Math.min(rl, b.l[i]); bars++;
    } else if (open) {
      open = false;
      // a session with too few bars (market closed) gives no range
      const need = Math.max(1, Math.floor((((to - from + 24) % 24 || 24) * 3600) / tfSec / 2));
      if (bars >= need) { doneH = rh; doneL = rl; }
    }
    if (!w) { hi[i] = doneH; lo[i] = doneL; }
  }
  const r = { hi, lo };
  x.cache.set(key, r);
  return r;
}

// fractal swings: a high with `k` lower highs on each side, known k bars later
export function swings(x: Ctx, k: number): { hiAt: Int32Array; loAt: Int32Array } {
  const key = `sw:${k}`;
  const hit = x.cache.get(key) as { hiAt: Int32Array; loAt: Int32Array } | undefined;
  if (hit) return hit;
  const { b, n } = x;
  // the last confirmed swing high / low index at each bar (-1: none)
  const hiAt = new Int32Array(n).fill(-1), loAt = new Int32Array(n).fill(-1);
  let lh = -1, ll = -1;
  for (let i = 0; i < n; i++) {
    const q = i - k;
    if (q >= k) {
      let isH = true, isL = true;
      for (let j = q - k; j <= q + k; j++) {
        if (j === q) continue;
        if (b.h[j] >= b.h[q]) isH = false;
        if (b.l[j] <= b.l[q]) isL = false;
      }
      if (isH) lh = q;
      if (isL) ll = q;
    }
    hiAt[i] = lh; loAt[i] = ll;
  }
  const r = { hiAt, loAt };
  x.cache.set(key, r);
  return r;
}

// ---------------------------------------------------------------- the trades
// entry: a limit price (else the next bar's open); expire: bars the limit waits;
// maxBars: bars held at most; exitAt: a bar index to be out by (e.g. the day's end)
// trail: a chandelier stop, that many ATR 14 from the best price since the entry
export type Order = { i: number; dir: 1 | -1; stop: number; target: number; entry?: number; expire?: number; maxBars?: number; exitAt?: number; trail?: number };
export type Trade = { e: number; x: number; t: number; dir: 1 | -1; r: number; costR: number };

// the most a trade may pay in costs, as a share of its risk
export const MAX_COST_R = 0.25;

// one position at a time: orders are taken in order, each once the previous trade is out
export function simulate(x: Ctx, orders: Order[]): Trade[] {
  const { b, n, roll } = x;
  const out: Trade[] = [];
  let free = 0;
  for (const od of orders) {
    if (od.i < free || od.i < x.start || od.i + 1 >= n) continue;
    const d = od.dir;
    // the fill
    let e = -1, entry = NaN;
    if (od.entry === undefined) {
      e = od.i + 1;
      if (roll[e]) continue;
      entry = b.o[e];
    } else {
      const last = Math.min(n - 1, od.i + (od.expire ?? 1), od.exitAt ?? n - 1);
      for (let j = od.i + 1; j <= last; j++) {
        if (roll[j]) continue;
        if (d > 0 ? b.l[j] <= od.entry : b.h[j] >= od.entry) { e = j; entry = d > 0 ? Math.min(b.o[j], od.entry) : Math.max(b.o[j], od.entry); break; }
      }
      if (e < 0) continue;
    }
    const risk = d * (entry - od.stop);
    if (!(risk > 0)) continue;
    const costR = (2 * x.m.cost * entry) / risk;
    if (costR > MAX_COST_R) continue;
    if (!Number.isNaN(od.target) && d * (od.target - entry) <= 0) continue;
    const end = Math.min(n - 1, od.exitAt ?? n - 1, od.maxBars ? e + od.maxBars - 1 : n - 1);
    let xi = -1, px = NaN, stop = od.stop, best = entry;
    for (let j = e; j <= n - 1; j++) {
      if (!roll[j]) {
        // stop first (on the fill bar too), then the target (on the fill bar only if the close is past it)
        if (d > 0 ? b.l[j] <= stop : b.h[j] >= stop) { xi = j; px = j === e ? stop : d > 0 ? Math.min(b.o[j], stop) : Math.max(b.o[j], stop); break; }
        if (!Number.isNaN(od.target)) {
          if (j > e && (d > 0 ? b.h[j] >= od.target : b.l[j] <= od.target)) { xi = j; px = d > 0 ? Math.max(b.o[j], od.target) : Math.min(b.o[j], od.target); break; }
          if (j === e && (d > 0 ? b.c[j] >= od.target : b.c[j] <= od.target)) { xi = j; px = b.c[j]; break; }
        }
        if (j >= end) { xi = j; px = b.c[j]; break; }
        // the trailing stop moves at the bar's close, for the next bars
        if (od.trail) {
          best = d > 0 ? Math.max(best, b.h[j]) : Math.min(best, b.l[j]);
          const ts = best - d * od.trail * x.atr[j];
          if (d > 0 ? ts > stop : ts < stop) stop = ts;
        }
      }
    }
    if (xi < 0) break;
    out.push({ e, x: xi, t: b.t[e], dir: d, r: (d * (px - entry)) / risk - costR, costR });
    free = xi;
  }
  return out;
}

// ---------------------------------------------------------------- the statistics
// n, wins, sum of R, sum of R², gross win, gross loss
export type Acc = [number, number, number, number, number, number];
export const acc = (): Acc => [0, 0, 0, 0, 0, 0];
export function add(a: Acc, r: number) {
  a[0]++; if (r > 0) a[1]++; a[2] += r; a[3] += r * r;
  if (r > 0) a[4] += r; else a[5] -= r;
}
export function merge(a: Acc, b: Acc) { for (let k = 0; k < 6; k++) a[k] += b[k]; }
export const meanR = (a: Acc) => (a[0] ? a[2] / a[0] : 0);
export function tOf(a: Acc) {
  if (a[0] < 3) return 0;
  const m = a[2] / a[0], v = a[3] / a[0] - m * m;
  return v > 0 ? m / Math.sqrt(v / a[0]) : 0;
}

// a setup's variants: each gives its orders for a market / timeframe
export type Variant = { key: string; label: string; orders: (x: Ctx) => Order[] };
export type Family = { id: string; label: string; tfs: string[]; variants: (tf: string) => Variant[] };

// per variant: [search, check] accumulators, and the trades per year (search and check)
export type MarketResult = { id: string; sym: string; cls: Cls; tf: string; res: Record<string, { is: Acc; oos: Acc; years: Record<number, Acc> }> };

export function runMarket(fam: Family, m: Mkt): MarketResult {
  const b = loadBars(m.file);
  const x = makeCtx(m, b);
  const res: MarketResult['res'] = {};
  for (const v of fam.variants(m.tf)) {
    const trades = simulate(x, v.orders(x));
    const r = { is: acc(), oos: acc(), years: {} as Record<number, Acc> };
    for (const tr of trades) {
      add(tr.t < SPLIT ? r.is : r.oos, tr.r);
      const y = new Date(tr.t * 1000).getUTCFullYear();
      add((r.years[y] ??= acc()), tr.r);
    }
    res[v.key] = r;
  }
  return { id: m.id, sym: m.sym, cls: m.cls, tf: m.tf, res };
}
