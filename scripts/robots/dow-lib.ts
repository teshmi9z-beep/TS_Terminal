import fs from 'node:fs';
import path from 'node:path';
import { between, readDataset, TEST_FROM } from './dataset';
import { costOf } from '../../src/robots/search';
import { parisOffset } from '../../src/robots/features';
import { zoneHours } from '../../src/data/import/csvImport';
import { atr14, dowAllow, dowHigherTrend, dowRun, DOW_DEFAULTS, type DowBars, type DowParams, type DowTrade } from '../../src/robots/dow';

// What the Dow structure study (dow-study.ts) and its close look (dow-inspect.ts) share:
// the markets, their bars since 2020, the active hours, the higher timeframe's trend,
// the settings' keys and the statistics.

export type Spec = { id: string; symbol: string; market: string; tf: string; source: string; file: string; ticks?: boolean; cost: number };
// cost: the costs paid, in R (the result at other costs: sumR + (1 - k) × cost)
export type Stats = { n: number; wins: number; sumR: number; gross: number; loss: number; maxDD: number; days: number; cost: number };
// htf: entries only in the direction of the higher timeframe's Dow trend
export type Variant = DowParams & { hours: 'all' | 'med' | 'top'; htf: 0 | 1 };

const DATA = path.resolve('robots/data');
const TICKS = path.resolve('robots/dow/ticks');
export const SPLIT = 0.7;

// the markets: forex majors and main crosses, indices, commodities, Bitcoin and Ether
const FX = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF'];
const IDX = ['SPX500', 'NDX100', 'DAX40', 'CAC40', 'FTSE100', 'NIKKEI'];
const COM = ['XAUUSD', 'XAGUSD', 'WTI', 'BRENT', 'XAUEUR'];
const CRYPTO = ['BTCUSDT', 'ETHUSDT'];
const TIME_TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TICK_TFS = ['150T', '250T', '500T', '1000T'];

export function specs(): Spec[] {
  const out: Spec[] = [];
  const add = (source: string, prefix: string, symbol: string, market: string) => {
    for (const tf of TIME_TFS) {
      const file = path.join(DATA, `${prefix}_${symbol}_${tf}.bin`);
      if (!fs.existsSync(file)) continue;
      // Bitcoin and Ether traded on the perpetuals (the venue for short trades): their costs
      const costId = prefix === 'binance' ? `bnfut_${symbol}` : `${prefix}_${symbol}`;
      out.push({ id: `${prefix}_${symbol}_${tf}`, symbol, market, tf, source, file, cost: costOf({ id: costId, market, symbol }) });
    }
  };
  for (const s of FX) add('HistData', 'histdata', s, 'Forex');
  for (const s of IDX) add('HistData', 'histdata', s, 'Index');
  for (const s of COM) add('HistData', 'histdata', s, 'Commodity');
  for (const s of CRYPTO) add('Binance', 'binance', s, 'Crypto');
  if (fs.existsSync(TICKS)) {
    for (const dir of fs.readdirSync(TICKS)) {
      const metaFile = path.join(TICKS, dir, 'meta.json');
      if (!fs.existsSync(metaFile)) continue;
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { source: string; symbol: string; market: string; id: string };
      for (const tf of TICK_TFS) {
        out.push({ id: `${meta.id}_${tf}`, symbol: meta.symbol, market: meta.market, tf, source: meta.source, file: path.join(TICKS, dir), ticks: true, cost: costOf({ id: meta.id, market: meta.market, symbol: meta.symbol }) });
      }
    }
  }
  return out;
}

// New York seconds of the day
const nyDay = (t: number) => (((t + zoneHours('ny', t) * 3600) % 86400) + 86400) % 86400;

export function load(s: Spec): DowBars | null {
  let rows: Float64Array;
  if (s.ticks) {
    const n = parseInt(s.tf, 10);
    const parts = fs.readdirSync(s.file).filter((f) => f.endsWith(`_${n}.f64`)).sort();
    const bufs = parts.map((f) => new Float64Array(fs.readFileSync(path.join(s.file, f)).buffer.slice(0)));
    rows = new Float64Array(bufs.reduce((a, b) => a + b.length, 0));
    let k = 0;
    for (const b of bufs) { rows.set(b, k); k += b.length; }
    rows = between(rows, TEST_FROM, Infinity);
  } else {
    rows = between(readDataset(s.file).rows, TEST_FROM, Infinity);
  }
  // HistData's forex and metals: the rollover's bid-only dip is no market (the tick files
  // already leave it out)
  const skipRoll = s.source === 'HistData' && s.market !== 'Index' && !s.ticks && ['1m', '5m', '15m'].includes(s.tf);
  const n0 = rows.length / 6;
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  const step = s.tf === '1m' ? 60 : s.tf === '5m' ? 300 : s.tf === '15m' ? 900 : 3600;
  for (let i = 0; i < n0; i++) {
    const k = i * 6;
    if (skipRoll) {
      const a = nyDay(rows[k]), e = a + step;
      if (e > 60300 && a < 65700) continue;
    }
    if (!(rows[k + 2] >= rows[k + 3]) || !(rows[k + 4] > 0)) continue;
    t.push(rows[k]); o.push(rows[k + 1]); h.push(rows[k + 2]); l.push(rows[k + 3]); c.push(rows[k + 4]);
  }
  if (t.length < (s.tf === '1d' ? 1000 : 2000)) return null;
  const f = (a: number[]) => Float64Array.from(a);
  return { n: t.length, t: f(t), o: f(o), h: f(h), l: f(l), c: f(c) };
}

// how much the price moves in each hour of the day (Paris), on the tuning part only: the
// sum of the bars' ranges in that hour, per day seen
export function hourProfile(b: DowBars, end: number): number[] {
  const sum = new Array(24).fill(0), days = new Array(24).fill(0).map(() => new Set<number>());
  for (let i = 0; i < end; i++) {
    const p = b.t[i] + parisOffset(b.t[i]);
    const hr = Math.floor((p % 86400) / 3600);
    sum[hr] += (b.h[i] - b.l[i]) / b.c[i];
    days[hr].add(Math.floor(p / 86400));
  }
  // over every day of the period (an hour without bars is a quiet hour)
  const all = new Set<number>();
  for (const d of days) for (const x of d) all.add(x);
  return sum.map((v) => v / Math.max(1, all.size));
}

// the higher timeframe: 1 hour above 1 and 5 minutes, 4 hours above 15 minutes, a day
// above 1 hour; 20 bars above tick bars
export const htfSeconds = (tf: string) => (tf === '1m' || tf === '5m' ? 3600 : tf === '15m' ? 14400 : tf === '1h' ? 86400 : tf === '4h' || tf === '1d' ? 604800 : 0);
export const htfTrend = (b: DowBars, tf: string) => dowHigherTrend(b, htfSeconds(tf));
export const allowMask = (hours: Uint8Array | undefined, htf: Int8Array | undefined, n: number) => dowAllow(n, hours, htf);

export function hoursMask(b: DowBars, profile: number[], mode: Variant['hours']): Uint8Array | undefined {
  if (mode === 'all') return undefined;
  const sorted = [...profile].sort((a, z) => a - z);
  const cut = mode === 'med' ? sorted[12] : sorted[16];
  const ok = profile.map((v) => v >= cut);
  const out = new Uint8Array(b.n);
  for (let i = 0; i < b.n; i++) {
    const p = b.t[i] + parisOffset(b.t[i]);
    out[i] = ok[Math.floor((p % 86400) / 3600)] ? 1 : 0;
  }
  return out;
}

export function stats(trades: DowTrade[], b: DowBars, from: number, to: number, cost: number): Stats {
  const s: Stats = { n: 0, wins: 0, sumR: 0, gross: 0, loss: 0, maxDD: 0, days: (b.t[Math.max(from, to - 1)] - b.t[from]) / 86400, cost: 0 };
  let eq = 0, peak = 0;
  for (const tr of trades) {
    if (tr.entryIdx < from || tr.entryIdx >= to) continue;
    s.n++;
    s.sumR += tr.r;
    s.cost += (cost * (tr.entry + tr.exit)) / Math.abs(tr.entry - tr.stop);
    if (tr.r > 0) { s.wins++; s.gross += tr.r; } else s.loss -= tr.r;
    eq += tr.r;
    peak = Math.max(peak, eq);
    s.maxDD = Math.max(s.maxDD, peak - eq);
  }
  return s;
}

// ---------------------------------------------------------------- the grids
export const key = (v: Variant) => [v.swing, v.body, v.box, v.entry, v.target, v.targetR, v.liq, v.hours, v.maxAge, v.maxCostR, v.be ? 1 : 0, v.minLeg, v.htf, v.mode, v.noRange ? 1 : 0].join('|');
export function variantOf(k: string): Variant {
  const [swing, body, box, entry, target, targetR, liq, hours, maxAge, maxCostR, be, minLeg, htf, mode, noRange] = k.split('|');
  return {
    ...DOW_DEFAULTS, swing: +swing, body: +body, box: box as Variant['box'], entry: entry as Variant['entry'], target: target as Variant['target'],
    targetR: +targetR, liq: liq as Variant['liq'], hours: hours as Variant['hours'], maxAge: +maxAge, maxCostR: +(maxCostR ?? 0),
    be: be === '1', minLeg: +(minLeg ?? 0), htf: htf === '1' ? 1 : 0, mode: (mode ?? 'box') as Variant['mode'], noRange: noRange === '1',
  };
}
// the timeframe groups the next stages pick their base settings for
export const groupOf = (tf: string) => (/T$/.test(tf) ? 'ticks' : tf === '1m' || tf === '5m' ? 'scalping' : 'intraday');

// the bars of the active hours only (the hours above the median, measured on the tuning
// part): the quiet hours taken out of the market altogether, as the rollover is, so they
// make no swing and no break
export function activeOnly(b: DowBars): DowBars {
  const split = Math.floor(b.n * SPLIT);
  const keep = hoursMask(b, hourProfile(b, split), 'med');
  if (!keep) return b;
  const idx: number[] = [];
  for (let i = 0; i < b.n; i++) if (keep[i]) idx.push(i);
  const pick = (a: ArrayLike<number>) => Float64Array.from(idx, (i) => a[i]);
  return { n: idx.length, t: pick(b.t), o: pick(b.o), h: pick(b.h), l: pick(b.l), c: pick(b.c) };
}

// the entries allowed on each bar for a setting (active hours measured on the tuning part)
export function allowFor(b: DowBars, spec: Spec, v: Variant): Uint8Array | undefined {
  const split = Math.floor(b.n * SPLIT);
  const hours = v.hours === 'all' ? undefined : hoursMask(b, hourProfile(b, split), v.hours);
  return allowMask(hours, v.htf ? htfTrend(b, spec.tf) : undefined, b.n);
}

// the trades' statistics year by year (by entry)
export function yearly(trades: DowTrade[], b: DowBars, cost = 0): [number, Stats][] {
  const out = new Map<number, DowTrade[]>();
  for (const t of trades) {
    const y = new Date(b.t[t.entryIdx] * 1000).getUTCFullYear();
    if (!out.has(y)) out.set(y, []);
    out.get(y)!.push(t);
  }
  return [...out].sort((a, z) => a[0] - z[0]).map(([y, ts]) => {
    const s: Stats = { n: 0, wins: 0, sumR: 0, gross: 0, loss: 0, maxDD: 0, days: 365, cost: 0 };
    let eq = 0, peak = 0;
    for (const tr of ts) {
      s.n++; s.sumR += tr.r; s.cost += (cost * (tr.entry + tr.exit)) / Math.abs(tr.entry - tr.stop);
      if (tr.r > 0) { s.wins++; s.gross += tr.r; } else s.loss -= tr.r;
      eq += tr.r; peak = Math.max(peak, eq); s.maxDD = Math.max(s.maxDD, peak - eq);
    }
    return [y, s];
  });
}

// Random entries in the direction of the setting's own Dow trend, as many as the robot's
// trades, with its stops (in ATR), its exit (stop, the clean close the other way, or its
// fixed target), its costs, one trade at a time: the share of `runs` runs the robot beats
// on each period (the entry's own worth, the trend's aside). NaN for liquidity targets.
export function luckTest(b: DowBars, spec: Spec, v: Variant, trades: DowTrade[], runs = 200): { is: number; oos: number; all: number } {
  if (v.target === 'liq' || v.target === 'trail' || v.mode !== 'box') return { is: NaN, oos: NaN, all: NaN };
  const allow = allowFor(b, spec, v);
  const trend = dowRun(b, { ...DOW_DEFAULTS, swing: v.swing, body: v.body }, undefined, true).trend;
  const atr = atr14(b);
  const split = Math.floor(b.n * SPLIT);
  const ratios = trades.map((t) => Math.abs(t.entry - t.stop) / atr[t.entryIdx]).filter((x) => Number.isFinite(x) && x > 0);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const sim = (from: number, to: number, count: number) => {
    const bars: number[] = [];
    for (let tries = 0; bars.length < count * 3 && tries < count * 200; tries++) {
      const i = from + 1 + Math.floor(rnd() * (to - from - 2));
      const a = allow ? allow[i] : 1;
      const side = trend[i - 1];
      if (!side || !(a === 1 || a === (side === 1 ? 2 : 3))) continue;
      bars.push(i);
    }
    bars.sort((x, z) => x - z);
    let total = 0, taken = 0, free = from;
    for (const i of bars) {
      if (taken >= count) break;
      if (i < free) continue;
      const up = trend[i - 1] === 1;
      const entry = b.o[i], risk = ratios[Math.floor(rnd() * ratios.length)] * atr[i - 1];
      const stop = up ? entry - risk : entry + risk;
      const target = v.target === 'fixed' ? entry + (up ? 1 : -1) * v.targetR * risk : NaN;
      let exit = b.c[to - 1], j = i;
      for (; j < to; j++) {
        if (up ? b.l[j] <= stop : b.h[j] >= stop) { exit = up ? Math.min(b.o[j], stop) : Math.max(b.o[j], stop); break; }
        if (!Number.isNaN(target) && (up ? b.h[j] >= target : b.l[j] <= target)) { exit = up ? Math.max(b.o[j], target) : Math.min(b.o[j], target); break; }
        if (trend[j] === (up ? -1 : 1)) { exit = b.c[j]; break; }
      }
      total += ((exit - entry) * (up ? 1 : -1) - spec.cost * (entry + exit)) / risk;
      taken++;
      free = j + 1;
    }
    return total;
  };
  const beat = (from: number, to: number) => {
    const mine = trades.filter((t) => t.entryIdx >= from && t.entryIdx < to);
    if (!mine.length || !ratios.length) return NaN;
    const R = mine.reduce((a, t) => a + t.r, 0);
    let n = 0;
    for (let r = 0; r < runs; r++) if (sim(from, to, mine.length) < R) n++;
    return n / runs;
  };
  return { is: beat(0, split), oos: beat(split, b.n), all: beat(0, b.n) };
}
