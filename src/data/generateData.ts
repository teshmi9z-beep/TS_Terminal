import type { Candle, Timeframe } from '../types';
import { tfSeconds } from './timeframes';

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHUNK_SIZE = 500;

function seedFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// each chunk is generated independently (seeded by chunk index) so previously
// loaded / rendered bars never change when older history is appended.
function generateTimeChunk(ticker: string, basePrice: number, tf: Timeframe, chunkIndex: number): Candle[] {
  const step = tfSeconds(tf) ?? 60;
  const rand = mulberry32(seedFromString(ticker + tf + chunkIndex));
  const now = Math.floor(Date.now() / 1000);
  const chunkEnd = now - now % step - chunkIndex * CHUNK_SIZE * step;
  const startTime = chunkEnd - CHUNK_SIZE * step;
  const vol = basePrice < 5 ? basePrice * 0.01 : basePrice * 0.006;

  // deterministic per-chunk anchor price so charts don't jump wildly between chunks
  const anchorRand = mulberry32(seedFromString(ticker + 'anchor' + chunkIndex));
  let price = basePrice * (1 + (anchorRand() - 0.5) * 0.15 * chunkIndex);

  const candles: Candle[] = [];
  for (let i = 0; i < CHUNK_SIZE; i++) {
    const time = startTime + i * step;
    const open = price;
    const drift = (rand() - 0.5) * vol;
    const path = 4;
    let high = open, low = open, cur = open;
    for (let p = 0; p < path; p++) {
      cur += (rand() - 0.5) * (vol / path) + drift / path;
      high = Math.max(high, cur);
      low = Math.min(low, cur);
    }
    const close = cur;
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    const volume = Math.round(100 + rand() * 1000);
    candles.push({ time, open, high, low, close, volume });
    price = close > 0 ? close : open;
  }
  return candles;
}

function generateTickChunk(ticker: string, basePrice: number, ticksPerBar: number, chunkIndex: number): Candle[] {
  const rand = mulberry32(seedFromString(ticker + ticksPerBar + 'tick' + chunkIndex));
  const vol = basePrice < 5 ? basePrice * 0.002 : basePrice * 0.0012;
  const now = Math.floor(Date.now() / 1000);
  const chunkEndBar = -chunkIndex * CHUNK_SIZE;
  const anchorRand = mulberry32(seedFromString(ticker + 'tickanchor' + chunkIndex));
  let price = basePrice * (1 + (anchorRand() - 0.5) * 0.15 * chunkIndex);
  let time = now + (chunkEndBar - CHUNK_SIZE) * ticksPerBar;

  const candles: Candle[] = [];
  for (let b = 0; b < CHUNK_SIZE; b++) {
    const open = price;
    let high = open, low = open, cur = open, volSum = 0;
    for (let t = 0; t < ticksPerBar; t++) {
      cur += (rand() - 0.5) * vol;
      high = Math.max(high, cur);
      low = Math.min(low, cur);
      volSum += Math.round(1 + rand() * 20);
    }
    const close = cur;
    candles.push({ time, open, high, low, close, volume: volSum });
    price = close > 0 ? close : open;
    time += ticksPerBar;
  }
  return candles;
}

/** count bars ending "now", most recent first internally but returned ascending by time */
export function generateCandles(ticker: string, basePrice: number, tf: Timeframe, count = 500): Candle[] {
  const numChunks = Math.max(1, Math.ceil(count / CHUNK_SIZE));
  const chunks: Candle[] = [];
  for (let c = numChunks - 1; c >= 0; c--) {
    chunks.push(...(tf.endsWith('T') ? generateTickChunk(ticker, basePrice, parseInt(tf), c) : generateTimeChunk(ticker, basePrice, tf, c)));
  }
  return chunks.slice(-count);
}

/** additional older bars, to prepend before the current oldest loaded bar */
export function generateOlderCandles(ticker: string, basePrice: number, tf: Timeframe, alreadyLoadedCount: number): Candle[] {
  const chunkIndex = Math.floor(alreadyLoadedCount / CHUNK_SIZE);
  return tf.endsWith('T') ? generateTickChunk(ticker, basePrice, parseInt(tf), chunkIndex) : generateTimeChunk(ticker, basePrice, tf, chunkIndex);
}

export function getDailyChange(ticker: string, basePrice: number): { last: number; prevClose: number } {
  const candles = generateCandles(ticker, basePrice, '1D', CHUNK_SIZE);
  const last = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2]?.close ?? candles[candles.length - 1].open;
  return { last, prevClose };
}
