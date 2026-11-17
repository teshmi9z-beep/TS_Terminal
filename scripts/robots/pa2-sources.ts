import fs from 'node:fs';
import path from 'node:path';
import { COLS, readDataset } from './dataset';
import { nbBacktest, type NbSessionKey } from '../../src/robots/noiseBand';
import { TIGHT } from './pa-check-costs';

// Is the loss on the unseen weeks the strategy's or the price source's? The robot's rule on two
// sources over the same days: the lab's file against Yahoo's (kept in robots/data), and IBKR's
// Nasdaq against Yahoo's NQ on the unseen days both cover.
// node robots/.build/pa2-sources.mjs <dir with the fresh Yahoo files>
const dir = process.argv[2];
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
type B = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; n: number };
function lab(id: string): B | null {
  const f = ['bin', 'json'].map((e) => path.resolve('robots/data', `${id}.${e}`)).find((x) => fs.existsSync(x));
  if (!f) return null;
  const { rows } = readDataset(f);
  const b: B = { t: [], o: [], h: [], l: [], c: [], n: 0 };
  for (let i = 0; i < rows.length / COLS; i++) { const k = i * COLS; if (rows[k] < Date.UTC(2026, 4, 1) / 1000 || rows[k] % 900) continue; b.t.push(rows[k]); b.o.push(rows[k + 1]); b.h.push(rows[k + 2]); b.l.push(rows[k + 3]); b.c.push(rows[k + 4]); }
  b.n = b.t.length;
  return b;
}
function fresh(file: string): B {
  const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).chart.result[0], q = r.indicators.quote[0];
  const b: B = { t: [], o: [], h: [], l: [], c: [], n: 0 };
  (r.timestamp as number[]).forEach((ts, i) => { if (ts % 900 || q.open[i] == null || q.close[i] == null) return; b.t.push(ts); b.o.push(q.open[i]); b.h.push(q.high[i]); b.l.push(q.low[i]); b.c.push(q.close[i]); });
  b.n = b.t.length;
  return b;
}
const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
function compare(name: string, A: B | null, B2: B | null, key: NbSessionKey, ck: string, from: number, to: number, la: string, lb: string) {
  if (!A || !B2) { say(`${name} : fichier absent`); return; }
  const run = (b: B) => nbBacktest(b, key, TIGHT[ck], from).filter((t) => b.t[t.entryBar] <= to).map((t) => ({ date: t.date, side: t.side, r: (t.net[0] + t.net[1]) / 2 }));
  const a = run(A), b = run(B2);
  const s = (x: { r: number }[]) => `${String(x.length).padStart(3)} signaux ${(x.reduce((p, q) => p + q.r, 0)).toFixed(2).padStart(6)} R`;
  const bd = new Map(b.map((x) => [x.date, x]));
  const same = a.filter((x) => bd.get(x.date)?.side === x.side).length;
  say(`${name.padEnd(22)} ${d(from)} → ${d(to)} | ${la} ${s(a)} | ${lb} ${s(b)} | mêmes jours et même sens : ${same}`);
}
const S19 = Date.UTC(2026, 8, 19) / 1000;
say('================ MÊME RÈGLE, DEUX SOURCES DE PRIX ================');
say('Avant le 19 septembre (jours connus du labo) :');
compare('Or, New York', lab('histdata_XAUUSD_15m'), lab('yahoo_GOLD_15m'), 'nym', 'XAUUSD', Date.UTC(2026, 7, 20) / 1000, Date.UTC(2026, 8, 18, 23) / 1000, 'HistData', 'Yahoo GC');
compare('Or, Londres', lab('histdata_XAUUSD_15m'), lab('yahoo_GOLD_15m'), 'ldn', 'XAUUSD', Date.UTC(2026, 7, 20) / 1000, Date.UTC(2026, 8, 18, 23) / 1000, 'HistData', 'Yahoo GC');
compare('USDJPY, Londres', lab('histdata_USDJPY_15m'), lab('yahoo_USDJPY_15m'), 'ldn', 'USDJPY', Date.UTC(2026, 7, 20) / 1000, Date.UTC(2026, 8, 18, 23) / 1000, 'HistData', 'Yahoo');
compare('Nasdaq', lab('histdata_NDX100_15m'), lab('dl_ibkr_US100_15m'), 'us', 'NDX100', Date.UTC(2026, 5, 1) / 1000, Date.UTC(2026, 8, 18, 23) / 1000, 'HistData', 'IBKR');
say('\nJours jamais vus couverts par deux sources :');
compare('Nasdaq', lab('dl_ibkr_US100_15m'), fresh('NQ=F.json'), 'us', 'NDX100', S19, Date.UTC(2026, 9, 5, 23) / 1000, 'IBKR', 'Yahoo NQ');
compare('Or, New York', lab('yahoo_GOLD_15m'), fresh('GC=F.json'), 'nym', 'XAUUSD', S19, Date.UTC(2026, 8, 24, 23) / 1000, 'Yahoo (labo)', 'Yahoo (frais)');
fs.writeFileSync('robots/pa/sources.txt', lines.join('\n'));
