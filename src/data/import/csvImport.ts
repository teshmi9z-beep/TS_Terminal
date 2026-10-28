// Reads price history files (CSV / TXT, or ZIP archives of them) into flat rows of
// [time, open, high, low, close, volume] (time in seconds). Formats recognised:
// MetaTrader 4 / 5 exports, Dukascopy, HistData, Binance (data.binance.vision),
// TradingView "export chart data", Yahoo downloads, and any CSV with a date / time
// and open, high, low, close columns (with or without a header line).

export const COLS = 6;

export type ParsedFile = {
  name: string;
  rows: Float64Array;
  n: number;
  // the file wrote its time zone (Z, GMT+0100...): no shift applied at import
  hasZone: boolean;
  // lines that were not a bar (header, blank, unreadable)
  skipped: number;
  format: string;
  symbolHint: string;
};

// ---- ZIP (stored or deflated entries, no zip64): browser DecompressionStream
type ZipEntry = { name: string; open: () => Promise<ReadableStream<Uint8Array>> };

async function zipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('archive ZIP illisible');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) throw new Error('archive ZIP trop grande (zip64) : décompressez-la puis importez les fichiers');
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const out: ZipEntry[] = [];
  for (let p = 0, k = 0; k < count && p + 46 <= cd.byteLength; k++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !/\.(csv|txt)$/i.test(name)) continue;
    out.push({
      name: name.split('/').pop()!,
      open: async () => {
        // the data follows the local header, whose name / extra lengths may differ
        const lh = new DataView(await file.slice(local, local + 30).arrayBuffer());
        const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + size).stream();
        if (method === 0) return raw;
        if (method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
        throw new Error(`${name} : compression non gérée`);
      },
    });
  }
  return out;
}

// ---- lines of a byte stream, with the bytes read so far
async function eachLine(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, onBytes?: (n: number) => void) {
  let bytes = 0;
  const counted = stream.pipeThrough(new TransformStream<Uint8Array, BufferSource>({
    transform(chunk, ctl) { bytes += chunk.byteLength; onBytes?.(bytes); ctl.enqueue(chunk as Uint8Array<ArrayBuffer>); },
  }));
  const reader = counted.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = rest + value;
    let start = 0;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
      onLine(text.charCodeAt(i - 1) === 13 ? text.slice(start, i - 1) : text.slice(start, i));
      start = i + 1;
    }
    rest = text.slice(start);
  }
  if (rest.trim()) onLine(rest);
}

// ---- dates
// 2023.01.02 / 2023-01-02 / 20230102, then [ T]17:00[:00[.000]] or 170000, then Z / GMT+0100 / +01:00
const YMD = /^(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})(?:[ T]+(\d{1,2}):?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?\s*(Z|(?:GMT|UTC)?\s*([+-])(\d{1,2}):?(\d{2})?)?/i;
// 02.01.2023 / 02/01/2023 (day first unless a value shows otherwise)
const DMY = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|(?:GMT|UTC)?\s*([+-])(\d{1,2}):?(\d{2})?)?/i;

type TimeParse = (text: string) => number;
let zoneSeen = false;

function zoneOffset(m: RegExpMatchArray): number {
  if (!m[7]) return 0;
  zoneSeen = true;
  if (m[7].toUpperCase() === 'Z' || !m[8]) return 0;
  return (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 3600 + Number(m[10] ?? 0) * 60);
}

function makeTimeParser(order: 'ymd' | 'dmy' | 'mdy', epoch: number): TimeParse {
  if (epoch) return (s) => { const v = Number(s); return Number.isFinite(v) ? v / epoch : NaN; };
  if (order === 'ymd') {
    return (s) => {
      const m = s.match(YMD);
      if (!m) return NaN;
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000 - zoneOffset(m);
    };
  }
  return (s) => {
    const m = s.match(DMY);
    if (!m) return NaN;
    const [d, mo] = order === 'dmy' ? [+m[1], +m[2]] : [+m[2], +m[1]];
    return Date.UTC(+m[3], mo - 1, d, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000 - zoneOffset(m);
  };
}

// ---- layout of the columns, found on the first lines
type Plan = {
  delim: string; decimalComma: boolean; header: boolean;
  time: number[]; o: number; h: number; l: number; c: number; v: number;
  order: 'ymd' | 'dmy' | 'mdy'; epoch: number; format: string;
};

const clean = (f: string) => f.trim().replace(/^["'<]+|[">']+$/g, '').trim().toLowerCase();
const isTimeOfDay = (f: string) => /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(f.trim());
const isNum = (f: string) => /^-?\d+([.,]\d+)?([eE][-+]?\d+)?$/.test(f.trim());

function detect(sample: string[], fileName: string): Plan {
  const lines = sample.filter((l) => l.trim()).slice(0, 40);
  if (!lines.length) throw new Error('fichier vide');
  // the separator that splits every line into the same number (5 or more) of fields
  let delim = '';
  for (const d of ['\t', ';', ',', '|']) {
    const counts = lines.slice(1).map((l) => l.split(d).length);
    const n = counts[0] ?? lines[0].split(d).length;
    if (n >= 5 && counts.filter((c) => c === n).length >= counts.length * 0.8) { delim = d; break; }
  }
  if (!delim) throw new Error('colonnes introuvables : il faut une date et les prix open, high, low, close');
  const split = (l: string) => l.split(delim);
  const first = split(lines[0]).map(clean);
  const names = first.map((f) => f.replace(/\s+/g, ' '));
  const header = names.some((f) => /^(open|high|low|close|date|time|datetime|timestamp|gmt time|local time|open time|open_time|ouverture)$/.test(f));
  const data = split(lines[header ? 1 : 0] ?? '');
  const plan: Plan = { delim, decimalComma: false, header, time: [], o: -1, h: -1, l: -1, c: -1, v: -1, order: 'ymd', epoch: 0, format: 'CSV' };
  if (header) {
    const find = (re: RegExp) => names.findIndex((f) => re.test(f));
    const date = find(/^(date|day|datetime|date time|timestamp|time|gmt time|local time|utc|open[ _]?time|period|dt|ts)$/);
    const time = names.findIndex((f, i) => i !== date && /^(time|heure|hour)$/.test(f));
    plan.time = date < 0 ? [] : time > date ? [date, time] : [date];
    plan.o = find(/^(open|o|ouverture|first)$/);
    plan.h = find(/^(high|h|haut|plus haut|max)$/);
    plan.l = find(/^(low|l|bas|plus bas|min)$/);
    plan.c = find(/^(close|c|last|clôture|cloture|dernier)$/);
    if (plan.c < 0) plan.c = find(/^(adj close|price)$/);
    plan.v = find(/^(volume|vol|v|tick volume|tickvol|real volume)$/);
    if (plan.v < 0) plan.v = find(/vol/);
    plan.format = names.some((f) => f === 'tickvol') ? 'MetaTrader 5' : /^(gmt|local) time$/.test(names[0]) ? 'Dukascopy' : 'CSV';
  } else {
    const f0 = data[0]?.trim() ?? '';
    if (/^\d{9,17}(\.\d+)?$/.test(f0)) {
      const v = Number(f0);
      plan.epoch = v < 1e11 ? 1 : v < 1e14 ? 1000 : 1e6;
      Object.assign(plan, { time: [0], o: 1, h: 2, l: 3, c: 4, v: data.length > 5 ? 5 : -1 });
      plan.format = data.length >= 11 ? 'Binance' : 'CSV (horodatage Unix)';
    } else if (isTimeOfDay(data[1] ?? '')) {
      Object.assign(plan, { time: [0, 1], o: 2, h: 3, l: 4, c: 5, v: data.length > 6 ? 6 : -1 });
      plan.format = 'MetaTrader 4';
    } else {
      Object.assign(plan, { time: [0], o: 1, h: 2, l: 3, c: 4, v: data.length > 5 ? 5 : -1 });
      plan.format = /^\d{8} \d{6}$/.test(f0) ? 'HistData' : 'CSV';
    }
  }
  if (!plan.time.length || [plan.o, plan.h, plan.l, plan.c].some((i) => i < 0)) throw new Error('colonnes introuvables : il faut une date et les prix open, high, low, close');
  if (/histdata|^dat_ascii/i.test(fileName)) plan.format = 'HistData';
  // numbers written 1,0701 (French spreadsheet) when the separator is not a comma
  const body = lines.slice(header ? 1 : 0).map(split);
  plan.decimalComma = delim !== ',' && body.some((r) => /^\d+,\d+$/.test(r[plan.c]?.trim() ?? ''));
  if (!body.some((r) => isNum(r[plan.c] ?? ''))) throw new Error('la colonne close ne contient pas de prix');
  // numeric time column in a file with a header (TradingView exports Unix seconds)
  const t0 = plan.time.map((i) => body[0]?.[i]?.trim() ?? '').join(' ');
  if (!plan.epoch && /^\d{9,17}(\.\d+)?$/.test(t0)) {
    const v = Number(t0);
    plan.epoch = v < 1e11 ? 1 : v < 1e14 ? 1000 : 1e6;
    if (plan.format === 'CSV') plan.format = 'TradingView / Unix';
  }
  if (!plan.epoch) {
    // day and month order, from values above 12
    const texts = body.map((r) => plan.time.map((i) => r[i]?.trim() ?? '').join(' ').replace(/^["']/, ''));
    if (texts.some((s) => YMD.test(s))) plan.order = 'ymd';
    else if (texts.some((s) => DMY.test(s))) {
      let dFirst = false, mFirst = false;
      for (const s of texts) {
        const m = s.match(DMY);
        if (m && +m[1] > 12) dFirst = true;
        if (m && +m[2] > 12) mFirst = true;
      }
      plan.order = mFirst && !dFirst ? 'mdy' : 'dmy';
    } else throw new Error(`date illisible : « ${texts[0]} »`);
  }
  return plan;
}

// ---- file name -> symbol: EURUSD_M1_2023.csv, DAT_ASCII_EURUSD_M1_2023, BTCUSDT-1m-2024-01, OANDA_XAUUSD, 60
const NOISE = new Set(['DAT', 'ASCII', 'HISTDATA', 'COM', 'CANDLESTICK', 'BID', 'ASK', 'MID', 'CSV', 'TXT', 'ZIP', 'DATA', 'EXPORT', 'EXPORTED',
  'FX', 'OANDA', 'FXCM', 'FOREXCOM', 'PEPPERSTONE', 'ICMARKETS', 'BINANCE', 'BYBIT', 'KLINES', 'SPOT', 'FUTURES', 'UM', 'CM', 'TICKS', 'TICK', 'LAST',
  'GMT', 'UTC', 'BARS', 'HISTORY', 'HISTORICAL', 'CHART', 'CAPITALCOM', 'TVC', 'SP', 'NASDAQ', 'NYSE', 'XETR', 'EURONEXT', 'COMEX', 'NYMEX', 'CME', 'CBOT', 'MINI', 'CFD']);
const TF_TOKEN = /^(M|H|D|W|MN)\d+$|^\d+[SMHDW]?$|^\d+(MIN|MINS|MINUTE|MINUTES|HOUR|HOURS|DAY|DAILY)$|^(DAILY|WEEKLY|HOURLY|MINUTE)$/;

export function symbolFromName(name: string): string {
  const base = name.replace(/\.(csv|txt|zip)$/i, '').toUpperCase();
  for (const tok of base.split(/[_\-\s,()[\]]+/)) {
    const t = tok.replace(/^[.=^]+|[.=]+$/g, '');
    if (t.length < 2 || t.length > 16 || !/[A-Z]/.test(t) || NOISE.has(t) || TF_TOKEN.test(t)) continue;
    // Yahoo names: EURUSD=X, ^GDAXI
    return t.replace(/=X$/, '').replace(/=F$/, '');
  }
  return '';
}

// ---- one file (or every CSV of a ZIP)
export async function parseFiles(file: File, onProgress?: (done: number) => void): Promise<ParsedFile[]> {
  if (/\.zip$/i.test(file.name)) {
    const entries = await zipEntries(file);
    if (!entries.length) throw new Error('aucun fichier CSV dans l’archive');
    const out: ParsedFile[] = [];
    let firstError: unknown = null;
    for (const [k, e] of entries.entries()) {
      // the notes next to the data (HistData's gap report .txt) are left out
      try {
        out.push(await parseStream(e.name, await e.open(), file.name));
      } catch (err) {
        firstError ??= err;
      }
      onProgress?.((k + 1) / entries.length);
    }
    if (!out.length) throw firstError;
    return out;
  }
  return [await parseStream(file.name, file.stream(), file.name, (b) => onProgress?.(b / Math.max(1, file.size)))];
}

async function parseStream(name: string, stream: ReadableStream<Uint8Array>, outerName: string, onBytes?: (n: number) => void): Promise<ParsedFile> {
  // set once the first lines have shown the layout
  let plan: Plan | null = null;
  let parseTime: TimeParse | null = null;
  const failed: { error: Error | null } = { error: null };
  const sample: string[] = [];
  let rows = new Float64Array(COLS * 65536);
  let n = 0, skipped = 0;
  zoneSeen = false;

  const push = (line: string) => {
    if (!plan || !parseTime) return;
    const f = line.split(plan.delim);
    const num = (i: number) => {
      if (i < 0) return 0;
      let s = f[i];
      if (s === undefined) return NaN;
      if (s.includes('"')) s = s.replace(/"/g, '');
      return Number(plan!.decimalComma ? s.replace(',', '.') : s);
    };
    const tText = plan.time.length === 1 ? f[plan.time[0]] : plan.time.map((i) => f[i]).join(' ');
    const t = parseTime((tText ?? '').replace(/"/g, '').trim());
    const o = num(plan.o), h = num(plan.h), l = num(plan.l), c = num(plan.c);
    if (!Number.isFinite(t) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) { skipped++; return; }
    if ((n + 1) * COLS > rows.length) { const bigger = new Float64Array(rows.length * 2); bigger.set(rows); rows = bigger; }
    const v = num(plan.v);
    const k = n * COLS;
    rows[k] = t; rows[k + 1] = o; rows[k + 2] = Math.max(h, o, c); rows[k + 3] = Math.min(l, o, c); rows[k + 4] = c; rows[k + 5] = Number.isFinite(v) ? v : 0;
    n++;
  };
  const start = () => {
    try {
      plan = detect(sample, outerName || name);
      parseTime = makeTimeParser(plan.order, plan.epoch);
    } catch (e) {
      failed.error = e instanceof Error ? e : new Error(String(e));
      return;
    }
    for (const [i, l] of sample.entries()) if (!(plan.header && i === 0) && l.trim()) push(l); else skipped++;
    sample.length = 0;
  };

  await eachLine(stream, (line) => {
    if (failed.error) return;
    if (!plan) {
      // leading blank lines and a byte-order mark
      const l = line.replace(/^﻿/, '');
      if (!sample.length && !l.trim()) return;
      sample.push(l);
      if (sample.length >= 40) start();
      return;
    }
    if (line.trim()) push(line);
  }, onBytes);
  if (!plan && !failed.error) start();
  if (failed.error) throw new Error(`${name} : ${failed.error.message}`);
  if (!n) throw new Error(`${name} : aucune barre lisible`);
  const sorted = sortRows(rows.subarray(0, n * COLS));
  return {
    name, rows: sorted, n: sorted.length / COLS, hasZone: zoneSeen, skipped,
    format: (plan as Plan | null)?.format ?? 'CSV',
    symbolHint: symbolFromName(name) || symbolFromName(outerName),
  };
}

// ---- rows sorted by time, one per time (the last one wins)
export function sortRows(d: Float64Array): Float64Array {
  const n = d.length / COLS;
  let ordered = true;
  for (let i = 1; i < n && ordered; i++) if (d[i * COLS] <= d[(i - 1) * COLS]) ordered = false;
  if (ordered) return d.slice();
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // stable: equal times keep file order, then the last one is kept
  idx.sort((a, b) => d[a * COLS] - d[b * COLS] || a - b);
  const out = new Float64Array(n * COLS);
  let m = 0;
  for (let j = 0; j < n; j++) {
    const i = idx[j];
    if (m && out[(m - 1) * COLS] === d[i * COLS]) m--;
    out.set(d.subarray(i * COLS, i * COLS + COLS), m * COLS);
    m++;
  }
  return out.slice(0, m * COLS);
}

// several files of one market (months or years of the same series) into one
export function mergeRows(parts: Float64Array[]): Float64Array {
  if (parts.length === 1) return parts[0];
  const sortedParts = [...parts].sort((a, b) => a[0] - b[0]);
  const total = sortedParts.reduce((a, p) => a + p.length, 0);
  const all = new Float64Array(total);
  let at = 0;
  for (const p of sortedParts) { all.set(p, at); at += p.length; }
  return sortRows(all);
}

// ---- bar size: the most common gap between bars
export const STEPS: [string, number][] = [['1m', 60], ['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600], ['4h', 14400], ['1d', 86400], ['1w', 604800]];

export function detectStep(d: Float64Array): number {
  const n = d.length / COLS;
  const counts = new Map<number, number>();
  const stride = Math.max(1, Math.floor(n / 20000));
  for (let i = stride; i < n; i += stride) {
    const g = d[i * COLS] - d[(i - 1) * COLS];
    if (g > 0) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = 0, bestN = 0;
  for (const [g, c] of counts) if (c > bestN) { best = g; bestN = c; }
  return best;
}

export function tfOfStep(step: number): string | null {
  // daily files written at 00:00 local time drift by an hour around DST changes
  if (step >= 82800 && step <= 90000) return '1d';
  return STEPS.find(([, s]) => s === step)?.[0] ?? null;
}

// ---- bigger bars from smaller ones. Days are UTC days; outside crypto, Sunday
// evening's bars (the forex / futures week opens then) go into Monday's.
export function resampleRows(d: Float64Array, seconds: number, sundayIntoMonday: boolean): Float64Array {
  const n = d.length / COLS;
  const out = new Float64Array(n * COLS);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const k = i * COLS;
    let t = Math.floor(d[k] / seconds) * seconds;
    // (days since 1970-01-01, a Thursday, + 4) % 7 is the weekday, 0 for Sunday
    if (seconds === 86400 && sundayIntoMonday && Math.floor(t / 86400 + 4) % 7 === 0) t += 86400;
    const last = (m - 1) * COLS;
    if (m && out[last] === t) {
      out[last + 2] = Math.max(out[last + 2], d[k + 2]);
      out[last + 3] = Math.min(out[last + 3], d[k + 3]);
      out[last + 4] = d[k + 4];
      out[last + 5] += d[k + 5];
    } else {
      out.set(d.subarray(k, k + COLS), m * COLS);
      out[m * COLS] = t;
      m++;
    }
  }
  return out.slice(0, m * COLS);
}

// ---- the file's clock
export type Zone = 'utc' | 'broker' | 'paris' | 'ny' | 'histdata' | '-5' | '+1' | '+2' | '+3';
export const ZONES: [Zone, string][] = [
  ['utc', 'UTC'],
  ['broker', 'Courtier MetaTrader (UTC+2, UTC+3 l’été)'],
  ['paris', 'Paris (UTC+1, UTC+2 l’été)'],
  ['ny', 'New York (UTC−5, UTC−4 l’été)'],
  ['histdata', 'HistData (New York, heure d’été américaine jusqu’en 2018, européenne depuis)'],
  ['-5', 'UTC−5 fixe'],
  ['+1', 'UTC+1 fixe'], ['+2', 'UTC+2 fixe'], ['+3', 'UTC+3 fixe'],
];

const DAY = 86400;
// the n-th Sunday (n = -1: the last) of a month, as UTC midnight
function sunday(y: number, month: number, n: number): number {
  if (n < 0) {
    const last = Date.UTC(y, month + 1, 0) / 1000;
    return last - (Math.floor(last / DAY + 4) % 7) * DAY;
  }
  const first = Date.UTC(y, month, 1) / 1000;
  return first + ((7 - (Math.floor(first / DAY + 4) % 7)) % 7) * DAY + (n - 1) * 7 * DAY;
}
// US daylight saving time (New York), from 2007: second Sunday of March to first of November
function usSummer(t: number): boolean {
  const y = new Date(t * 1000).getUTCFullYear();
  const [a, b] = y >= 2007 ? [sunday(y, 2, 2), sunday(y, 10, 1)] : [sunday(y, 3, 1), sunday(y, 9, -1)];
  return t >= a + 7200 && t < b + 7200;
}
// European summer time: last Sunday of March to last Sunday of October
function euSummer(t: number): boolean {
  const y = new Date(t * 1000).getUTCFullYear();
  return t >= sunday(y, 2, -1) + 3600 && t < sunday(y, 9, -1) + 3600;
}

// hours the file's clock is ahead of UTC at a (file clock) time
export function zoneHours(zone: Zone, t: number): number {
  switch (zone) {
    case 'utc': return 0;
    // most MetaTrader servers: New York time + 7 h, so the day closes at midnight
    case 'broker': return usSummer(t) ? 3 : 2;
    case 'paris': return euSummer(t) ? 2 : 1;
    case 'ny': return usSummer(t) ? -4 : -5;
    // HistData says "EST without daylight saving", but its bars follow New York's summer
    // time (compared with Binance's gold and Yahoo's EURUSD, and the gold's daily break
    // staying at 17:00 all year): on the US dates until 2018, on the European ones since 2019
    case 'histdata': return (new Date(t * 1000).getUTCFullYear() < 2019 ? usSummer(t) : euSummer(t)) ? -4 : -5;
    default: return Number(zone);
  }
}

// the file's clock -> UTC (sorted again: the autumn hour change repeats an hour)
export function toUtc(d: Float64Array, zone: Zone): Float64Array {
  if (zone === 'utc') return d;
  const out = d.slice();
  for (let k = 0; k < out.length; k += COLS) out[k] -= zoneHours(zone, out[k]) * 3600;
  return sortRows(out);
}
