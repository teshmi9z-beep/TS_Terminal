import fs from 'node:fs';
import path from 'node:path';
import { Features, toBars } from '../../src/robots/features';
import { HR_LENGTHS, hrExpiry } from '../../src/robots/catalog';
import { costOf, SPLIT } from '../../src/robots/search';
import type { HourCell, HourStudy } from '../../src/robots/report';
import { between, datasetFiles, fromArg, idOfFile, readDataset, readHeader, toBarList } from './dataset';

// Does the break of an hour's range launch the day? For every market, hour H (Paris
// time) and range length: each day, the first close out of the range (before 23:00),
// an entry at the next bar's open in its direction, and the day's result at 23:00:
// - hold: kept until 23:00 (or the forex rollover when it comes first) whatever happens;
// - stop: out on a return to the range's other side (-1 R), else kept as long;
// in R (1 R = entry to the range's other side), costs paid; no break is read during the
// forex rollover (16:45-18:15 New York), whose spread spikes only bid-only data shows. The same days' plain
// direction (range end to 23:00, up or down) is the baseline: a break "knows" the
// day's direction only if it is right more often than that.
// Writes robots/hour/study-<tf>.json (every sum), and public/robots/hours.json (per market
// and setting, the averages the Robots page shows) from the 15 minutes.
// Only the bars since --from count (2020 by default).
// Usage: node robots/.build/hour-study.mjs [--tfs 15m] [--markets Forex,Index] [--only XAUUSD] [--min-years 3] [--from 2020-01-01|all]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const TFS = arg('--tfs')?.split(',') ?? ['15m'];
const MARKETS = arg('--markets')?.split(',');
const only = arg('--only');
const minYears = Number(arg('--min-years') ?? 3);
const FROM = fromArg();
const YEAR = 365.25 * 86400;
const DATA = path.resolve('robots/data');
const OUT = path.resolve('robots/hour');
fs.mkdirSync(OUT, { recursive: true });

export const CLOSES = ['c', 'm', 'b'] as const;
// per market, hour, length and close rule: [period][side] with period 0 = tuning (70 %), 1 = check
// and side 0 = long, 1 = short; each cell: n, right direction, R held, R with the stop, the
// costs in R (all sums)
export type Cell = [n: number, right: number, hold: number, stop: number, cost: number];
export type StudyMarket = {
  id: string; symbol: string; market: string; tf: string; from: number; to: number; split: number;
  // [H][length][close] -> [period][side] cells
  cells: Record<string, Cell[][]>;
  // [H][length] -> [period]: days with a range, days up (range end -> 23:00)
  base: Record<string, [number, number][]>;
};

function study(f: Features, cost: number, split: number): Pick<StudyMarket, 'cells' | 'base'> {
  const { o, h, l, c, n, t } = f.b;
  const p = f.local(), step = f.step(), roll = f.rollover();
  const cells: StudyMarket['cells'] = {}, base: StudyMarket['base'] = {};
  for (let H = 0; H < 24; H++) {
    for (const [lenId, len] of Object.entries(HR_LENGTHS)) {
      if (len * 60 < step) continue;
      const r = f.hourRange(H, len);
      // the day's plain direction, from the range's end to 23:00
      const b: [number, number][] = [[0, 0], [0, 0]];
      let lastEnd = NaN, exp = 0, from = -1;
      const days: { i0: number; exp: number }[] = [];
      for (let i = 0; i < n; i++) {
        if (!(r.hi[i] >= r.lo[i])) continue;
        if (r.end[i] !== lastEnd) {
          if (from >= 0) days.push({ i0: from, exp });
          lastEnd = r.end[i]; exp = hrExpiry(lastEnd, 'd'); from = i;
        }
      }
      if (from >= 0) days.push({ i0: from, exp });
      for (const d of days) {
        let j = d.i0;
        while (j + 1 < n && p[j + 1] < d.exp && r.end[j + 1] === r.end[d.i0] && !roll[j + 1]) j++;
        const per = t[d.i0] < split ? 0 : 1;
        b[per][0]++;
        if (c[j] > o[d.i0]) b[per][1]++;
      }
      base[`${H}_${lenId}`] = b;
      for (const close of CLOSES) {
        const cl: Cell[][] = [[[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]];
        for (const d of days) {
          const end = r.end[d.i0];
          let side = 0, i = d.i0;
          for (; i < n - 1 && r.end[i] === end && p[i] < d.exp; i++) {
            const hi = r.hi[i], lo = r.lo[i];
            // the forex rollover's dips are not breaks (see Features.rollover)
            if (roll[i]) continue;
            const m = close === 'm' ? 0.2 * (hi - lo) : 0;
            let up = c[i] > hi + m, dn = c[i] < lo - m;
            if (close === 'b') {
              const body = Math.abs(c[i] - o[i]) >= 0.6 * (h[i] - l[i]);
              up &&= body && c[i] > o[i];
              dn &&= body && c[i] < o[i];
            }
            if (up) { side = 1; break; }
            if (dn) { side = -1; break; }
          }
          if (!side) continue;
          const e = i + 1;
          if (p[e] >= d.exp || r.end[e] !== end || roll[e]) continue;
          const entry = o[e], hi = r.hi[i], lo = r.lo[i];
          const other = side > 0 ? lo : hi;
          const R = (entry - other) * side;
          if (!(R > 0)) continue;
          let stopped = NaN, j = e;
          for (; ; j++) {
            if (Number.isNaN(stopped)) {
              // a gap through the other side fills at the open
              if ((o[j] - other) * side <= 0) stopped = (o[j] - entry) * side / R;
              else if (((side > 0 ? l[j] : h[j]) - other) * side <= 0) stopped = -1;
            }
            // out at 23:00, or before the rollover when it comes first
            if (j + 1 >= n || p[j + 1] >= d.exp || r.end[j + 1] !== end || roll[j + 1]) break;
          }
          const hold = ((c[j] - entry) * side) / R;
          const costR = (2 * cost * entry) / R;
          const cell = cl[t[e] < split ? 0 : 1][side > 0 ? 0 : 1];
          cell[0]++;
          if (hold > 0) cell[1]++;
          cell[2] += hold - costR;
          cell[3] += (Number.isNaN(stopped) ? hold : stopped) - costR;
          cell[4] += costR;
        }
        for (const per of cl) for (const s of per) for (const k of [2, 3, 4]) s[k] = +s[k].toFixed(2);
        cells[`${H}_${lenId}_${close}`] = cl;
      }
      f.drop('hr');
    }
  }
  return { cells, base };
}

const t0 = Date.now();
for (const tf of TFS) {
  const out: StudyMarket[] = [];
  for (const file of datasetFiles(DATA)) {
    const id = idOfFile(file);
    if (!file.endsWith('.bin') || !id.endsWith(`_${tf}`) || /^(bnfut|import|yf)_/.test(id) || (only && !id.includes(only))) continue;
    const { meta } = readHeader(path.join(DATA, file));
    if ((MARKETS && !MARKETS.includes(meta.market)) || (meta.to - Math.max(meta.from, FROM)) / YEAR < minYears) continue;
    const t1 = Date.now();
    const rows = between(readDataset(path.join(DATA, file)).rows, FROM, Infinity);
    const b = toBars(toBarList(rows));
    const f = new Features(b);
    const split = b.t[Math.floor(b.n * SPLIT)];
    const res = study(f, costOf(meta), split);
    out.push({ id, symbol: meta.symbol, market: meta.market, tf, from: b.t[0], to: b.t[b.n - 1], split, ...res });
    console.log(`${id.padEnd(28)} ${String(b.n).padStart(7)} barres  ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  }
  fs.writeFileSync(path.join(OUT, `study-${tf}.json`), JSON.stringify(out));
  console.log(`${tf} : ${out.length} marchés dans robots/hour/study-${tf}.json`);
  if (tf === '15m' && !only && !MARKETS) writePage(out);
}

// per market and setting: trades, precision against the day's plain direction, R a trade
function writePage(study: StudyMarket[]) {
  const r2 = (x: number) => Math.round(x * 100) / 100, r1 = (x: number) => Math.round(x * 10) / 10;
  const page: HourStudy = { generatedAt: Date.now(), tf: '15m', from: FROM, markets: [] };
  for (const m of study) {
    const cells: Record<string, HourCell> = {};
    for (const [key, cl] of Object.entries(m.cells)) {
      const [H, len] = key.split('_');
      const b = m.base[`${H}_${len}`];
      const v = [0, 1].map((per) => {
        const [L, S] = cl[per], [days, up] = b[per];
        const n = L[0] + S[0];
        if (!n || !days) return null;
        const upP = up / days;
        const edge = ((L[1] + S[1]) / n - (L[0] * upP + S[0] * (1 - upP)) / n) * 100;
        // against the break: the held trade the other way, costs paid again
        return { n, edge, follow: (L[3] + S[3]) / n, fade: (-(L[2] + S[2]) - 2 * (L[4] + S[4])) / n };
      });
      if (!v[0] || !v[1]) continue;
      cells[key] = [v[0].n, v[1].n, r1(v[0].edge), r1(v[1].edge), r2(v[0].follow), r2(v[1].follow), r2(v[0].fade), r2(v[1].fade)];
    }
    page.markets.push({ symbol: m.symbol, market: m.market, from: m.from, to: m.to, split: m.split, cells });
  }
  fs.writeFileSync(path.resolve('public/robots/hours.json'), JSON.stringify(page));
  console.log(`public/robots/hours.json : ${page.markets.length} marchés`);
}
console.log(`terminé en ${((Date.now() - t0) / 60000).toFixed(1)} min`);
