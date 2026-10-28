import fs from 'node:fs';
import path from 'node:path';

// The robot lab's history on disk, one market / timeframe per file in robots/data:
// - <id>.bin: "TSHD", the header's length (uint32), the JSON header (DatasetMeta)
//   padded with spaces to a multiple of 8 bytes, then the bars, oldest first. Big
//   histories (years of 1-minute bars) load fast and the header alone says what the
//   file holds. Two layouts, little-endian:
//   - with a scale in the header, 24 bytes a bar: time (uint32, Unix seconds), open,
//     high, low, close (int32, price x scale) and volume (float32). Used whenever
//     every price comes back exactly, which is the case of quotes with a fixed
//     number of decimals: half the size of float64 rows;
//   - without, float64 rows [time, open, high, low, close, volume] (48 bytes);
// - <id>.json: the first format, { ...meta, bars: [[time, open, high, low, close, volume], ...] }.

export const COLS = 6;

// Robot tests use the market since 2020 only (the user's rule: older markets behaved
// differently); `--from YYYY-MM-DD` changes it, `--from all` takes every bar. The older
// history stays on disk for the charts.
export const TEST_FROM = Date.UTC(2020, 0, 1) / 1000;
export function fromArg(argv: string[] = process.argv): number {
  const v = argv.includes('--from') ? argv[argv.indexOf('--from') + 1] : undefined;
  if (!v) return TEST_FROM;
  if (v === 'all') return 0;
  const t = Date.parse(`${v}T00:00:00Z`) / 1000;
  if (!Number.isFinite(t)) throw new Error(`--from : date illisible ${v}`);
  return t;
}
const MAGIC = 'TSHD';
// one read / write call moves at most this much (a single call fails past 2 GB)
const SLICE = 1 << 26;

export type DatasetMeta = {
  id: string; market: string; source: string; symbol: string; tf: string; bars: number; from: number; to: number;
  // the platform ticker, when `symbol` alone would map to another one (a future downloaded
  // from the Data tab: "US100" is the cash index's alias for imported files)
  platform?: string;
  // prices stored as int32 (price x scale)
  scale?: number;
};
type JsonDataset = Omit<DatasetMeta, 'bars' | 'from' | 'to'> & { bars: number[][] };
const rowBytes = (meta: DatasetMeta) => (meta.scale ? 24 : 48);

// every dataset file of a folder (the .bin one when an id has both)
export function datasetFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir);
  const bins = new Set(names.filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4)));
  return names.filter((f) => f.endsWith('.bin') || (f.endsWith('.json') && !bins.has(f.slice(0, -5))));
}

export const idOfFile = (file: string) => path.basename(file).replace(/\.(bin|json)$/, '');

function header(fd: number): { meta: DatasetMeta; offset: number } {
  const pre = Buffer.alloc(8);
  fs.readSync(fd, pre, 0, 8, 0);
  if (pre.toString('latin1', 0, 4) !== MAGIC) throw new Error('fichier de données inconnu');
  const len = pre.readUInt32LE(4);
  const text = Buffer.alloc(len);
  fs.readSync(fd, text, 0, len, 8);
  return { meta: JSON.parse(text.toString('utf8')) as DatasetMeta, offset: 8 + len };
}

// what a .bin file holds and where its bars start, without reading them
export function readHeader(file: string): { meta: DatasetMeta; offset: number } {
  const fd = fs.openSync(file, 'r');
  try { return header(fd); } finally { fs.closeSync(fd); }
}

// 10^decimals turning every price into an int32 that divides back to the same
// number, with times fitting a uint32; 0 when there is none
function priceScale(rows: Float64Array): number {
  let dec = 0;
  for (let k = 0; k < rows.length; k += COLS) {
    const t = rows[k];
    if (!Number.isInteger(t) || t < 0 || t > 0xffffffff) return 0;
    for (let j = 1; j <= 4; j++) {
      const p = rows[k + j];
      while (Math.round(p * 10 ** dec) / 10 ** dec !== p) if (++dec > 9) return 0;
    }
  }
  const scale = 10 ** dec;
  for (let k = 0; k < rows.length; k += COLS) {
    for (let j = 1; j <= 4; j++) {
      const q = Math.round(rows[k + j] * scale);
      if (Math.abs(q) > 0x7fffffff || q / scale !== rows[k + j]) return 0;
    }
  }
  return scale;
}

function encode(rows: Float64Array, scale: number): Uint8Array {
  const n = rows.length / COLS;
  const out = new Uint8Array(n * 24);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const k = i * COLS, o = i * 24;
    v.setUint32(o, rows[k], true);
    for (let j = 1; j <= 4; j++) v.setInt32(o + j * 4, Math.round(rows[k + j] * scale), true);
    v.setFloat32(o + 20, rows[k + 5], true);
  }
  return out;
}

function decode(bytes: Uint8Array, scale: number): Float64Array {
  const n = bytes.length / 24;
  const rows = new Float64Array(n * COLS);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    const k = i * COLS, o = i * 24;
    rows[k] = v.getUint32(o, true);
    for (let j = 1; j <= 4; j++) rows[k + j] = v.getInt32(o + j * 4, true) / scale;
    rows[k + 5] = v.getFloat32(o + 20, true);
  }
  return rows;
}

// bars [first, first + n) of an open .bin file, as float64 rows
function readRows(fd: number, file: string, meta: DatasetMeta, offset: number, first: number, n: number): Float64Array {
  const size = rowBytes(meta);
  const bytes = new Uint8Array(n * size);
  const start = offset + first * size;
  for (let at = 0; at < bytes.length;) {
    const got = fs.readSync(fd, bytes, at, Math.min(SLICE, bytes.length - at), start + at);
    if (!got) throw new Error(`${path.basename(file)} : fichier tronqué`);
    at += got;
  }
  return meta.scale ? decode(bytes, meta.scale) : new Float64Array(bytes.buffer);
}

// the bars of a file (only the last `last` ones when given)
export function readDataset(file: string, last = Infinity): { meta: DatasetMeta; rows: Float64Array } {
  if (file.endsWith('.json')) {
    const { bars, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonDataset;
    const n = bars.length, first = Math.max(0, n - last);
    const rows = new Float64Array((n - first) * COLS);
    for (let i = first; i < n; i++) for (let k = 0; k < COLS; k++) rows[(i - first) * COLS + k] = bars[i][k] ?? 0;
    return { meta: { ...rest, bars: n, from: bars[0]?.[0] ?? 0, to: bars[n - 1]?.[0] ?? 0 }, rows };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const { meta, offset } = header(fd);
    const n = Math.min(meta.bars, last);
    return { meta, rows: readRows(fd, file, meta, offset, meta.bars - n, n) };
  } finally {
    fs.closeSync(fd);
  }
}

// the last `limit` bars before `before` (a time): a .bin file is searched in
// place and only these bars are read, so paging back through years of minutes stays fast
export function readPage(file: string, before: number, limit: number): Float64Array {
  if (file.endsWith('.json')) {
    const { rows } = readDataset(file);
    const end = firstAtOrAfter(rows, before);
    return rows.slice(Math.max(0, end - limit) * COLS, end * COLS);
  }
  const fd = fs.openSync(file, 'r');
  try {
    const { meta, offset } = header(fd);
    const size = rowBytes(meta);
    const probe = Buffer.alloc(8);
    const timeAt = (i: number) => {
      fs.readSync(fd, probe, 0, 8, offset + i * size);
      return meta.scale ? probe.readUInt32LE(0) : probe.readDoubleLE(0);
    };
    let lo = 0, hi = meta.bars;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (timeAt(mid) < before) lo = mid + 1; else hi = mid; }
    const first = Math.max(0, lo - limit);
    return readRows(fd, file, meta, offset, first, lo - first);
  } finally {
    fs.closeSync(fd);
  }
}

// rows sorted by time -> a .bin file (written aside, then swapped in)
export function writeDataset(file: string, meta: Omit<DatasetMeta, 'bars' | 'from' | 'to' | 'scale'>, rows: Float64Array): DatasetMeta {
  const n = rows.length / COLS;
  const scale = priceScale(rows);
  const head: DatasetMeta = { ...meta, bars: n, from: n ? rows[0] : 0, to: n ? rows[(n - 1) * COLS] : 0, ...(scale ? { scale } : {}) };
  let text = JSON.stringify(head);
  text += ' '.repeat((8 - ((8 + Buffer.byteLength(text)) % 8)) % 8);
  const pre = Buffer.alloc(8);
  pre.write(MAGIC, 0, 'latin1');
  pre.writeUInt32LE(Buffer.byteLength(text), 4);
  const bytes = scale ? encode(rows, scale) : new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, pre);
    fs.writeSync(fd, text);
    for (let at = 0; at < bytes.length; at += SLICE) fs.writeSync(fd, bytes.subarray(at, Math.min(bytes.length, at + SLICE)));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return head;
}

// two series into one sorted by time; on the same time the row of `newer` wins
export function mergeNewer(older: Float64Array, newer: Float64Array): Float64Array {
  const all = new Float64Array(older.length + newer.length);
  all.set(older);
  all.set(newer, older.length);
  const n = all.length / COLS;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => all[a * COLS] - all[b * COLS] || a - b);
  const out = new Float64Array(all.length);
  let m = 0;
  for (const i of idx) {
    if (m && out[(m - 1) * COLS] === all[i * COLS]) m--;
    out.set(all.subarray(i * COLS, i * COLS + COLS), m * COLS);
    m++;
  }
  return out.slice(0, m * COLS);
}

// Bad ticks of a quote history (HistData has a few: EURUSD at 1965 for one minute in
// 2001, AUDUSD opening at 39.8 in 2004, prices at 0 or below), and even whole months
// of another market's prices (AUDJPY in May 2005). A price far from the bars around it
// that they do not confirm is one:
// - an open (or a close) far from the previous close while the rest of the bar (or
//   the next open) is back near it is set back to the level around it;
// - bars that jump away as a whole and come back to the level before them within
//   240 bars are dropped (one bar, or a run like AUDUSD at 0.1006 in August 2000);
// - a wick the neighbouring bars never come near is cut back to them;
// - a month with many dropped bars is unreadable and goes as a whole.
// Real moves (a crash, the Swiss franc in January 2015) last more than a bar and are
// kept. "Far" is 50 times the typical bar range, that of the series or the recent one
// when the market is wilder (the Turkish lira in late 2021).
export function cleanBars(rows: Float64Array): { rows: Float64Array; fixed: number; dropped: number; months: string[] } {
  const n = rows.length / COLS;
  const at = (i: number, k: number) => rows[i * COLS + k];
  const sample: number[] = [];
  const every = Math.max(1, Math.floor(n / 20_000));
  for (let i = 0; i < n; i += every) if (at(i, 4) > 0 && at(i, 2) >= at(i, 3)) sample.push((at(i, 2) - at(i, 3)) / at(i, 4));
  sample.sort((a, b) => a - b);
  const typical = Math.max(sample[sample.length >> 1] || 0, 1e-5);
  // recent typical range: an average of the last few hundred bars' ranges (each capped)
  let recent = typical, far = 50 * typical;
  const monthOf = (t: number) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1; };
  const barsIn = new Map<number, number>(), dropsIn = new Map<number, number>();
  const out = new Float64Array(rows.length);
  let m = 0, fixed = 0, dropped = 0, prevC = NaN;
  const RUN = 240;
  for (let i = 0; i < n; i++) { const mo = monthOf(at(i, 0)); barsIn.set(mo, (barsIn.get(mo) ?? 0) + 1); }
  const drop = (k: number) => { const mo = monthOf(at(k, 0)); dropped++; dropsIn.set(mo, (dropsIn.get(mo) ?? 0) + 1); };
  for (let i = 0; i < n; i++) {
    let o = at(i, 1), h = at(i, 2), l = at(i, 3), c = at(i, 4);
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) { drop(i); continue; }
    far = 50 * Math.max(typical, recent);
    if (prevC > 0) {
      const away = (p: number) => Math.abs(p - prevC) / prevC;
      const nextO = i + 1 < n ? at(i + 1, 1) : c;
      // after a pause (a weekend) a real gap can be filled within hours: only a huge one is bad
      const gapFar = i > 0 && at(i, 0) - at(i - 1, 0) > 3600 ? 10 * far : far;
      if (away(o) > gapFar && away(c) > gapFar) {
        // the bars away from the level, up to the first one opening back near it
        const jump = away(c);
        let j = i + 1;
        while (j < n && j - i <= RUN && away(at(j, 1)) >= jump / 3) j++;
        if (j < n && j - i <= RUN) {
          for (let k = i; k < j; k++) drop(k);
          i = j - 1;
          continue;
        }
      }
      if (away(o) > far && away(c) < away(o) / 3) { o = prevC; fixed++; }
      if (away(c) > far && away(o) < away(c) / 3 && i + 1 < n && away(nextO) < away(c) / 3) { c = nextO; fixed++; }
    }
    const top = Math.max(o, c), bot = Math.min(o, c);
    const nbHigh = Math.max(i > 0 ? at(i - 1, 2) : top, i + 1 < n ? at(i + 1, 2) : top);
    const nbLow = Math.min(i > 0 ? at(i - 1, 3) : bot, i + 1 < n ? at(i + 1, 3) : bot);
    if ((h - top) / top > far && nbHigh - top < (h - top) / 3) { h = Math.min(h, nbHigh); fixed++; }
    if ((bot - l) / bot > far && bot - nbLow < (bot - l) / 3) { l = Math.max(l, nbLow); fixed++; }
    h = Math.max(h, top); l = Math.min(l, bot);
    const j = m * COLS;
    out[j] = at(i, 0); out[j + 1] = o; out[j + 2] = h; out[j + 3] = l; out[j + 4] = c; out[j + 5] = at(i, 5);
    m++;
    prevC = c;
    recent += (Math.min((h - l) / c, 5 * recent) - recent) / 300;
  }
  // unreadable months: more than 5 % of the month's bars dropped (isolated bad ticks, even
  // many, leave the rest of the month usable)
  const bad = new Set([...dropsIn].filter(([mo, d]) => d > 100 && d > 0.05 * (barsIn.get(mo) ?? 0)).map(([mo]) => mo));
  let kept = out.slice(0, m * COLS);
  if (bad.size) {
    const k2 = new Float64Array(kept.length);
    let q = 0;
    for (let i = 0; i < m; i++) {
      if (bad.has(monthOf(kept[i * COLS]))) { dropped++; continue; }
      k2.set(kept.subarray(i * COLS, i * COLS + COLS), q * COLS);
      q++;
    }
    kept = k2.slice(0, q * COLS);
  }
  return { rows: kept, fixed, dropped, months: [...bad].sort().map((mo) => `${String(mo).slice(0, 4)}-${String(mo).slice(4)}`) };
}

// index of the first row with time >= t (the row count when there is none)
function firstAtOrAfter(rows: Float64Array, t: number): number {
  let lo = 0, hi = rows.length / COLS;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid * COLS] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// the rows with from <= time <= to
export function between(rows: Float64Array, from: number, to: number): Float64Array {
  return rows.subarray(firstAtOrAfter(rows, from) * COLS, firstAtOrAfter(rows, to + 1) * COLS);
}

// float64 rows -> the lab's [[time, open, high, low, close, volume], ...]
export function toBarList(rows: Float64Array): number[][] {
  const out: number[][] = new Array(rows.length / COLS);
  for (let i = 0; i < out.length; i++) out[i] = Array.from(rows.subarray(i * COLS, i * COLS + COLS));
  return out;
}
