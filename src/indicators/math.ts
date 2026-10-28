import type { Candle } from '../types';

export type LinePoint = { time: number; value: number };

export function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevOpen = 0, prevClose = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    out.push({ time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: c.volume });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

export function sma(candles: Candle[], period: number): LinePoint[] {
  const out: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

export function ema(candles: Candle[], period: number): LinePoint[] {
  const out: LinePoint[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close;
    const value: number = prev === null ? price : price * k + prev * (1 - k);
    prev = value;
    if (i >= period - 1) out.push({ time: candles[i].time, value });
  }
  return out;
}

// Zero-Lag EMA: EMA applied to a de-lagged series (2*price - price[lag])
export function zlema(candles: Candle[], period: number): LinePoint[] {
  const lag = Math.floor((period - 1) / 2);
  const deLagged = candles.map((c, i) => {
    const ref = i - lag >= 0 ? candles[i - lag].close : c.close;
    return 2 * c.close - ref;
  });
  const k = 2 / (period + 1);
  const out: LinePoint[] = [];
  let prev: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const value: number = prev === null ? deLagged[i] : deLagged[i] * k + prev * (1 - k);
    prev = value;
    if (i >= period - 1) out.push({ time: candles[i].time, value });
  }
  return out;
}

export function bollinger(candles: Candle[], period: number, mult = 2) {
  const basis = sma(candles, period);
  const upper: LinePoint[] = [];
  const lower: LinePoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const mean = basis[i - period + 1].value;
    const variance = slice.reduce((s, c) => s + (c.close - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push({ time: candles[i].time, value: mean + mult * sd });
    lower.push({ time: candles[i].time, value: mean - mult * sd });
  }
  return { basis, upper, lower };
}

export function rsi(candles: Candle[], period = 14): LinePoint[] {
  const out: LinePoint[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      out.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
    }
  }
  return out;
}

export function wma(candles: Candle[], period: number): LinePoint[] {
  const out: LinePoint[] = [];
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += candles[i - k].close * (period - k);
    out.push({ time: candles[i].time, value: sum / denom });
  }
  return out;
}

export function macd(candles: Candle[], fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(candles, fast);
  const emaSlow = ema(candles, slow);
  const offset = emaFast.length - emaSlow.length;
  const macdLine: LinePoint[] = emaSlow.map((s, i) => ({ time: s.time, value: emaFast[i + offset].value - s.value }));
  const k = 2 / (signalPeriod + 1);
  const signal: LinePoint[] = [];
  let prev: number | null = null;
  for (const p of macdLine) {
    const value: number = prev === null ? p.value : p.value * k + prev * (1 - k);
    prev = value;
    signal.push({ time: p.time, value });
  }
  const histogram: LinePoint[] = macdLine.map((p, i) => ({ time: p.time, value: p.value - signal[i].value }));
  return { macdLine, signal, histogram };
}

export function atr(candles: Candle[], period = 14): LinePoint[] {
  const trs: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
  });
  const out: LinePoint[] = [];
  let avg = 0;
  for (let i = 0; i < trs.length; i++) {
    if (i < period) { avg += trs[i] / period; if (i === period - 1) out.push({ time: candles[i].time, value: avg }); }
    else { avg = (avg * (period - 1) + trs[i]) / period; out.push({ time: candles[i].time, value: avg }); }
  }
  return out;
}

export function cci(candles: Candle[], period = 20): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const typical = slice.map((c) => (c.high + c.low + c.close) / 3);
    const mean = typical.reduce((s, v) => s + v, 0) / period;
    const meanDev = typical.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    out.push({ time: candles[i].time, value: meanDev === 0 ? 0 : (tp - mean) / (0.015 * meanDev) });
  }
  return out;
}

export function momentum(candles: Candle[], period = 10): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = period; i < candles.length; i++) {
    out.push({ time: candles[i].time, value: candles[i].close - candles[i - period].close });
  }
  return out;
}

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3) {
  const kLine: LinePoint[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...slice.map((c) => c.high));
    const ll = Math.min(...slice.map((c) => c.low));
    const k = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
    kLine.push({ time: candles[i].time, value: k });
  }
  const dLine: LinePoint[] = [];
  for (let i = dPeriod - 1; i < kLine.length; i++) {
    const avg = kLine.slice(i - dPeriod + 1, i + 1).reduce((s, p) => s + p.value, 0) / dPeriod;
    dLine.push({ time: kLine[i].time, value: avg });
  }
  return { kLine, dLine };
}

// session VWAP, anchored to each UTC day (a daily-or-higher bar is its own session)
export function vwap(candles: Candle[]): LinePoint[] {
  const out: LinePoint[] = [];
  let day = -1, pv = 0, vol = 0;
  for (const c of candles) {
    const d = Math.floor(c.time / 86400);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
    out.push({ time: c.time, value: vol > 0 ? pv / vol : tp });
  }
  return out;
}

export function donchian(candles: Candle[], period = 20) {
  const upper: LinePoint[] = [], lower: LinePoint[] = [], basis: LinePoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let k = i - period + 1; k <= i; k++) { hh = Math.max(hh, candles[k].high); ll = Math.min(ll, candles[k].low); }
    upper.push({ time: candles[i].time, value: hh });
    lower.push({ time: candles[i].time, value: ll });
    basis.push({ time: candles[i].time, value: (hh + ll) / 2 });
  }
  return { upper, lower, basis };
}

export function obv(candles: Candle[]): LinePoint[] {
  const out: LinePoint[] = [];
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      if (candles[i].close > candles[i - 1].close) acc += candles[i].volume;
      else if (candles[i].close < candles[i - 1].close) acc -= candles[i].volume;
    }
    out.push({ time: candles[i].time, value: acc });
  }
  return out;
}

export function williamsR(candles: Candle[], period = 14): LinePoint[] {
  const out: LinePoint[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let k = i - period + 1; k <= i; k++) { hh = Math.max(hh, candles[k].high); ll = Math.min(ll, candles[k].low); }
    out.push({ time: candles[i].time, value: hh === ll ? -50 : ((hh - candles[i].close) / (hh - ll)) * -100 });
  }
  return out;
}

// Wilder's ADX with +DI / -DI
export function adx(candles: Candle[], period = 14) {
  const adxLine: LinePoint[] = [], plusDI: LinePoint[] = [], minusDI: LinePoint[] = [];
  let trS = 0, pS = 0, mS = 0, adxV = 0, dxCount = 0, dxSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    const pDM = up > down && up > 0 ? up : 0;
    const mDM = down > up && down > 0 ? down : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= period) {
      trS += tr; pS += pDM; mS += mDM;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr;
      pS = pS - pS / period + pDM;
      mS = mS - mS / period + mDM;
    }
    const pdi = trS === 0 ? 0 : (100 * pS) / trS;
    const mdi = trS === 0 ? 0 : (100 * mS) / trS;
    const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    plusDI.push({ time: c.time, value: pdi });
    minusDI.push({ time: c.time, value: mdi });
    if (dxCount < period) {
      dxSum += dx; dxCount++;
      if (dxCount === period) { adxV = dxSum / period; adxLine.push({ time: c.time, value: adxV }); }
    } else {
      adxV = (adxV * (period - 1) + dx) / period;
      adxLine.push({ time: c.time, value: adxV });
    }
  }
  return { adxLine, plusDI, minusDI };
}
