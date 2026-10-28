import path from 'node:path';
import { COLS, readDataset } from './dataset';

// What the index study (index-study.ts) and its close look (index-inspect.ts) share: the
// user's main-list indices, their bars, the indicators and the candle configurations.

export const DATA = path.resolve('robots/data');
export const SPLIT = Date.UTC(2024, 8, 1) / 1000;
// per side (costOf's index venue)
export const COST = 0.0002;

export type Bars = { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number };
export type Market = { sym: string; name: string; file: string; histdata: boolean };

// HistData has every index but the Dow and the Russell since 2010, intraday included;
// Yahoo has those two intraday since 2024-09 only (the check period: extra unseen markets)
const HD: [string, string][] = [['HSI', 'HSI'], ['NIKKEI', 'Nikkei 225'], ['CAC40', 'CAC 40'], ['DAX40', 'DAX 40'], ['SPX500', 'S&P 500'], ['NDX100', 'Nasdaq 100']];
const YF: [string, string][] = [['DJI', 'Dow Jones'], ['RUT2000', 'Russell 2000']];

export function markets(tf: string): { core: Market[]; extra: Market[] } {
  const f = (p: string, s: string) => path.join(DATA, `${p}_${s}_${tf}.bin`);
  // daily: Yahoo's cash-index sessions for all eight (clean opens and closes)
  if (tf === '1d') return { core: [...HD, ...YF].map(([s, name]) => ({ sym: s, name, file: f('yf', s), histdata: false })), extra: [] };
  return {
    core: HD.map(([s, name]) => ({ sym: s, name, file: f('histdata', s), histdata: true })),
    extra: tf === '1h' || tf === '4h' ? YF.map(([s, name]) => ({ sym: s, name, file: f('yf', s), histdata: false })) : [],
  };
}

export function load(file: string): Bars {
  const { rows } = readDataset(file);
  const n = rows.length / COLS;
  const b: Bars = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), n };
  for (let i = 0; i < n; i++) {
    const k = i * COLS;
    b.t[i] = rows[k]; b.o[i] = rows[k + 1]; b.h[i] = rows[k + 2]; b.l[i] = rows[k + 3]; b.c[i] = rows[k + 4];
  }
  return b;
}

// ---------------------------------------------------------------- indicators
export function atr14(b: Bars): Float64Array {
  const a = new Float64Array(b.n);
  let v = 0;
  for (let i = 0; i < b.n; i++) {
    const tr = i ? Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])) : b.h[i] - b.l[i];
    v = i < 14 ? (v * i + tr) / (i + 1) : (v * 13 + tr) / 14;
    a[i] = v;
  }
  return a;
}
export function sma(src: Float64Array, len: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    s += src[i];
    if (i >= len) s -= src[i - len];
    if (i >= len - 1) out[i] = s / len;
  }
  return out;
}
export function stdev(src: Float64Array, mean: Float64Array, len: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += (src[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / len);
  }
  return out;
}
export function rsi(c: Float64Array, len: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  let up = 0, dn = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= len) { up += u / len; dn += w / len; } else { up = (up * (len - 1) + u) / len; dn = (dn * (len - 1) + w) / len; }
    if (i >= len) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

// ---------------------------------------------------------------- the configurations
export type EventDef = { key: string; label: string; test: (i: number) => boolean };

export function events(b: Bars): EventDef[] {
  const { o, h, l, c } = b;
  const atr = atr14(b), s20 = sma(c, 20), sd20 = stdev(c, s20, 20), r2 = rsi(c, 2), r14 = rsi(c, 14);
  const range = (i: number) => h[i] - l[i];
  const body = (i: number) => Math.abs(c[i] - o[i]);
  const minClose = (i: number, n: number) => { let m = Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.min(m, c[j]); return m; };
  const maxClose = (i: number, n: number) => { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) m = Math.max(m, c[j]); return m; };
  const minLow = (i: number, n: number) => { let m = Infinity; for (let j = i - n; j < i; j++) m = Math.min(m, l[j]); return m; };
  const maxHigh = (i: number, n: number) => { let m = -Infinity; for (let j = i - n; j < i; j++) m = Math.max(m, h[j]); return m; };
  const E: EventDef[] = [{ key: 'all', label: 'toutes les bougies (référence)', test: () => true }];
  for (const k of [2, 3, 4, 5]) {
    E.push({ key: `down_${k}`, label: `${k} clôtures en baisse d’affilée`, test: (i) => { for (let j = 0; j < k; j++) if (!(c[i - j] < c[i - j - 1])) return false; return true; } });
    E.push({ key: `up_${k}`, label: `${k} clôtures en hausse d’affilée`, test: (i) => { for (let j = 0; j < k; j++) if (!(c[i - j] > c[i - j - 1])) return false; return true; } });
  }
  for (const n of [5, 10, 20]) {
    E.push({ key: `low_${n}`, label: `clôture la plus basse des ${n} dernières bougies`, test: (i) => c[i] <= minClose(i, n) });
    E.push({ key: `high_${n}`, label: `clôture la plus haute des ${n} dernières bougies`, test: (i) => c[i] >= maxClose(i, n) });
  }
  E.push({ key: 'rsi2_lt10', label: 'RSI 2 sous 10', test: (i) => r2[i] < 10 });
  E.push({ key: 'rsi2_gt90', label: 'RSI 2 au-dessus de 90', test: (i) => r2[i] > 90 });
  E.push({ key: 'rsi14_lt30', label: 'RSI 14 sous 30', test: (i) => r14[i] < 30 });
  E.push({ key: 'rsi14_gt70', label: 'RSI 14 au-dessus de 70', test: (i) => r14[i] > 70 });
  E.push({ key: 'bb_below', label: 'clôture sous la bande de Bollinger basse (20, 2)', test: (i) => c[i] < s20[i] - 2 * sd20[i] });
  E.push({ key: 'bb_above', label: 'clôture au-dessus de la bande haute (20, 2)', test: (i) => c[i] > s20[i] + 2 * sd20[i] });
  E.push({ key: 'stretch_dn', label: 'clôture à plus de 2 ATR sous la moyenne 20', test: (i) => c[i] < s20[i] - 2 * atr[i] });
  E.push({ key: 'stretch_up', label: 'clôture à plus de 2 ATR au-dessus de la moyenne 20', test: (i) => c[i] > s20[i] + 2 * atr[i] });
  E.push({ key: 'big_bull', label: 'grande bougie haussière (plus de 2 ATR, corps 60 %)', test: (i) => range(i) > 2 * atr[i - 1] && c[i] > o[i] && body(i) > 0.6 * range(i) });
  E.push({ key: 'big_bear', label: 'grande bougie baissière (plus de 2 ATR, corps 60 %)', test: (i) => range(i) > 2 * atr[i - 1] && c[i] < o[i] && body(i) > 0.6 * range(i) });
  E.push({ key: 'pin_bull', label: 'longue mèche basse (60 % de la bougie, petit corps)', test: (i) => range(i) > 0.5 * atr[i - 1] && Math.min(o[i], c[i]) - l[i] >= 0.6 * range(i) && body(i) <= 0.3 * range(i) });
  E.push({ key: 'pin_bear', label: 'longue mèche haute (60 % de la bougie, petit corps)', test: (i) => range(i) > 0.5 * atr[i - 1] && h[i] - Math.max(o[i], c[i]) >= 0.6 * range(i) && body(i) <= 0.3 * range(i) });
  E.push({ key: 'engulf_bull', label: 'avalement haussier', test: (i) => c[i] > o[i] && c[i - 1] < o[i - 1] && o[i] <= c[i - 1] && c[i] >= o[i - 1] });
  E.push({ key: 'engulf_bear', label: 'avalement baissier', test: (i) => c[i] < o[i] && c[i - 1] > o[i - 1] && o[i] >= c[i - 1] && c[i] <= o[i - 1] });
  E.push({ key: 'inside', label: 'bougie intérieure (inside bar)', test: (i) => h[i] < h[i - 1] && l[i] > l[i - 1] });
  E.push({ key: 'outside_bull', label: 'bougie englobante haussière (outside bar)', test: (i) => h[i] > h[i - 1] && l[i] < l[i - 1] && c[i] > o[i] });
  E.push({ key: 'outside_bear', label: 'bougie englobante baissière (outside bar)', test: (i) => h[i] > h[i - 1] && l[i] < l[i - 1] && c[i] < o[i] });
  E.push({ key: 'gap_up', label: 'ouverture en gap haussier (plus d’un demi ATR)', test: (i) => o[i] - c[i - 1] > 0.5 * atr[i - 1] });
  E.push({ key: 'gap_dn', label: 'ouverture en gap baissier (plus d’un demi ATR)', test: (i) => c[i - 1] - o[i] > 0.5 * atr[i - 1] });
  E.push({ key: 'fvg_bull', label: 'imbalance haussière (bas au-dessus du haut d’il y a 2 bougies)', test: (i) => l[i] > h[i - 2] });
  E.push({ key: 'fvg_bear', label: 'imbalance baissière (haut sous le bas d’il y a 2 bougies)', test: (i) => h[i] < l[i - 2] });
  E.push({ key: 'fvg_big_bull', label: 'grande imbalance haussière (plus d’un demi ATR)', test: (i) => l[i] - h[i - 2] > 0.5 * atr[i] });
  E.push({ key: 'fvg_big_bear', label: 'grande imbalance baissière (plus d’un demi ATR)', test: (i) => l[i - 2] - h[i] > 0.5 * atr[i] });
  for (const n of [10, 20]) {
    E.push({ key: `sweep_low_${n}`, label: `mèche sous le plus bas des ${n} bougies, clôture au-dessus (prise de liquidité)`, test: (i) => { const m = minLow(i, n); return l[i] < m && c[i] > m; } });
    E.push({ key: `sweep_high_${n}`, label: `mèche au-dessus du plus haut des ${n} bougies, clôture en dessous`, test: (i) => { const m = maxHigh(i, n); return h[i] > m && c[i] < m; } });
    E.push({ key: `break_high_${n}`, label: `clôture au-dessus du plus haut des ${n} bougies`, test: (i) => c[i] > maxHigh(i, n) });
    E.push({ key: `break_low_${n}`, label: `clôture sous le plus bas des ${n} bougies`, test: (i) => c[i] < minLow(i, n) });
  }
  E.push({ key: 'nr7', label: 'bougie la plus étroite des 7 dernières', test: (i) => { for (let j = i - 6; j < i; j++) if (range(j) <= range(i)) return false; return true; } });
  E.push({ key: 'close_top', label: 'clôture dans le haut de la bougie (10 %), bougie de plus d’un ATR', test: (i) => range(i) > atr[i - 1] && h[i] - c[i] <= 0.1 * range(i) });
  E.push({ key: 'close_bottom', label: 'clôture dans le bas de la bougie (10 %), bougie de plus d’un ATR', test: (i) => range(i) > atr[i - 1] && c[i] - l[i] <= 0.1 * range(i) });
  return E;
}
