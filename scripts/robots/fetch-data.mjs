// Downloads the history used by the robot lab into robots/data/<id>.json:
// { id, market, source, symbol, tf, bars: [[time, open, high, low, close, volume], ...] }
// Binance USDⓈ-M futures (TradFi perpetuals: gold, oil, US indices / stocks) and
// Yahoo Finance (forex, indices, commodities, stocks). The crypto and the long
// 1-minute histories come from scripts/robots/fetch-history.ts.
// Usage: node scripts/robots/fetch-data.mjs [--only <text>]
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('robots/data');
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRADFI = ['XAUUSDT', 'XAGUSDT', 'CLUSDT', 'SPYUSDT', 'QQQUSDT', 'TSLAUSDT', 'NVDAUSDT'];
const TRADFI_TF = { '5m': 60_000, '15m': 40_000, '1h': 20_000, '4h': 5_000 };
const YAHOO = [
  ['EURUSD=X', 'EURUSD', 'Forex'], ['GBPUSD=X', 'GBPUSD', 'Forex'], ['USDJPY=X', 'USDJPY', 'Forex'], ['AUDUSD=X', 'AUDUSD', 'Forex'],
  ['GC=F', 'GOLD', 'Commodity'], ['SI=F', 'SILVER', 'Commodity'], ['CL=F', 'WTI', 'Commodity'],
  ['^NDX', 'NDX', 'Index'], ['^GSPC', 'SPX', 'Index'], ['^DJI', 'DJI', 'Index'], ['^GDAXI', 'DAX', 'Index'], ['^FCHI', 'CAC40', 'Index'],
  ['AAPL', 'AAPL', 'Stock'], ['TSLA', 'TSLA', 'Stock'], ['NVDA', 'NVDA', 'Stock'], ['MSFT', 'MSFT', 'Stock'], ['AMZN', 'AMZN', 'Stock'],
];
const YAHOO_TF = ['1m', '5m', '15m', '30m', '1h', '1d'];

function save(meta, bars) {
  bars.sort((a, b) => a[0] - b[0]);
  const uniq = bars.filter((b, i) => i === 0 || b[0] !== bars[i - 1][0]);
  if (uniq.length < 300) { console.log(`  ${meta.id}: ${uniq.length} barres, ignoré`); return; }
  fs.writeFileSync(path.join(OUT, `${meta.id}.json`), JSON.stringify({ ...meta, bars: uniq }));
  const d = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`  ${meta.id}: ${uniq.length} barres ${d(uniq[0][0])} → ${d(uniq[uniq.length - 1][0])}`);
}

// ---- Binance: pages of klines going back from now; ~2000 weight a minute at most
async function binance(host, prefix, symbol, tf, want, limit, weight) {
  const bars = [];
  let end = Date.now();
  while (bars.length < want) {
    const url = `${host}${prefix}/klines?symbol=${symbol}&interval=${tf}&limit=${limit}&endTime=${end}`;
    let rows;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 418) { await sleep(30_000); continue; }
      if (!r.ok) { if (attempt < 2) { await sleep(2000); continue; } throw new Error(`${symbol} ${tf} HTTP ${r.status}`); }
      rows = await r.json();
      break;
    }
    if (!rows.length) break;
    for (const k of rows) bars.push([Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5]]);
    end = rows[0][0] - 1;
    if (rows.length < limit) break;
    await sleep(weight * 30);
  }
  return bars;
}

// ---- Yahoo: chart API, by range or by windows of dates
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };
async function yahooChunk(symbol, interval, q) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&${q}&includePrePost=false`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: UA });
    if (r.status === 429) { await sleep(10_000); continue; }
    if (!r.ok) return [];
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const qt = res?.indicators?.quote?.[0] ?? {};
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const o = qt.open?.[i], h = qt.high?.[i], l = qt.low?.[i], c = qt.close?.[i];
      if ([o, h, l, c].some((v) => v == null || !Number.isFinite(v))) continue;
      out.push([ts[i], o, h, l, c, qt.volume?.[i] ?? 0]);
    }
    return out;
  }
  return [];
}

async function yahoo(symbol, tf) {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  if (tf === '1m') {
    const bars = [];
    for (let k = 0; k < 4; k++) bars.push(...await yahooChunk(symbol, '1m', `period1=${now - (k + 1) * 7 * day}&period2=${now - k * 7 * day}`));
    return bars;
  }
  if (tf === '1h') return yahooChunk(symbol, '60m', `period1=${now - 729 * day}&period2=${now}`);
  // range=max comes back in monthly bars: explicit dates keep daily ones
  if (tf === '1d') return yahooChunk(symbol, '1d', `period1=0&period2=${now}`);
  return yahooChunk(symbol, tf, 'range=60d');
}

async function main() {
  const jobs = [];
  for (const s of TRADFI) for (const [tf, want] of Object.entries(TRADFI_TF)) {
    jobs.push({ id: `bnfut_${s}_${tf}`, run: () => binance('https://fapi.binance.com', '/fapi/v1', s, tf, want, 1500, 10), meta: { market: s.startsWith('X') || s === 'CLUSDT' ? 'Commodity' : 'Stock', source: 'Binance Futures', symbol: s, tf } });
  }
  for (const [y, name, market] of YAHOO) for (const tf of YAHOO_TF) {
    jobs.push({ id: `yahoo_${name}_${tf}`, run: () => yahoo(y, tf), meta: { market, source: 'Yahoo', symbol: name, tf } });
  }
  for (const j of jobs) {
    if (only && !j.id.includes(only)) continue;
    if (fs.existsSync(path.join(OUT, `${j.id}.json`)) && !process.argv.includes('--force')) { console.log(`  ${j.id}: déjà là`); continue; }
    try {
      save({ id: j.id, ...j.meta }, await j.run());
    } catch (e) {
      console.log(`  ${j.id}: échec ${e.message}`);
    }
    if (j.id.startsWith('yahoo')) await sleep(400);
  }
  console.log('terminé');
}

main();
