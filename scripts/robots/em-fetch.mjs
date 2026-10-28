// Downloads the daily volatility indices the Expected Move study needs (scripts/robots/em-study.ts)
// from Yahoo, since late 2019, into robots/em/data: VIX, VIX1D (since April 2023), VXN, VXD,
// RVX, and the European / Japanese ones when Yahoo has them. Rows [time (UTC midnight of the
// exchange date), open, high, low, close]. Usage: node scripts/robots/em-fetch.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('robots/em/data');
const FROM = Date.UTC(2019, 8, 1) / 1000;
const LIST = [['VIX', '^VIX'], ['VIX1D', '^VIX1D'], ['VXN', '^VXN'], ['VXD', '^VXD'], ['RVX', '^RVX'], ['VDAX', '^VDAX'], ['V2TX', '^V2TX'], ['JNIV', '^JNIV']];
fs.mkdirSync(OUT, { recursive: true });
for (const [name, y] of LIST) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&period1=${FROM}&period2=${Math.floor(Date.now() / 1000)}`;
    const j = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })).json();
    const r = j.chart?.result?.[0];
    if (!r?.timestamp) { console.log(`${name}: rien (${j.chart?.error?.description ?? 'pas de données'})`); continue; }
    const q = r.indicators.quote[0], gmt = r.meta.gmtoffset ?? 0;
    const rows = [];
    r.timestamp.forEach((t, i) => {
      if (q.open[i] == null || q.close[i] == null) return;
      rows.push([Math.floor((t + gmt) / 86400) * 86400, q.open[i], q.high[i], q.low[i], q.close[i]]);
    });
    fs.writeFileSync(path.join(OUT, `${name}_1d.json`), JSON.stringify(rows));
    const d = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    console.log(`${name}: ${rows.length} jours ${d(rows[0][0])} → ${d(rows.at(-1)[0])}`);
  } catch (e) { console.log(`${name}: erreur ${e.message}`); }
}
