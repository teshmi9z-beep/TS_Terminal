import type { Candle, Symbol, Timeframe } from '../../types';
import { generateCandles, generateOlderCandles } from '../generateData';
import { tfSeconds } from '../timeframes';
import type { FeedSession } from './types';

const INITIAL = 500;

// offline fallback: deterministic random walk + a 1s live wiggle
export class SimSession implements FeedSession {
  readonly source = 'sim' as const;
  readonly label = 'Simulation';
  readonly realtime = false;
  hasMore = true;
  private loaded = 0;
  private last: Candle | null = null;
  private tickCount = 0;
  private sym: Symbol;
  private tf: Timeframe;

  constructor(sym: Symbol, tf: Timeframe) {
    this.sym = sym;
    this.tf = tf;
  }

  async load(): Promise<Candle[]> {
    const c = generateCandles(this.sym.ticker, this.sym.basePrice || 100, this.tf, INITIAL);
    this.loaded = c.length;
    this.last = c[c.length - 1] ?? null;
    return c;
  }

  async loadOlder(): Promise<Candle[]> {
    if (this.loaded > 20000) { this.hasMore = false; return []; }
    const older = generateOlderCandles(this.sym.ticker, this.sym.basePrice || 100, this.tf, this.loaded);
    this.loaded += older.length;
    return older;
  }

  subscribe(onBar: (c: Candle) => void): () => void {
    const isTick = this.tf.endsWith('T');
    const ticksPerBar = isTick ? parseInt(this.tf) : 0;
    const step = tfSeconds(this.tf) ?? 60;
    const id = setInterval(() => {
      const last = this.last;
      if (!last) return;
      const vol = last.close * 0.0004;
      const price = last.close + (Math.random() - 0.5) * vol;
      const now = Math.floor(Date.now() / 1000);
      let bar: Candle;
      if (isTick) {
        this.tickCount += 1 + Math.floor(Math.random() * 8);
        bar = this.tickCount >= ticksPerBar
          ? { time: last.time + ticksPerBar, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 1 }
          : { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, volume: last.volume + 1 };
        if (this.tickCount >= ticksPerBar) this.tickCount = 0;
      } else if (now >= last.time + step) {
        const t = now - (now % step);
        bar = { time: t, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 10 };
      } else {
        bar = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price, volume: last.volume + 5 };
      }
      this.last = bar;
      onBar(bar);
    }, 1000);
    return () => clearInterval(id);
  }
}
