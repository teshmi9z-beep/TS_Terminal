import type { Candle } from '../../types';
import type { FeedSession, MarketMeta } from './types';

const MIN_BARS = 300;
const MAX_PRELOAD_PAGES = 8;

// builds bars of `step` seconds from a finer native feed, for history and live.
// With `sessionAligned`, buckets start at the session open (a US 4H bar runs
// 9:30-13:30 New York like on TradingView) instead of on the UTC clock.
export class AggregatedSession implements FeedSession {
  readonly source: FeedSession['source'];
  readonly label: string;
  // read from the source each time: IBKR tells only once connected whether it is real time
  get realtime() { return this.inner.realtime; }
  private inner: FeedSession;
  private step: number;
  private sessionAligned: boolean;
  private anchor = 0;
  private base: Candle[] = [];
  private firstOut = Infinity;

  // `anchor`: offset of the buckets from 1970-01-01 (weeks start on Monday: 4 days)
  constructor(inner: FeedSession, step: number, sessionAligned: boolean, anchor = 0) {
    this.inner = inner;
    this.step = step;
    this.sessionAligned = sessionAligned;
    this.anchor = anchor;
    this.source = inner.source;
    this.label = inner.label;
  }

  get hasMore() { return this.inner.hasMore; }
  set hasMore(v: boolean) { this.inner.hasMore = v; }

  // session-aligned: each day's buckets start at that day's first bar, so a US 4H bar keeps
  // opening at 9:30 New York across summer / winter time (13:30 or 14:30 UTC)
  private dayAnchor = new Map<number, number>();

  private bucket(t: number) {
    const a = this.dayAnchor.get(Math.floor(t / 86400)) ?? this.anchor;
    return Math.floor((t - a) / this.step) * this.step + a;
  }

  private alignDays() {
    this.dayAnchor.clear();
    if (!this.sessionAligned || 86400 % this.step !== 0) return;
    let day = Math.floor((this.base[0]?.time ?? 0) / 86400);
    // the oldest day may start mid-session: it keeps the common anchor
    for (const c of this.base) {
      const d = Math.floor(c.time / 86400);
      if (d !== day) { day = d; this.dayAnchor.set(d, c.time % this.step); }
    }
  }

  private aggregate(): Candle[] {
    this.alignDays();
    const out: Candle[] = [];
    for (const c of this.base) {
      const t = this.bucket(c.time);
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        last.volume += c.volume;
      } else {
        out.push({ ...c, time: t });
      }
    }
    // the oldest bucket may be missing its first base bars
    if (out.length && this.base.length && this.bucket(this.base[0].time) !== this.base[0].time) out.shift();
    return out;
  }

  private prepend(older: Candle[]) {
    const first = this.base[0]?.time ?? Infinity;
    this.base = [...older.filter((c) => c.time < first), ...this.base];
  }

  async load(): Promise<Candle[]> {
    this.base = await this.inner.load();
    if (this.sessionAligned && this.base.length && 86400 % this.step === 0) {
      // first bar of the most recent trading day marks the session open
      const last = this.base[this.base.length - 1];
      const day = Math.floor(last.time / 86400);
      this.anchor = (this.base.find((c) => Math.floor(c.time / 86400) === day) ?? last).time % this.step;
    }
    let out = this.aggregate();
    for (let i = 0; out.length < MIN_BARS && this.inner.hasMore && i < MAX_PRELOAD_PAGES; i++) {
      const older = await this.inner.loadOlder().catch(() => []);
      if (!older.length) break;
      this.prepend(older);
      out = this.aggregate();
    }
    this.firstOut = out[0]?.time ?? Infinity;
    return out;
  }

  async loadOlder(): Promise<Candle[]> {
    const older = await this.inner.loadOlder();
    if (!older.length) return [];
    this.prepend(older);
    const out = this.aggregate().filter((c) => c.time < this.firstOut);
    if (out.length) this.firstOut = out[0].time;
    return out;
  }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    return this.inner.subscribe((b) => {
      const base = this.base;
      const last = base[base.length - 1];
      if (!last || b.time > last.time) {
        base.push(b);
        // a new trading day opens on this bar
        const d = Math.floor(b.time / 86400);
        if (last && this.sessionAligned && 86400 % this.step === 0 && d !== Math.floor(last.time / 86400)) this.dayAnchor.set(d, b.time % this.step);
      } else {
        let i = base.length - 1;
        while (i >= 0 && base[i].time > b.time) i--;
        if (i >= 0 && base[i].time === b.time) base[i] = b; else return;
      }
      const t = this.bucket(b.time);
      let agg: Candle | null = null;
      for (let i = base.length - 1; i >= 0 && this.bucket(base[i].time) === t; i--) {
        const c = base[i];
        agg = agg
          ? { time: t, open: c.open, high: Math.max(agg.high, c.high), low: Math.min(agg.low, c.low), close: agg.close, volume: agg.volume + c.volume }
          : { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      }
      if (agg) onBar(agg);
    }, onMeta);
  }
}
