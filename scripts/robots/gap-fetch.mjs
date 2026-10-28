// Downloads what the opening-gap study needs (scripts/robots/gap-study.ts), into robots/gaps/data:
// - the cash indices' 15-minute bars, session hours only, since 2020, from Interactive Brokers
//   (IB Gateway on this computer, read-only requests), one month per request, going back (IBKR
//   answers in about 13 ms per bar: 15-minute bars take an hour for the 7 indices, 5-minute ones three);
// - their daily bars since late 2019 from Yahoo (the Dow's only source: IBKR refuses its index).
// Files already there are extended, not fetched again; the indices download side by side. Usage: node scripts/robots/gap-fetch.mjs [port]
import fs from 'node:fs';
import path from 'node:path';
import { IBApi, EventName, SecType, BarSizeSetting, WhatToShow } from '@stoqey/ib';

const OUT = path.resolve('robots/gaps/data');
const FROM = Date.UTC(2020, 0, 1) / 1000;
const DAILY_FROM = Date.UTC(2019, 8, 1) / 1000;
// platform ticker -> IBKR index, Yahoo symbol
const INDICES = [
  ['SPX500', { symbol: 'SPX', exchange: 'CBOE', currency: 'USD' }, '^GSPC'],
  ['NDX100', { symbol: 'NDX', exchange: 'NASDAQ', currency: 'USD' }, '^NDX'],
  ['RUT2000', { symbol: 'RUT', exchange: 'RUSSELL', currency: 'USD' }, '^RUT'],
  ['DJI', null, '^DJI'],
  ['DAX40', { symbol: 'DAX', exchange: 'EUREX', currency: 'EUR' }, '^GDAXI'],
  ['CAC40', { symbol: 'CAC40', exchange: 'MONEP', currency: 'EUR' }, '^FCHI'],
  ['NIKKEI', { symbol: 'N225', exchange: 'OSE.JPN', currency: 'JPY' }, '^N225'],
  ['HSI', { symbol: 'HSI', exchange: 'HKFE', currency: 'HKD' }, '^HSI'],
];
fs.mkdirSync(OUT, { recursive: true });
const read = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);
const write = (f, rows) => fs.writeFileSync(f, JSON.stringify(rows));
const ibTime = (unix) => { const d = new Date(unix * 1000).toISOString(); return `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 19)}`; };
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

async function yahooDaily(ticker, y) {
  const file = path.join(OUT, `${ticker}_1d.json`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&period1=${DAILY_FROM}&period2=${Math.floor(Date.now() / 1000)}`;
  const j = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })).json();
  const r = j.chart.result[0], q = r.indicators.quote[0], gmt = r.meta.gmtoffset ?? 0;
  const rows = [];
  r.timestamp.forEach((t, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    rows.push([Math.floor((t + gmt) / 86400) * 86400, q.open[i], q.high[i], q.low[i], q.close[i]]);
  });
  write(file, rows);
  console.log(`${ticker} daily: ${rows.length} days ${day(rows[0][0])} → ${day(rows[rows.length - 1][0])}`);
}

const ib = new IBApi({ host: '127.0.0.1', port: Number(process.argv[2] ?? 4001), clientId: 78 });
let nextId = 1;
const pending = new Map();
ib.on(EventName.error, (err, code, reqId) => {
  const p = pending.get(reqId);
  if (!p || (code >= 2100 && code < 2200)) return;
  pending.delete(reqId);
  p.done(/no data|aucune donn/i.test(err?.message ?? '') ? [] : new Error(`${code} ${err?.message ?? err}`));
});
ib.on(EventName.historicalData, (reqId, time, o, h, l, c) => {
  const p = pending.get(reqId);
  if (!p) return;
  if (String(time).startsWith('finished')) { pending.delete(reqId); p.done(p.rows); } else if (o > 0) p.rows.push([Number(time), o, h, l, c]);
});
function month(contract, end) {
  return new Promise((resolve, reject) => {
    const reqId = nextId++;
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('timeout')); }, 120000);
    pending.set(reqId, { rows: [], done: (r) => { clearTimeout(timer); r instanceof Error ? reject(r) : resolve(r); } });
    // useRTH 1: the session only (the index isn't computed outside it); formatDate 2: epoch seconds
    ib.reqHistoricalData(reqId, { ...contract, secType: SecType.IND }, end ? ibTime(end) : '', '1 M', BarSizeSetting.MINUTES_FIFTEEN, WhatToShow.TRADES, 1, 2, false);
  });
}

async function intraday(ticker, contract) {
  const file = path.join(OUT, `${ticker}_15m.json`);
  let rows = read(file);
  const have = new Set(rows.map((r) => r[0]));
  let fetched = 0;
  const save = () => { rows.sort((a, b) => a[0] - b[0]); write(file, rows); };
  // one month ending at `end` (0: now), with two more tries after a failure
  const get = async (end) => {
    for (let attempt = 0; ; attempt++) {
      try { return await month(contract, end); } catch (e) {
        if (attempt >= 2) throw e;
        console.log(`  ${ticker}: ${e.message}, new try`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  const add = (got) => { for (const r of got) if (!have.has(r[0])) { rows.push(r); have.add(r[0]); fetched++; } };
  // the months newer than the file, then the older ones back to 2020
  const newest = rows.length ? rows[rows.length - 1][0] : 0;
  let end = 0;
  for (;;) {
    const got = await get(end);
    if (!got.length) break;
    add(got);
    console.log(`  ${ticker} <- ${day(got[0][0])} (${rows.length} bars)`);
    if (got[0][0] <= newest || got[0][0] <= FROM) break;
    end = got[0][0] - 1;
    if (!newest) save();
  }
  save();
  end = rows.length ? rows[0][0] - 1 : 0;
  while (end > FROM) {
    const got = await get(end);
    if (!got.length) break;
    add(got);
    end = got[0][0] - 1;
    save();
    console.log(`  ${ticker} <- ${day(got[0][0])} (${rows.length} bars)`);
  }
  rows = rows.filter((r) => r[0] >= FROM - 86400 * 7);
  save();
  console.log(`${ticker} 15m: ${rows.length} bars (${fetched} new) ${day(rows[0][0])} -> ${day(rows[rows.length - 1][0])}`);
}

ib.once(EventName.nextValidId, async () => {
  try {
    for (const [ticker, , y] of INDICES) await yahooDaily(ticker, y);
    // every index at once: IBKR answers each request slowly but serves several together
    await Promise.all(INDICES.filter(([, c]) => c).map(([ticker, contract]) => intraday(ticker, contract)));
  } catch (e) {
    console.error('failed:', e.message);
  }
  ib.disconnect();
  process.exit(0);
});
ib.connect();
