import type { Candle, Symbol, Timeframe } from '../../types';
import { isTickTf, parseTf, tfSeconds } from '../timeframes';

// Local copy of every chart's bars (IndexedDB), used when the computer is offline
// and to keep history the source no longer serves. A series is one symbol in one
// timeframe from one source; its bars are split into chunks by time so a live
// update only rewrites the newest chunk. A chunk is a flat Float64Array of
// [time, open, high, low, close, volume] rows sorted by time (48 bytes a bar).

export type SeriesInfo = {
  key: string;
  ticker: string;
  tf: Timeframe;
  // e.g. "binance:BTCUSDT" or "yahoo:AAPL"
  feed: string;
  label: string;
  symbol: Symbol;
};

export type SeriesMeta = SeriesInfo & { first: number; last: number; count: number; updatedAt: number };

type Chunk = { key: string; i: number; d: Float64Array };

const DB_NAME = 'tesh-offline';
const COLS = 6;

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('series', { keyPath: 'key' }).createIndex('ticker', 'ticker');
        db.createObjectStore('chunks', { keyPath: ['key', 'i'] });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const allChunks = (key: string, upTo = Infinity) => IDBKeyRange.bound([key, -Infinity], [key, upTo]);

// about 2000 bars a chunk; tick bars: one minute per tick of the count (1T: a minute)
function chunkSpan(tf: Timeframe): number {
  return isTickTf(tf) ? 60 * parseTf(tf).n : (tfSeconds(tf) ?? 60) * 2000;
}
const chunkOf = (tf: Timeframe, t: number) => Math.floor(t / chunkSpan(tf));

// most chunks kept per series: tick and second bars pile up fast when live
function maxChunks(tf: Timeframe): number {
  return isTickTf(tf) || parseTf(tf).unit === 's' ? 200 : 400;
}

function toCandles(chunks: Float64Array[], before = Infinity): Candle[] {
  const out: Candle[] = [];
  for (const d of chunks) {
    for (let k = 0; k < d.length; k += COLS) {
      if (d[k] >= before) continue;
      out.push({ time: d[k], open: d[k + 1], high: d[k + 2], low: d[k + 3], close: d[k + 4], volume: d[k + 5] });
    }
  }
  return out;
}

// adds or replaces bars (by time) in a series
export async function saveBars(info: SeriesInfo, bars: Candle[]): Promise<void> {
  if (!bars.length) return;
  const db = await openDb();
  if (!db) return;
  const groups = new Map<number, Candle[]>();
  let first = Infinity, last = -Infinity;
  for (const b of bars) {
    if (!Number.isFinite(b.time) || !Number.isFinite(b.close)) continue;
    const i = chunkOf(info.tf, b.time);
    const g = groups.get(i);
    if (g) g.push(b); else groups.set(i, [b]);
    first = Math.min(first, b.time);
    last = Math.max(last, b.time);
  }
  if (!groups.size) return;
  const tx = db.transaction(['series', 'chunks'], 'readwrite');
  const chunks = tx.objectStore('chunks');
  const series = tx.objectStore('series');
  const prev = await req(series.get(info.key) as IDBRequest<SeriesMeta | undefined>);
  let added = 0;
  await Promise.all([...groups].map(async ([i, list]) => {
    const old = await req(chunks.get([info.key, i]) as IDBRequest<Chunk | undefined>);
    const rows = new Map<number, number[]>();
    if (old) for (let k = 0; k < old.d.length; k += COLS) rows.set(old.d[k], Array.from(old.d.subarray(k, k + COLS)));
    for (const c of list) rows.set(c.time, [c.time, c.open, c.high, c.low, c.close, c.volume]);
    const times = [...rows.keys()].sort((a, b) => a - b);
    const d = new Float64Array(times.length * COLS);
    times.forEach((t, j) => d.set(rows.get(t)!, j * COLS));
    added += times.length - (old ? old.d.length / COLS : 0);
    chunks.put({ key: info.key, i, d });
  }));
  series.put({
    ...info,
    first: Math.min(prev?.first ?? Infinity, first),
    last: Math.max(prev?.last ?? -Infinity, last),
    count: (prev?.count ?? 0) + added,
    updatedAt: Date.now(),
  } satisfies SeriesMeta);
  await done(tx);
  if (!isImported(info.key) && (prev?.count ?? 0) + added > maxChunks(info.tf) * 1000) await prune(info.key, info.tf);
}

// history imported from files (Développeur · Data): never pruned
export const importFeed = (ticker: string) => `import:${ticker}`;
const isImported = (key: string) => key.split('|')[2]?.startsWith('import:') ?? false;

// Adds a large block of bars, as flat rows [time, open, high, low, close, volume]
// sorted by time: written chunk by chunk, merged with the bars already there.
export async function saveRows(info: SeriesInfo, d: Float64Array, onProgress?: (done: number) => void): Promise<number> {
  const db = await openDb();
  if (!db) throw new Error('stockage du navigateur indisponible');
  const n = d.length / COLS;
  if (!n) return 0;
  // [chunk index, first row, end row]
  const groups: [number, number, number][] = [];
  for (let r = 0; r < n;) {
    const i = chunkOf(info.tf, d[r * COLS]);
    let e = r + 1;
    while (e < n && chunkOf(info.tf, d[e * COLS]) === i) e++;
    groups.push([i, r, e]);
    r = e;
  }
  let added = 0;
  const BATCH = 100;
  for (let g = 0; g < groups.length; g += BATCH) {
    const tx = db.transaction('chunks', 'readwrite');
    const chunks = tx.objectStore('chunks');
    await Promise.all(groups.slice(g, g + BATCH).map(async ([i, s, e]) => {
      const old = await req(chunks.get([info.key, i]) as IDBRequest<Chunk | undefined>);
      let rows = d.slice(s * COLS, e * COLS);
      if (old) {
        const byTime = new Map<number, Float64Array>();
        for (let k = 0; k < old.d.length; k += COLS) byTime.set(old.d[k], old.d.subarray(k, k + COLS));
        for (let k = 0; k < rows.length; k += COLS) byTime.set(rows[k], rows.subarray(k, k + COLS));
        const times = [...byTime.keys()].sort((a, b) => a - b);
        const merged = new Float64Array(times.length * COLS);
        times.forEach((t, j) => merged.set(byTime.get(t)!, j * COLS));
        rows = merged;
      }
      added += rows.length / COLS - (old ? old.d.length / COLS : 0);
      chunks.put({ key: info.key, i, d: rows });
    }));
    await done(tx);
    onProgress?.(Math.min(groups.length, g + BATCH) / groups.length);
  }
  const tx = db.transaction('series', 'readwrite');
  const series = tx.objectStore('series');
  const prev = await req(series.get(info.key) as IDBRequest<SeriesMeta | undefined>);
  series.put({
    ...info,
    first: Math.min(prev?.first ?? Infinity, d[0]),
    last: Math.max(prev?.last ?? -Infinity, d[(n - 1) * COLS]),
    count: (prev?.count ?? 0) + added,
    updatedAt: Date.now(),
  } satisfies SeriesMeta);
  await done(tx);
  return added;
}

// drops the oldest chunks beyond the per-series limit
async function prune(key: string, tf: Timeframe) {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(['series', 'chunks'], 'readwrite');
  const chunks = tx.objectStore('chunks');
  const keys = await req(chunks.getAllKeys(allChunks(key))) as [string, number][];
  const extra = keys.length - maxChunks(tf);
  if (extra <= 0) return;
  let removed = 0;
  for (const k of keys.slice(0, extra)) {
    const c = await req(chunks.get(k) as IDBRequest<Chunk | undefined>);
    removed += c ? c.d.length / COLS : 0;
    chunks.delete(k);
  }
  const firstLeft = await req(chunks.get(keys[extra]) as IDBRequest<Chunk | undefined>);
  const series = tx.objectStore('series');
  const meta = await req(series.get(key) as IDBRequest<SeriesMeta | undefined>);
  if (meta) series.put({ ...meta, count: meta.count - removed, first: firstLeft?.d[0] ?? meta.first });
  await done(tx);
}

// newest bars of a series, at least `minBars` when it has them (whole chunks)
export async function readLatest(key: string, minBars: number): Promise<Candle[]> {
  return readChunks(key, Infinity, minBars);
}

// bars strictly older than `before`
export async function readBefore(key: string, tf: Timeframe, before: number, minBars: number): Promise<Candle[]> {
  return readChunks(key, before, minBars, chunkOf(tf, before));
}

async function readChunks(key: string, before: number, minBars: number, upTo = Infinity): Promise<Candle[]> {
  const db = await openDb();
  if (!db) return [];
  const store = db.transaction('chunks').objectStore('chunks');
  const found = await new Promise<Float64Array[]>((resolve, reject) => {
    const out: Float64Array[] = [];
    let n = 0;
    const r = store.openCursor(allChunks(key, upTo), 'prev');
    r.onsuccess = () => {
      const c = r.result;
      if (!c || n >= minBars) { resolve(out.reverse()); return; }
      const d = (c.value as Chunk).d;
      out.push(d);
      for (let k = 0; k < d.length; k += COLS) if (d[k] < before) n++;
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
  return toCandles(found, before);
}

export async function listSeries(): Promise<SeriesMeta[]> {
  const db = await openDb();
  if (!db) return [];
  return req(db.transaction('series').objectStore('series').getAll() as IDBRequest<SeriesMeta[]>);
}

export async function seriesOf(ticker: string): Promise<SeriesMeta[]> {
  const db = await openDb();
  if (!db) return [];
  return req(db.transaction('series').objectStore('series').index('ticker').getAll(ticker) as IDBRequest<SeriesMeta[]>);
}

export async function deleteSeries(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(['series', 'chunks'], 'readwrite');
  tx.objectStore('series').delete(key);
  tx.objectStore('chunks').delete(allChunks(key));
  await done(tx);
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(['series', 'chunks'], 'readwrite');
  tx.objectStore('series').clear();
  tx.objectStore('chunks').clear();
  await done(tx);
}

// ---- settings: charts are saved while they are open unless turned off
const AUTO_KEY = 'tesh.offline.auto';
export function autoSaveEnabled(): boolean {
  try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; }
}
export function setAutoSave(on: boolean) {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* storage denied */ }
}
