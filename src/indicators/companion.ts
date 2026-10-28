import type { Candle, Symbol, Timeframe } from '../types';

// Another symbol's bars an indicator needs, e.g. the future of the cash index on the chart.
// Loaded once per (ticker, timeframe), kept live while indicators read it, dropped two minutes
// after the last read. Indicators compute synchronously: they read what is there, and the
// charts redraw them on COMPANION_EVENT when bars arrive.

export const COMPANION_EVENT = 'companion-data';

export type Companion = {
  candles: Candle[];
  state: 'loading' | 'ready' | 'error';
  error?: string;
};

type Entry = Companion & {
  readAt: number;
  stop?: () => void;
  older?: () => Promise<Candle[]>;
  hasMore?: () => boolean;
  paging: boolean;
  pages: number;
};

const MAX_PAGES = 12;
const entries = new Map<string, Entry>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; window.dispatchEvent(new Event(COMPANION_EVENT)); }, 300);
}

function merge(list: Candle[], bar: Candle) {
  const last = list[list.length - 1];
  if (!last || bar.time > last.time) list.push(bar);
  else if (bar.time === last.time) list[list.length - 1] = bar;
  else {
    const i = list.findIndex((c) => c.time === bar.time);
    if (i >= 0) list[i] = bar;
  }
}

function load(key: string, sym: Symbol, tf: Timeframe) {
  const e: Entry = { candles: [], state: 'loading', readAt: Date.now(), paging: false, pages: 0 };
  entries.set(key, e);
  // loaded on first use: the robot scripts share the indicators but run outside the browser
  import('../data/feeds').then(({ openFeed }) => openFeed(sym, tf, { save: false, localHistory: false })).then(({ session, candles, fallbackReason }) => {
    if (entries.get(key) !== e) return;
    // never the simulator's invented prices
    if (session.source === 'sim') {
      e.state = 'error';
      e.error = fallbackReason ?? `${sym.ticker} indisponible`;
      notify();
      return;
    }
    e.candles = candles.slice();
    e.state = 'ready';
    e.older = () => session.loadOlder();
    e.hasMore = () => session.hasMore;
    e.stop = session.subscribe((bar) => { merge(e.candles, bar); notify(); });
    notify();
  }).catch((err) => {
    e.state = 'error';
    e.error = err instanceof Error ? err.message : String(err);
    notify();
  });
}

// the bars of `sym` in timeframe `tf`, going back to `from` when given (older pages load
// in the background, a dozen at most)
export function companion(sym: Symbol, tf: Timeframe, from?: number): Companion {
  const key = `${sym.ticker}|${tf}`;
  let e = entries.get(key);
  if (!e) { load(key, sym, tf); e = entries.get(key)!; }
  e.readAt = Date.now();
  const first = e.candles[0]?.time;
  if (from != null && first != null && from < first && e.state === 'ready' && !e.paging && e.pages < MAX_PAGES && e.hasMore?.()) {
    e.paging = true;
    e.pages++;
    const entry = e;
    entry.older!().then((older) => {
      const head = entry.candles[0]?.time ?? Infinity;
      entry.candles = [...older.filter((c) => c.time < head), ...entry.candles];
      notify();
    }).catch(() => { entry.pages = MAX_PAGES; }).finally(() => { entry.paging = false; });
  }
  return e;
}

// drop what no indicator read for two minutes
if (typeof window !== 'undefined') setInterval(() => {
  const now = Date.now();
  for (const [key, e] of entries) {
    if (now - e.readAt < 120_000) continue;
    e.stop?.();
    entries.delete(key);
  }
}, 60_000);

// the close of `list` at `time`: the bar that started at or before it, at most `maxAge`
// seconds before (a cash index has no bar outside its session: none then)
export function closeAt(list: Candle[], time: number, maxAge: number): number {
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && time - list[best].time < maxAge ? list[best].close : NaN;
}

// the symbol and timeframe of the bars the main chart gives its indicators, set by the chart
// when its bars change (the store's symbol changes first: the old bars stay until the new
// ones arrive, and must not be read as the new symbol's)
let chartSeries: { sym: Symbol; tf: Timeframe } | null = null;
export const setChartSeries = (sym: Symbol, tf: Timeframe) => { chartSeries = { sym, tf }; };
export const currentChartSeries = () => chartSeries;

// the chart's background color, for indicators whose colors must stay readable on a light
// background as on a dark one (set by the chart when the theme or the background changes)
let chartBackground = '#131722';
export const setChartBackground = (c: string) => { chartBackground = c; };
export function chartIsLight(): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(chartBackground);
  if (!m) return false;
  const [r, g, b] = m.slice(1, 4).map((h) => parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

// runs `fn` as if the chart showed `sym` in `tf` (a small chart computing the main chart's
// indicators on its own series), then puts the main chart's back
export function withChartSeries<T>(sym: Symbol, tf: Timeframe, fn: () => T): T {
  const saved = chartSeries;
  chartSeries = { sym, tf };
  try { return fn(); } finally { chartSeries = saved; }
}
