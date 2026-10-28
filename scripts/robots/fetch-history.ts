import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COLS, mergeRows, parseFiles, resampleRows, sortRows, toUtc, zoneHours } from '../../src/data/import/csvImport';
import { between, cleanBars, mergeNewer, readDataset, writeDataset } from './dataset';
import { SYMBOLS } from '../../src/data/symbols';
import { yahooId } from '../../src/data/feeds/resolve';

// Downloads the whole 1-minute history of the robot lab's markets and builds every
// timeframe from it into robots/data/<source>_<symbol>_<tf>.bin:
// - Binance spot (every crypto of src/data/symbols.ts): data.binance.vision's
//   monthly archives since each pair's listing, then the daily ones of the current month;
// - HistData.com (forex, gold, silver, oil, indices): one ZIP a year, a month for
//   the current year, kept in robots/raw/histdata. ZIPs already downloaded by hand
//   into the Downloads folder are picked up instead of downloaded again. The indices
//   added later are kept light: 15 minutes and more for the whole history, 1 and 5
//   minutes for the last 3 months only, and their ZIPs are removed once read;
// - Yahoo Finance (every index of the platform): 15 minutes for the last 60 days,
//   1 hour for the last 2 years and the whole daily history, added to what the
//   earlier runs kept, so the 15-minute history grows from one run to the next.
// Only what is missing is downloaded: run it again to bring everything up to date.
// HistData's bad ticks are taken out on the way (see cleanBars); `clean` repairs the
// files downloaded before that filter existed, without downloading anything, and
// `retime` moves the HistData files read as UTC-5 all year onto their true times.
// Usage: node robots/.build/history.mjs [binance] [histdata] [yahoo] [clean] [retime] [--only EURUSD,DAX40] [--rebuild]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const only = arg('--only')?.toUpperCase().split(',');
const picked = ['binance', 'histdata', 'yahoo'].filter((s) => process.argv.includes(s));
const sources = picked.length ? picked : ['binance', 'histdata', 'yahoo'];
const DATA = path.resolve('robots/data');
const RAW = path.resolve('robots/raw/histdata');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });

const TFS: [string, number][] = [['5m', 300], ['15m', 900], ['30m', 1800], ['1h', 3600], ['4h', 14400], ['1d', 86400]];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, '0');

// the file's bars (every CSV of a ZIP), in the file's own clock
async function rowsOf(buf: Buffer, name: string): Promise<Float64Array[]> {
  return (await parseFiles(new File([new Uint8Array(buf)], name))).map((p) => p.rows);
}

// HistData's bad ticks taken out (the exchanges' own data is left as it is)
function clean(source: string, rows: Float64Array, symbol = '', market = ''): { rows: Float64Array; note: string } {
  if (source !== 'HistData') return { rows, note: '' };
  const c = cleanBars(rows);
  const months = c.months.length ? ` (mois illisibles retirés : ${c.months.join(', ')})` : '';
  const ref = market === 'Index' ? againstReference(symbol, c.rows) : { rows: c.rows, dropped: 0, spans: [] };
  const note = (c.fixed || c.dropped ? ` · ticks erronés : ${c.fixed} corrigés, ${c.dropped} retirés${months}` : '')
    + (ref.dropped ? ` · ${ref.dropped} barres d'un autre marché retirées (${ref.spans.join(', ')})` : '');
  return { rows: ref.rows, note };
}

// HistData's index files hold other markets' prices for whole periods (the DAX at Euro
// Stoxx 50 levels from June 2020 to December 2023, a "Dollar Index" at Dow Jones levels
// until 2018): every bar is compared with Yahoo's daily close of the same index (the
// last one on or before its day), and the bars more than 25 % away from it go.
function againstReference(symbol: string, rows: Float64Array): { rows: Float64Array; dropped: number; spans: string[] } {
  const ref = existing(path.join(DATA, `yf_${symbol}_1d.bin`));
  const n = rows.length / COLS;
  if (!ref || !n) return { rows, dropped: 0, spans: [] };
  const rn = ref.length / COLS;
  const out = new Float64Array(rows.length);
  let m = 0, dropped = 0, j = 0, spanFrom = -1, spanTo = -1;
  const spans: string[] = [];
  const close = () => { if (spanFrom >= 0) spans.push(`${day(spanFrom)} → ${day(spanTo)}`); spanFrom = -1; };
  for (let i = 0; i < n; i++) {
    const t = rows[i * COLS];
    while (j + 1 < rn && ref[(j + 1) * COLS] <= t) j++;
    const r = ref[j * COLS] <= t ? ref[j * COLS + 4] : NaN;
    if (r > 0 && Math.abs(Math.log(rows[i * COLS + 4] / r)) > Math.log(1.25)) {
      dropped++;
      if (spanFrom < 0) spanFrom = t;
      spanTo = t;
      continue;
    }
    close();
    out.set(rows.subarray(i * COLS, i * COLS + COLS), m * COLS);
    m++;
  }
  close();
  return { rows: out.slice(0, m * COLS), dropped, spans: spans.filter((_, k) => k < 6) };
}

// the 1-minute bars and every bigger timeframe built from them, as <prefix>_<name>_<tf>.bin
function writeAll(source: string, prefix: string, name: string, symbol: string, market: string, raw: Float64Array) {
  const { rows, note } = clean(source, raw, symbol, market);
  const sundayIntoMonday = market !== 'Crypto';
  const meta = (tf: string) => ({ id: `${prefix}_${name}_${tf}`, market, source, symbol, tf });
  const m1 = writeDataset(path.join(DATA, `${prefix}_${name}_1m.bin`), meta('1m'), rows);
  const out = [`1m ${m1.bars}`];
  for (const [tf, s] of TFS) {
    const d = writeDataset(path.join(DATA, `${prefix}_${name}_${tf}.bin`), meta(tf), resampleRows(rows, s, sundayIntoMonday));
    out.push(`${tf} ${d.bars}`);
  }
  console.log(`  ${symbol} : ${day(m1.from)} → ${day(m1.to)} · barres ${out.join(', ')}${note}`);
}

const existing = (file: string): Float64Array | null => {
  try { return readDataset(file).rows; } catch { return null; }
};

// the light layout: 1 and 5 minutes for the last FINE_DAYS days only, 15 minutes for the
// whole history and every bigger timeframe built from it. `m1` (new 1-minute bars) is
// added to what the files already hold.
const FINE_DAYS = 92;
const NONE = new Float64Array(0);
function writeLight(source: string, prefix: string, symbol: string, market: string, raw: Float64Array) {
  const m1 = clean(source, raw, symbol, market).rows;
  const file = (tf: string) => path.join(DATA, `${prefix}_${symbol}_${tf}.bin`);
  const meta = (tf: string) => ({ id: `${prefix}_${symbol}_${tf}`, market, source, symbol, tf });
  const sundayIntoMonday = market !== 'Crypto';
  // from midnight FINE_DAYS days ago
  const cut = Math.floor((Date.now() / 1000 - FINE_DAYS * 86400) / 86400) * 86400;
  const fine = between(mergeNewer(existing(file('1m')) ?? NONE, m1), cut, Infinity);
  const m15 = mergeNewer(existing(file('15m')) ?? NONE, resampleRows(m1, 900, sundayIntoMonday));
  const out: string[] = [];
  if (fine.length) {
    out.push(`1m ${writeDataset(file('1m'), meta('1m'), fine).bars}`);
    out.push(`5m ${writeDataset(file('5m'), meta('5m'), resampleRows(fine, 300, sundayIntoMonday)).bars}`);
  } else {
    for (const tf of ['1m', '5m']) fs.rmSync(file(tf), { force: true });
  }
  const d15 = writeDataset(file('15m'), meta('15m'), m15);
  out.push(`15m ${d15.bars}`);
  for (const [tf, s] of TFS) if (s > 900) out.push(`${tf} ${writeDataset(file(tf), meta(tf), resampleRows(m15, s, sundayIntoMonday)).bars}`);
  console.log(`  ${symbol} : ${day(d15.from)} → ${day(d15.to)} · barres ${out.join(', ')} (1m et 5m à partir du ${day(cut)})`);
}

// ---- Binance spot
// every crypto of the platform's list, BTCUSD -> BTCUSDT
const CRYPTO = SYMBOLS.filter((s) => s.category === 'Crypto').map((s) => s.ticker.replace(/USD$/, 'USDT'));
const VISION = 'https://data.binance.vision/data/spot';

async function download(url: string): Promise<Buffer | null> {
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      status = r.status;
    } catch (e) {
      if (attempt >= 4) throw e;
    }
    if (attempt >= 4) throw new Error(`${url} : HTTP ${status}`);
    await sleep(2000 * attempt);
  }
}

// a few downloads at a time, results in the order asked
async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < jobs.length) { const k = next++; out[k] = await jobs[k](); }
  }));
  return out;
}

async function binance(symbol: string) {
  const name = symbol.replace(/USDT$/, 'USD');
  const file = path.join(DATA, `binance_${symbol}_1m.bin`);
  const old = existing(file);
  const now = new Date();
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  // from the month of the last bar we have, else from Binance's first month
  let start = Date.UTC(2017, 7, 1);
  if (old?.length) { const d = new Date(old[old.length - COLS] * 1000); start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  const months: number[] = [];
  for (let m = start; m < thisMonth; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) months.push(m);
  // before the listing there is nothing: skip ahead to the first month found
  if (!old?.length) {
    while (months.length) {
      const d = new Date(months[0]);
      const r = await fetch(`${VISION}/monthly/klines/${symbol}/1m/${symbol}-1m-${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}.zip`, { method: 'HEAD' });
      if (r.ok) break;
      months.shift();
    }
  }
  const tag = (t: number, withDay = false) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}${withDay ? `-${pad2(d.getUTCDate())}` : ''}`;
  };
  const daysOf = (from: number, to: number) => {
    const out: string[] = [];
    for (let t = from; t < to; t += 86400_000) out.push(`daily/klines/${symbol}/1m/${symbol}-1m-${tag(t, true)}.zip`);
    return out;
  };
  const fetchAll = (names: string[]) => pool(names.map((n) => () => download(`${VISION}/${n}`)), 6);
  const names = months.map((m) => `monthly/klines/${symbol}/1m/${symbol}-1m-${tag(m)}.zip`);
  process.stdout.write(`  ${name} : ${names.length} mois… `);
  const bufs = await fetchAll(names);
  // the current month day by day up to yesterday, and the last month too while its archive isn't out
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daily = [...(months.length && !bufs[bufs.length - 1] ? daysOf(months[months.length - 1], thisMonth) : []), ...daysOf(thisMonth, today)];
  bufs.push(...await fetchAll(daily));
  names.push(...daily);
  const parts: Float64Array[] = old?.length ? [old] : [];
  let got = 0;
  for (const [k, b] of bufs.entries()) {
    if (!b) continue;
    got++;
    parts.push(...await rowsOf(b, path.basename(names[k])));
  }
  // today's closed minutes, from the API (the archives stop at yesterday)
  const today1m: number[] = [];
  for (let from = today; ;) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000&startTime=${from}`);
    if (!r.ok) break;
    const ks = (await r.json()) as (string | number)[][];
    for (const k of ks) if (Number(k[6]) < Date.now()) today1m.push(Number(k[0]) / 1000, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5]));
    if (ks.length < 1000) break;
    from = Number(ks[ks.length - 1][0]) + 60_000;
  }
  if (today1m.length) parts.push(Float64Array.from(today1m));
  console.log(`${got} archives reçues, ${today1m.length / COLS} minutes d’aujourd’hui`);
  if (!parts.length) return;
  writeAll('Binance', 'binance', symbol, name, 'Crypto', mergeRows(parts));
  // the capped files of the first downloads
  for (const tf of ['1m', ...TFS.map(([t]) => t)]) fs.rmSync(path.join(DATA, `binance_${symbol}_${tf}.json`), { force: true });
}

// ---- HistData.com: M1 bars in "Generic ASCII", New York time (see zoneHours' 'histdata')
const HISTDATA: [code: string, symbol: string, market: string, light?: boolean][] = [
  ['EURUSD', 'EURUSD', 'Forex'], ['GBPUSD', 'GBPUSD', 'Forex'], ['USDJPY', 'USDJPY', 'Forex'], ['AUDUSD', 'AUDUSD', 'Forex'],
  ['USDCAD', 'USDCAD', 'Forex'], ['USDCHF', 'USDCHF', 'Forex'], ['EURGBP', 'EURGBP', 'Forex'],
  // crosses and exotics (HistData has no USDILS, EURZAR, EURSGD, GBPNOK, GBPSEK, GBPZAR, GBPSGD, NOKJPY, SEKJPY)
  ...[
    'NZDUSD', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'EURNZD', 'GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPCAD', 'GBPNZD',
    'AUDJPY', 'AUDCAD', 'AUDCHF', 'AUDNZD', 'NZDJPY', 'NZDCHF', 'CADJPY', 'CADCHF', 'CHFJPY',
    'USDNOK', 'USDSEK', 'USDDKK', 'USDPLN', 'USDZAR', 'USDMXN', 'USDSGD', 'USDHKD', 'USDTRY',
    'EURNOK', 'EURSEK', 'EURPLN', 'EURTRY', 'ZARJPY',
  ].map((p): [string, string, string] => [p, p, 'Forex']),
  ['XAUUSD', 'XAUUSD', 'Commodity'], ['XAGUSD', 'XAGUSD', 'Commodity'], ['WTIUSD', 'WTI', 'Commodity'],
  // added for the Dow structure study's check on markets it never saw (light: 15 minutes and more)
  ['BCOUSD', 'BRENT', 'Commodity', true], ['XAUEUR', 'XAUEUR', 'Commodity', true],
  ['SPXUSD', 'SPX500', 'Index'], ['NSXUSD', 'NDX100', 'Index'], ['GRXEUR', 'DAX40', 'Index'], ['FRXEUR', 'CAC40', 'Index'],
  ['UKXGBP', 'FTSE100', 'Index'], ['JPXJPY', 'NIKKEI', 'Index'],
  ['ETXEUR', 'STOXX50', 'Index', true], ['HKXHKD', 'HSI', 'Index', true], ['AUXAUD', 'ASX200', 'Index', true], ['UDXUSD', 'DXY', 'Index', true],
];
const HD = 'https://www.histdata.com';
const pageOf = (code: string, year: number, month?: number) => `${HD}/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/${code.toLowerCase()}/${year}${month ? `/${month}` : ''}`;

// raw/histdata/EURUSD_2018.zip (a year) or EURUSD_202609.zip (a month)
const rawName = (code: string, period: string) => `${code}_${period}.zip`;

// ZIPs saved by hand from the site (HISTDATA_COM_ASCII_EURUSD_M12018.zip)
function adoptDownloads() {
  const dir = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(dir)) return;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = /^HISTDATA_COM_ASCII_([A-Z]+)_M1_?(\d{4}(?:\d{2})?)(?: \(\d+\))?\.zip$/i.exec(f);
    if (!m) continue;
    const to = path.join(RAW, rawName(m[1].toUpperCase(), m[2]));
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(dir, f), to);
    n++;
  }
  if (n) console.log(`  ${n} ZIP HistData repris du dossier Téléchargements`);
}

// the page holds the form (with its token) that the download link posts
async function histdataZip(code: string, year: number, month?: number): Promise<Buffer | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await histdataOnce(code, year, month);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(5000 * attempt);
    }
  }
}

async function histdataOnce(code: string, year: number, month?: number): Promise<Buffer | null> {
  const page = pageOf(code, year, month);
  const html = await (await fetch(page)).text();
  const field = (n: string) => new RegExp(`name="${n}" id="${n}" value="([^"]*)"`).exec(html)?.[1];
  const tk = field('tk'), date = field('date'), datemonth = field('datemonth'), fxpair = field('fxpair');
  if (!tk || !date || !datemonth || !fxpair) return null;
  const r = await fetch(`${HD}/get.php`, {
    method: 'POST',
    body: new URLSearchParams({ tk, date, datemonth, platform: 'ASCII', timeframe: 'M1', fxpair }),
    headers: { Referer: page },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  // "PK": a ZIP (the site answers with a page when the period has no data)
  return r.ok && buf[0] === 0x50 && buf[1] === 0x4b ? buf : null;
}

async function histdataYears(code: string): Promise<number[]> {
  const html = await (await fetch(`${HD}/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/${code.toLowerCase()}`)).text();
  const re = new RegExp(`1-minute-bar-quotes/${code.toLowerCase()}/(\\d{4})`, 'g');
  return [...new Set([...html.matchAll(re)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

async function histdata(code: string, symbol: string, market: string, light = false) {
  const now = new Date();
  const year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
  const years = await histdataYears(code);
  const wanted: [period: string, y: number, m?: number][] = [];
  for (const y of years) {
    if (y < year) wanted.push([String(y), y]);
    else for (let m = 1; m <= month; m++) wanted.push([`${y}${pad2(m)}`, y, m]);
  }
  // a month fetched before its end is fetched again (at most once a day); a year always comes complete
  const complete = (period: string, at: number) => {
    if (period.length === 4) return true;
    const y = Number(period.slice(0, 4)), m = Number(period.slice(4));
    return at >= Date.UTC(y, m, 3) || Date.now() - at < 86400_000;
  };
  // light markets: the ZIPs already read into the files (period -> when it was downloaded)
  const readFile = path.join(RAW, `${code}.read.json`);
  let read: Record<string, number> = {};
  if (light) try { read = JSON.parse(fs.readFileSync(readFile, 'utf8')); } catch { /* none yet */ }
  let fetched = 0, missing = 0;
  for (const [period, y, m] of wanted) {
    const file = path.join(RAW, rawName(code, period));
    if (fs.existsSync(file) && complete(period, fs.statSync(file).mtimeMs)) continue;
    if (read[period] && complete(period, read[period])) continue;
    const buf = await histdataZip(code, y, m);
    if (buf) { fs.writeFileSync(file, buf); fetched++; } else missing++;
    await sleep(1200);
  }
  const files = fs.readdirSync(RAW).filter((f) => f.startsWith(`${code}_`) && f.endsWith('.zip')).sort();
  const out = path.join(DATA, `histdata_${symbol}_${light ? '15m' : '1m'}.bin`);
  const built = fs.existsSync(out) ? fs.statSync(out).mtimeMs : 0;
  const fresh = files.some((f) => fs.statSync(path.join(RAW, f)).mtimeMs > built);
  console.log(`  ${symbol} (${code}) : ${files.length} ZIP, ${fetched} téléchargés${missing ? `, ${missing} absents du site` : ''}`);
  if (!files.length || (!light && !fresh && !process.argv.includes('--rebuild'))) return;
  const parts: Float64Array[] = [];
  for (const f of files) {
    try {
      for (const rows of await rowsOf(fs.readFileSync(path.join(RAW, f)), f)) parts.push(toUtc(rows, 'histdata'));
    } catch (e) {
      console.log(`    ${f} illisible : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!parts.length) return;
  if (!light) { writeAll('HistData', 'histdata', symbol, symbol, market, mergeRows(parts)); return; }
  writeLight('HistData', 'histdata', symbol, market, mergeRows(parts));
  // read: only their dates are kept
  for (const f of files) {
    read[f.slice(code.length + 1, -4)] = fs.statSync(path.join(RAW, f)).mtimeMs;
    fs.rmSync(path.join(RAW, f));
  }
  fs.writeFileSync(readFile, JSON.stringify(read));
}

// ---- Yahoo Finance: the chart API, finished bars only
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
async function yahooBars(id: string, interval: string, step: number, query: string): Promise<Float64Array> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(id)}?interval=${interval}&${query}&includePrePost=false`, { headers: UA });
    if (r.status === 429 && attempt < 4) { await sleep(10_000 * attempt); continue; }
    if (!r.ok) throw new Error(`${id} ${interval} : HTTP ${r.status}`);
    type Chart = { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: Record<string, (number | null)[]>[] } }[] } };
    const res = ((await r.json()) as Chart).chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const q = res?.indicators?.quote?.[0] ?? {};
    const now = Date.now() / 1000;
    const out: number[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null || ts[i] + step > now) continue;
      out.push(ts[i], o, h, l, c, q.volume?.[i] ?? 0);
    }
    return sortRows(Float64Array.from(out));
  }
}

async function yahoo(ticker: string, id: string) {
  const now = Math.floor(Date.now() / 1000);
  const name = ticker.replace(/[^A-Za-z0-9]/g, '');
  const file = (tf: string) => path.join(DATA, `yf_${name}_${tf}.bin`);
  const meta = (tf: string) => ({ id: `yf_${name}_${tf}`, market: 'Index', source: 'Yahoo', symbol: ticker, tf });
  const got: Record<string, Float64Array> = {};
  for (const [tf, interval, step, query] of [
    ['15m', '15m', 900, 'range=60d'],
    ['1h', '60m', 3600, `period1=${now - 729 * 86400}&period2=${now}`],
    // range=max comes back in monthly bars: explicit dates keep daily ones
    ['1d', '1d', 86400, `period1=0&period2=${now}`],
  ] as const) {
    const rows = mergeNewer(existing(file(tf)) ?? NONE, await yahooBars(id, interval, step, query));
    if (rows.length) got[tf] = rows;
    await sleep(400);
  }
  if (got['15m']) got['30m'] = resampleRows(got['15m'], 1800, false);
  if (got['1h']) got['4h'] = resampleRows(got['1h'], 14400, false);
  const out: string[] = [];
  for (const tf of ['15m', '30m', '1h', '4h', '1d']) {
    if (!got[tf]) continue;
    const d = writeDataset(file(tf), meta(tf), got[tf]);
    if (tf !== '30m' && tf !== '4h') out.push(`${tf} ${d.bars} depuis le ${day(d.from)}`);
  }
  console.log(`  ${ticker} (${id}) : ${out.join(', ') || 'rien'}`);
}

// `clean`: the HistData files written before the bad-tick filter, repaired in place.
// Every timeframe is rebuilt from the cleaned 1-minute bars; the light indices (whose
// 1 minute covers the last months only) from their cleaned 15 minutes.
function repair() {
  for (const [, symbol, market, light] of HISTDATA) {
    if (only && !only.includes(symbol)) continue;
    const file = (tf: string) => path.join(DATA, `histdata_${symbol}_${tf}.bin`);
    if (!light) {
      const m1 = existing(file('1m'));
      if (m1) writeAll('HistData', 'histdata', symbol, symbol, market, m1);
      continue;
    }
    const m15 = existing(file('15m'));
    if (!m15) continue;
    const meta = (tf: string) => ({ id: `histdata_${symbol}_${tf}`, market, source: 'HistData', symbol, tf });
    const c15 = clean('HistData', m15, symbol, market);
    writeDataset(file('15m'), meta('15m'), c15.rows);
    for (const [tf, s] of TFS) if (s > 900) writeDataset(file(tf), meta(tf), resampleRows(c15.rows, s, true));
    const m1 = existing(file('1m'));
    const c1 = m1 ? clean('HistData', m1, symbol, market) : null;
    if (c1) {
      writeDataset(file('1m'), meta('1m'), c1.rows);
      writeDataset(file('5m'), meta('5m'), resampleRows(c1.rows, 300, true));
    }
    console.log(`  ${symbol} (léger) : 15 min${c15.note || ' · rien à corriger'}${c1 ? ` ; 1 min${c1.note || ' · rien à corriger'}` : ''}`);
  }
}

// `retime`: the HistData files first read as UTC-5 all year were an hour late in summer.
// Their 1-minute bars (15 minutes for the light indices) go back an hour where New York
// was on summer time, then every timeframe is built again. Done once per market
// (raw/histdata/retimed.txt lists them, one a line: several processes may add to it).
function retime() {
  const doneFile = path.join(RAW, 'retimed.txt');
  let done: string[] = [];
  try { done = fs.readFileSync(doneFile, 'utf8').split('\n').filter(Boolean); } catch { /* none yet */ }
  const shift = (rows: Float64Array) => {
    const out = rows.slice();
    // the files hold the HistData clock + 5 h
    for (let k = 0; k < out.length; k += COLS) { const clock = out[k] - 5 * 3600; out[k] = clock - zoneHours('histdata', clock) * 3600; }
    return sortRows(out);
  };
  for (const [, symbol, market, light] of HISTDATA) {
    if ((only && !only.includes(symbol)) || done.includes(symbol)) continue;
    const file = (tf: string) => path.join(DATA, `histdata_${symbol}_${tf}.bin`);
    const meta = (tf: string) => ({ id: `histdata_${symbol}_${tf}`, market, source: 'HistData', symbol, tf });
    if (!light) {
      const m1 = existing(file('1m'));
      if (!m1) continue;
      writeAll('HistData', 'histdata', symbol, symbol, market, shift(m1));
    } else {
      const m15 = existing(file('15m'));
      if (!m15) continue;
      const c15 = shift(m15);
      writeDataset(file('15m'), meta('15m'), c15);
      for (const [tf, s] of TFS) if (s > 900) writeDataset(file(tf), meta(tf), resampleRows(c15, s, true));
      const m1 = existing(file('1m'));
      if (m1) {
        const c1 = shift(m1);
        writeDataset(file('1m'), meta('1m'), c1);
        writeDataset(file('5m'), meta('5m'), resampleRows(c1, 300, true));
      }
      console.log(`  ${symbol} (léger) : recalé`);
    }
    fs.appendFileSync(doneFile, `${symbol}\n`);
  }
}

async function main() {
  const t0 = Date.now();
  if (process.argv.includes('retime')) {
    console.log('HistData : fichiers recalés sur l’heure d’été de New York');
    retime();
    console.log(`terminé en ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    return;
  }
  if (process.argv.includes('clean')) {
    console.log('HistData : nettoyage des ticks erronés des fichiers déjà téléchargés');
    repair();
    console.log(`terminé en ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    return;
  }
  if (sources.includes('binance')) {
    console.log('Binance (crypto, depuis la cotation)');
    for (const s of CRYPTO) {
      if (only && !only.some((o) => s.includes(o))) continue;
      try { await binance(s); } catch (e) { console.log(`  ${s} : échec ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  if (sources.includes('histdata')) {
    console.log('HistData (forex, métaux, pétrole, indices en M1)');
    adoptDownloads();
    for (const [code, symbol, market, light] of HISTDATA) {
      if (only && !only.includes(code) && !only.includes(symbol)) continue;
      try { await histdata(code, symbol, market, light); } catch (e) { console.log(`  ${symbol} : échec ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  if (sources.includes('yahoo')) {
    console.log('Yahoo (indices : 15 min sur 60 jours, 1 h sur 2 ans, jour depuis le début)');
    for (const s of SYMBOLS) {
      const id = s.category === 'Indices' ? yahooId(s) : null;
      if (!id || (only && !only.includes(s.ticker))) continue;
      try { await yahoo(s.ticker, id); } catch (e) { console.log(`  ${s.ticker} : échec ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  console.log(`terminé en ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

await main();
