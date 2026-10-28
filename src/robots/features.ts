import type { Candle, IndicatorConfig } from '../types';
import type { IndicatorDef, Plot } from '../indicators/types';
import { TSH_ARROW } from '../indicators/custom/tshArrow';
import { STO_RSI } from '../indicators/custom/stoRsi';
import { HA_CANDLES } from '../indicators/custom/haCandles';
import { adx, atr, rsi, zlema } from '../indicators/math';

// Values of the user's indicators, bar by bar, for one market and timeframe.
// Each series is computed once (cached by key) with the indicator's own code, then
// aligned on the bars: NaN where the indicator has no value yet.

export type Bars = {
  n: number;
  t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; v: Float64Array;
  candles: Candle[];
};

export function toBars(rows: number[][]): Bars {
  const n = rows.length;
  const b: Bars = {
    n, t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n),
    candles: new Array(n),
  };
  rows.forEach((r, i) => {
    b.t[i] = r[0]; b.o[i] = r[1]; b.h[i] = r[2]; b.l[i] = r[3]; b.c[i] = r[4]; b.v[i] = r[5] ?? 0;
    b.candles[i] = { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] ?? 0 };
  });
  return b;
}

// several 1h bars -> one 4h bar (UTC buckets)
export function resample(rows: number[][], seconds: number): number[][] {
  const out: number[][] = [];
  for (const r of rows) {
    const t = Math.floor(r[0] / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last[0] === t) {
      last[2] = Math.max(last[2], r[2]); last[3] = Math.min(last[3], r[3]); last[4] = r[4]; last[5] += r[5] ?? 0;
    } else out.push([t, r[1], r[2], r[3], r[4], r[5] ?? 0]);
  }
  return out;
}

const cfgOf = (type: string, inputs: Record<string, number | string | boolean> = {}): IndicatorConfig =>
  ({ id: type, type, period: 14, color: '#000', overlay: true, visible: true, inputs } as unknown as IndicatorConfig);

export type TshSeries = {
  // 1: trend up (SuperTrend under the price), -1: down
  trend: Int8Array;
  sigUp: Uint8Array; sigDn: Uint8Array; startUp: Uint8Array; startDn: Uint8Array; macdUp: Uint8Array; macdDn: Uint8Array;
};

export class Features {
  readonly b: Bars;
  private readonly index = new Map<number, number>();
  private readonly cache = new Map<string, unknown>();

  constructor(b: Bars) {
    this.b = b;
    for (let i = 0; i < b.n; i++) this.index.set(b.t[i], i);
  }

  get<T>(key: string, make: () => T): T {
    let v = this.cache.get(key) as T | undefined;
    if (v === undefined) { v = make(); this.cache.set(key, v); }
    return v;
  }

  // points {time, value} -> one value per bar
  private align(points: { time: number; value: number }[]): Float64Array {
    const out = new Float64Array(this.b.n).fill(NaN);
    for (const p of points) {
      const i = this.index.get(p.time);
      if (i !== undefined && Number.isFinite(p.value)) out[i] = p.value;
    }
    return out;
  }

  private flags(times: number[]): Uint8Array {
    const out = new Uint8Array(this.b.n);
    for (const t of times) { const i = this.index.get(t); if (i !== undefined) out[i] = 1; }
    return out;
  }

  private plots(def: IndicatorDef, inputs: Record<string, number | string | boolean>): Plot[] {
    return def.compute(this.b.candles, cfgOf(def.type, inputs));
  }

  atr(p = 14) { return this.get(`atr${p}`, () => this.align(atr(this.b.candles, p))); }
  zlema(p: number) { return this.get(`zl${p}`, () => this.align(zlema(this.b.candles, p))); }
  rsi(p = 14) { return this.get(`rsi${p}`, () => this.align(rsi(this.b.candles, p))); }

  adx(p = 14) {
    return this.get(`adx${p}`, () => {
      const a = adx(this.b.candles, p);
      return { adx: this.align(a.adxLine), pdi: this.align(a.plusDI), mdi: this.align(a.minusDI) };
    });
  }

  // Tsh_Arrow: trend (SuperTrend side), its signal arrows, trend starts and DEMA MACD arrows
  tsh(maSrc: string, len: number): TshSeries {
    return this.get(`tsh${maSrc}${len}`, () => {
      const plots = this.plots(TSH_ARROW, { maSrc, len, aisignals: true, voirFleche: true });
      const by = (k: string) => plots.find((p) => p.key === k)!;
      const up = this.align(by('up').data), dn = this.align(by('dn').data);
      const trend = new Int8Array(this.b.n);
      for (let i = 0; i < this.b.n; i++) trend[i] = Number.isFinite(up[i]) ? 1 : Number.isFinite(dn[i]) ? -1 : 0;
      const marks = (k: string) => (by(k).markers ?? []).map((m) => m.time);
      const arrows = by('arrows').labels ?? [];
      return {
        trend,
        sigUp: this.flags(marks('sigUp')), sigDn: this.flags(marks('sigDn')),
        startUp: this.flags(marks('startUp')), startDn: this.flags(marks('startDn')),
        macdUp: this.flags(arrows.filter((a) => a.style === 'up').map((a) => a.time)),
        macdDn: this.flags(arrows.filter((a) => a.style === 'down').map((a) => a.time)),
      };
    });
  }

  // Stoch Price Envelope: the k-bar range projected on the price (1 %, 50 %, 99 %, signal)
  spe(k: number, d: number) {
    return this.get(`spe${k}_${d}`, () => {
      const { h, l, c, n } = this.b;
      const hh = new Float64Array(n).fill(NaN), ll = new Float64Array(n).fill(NaN);
      // monotonic deques: highest / lowest of the last k bars
      const qh: number[] = [], ql: number[] = [];
      for (let i = 0; i < n; i++) {
        while (qh.length && h[qh[qh.length - 1]] <= h[i]) qh.pop();
        qh.push(i); if (qh[0] <= i - k) qh.shift();
        while (ql.length && l[ql[ql.length - 1]] >= l[i]) ql.pop();
        ql.push(i); if (ql[0] <= i - k) ql.shift();
        if (i >= k - 1) { hh[i] = h[qh[0]]; ll[i] = l[ql[0]]; }
      }
      const rawK = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) { const r = hh[i] - ll[i]; if (r > 0) rawK[i] = (100 * (c[i] - ll[i])) / r; }
      const smoothK = smaArr(rawK, 3), sig = smaArr(smoothK, d);
      const p99 = new Float64Array(n), p01 = new Float64Array(n), mid = new Float64Array(n), sigP = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const r = hh[i] - ll[i];
        p99[i] = 0.99 * r + ll[i]; p01[i] = 0.01 * r + ll[i]; mid[i] = 0.5 * r + ll[i]; sigP[i] = (sig[i] / 100) * r + ll[i];
      }
      // kPct: the smoothed stochastic (0-100); sigPct: the orange signal line's level in
      // the envelope (high in an uptrend, near 50 in a range, low in a downtrend)
      return { hh, ll, p99, p01, mid, sig: sigP, kPct: smoothK, sigPct: sig };
    });
  }

  // bars since the envelope's ceiling last rose (up) and its floor last fell (dn):
  // both large when the price ranges between flat red and green lines
  speAge(k: number) {
    return this.get(`speAge${k}`, () => {
      const e = this.spe(k, k), n = this.b.n;
      const up = new Int32Array(n), dn = new Int32Array(n);
      for (let i = 1; i < n; i++) {
        up[i] = e.hh[i] > e.hh[i - 1] ? 0 : up[i - 1] + 1;
        dn[i] = e.ll[i] < e.ll[i - 1] ? 0 : dn[i - 1] + 1;
      }
      return { up, dn };
    });
  }

  // typical bar length in seconds
  step(): number {
    return this.get('step', () => {
      const { t, n } = this.b;
      const gaps: number[] = [];
      for (let i = 1; i < Math.min(n, 400); i++) gaps.push(t[i] - t[i - 1]);
      gaps.sort((a, b) => a - b);
      return gaps[gaps.length >> 1] || 60;
    });
  }

  // The same market on a higher timeframe (seconds), built from these bars, and for
  // each bar the index of the last higher bar already closed at its close (-1 before):
  // a 4h bar counts as closed on the 15-minute bar that ends with it, never earlier.
  // Weeks start on Monday.
  htf(seconds: number): { f: Features; at: Int32Array } {
    return this.get(`htf${seconds}`, () => {
      const { t, o, h, l, c, v, n } = this.b;
      const step = this.step();
      const anchor = seconds >= 7 * 86400 ? 4 * 86400 : 0;
      const rows: number[][] = [];
      const bucketOf = new Float64Array(n), idx = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const bk = Math.floor((t[i] - anchor) / seconds);
        bucketOf[i] = bk;
        const last = rows[rows.length - 1];
        if (last && bucketOf[i - 1] === bk) {
          if (h[i] > last[2]) last[2] = h[i];
          if (l[i] < last[3]) last[3] = l[i];
          last[4] = c[i]; last[5] += v[i];
        } else rows.push([bk * seconds + anchor, o[i], h[i], l[i], c[i], v[i]]);
        idx[i] = rows.length - 1;
      }
      const at = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const end = (bucketOf[i] + 1) * seconds + anchor;
        at[i] = t[i] + step >= end ? idx[i] : idx[i] - 1;
      }
      return { f: new Features(toBars(rows)), at };
    });
  }

  // each bar's open time in Paris local time (Unix seconds shifted by UTC+1 / UTC+2)
  local(): Float64Array {
    return this.get('local', () => this.b.t.map((t) => t + parisOffset(t)));
  }

  // 1 on the bars touching 16:45 - 18:15 New York time: the forex rollover, when spreads
  // widen and the bid-only histories (HistData) dip, then come back only as the spreads
  // close again, around 18:00 (every year since 2020, on the crosses most). A move no
  // one could trade: buying the dip pays the wide ask. Bars longer than an hour hide it
  // inside them; of those, only the ones opening from 16:45 to 17:45 are left out.
  rollover(): Uint8Array {
    return this.get('rollover', () => {
      const w = this.step() <= 3600 ? this.step() : 0;
      return Uint8Array.from(this.b.t, (t) => {
        const s = (((t + nyOffset(t)) % 86400) + 86400) % 86400;
        return (w ? s + w > 60300 && s < 65700 : s >= 60300 && s < 63900) ? 1 : 0;
      });
    });
  }

  // The range of the candle of hour H, Paris time, lasting len minutes (1 hour: the
  // H h - H+1 h candle), as known on each bar: its high and low from the bar after the
  // range's last bar on, until the next day's range starts (NaN before and inside it),
  // and end: the range's end (Paris local time) telling one day's range from the next.
  // A range with less than half of its bars (market closed, or in the forex rollover) doesn't count.
  hourRange(H: number, len: number) {
    return this.get(`hr${H}_${len}`, () => {
      const { h, l, n } = this.b;
      const p = this.local(), step = this.step(), roll = this.rollover();
      const L = len * 60, S = H * 3600;
      const need = Math.max(1, Math.ceil((0.5 * L) / step));
      const hi = new Float64Array(n).fill(NaN), lo = new Float64Array(n).fill(NaN), end = new Float64Array(n).fill(NaN);
      let cur = NaN, cHi = -Infinity, cLo = Infinity, cnt = 0;
      let aHi = NaN, aLo = NaN, aEnd = NaN;
      const done = () => {
        if (cnt >= need) { aHi = cHi; aLo = cLo; aEnd = cur + L; }
        cur = NaN; cHi = -Infinity; cLo = Infinity; cnt = 0;
      };
      for (let i = 0; i < n; i++) {
        // start of the last range window opened at or before this bar (windows may wrap past midnight)
        const rs = Math.floor((p[i] - S) / 86400) * 86400 + S;
        const inside = p[i] - rs < L;
        // a range whose last bars are missing is complete once a bar outside it comes
        if (!Number.isNaN(cur) && (!inside || rs !== cur)) done();
        if (inside) {
          if (Number.isNaN(cur)) { cur = rs; aHi = NaN; aLo = NaN; aEnd = NaN; }
          // the rollover's bars don't make a range: their bid-only prices dip (the metals'
          // and oil's reopening bar, 18:00 New York, when Paris is only 5 hours ahead)
          if (!roll[i]) {
            if (h[i] > cHi) cHi = h[i];
            if (l[i] < cLo) cLo = l[i];
            cnt++;
          }
          if (p[i] + step >= rs + L) done();
          continue;
        }
        hi[i] = aHi; lo[i] = aLo; end[i] = aEnd;
      }
      return { hi, lo, end };
    });
  }

  // forgets the cached series whose key starts with one of the prefixes (the
  // hour-range rounds go through thousands of them, one at a time)
  drop(...prefixes: string[]) {
    for (const k of [...this.cache.keys()]) if (prefixes.some((p) => k.startsWith(p))) this.cache.delete(k);
  }

  // Sto+RSI: stochastic K / D and RSI, with the indicator's own code
  stoRsi(lengthK: number, lengthD: number) {
    return this.get(`sr${lengthK}_${lengthD}`, () => {
      const plots = this.plots(STO_RSI, { lengthK, lengthD, smoothK: 3, rsiLength: 14, voirSto: true, voirRsi: true });
      const by = (k: string) => this.align(plots.find((p) => p.key === k)!.data);
      return { k: by('k'), d: by('d') };
    });
  }

  // HA (bougies alternatives): 1 when the candle is rising (close above open)
  ha(candleType: string, lrcLength: number) {
    return this.get(`ha${candleType}${lrcLength}`, () => {
      const p = this.plots(HA_CANDLES, { candleType, lrcLength })[0];
      const out = new Int8Array(this.b.n);
      for (const cd of p.candles ?? []) { const i = this.index.get(cd.time); if (i !== undefined) out[i] = cd.close > cd.open ? 1 : -1; }
      return out;
    });
  }

  // Choppiness index: high in a range, low in a trend
  chop(p = 14) {
    return this.get(`chop${p}`, () => {
      const { h, l, c, n } = this.b;
      const out = new Float64Array(n).fill(NaN);
      const tr = new Float64Array(n);
      for (let i = 0; i < n; i++) tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      for (let i = p; i < n; i++) {
        let s = 0, hi = -Infinity, lo = Infinity;
        for (let j = i - p + 1; j <= i; j++) { s += tr[j]; if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
        if (hi > lo) out[i] = (100 * Math.log10(s / (hi - lo))) / Math.log10(p);
      }
      return out;
    });
  }

  // Kaufman efficiency ratio: net move / path length (1 = straight trend)
  er(p = 20) {
    return this.get(`er${p}`, () => {
      const { c, n } = this.b;
      const out = new Float64Array(n).fill(NaN);
      for (let i = p; i < n; i++) {
        let path = 0;
        for (let j = i - p + 1; j <= i; j++) path += Math.abs(c[j] - c[j - 1]);
        out[i] = path > 0 ? Math.abs(c[i] - c[i - p]) / path : 0;
      }
      return out;
    });
  }

  // trend of a ZLEMA on the higher timeframe (m bars of this one), as known on each
  // bar: the value of the last higher bar already closed (no look-ahead). 1 up, -1 down.
  htfTrend(m: number, p: number): Int8Array {
    return this.get(`htf${m}_${p}`, () => {
      const { t, c, n } = this.b;
      const gaps: number[] = [];
      for (let i = 1; i < Math.min(n, 200); i++) gaps.push(t[i] - t[i - 1]);
      gaps.sort((a, b) => a - b);
      const step = (gaps[gaps.length >> 1] || 60) * m;
      // higher bars: close of each bucket
      const hClose: number[] = [], hBucket: number[] = [];
      for (let i = 0; i < n; i++) {
        const bk = Math.floor(t[i] / step);
        if (hBucket.length && hBucket[hBucket.length - 1] === bk) hClose[hClose.length - 1] = c[i];
        else { hBucket.push(bk); hClose.push(c[i]); }
      }
      const z = zlema(hClose.map((v, k) => ({ time: k, open: v, high: v, low: v, close: v, volume: 0 })), p);
      const zv = new Float64Array(hClose.length).fill(NaN);
      for (const pt of z) zv[pt.time] = pt.value;
      const out = new Int8Array(n);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const bk = Math.floor(t[i] / step);
        while (k < hBucket.length - 1 && hBucket[k + 1] <= bk) k++;
        // hBucket[k] is this bar's bucket: use the previous (closed) one
        const j = hBucket[k] === bk ? k - 1 : k;
        if (j >= 1 && Number.isFinite(zv[j]) && Number.isFinite(zv[j - 1])) {
          out[i] = hClose[j] > zv[j] && zv[j] > zv[j - 1] ? 1 : hClose[j] < zv[j] && zv[j] < zv[j - 1] ? -1 : 0;
        }
      }
      return out;
    });
  }

  // volatility waking up: ATR 14 above its 50-bar average
  atrExpanding() {
    return this.get('atrx', () => {
      const a = this.atr(14), avg = smaArr(a, 50), out = new Uint8Array(this.b.n);
      for (let i = 0; i < this.b.n; i++) out[i] = a[i] > avg[i] ? 1 : 0;
      return out;
    });
  }

  lowest(p: number) { return this.get(`lo${p}`, () => rolling(this.b.l, p, Math.min)); }
  highest(p: number) { return this.get(`hi${p}`, () => rolling(this.b.h, p, Math.max)); }
}

// Paris: UTC+2 from the last Sunday of March to the last Sunday of October (01:00 UTC), else UTC+1
const dst = new Map<number, [number, number]>();
const lastSunday = (y: number, m: number) => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return Date.UTC(y, m, last.getUTCDate() - last.getUTCDay(), 1) / 1000;
};
export function parisOffset(t: number): number {
  const y = new Date(t * 1000).getUTCFullYear();
  let r = dst.get(y);
  if (!r) { r = [lastSunday(y, 2), lastSunday(y, 9)]; dst.set(y, r); }
  return t >= r[0] && t < r[1] ? 7200 : 3600;
}

// New York: UTC-4 from the second Sunday of March to the first of November (the first
// Sunday of April to the last of October before 2007), 2:00 local; else UTC-5
const usDst = new Map<number, [number, number]>();
const nthSunday = (y: number, m: number, k: number) => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (k - 1) * 7;
};
export function nyOffset(t: number): number {
  const y = new Date(t * 1000).getUTCFullYear();
  let r = usDst.get(y);
  if (!r) {
    r = y >= 2007
      ? [Date.UTC(y, 2, nthSunday(y, 2, 2), 7) / 1000, Date.UTC(y, 10, nthSunday(y, 10, 1), 6) / 1000]
      : [Date.UTC(y, 3, nthSunday(y, 3, 1), 7) / 1000, lastSunday(y, 9) + 5 * 3600];
    usDst.set(y, r);
  }
  return t >= r[0] && t < r[1] ? -4 * 3600 : -5 * 3600;
}

export function smaArr(src: Float64Array, len: number): Float64Array {
  const n = src.length, out = new Float64Array(n).fill(NaN);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) { sum = 0; count = 0; continue; }
    sum += v; count++;
    if (count > len) { sum -= src[i - len]; count = len; }
    if (count === len) out[i] = sum / len;
  }
  return out;
}

function rolling(src: Float64Array, p: number, f: (a: number, b: number) => number): Float64Array {
  const n = src.length, out = new Float64Array(n).fill(NaN);
  for (let i = p - 1; i < n; i++) {
    let v = src[i - p + 1];
    for (let j = i - p + 2; j <= i; j++) v = f(v, src[j]);
    out[i] = v;
  }
  return out;
}
