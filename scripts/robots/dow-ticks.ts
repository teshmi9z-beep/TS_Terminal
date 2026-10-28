import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { zoneHours } from '../../src/data/import/csvImport';

// Tick bars for the Dow structure study: 150, 250, 500 and 1000 ticks a bar, month by
// month, into robots/dow/ticks/<source>_<symbol>/<YYYY-MM>_<N>.f64 (float64 rows: time
// in seconds with milliseconds, open, high, low, close, volume). A month's last partial
// bar is dropped. Newest months first, so the recent history is there early.
// - histdata: HistData.com's tick quotes (bid / ask): the bars use the middle price,
//   ticks during the forex rollover (16:45 - 18:15 New York) are left out. A tick is a
//   change of quote. The ZIPs are kept in robots/raw/histdata-tick.
// - binance: Binance USD-M perpetuals' aggregated trades (data.binance.vision): a tick
//   is a trade, as on the platform's tick charts. The ZIPs are removed once read.
// Usage: node robots/.build/dow-ticks.mjs histdata|binance [--only EURUSD,XAUUSD] [--from 2020-01]

const TICKS = [150, 250, 500, 1000];
const OUT = path.resolve('robots/dow/ticks');
const RAW = path.resolve('robots/raw/histdata-tick');
const TAR = 'C:/Windows/System32/tar.exe';
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const only = arg('--only')?.toUpperCase().split(',');
const from = arg('--from') ?? '2020-01';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const HD_TICK: [code: string, symbol: string, market: string][] = [
  ['EURUSD', 'EURUSD', 'Forex'], ['GBPUSD', 'GBPUSD', 'Forex'], ['USDJPY', 'USDJPY', 'Forex'], ['AUDUSD', 'AUDUSD', 'Forex'],
  ['USDCAD', 'USDCAD', 'Forex'], ['USDCHF', 'USDCHF', 'Forex'], ['NZDUSD', 'NZDUSD', 'Forex'], ['EURGBP', 'EURGBP', 'Forex'],
  ['EURJPY', 'EURJPY', 'Forex'], ['GBPJPY', 'GBPJPY', 'Forex'], ['AUDJPY', 'AUDJPY', 'Forex'], ['EURCHF', 'EURCHF', 'Forex'],
  ['XAUUSD', 'XAUUSD', 'Commodity'], ['XAGUSD', 'XAGUSD', 'Commodity'], ['WTIUSD', 'WTI', 'Commodity'],
  ['SPXUSD', 'SPX500', 'Index'], ['NSXUSD', 'NDX100', 'Index'], ['GRXEUR', 'DAX40', 'Index'], ['FRXEUR', 'CAC40', 'Index'],
  ['UKXGBP', 'FTSE100', 'Index'], ['JPXJPY', 'NIKKEI', 'Index'],
];
export const BN_TICK: [symbol: string, market: string][] = [
  ['XAUUSDT', 'Commodity'], ['XAGUSDT', 'Commodity'], ['CLUSDT', 'Commodity'], ['SPYUSDT', 'Index'], ['QQQUSDT', 'Index'],
  ['BTCUSDT', 'Crypto'], ['ETHUSDT', 'Crypto'],
];

// months from `from` to the current one, newest first
function months(): string[] {
  const out: string[] = [];
  const now = new Date();
  let y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  for (;;) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k < from) break;
    out.push(k);
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

// the bars of one month for every tick count
class Builder {
  private rows = TICKS.map(() => [] as number[]);
  private cur = TICKS.map(() => ({ n: 0, t: 0, o: 0, h: 0, l: 0, c: 0, v: 0 }));
  add(t: number, p: number, v: number) {
    for (let k = 0; k < TICKS.length; k++) {
      const b = this.cur[k];
      if (b.n === 0) { b.t = t; b.o = b.h = b.l = b.c = p; b.v = 0; }
      if (p > b.h) b.h = p;
      if (p < b.l) b.l = p;
      b.c = p; b.v += v; b.n++;
      if (b.n === TICKS[k]) { this.rows[k].push(b.t, b.o, b.h, b.l, b.c, b.v); b.n = 0; }
    }
  }
  save(dir: string, month: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (let k = 0; k < TICKS.length; k++) fs.writeFileSync(path.join(dir, `${month}_${TICKS[k]}.f64`), Buffer.from(new Float64Array(this.rows[k]).buffer));
    return this.rows[0].length / 6;
  }
}

// every line of the ZIP's CSV (Windows' tar reads ZIPs)
async function eachLine(zip: string, fn: (line: string) => void) {
  const p = spawn(TAR, ['-xOf', zip, '*.csv'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: p.stdout, crlfDelay: Infinity });
  for await (const line of rl) fn(line);
  await new Promise((r) => p.on('close', r));
}

const done = (dir: string, month: string) => fs.existsSync(path.join(dir, `${month}_${TICKS[TICKS.length - 1]}.f64`));

// ---------------------------------------------------------------- HistData
const HD = 'https://www.histdata.com';
async function histdataZip(code: string, month: string): Promise<Buffer | null> {
  const [y, m] = month.split('-').map(Number);
  const page = `${HD}/download-free-forex-historical-data/?/ascii/tick-data-quotes/${code.toLowerCase()}/${y}/${m}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const html = await (await fetch(page)).text();
      const field = (n: string) => new RegExp(`name="${n}" id="${n}" value="([^"]*)"`).exec(html)?.[1];
      const tk = field('tk'), date = field('date'), datemonth = field('datemonth'), fxpair = field('fxpair');
      if (!tk || !date || !datemonth || !fxpair) return null;
      const r = await fetch(`${HD}/get.php`, { method: 'POST', body: new URLSearchParams({ tk, date, datemonth, platform: 'ASCII', timeframe: 'T', fxpair }), headers: { Referer: page } });
      const buf = Buffer.from(await r.arrayBuffer());
      return r.ok && buf[0] === 0x50 && buf[1] === 0x4b ? buf : null;
    } catch {
      await sleep(5000 * attempt);
    }
  }
  return null;
}

// New York time of a UTC time, in seconds of the day
const nyDay = (t: number) => (((t + zoneHours('ny', t) * 3600) % 86400) + 86400) % 86400;

async function histdata() {
  fs.mkdirSync(RAW, { recursive: true });
  for (const [code, symbol, market] of HD_TICK) {
    if (only && !only.includes(symbol) && !only.includes(code)) continue;
    const dir = path.join(OUT, `histdata_${symbol}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ source: 'HistData', symbol, market, id: `histdata_${symbol}` }));
    let misses = 0;
    for (const month of months()) {
      if (done(dir, month)) continue;
      const zip = path.join(RAW, `${code}_${month.replace('-', '')}.zip`);
      if (!fs.existsSync(zip)) {
        const buf = await histdataZip(code, month);
        if (!buf) { console.log(`${symbol} ${month} : pas de ticks`); if (++misses >= 3) break; continue; }
        fs.writeFileSync(zip, buf);
      }
      misses = 0;
      const b = new Builder();
      let ticks = 0, dropped = 0;
      await eachLine(zip, (line) => {
        // 20260802 170011000,1.154460,1.155200,0
        if (line.length < 20) return;
        const y = +line.slice(0, 4), mo = +line.slice(4, 6), d = +line.slice(6, 8);
        const H = +line.slice(9, 11), M = +line.slice(11, 13), S = +line.slice(13, 15), ms = +line.slice(15, 18);
        const c1 = line.indexOf(',', 18), c2 = line.indexOf(',', c1 + 1), c3 = line.indexOf(',', c2 + 1);
        const bid = +line.slice(c1 + 1, c2), ask = +line.slice(c2 + 1, c3 < 0 ? undefined : c3);
        if (!(bid > 0) || !(ask > 0)) return;
        const clock = Date.UTC(y, mo - 1, d, H, M, S, ms) / 1000;
        const t = clock - zoneHours('histdata', clock) * 3600;
        const ny = nyDay(t);
        // the rollover: spreads blow out, the quotes dip
        if (market !== 'Index' && ny >= 60300 && ny < 65700) { dropped++; return; }
        b.add(t, (bid + ask) / 2, 1);
        ticks++;
      });
      const bars = b.save(dir, month);
      console.log(`${symbol} ${month} : ${ticks} ticks, ${bars} barres de 150${dropped ? `, ${dropped} ticks du rollover écartés` : ''}`);
      await sleep(300);
    }
  }
}

// ---------------------------------------------------------------- Binance USD-M perpetuals
async function download(url: string, file: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return false;
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const out = fs.createWriteStream(file);
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
      await new Promise((res, rej) => out.end((e?: Error) => (e ? rej(e) : res(null))));
      return true;
    } catch (e) {
      console.log(`  ${url} : ${(e as Error).message}, nouvel essai`);
      await sleep(5000 * attempt);
    }
  }
  return false;
}

async function binance() {
  const tmp = path.resolve('robots/raw/binance-tick');
  fs.mkdirSync(tmp, { recursive: true });
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (const [symbol, market] of BN_TICK) {
    if (only && !only.includes(symbol)) continue;
    const dir = path.join(OUT, `bnfut_${symbol}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ source: 'Binance Futures', symbol, market, id: `bnfut_${symbol}` }));
    let misses = 0;
    for (const month of months()) {
      if (done(dir, month)) continue;
      // the current month: one file a day
      const files = month === thisMonth
        ? Array.from({ length: now.getUTCDate() - 1 }, (_, i) => `daily/aggTrades/${symbol}/${symbol}-aggTrades-${month}-${String(i + 1).padStart(2, '0')}.zip`)
        : [`monthly/aggTrades/${symbol}/${symbol}-aggTrades-${month}.zip`];
      const b = new Builder();
      let ticks = 0, got = 0;
      for (const f of files) {
        const zip = path.join(tmp, path.basename(f));
        const t0 = Date.now();
        if (!(await download(`https://data.binance.vision/data/futures/um/${f}`, zip))) continue;
        const mb = fs.statSync(zip).size / 1e6;
        got++;
        await eachLine(zip, (line) => {
          // agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker
          const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1), c3 = line.indexOf(',', c2 + 1);
          const c4 = line.indexOf(',', c3 + 1), c5 = line.indexOf(',', c4 + 1), c6 = line.indexOf(',', c5 + 1);
          const p = +line.slice(c1 + 1, c2);
          if (!(p > 0)) return;
          let t = +line.slice(c5 + 1, c6 < 0 ? undefined : c6);
          t = t > 1e14 ? t / 1e6 : t / 1e3;
          b.add(t, p, +line.slice(c2 + 1, c3));
          ticks++;
        });
        fs.rmSync(zip, { force: true });
        if (files.length === 1) console.log(`  ${symbol} ${month} : ${mb.toFixed(0)} Mo en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      if (!got) { console.log(`${symbol} ${month} : pas de transactions`); if (++misses >= 2) break; continue; }
      misses = 0;
      const bars = b.save(dir, month);
      console.log(`${symbol} ${month} : ${ticks} ticks, ${bars} barres de 150`);
    }
  }
}

if (process.argv.includes('histdata')) await histdata();
if (process.argv.includes('binance')) await binance();
console.log('fini');
