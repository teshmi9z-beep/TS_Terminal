import fs from 'node:fs';
import path from 'node:path';
import { TEST_FROM } from './dataset';
import { nyOffset } from '../../src/robots/features';
import { atr14, COST, events, load, markets, sma, SPLIT, type Bars } from './index-lib';

// Free search on the user's main-list indices (HSI, Nikkei 225, CAC 40, DAX 40, S&P 500,
// Nasdaq 100, Dow Jones, Russell 2000): which candle configurations are followed by a move.
// Each configuration is traded: entry at the next bar's open, exit at the close H bars
// later, index costs on both sides, no new trade while one is open. It is found on
// 2020-01 → 2024-08 and checked on 2024-09 → now, market by market, against simply
// being in the market over the same bars (the indices rose a lot since 2020).
// Usage: node robots/.build/index-study.mjs [--tf 15m,1h,4h,1d]

const OUT = path.resolve('robots/index');

// ---------------------------------------------------------------- the trades
const FILTERS = ['none', 'up', 'down'] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = { none: '', up: 'au-dessus de la moyenne 200', down: 'sous la moyenne 200' };
const HORIZONS: Record<string, number[]> = { '15m': [1, 4, 16], '1h': [1, 4, 12, 24], '4h': [1, 3, 6, 12], '1d': [1, 3, 5, 10] };
const TF_SEC: Record<string, number> = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

// running sums of a set of trades: r in % of the price, a in ATR 14
type Acc = { n: number; wins: number; r: number; a: number; a2: number };
const acc = (): Acc => ({ n: 0, wins: 0, r: 0, a: 0, a2: 0 });

// HistData bars touching the forex rollover (16:45 - 18:15 New York): bid prices dip there,
// so no entry and no exit on them (bars over 1 h: those opening 16:45 - 17:45)
function rolloverMask(b: Bars, tfSec: number): Uint8Array {
  const m = new Uint8Array(b.n);
  for (let i = 0; i < b.n; i++) {
    const ny = (((b.t[i] + nyOffset(b.t[i])) % 86400) + 86400) % 86400;
    if (tfSec <= 3600) {
      const end = ny + tfSec;
      m[i] = ny < 18.25 * 3600 && end > 16.75 * 3600 ? 1 : 0;
    } else m[i] = ny >= 16.75 * 3600 && ny <= 17.75 * 3600 ? 1 : 0;
  }
  return m;
}

type Row = { event: string; filter: Filter; dir: 1 | -1; h: number; is: Acc[]; oos: Acc[]; extra: Acc[] };

function run(tf: string) {
  const { core, extra } = markets(tf);
  const all = [...core, ...extra].filter((m) => fs.existsSync(m.file));
  const rows = new Map<string, Row>();
  let labels: Record<string, string> = {};
  all.forEach((m) => {
    const isExtra = extra.includes(m);
    const k = isExtra ? extra.indexOf(m) : core.indexOf(m);
    const b = load(m.file);
    const E = events(b);
    labels = Object.fromEntries(E.map((e) => [e.key, e.label]));
    const atr = atr14(b), s200 = sma(b.c, 200);
    const roll = m.histdata && tf !== '1d' ? rolloverMask(b, TF_SEC[tf]) : null;
    const start = Math.max(210, b.t.findIndex((t) => t >= TEST_FROM));
    // each configuration's bars, once
    const hit = E.map((e) => { const a = new Uint8Array(b.n); for (let i = start; i < b.n; i++) a[i] = e.test(i) ? 1 : 0; return a; });
    for (let ei = 0; ei < E.length; ei++) {
      for (const filter of FILTERS) {
        for (const dir of [1, -1] as const) {
          for (const H of HORIZONS[tf]) {
            const key = `${E[ei].key}|${filter}|${dir}|${H}`;
            let row = rows.get(key);
            if (!row) {
              row = { event: E[ei].key, filter, dir, h: H, is: core.map(acc), oos: core.map(acc), extra: extra.map(acc) };
              rows.set(key, row);
            }
            let next = 0;
            for (let i = start; i + H < b.n; i++) {
              if (i < next || !hit[ei][i]) continue;
              if (filter === 'up' ? !(b.c[i] > s200[i]) : filter === 'down' ? !(b.c[i] < s200[i]) : false) continue;
              const e = i + 1, x = i + H;
              if (roll && (roll[e] || roll[x])) continue;
              const r = dir * (b.c[x] / b.o[e] - 1) - 2 * COST;
              const a = r / (atr[i] / b.c[i]);
              const target = isExtra ? (b.t[e] >= SPLIT ? row.extra[k] : null) : b.t[e] < SPLIT ? row.is[k] : row.oos[k];
              if (target) { target.n++; if (r > 0) target.wins++; target.r += r; target.a += a; target.a2 += a * a; }
              next = x;
            }
          }
        }
      }
    }
    console.log(`  ${tf} ${m.name} : ${b.n} bougies, ${E.length} configurations`);
  });
  return { rows: [...rows.values()], labels, core: core.map((m) => m.name), extra: extra.map((m) => m.name) };
}

// ---------------------------------------------------------------- the reading
const pool = (a: Acc[]) => a.reduce((s, x) => ({ n: s.n + x.n, wins: s.wins + x.wins, r: s.r + x.r, a: s.a + x.a, a2: s.a2 + x.a2 }), acc());
const mean = (x: Acc) => (x.n ? x.a / x.n : 0);
const tstat = (x: Acc) => {
  if (x.n < 3) return 0;
  const m = x.a / x.n, v = x.a2 / x.n - m * m;
  return v > 0 ? m / Math.sqrt(v / x.n) : 0;
};
const MIN_N: Record<string, number> = { '15m': 600, '1h': 300, '4h': 150, '1d': 80 };

function read(tf: string, res: ReturnType<typeof run>) {
  const { rows, labels, core } = res;
  const base = new Map(rows.filter((r) => r.event === 'all').map((r) => [`${r.filter}|${r.dir}|${r.h}`, r]));
  const need = core.length - 1;
  const out = rows.filter((r) => r.event !== 'all').map((r) => {
    const b = base.get(`${r.filter}|${r.dir}|${r.h}`)!;
    const isP = pool(r.is), oosP = pool(r.oos), exP = pool(r.extra);
    const isPos = r.is.filter((x) => x.n >= 5 && x.r > 0).length;
    const oosPos = r.oos.filter((x) => x.n >= 3 && x.r > 0).length;
    // better than being in the market the same way over the same bars, market by market
    const isBeat = r.is.filter((x, k) => x.n >= 5 && mean(x) > mean(b.is[k])).length;
    const oosBeat = r.oos.filter((x, k) => x.n >= 3 && mean(x) > mean(b.oos[k])).length;
    const found = isP.n >= MIN_N[tf] && isP.r > 0 && tstat(isP) >= 2.5 && isPos >= need && isBeat >= need - 1 && mean(isP) > mean(pool(b.is));
    const holds = oosP.n >= MIN_N[tf] * 0.25 && oosP.r > 0 && mean(oosP) > mean(pool(b.oos)) && oosPos >= Math.ceil(core.length * 0.67) && oosBeat >= Math.ceil(core.length * 0.5);
    return {
      key: `${r.event}|${r.filter}|${r.dir}|${r.h}`, event: r.event, label: labels[r.event], filter: r.filter, dir: r.dir, h: r.h,
      is: { n: isP.n, win: isP.n ? isP.wins / isP.n : 0, r: isP.n ? isP.r / isP.n : 0, a: mean(isP), t: tstat(isP), pos: isPos, beat: isBeat, base: mean(pool(b.is)) },
      oos: { n: oosP.n, win: oosP.n ? oosP.wins / oosP.n : 0, r: oosP.n ? oosP.r / oosP.n : 0, a: mean(oosP), t: tstat(oosP), pos: oosPos, beat: oosBeat, base: mean(pool(b.oos)) },
      extra: { n: exP.n, r: exP.n ? exP.r / exP.n : 0, a: mean(exP), pos: r.extra.filter((x) => x.n >= 3 && x.r > 0).length },
      perMarket: core.map((_, k) => ({ isN: r.is[k].n, isR: r.is[k].n ? r.is[k].r / r.is[k].n : 0, oosN: r.oos[k].n, oosR: r.oos[k].n ? r.oos[k].r / r.oos[k].n : 0 })),
      found, holds,
    };
  });
  // how often an in-sample winner stays a winner, whatever its strength: the base rate
  const winners = out.filter((x) => x.is.n >= MIN_N[tf] && x.is.r > 0);
  const baseRate = winners.length ? winners.filter((x) => x.oos.r > 0).length / winners.length : 0;
  const found = out.filter((x) => x.found);
  return { tf, markets: core, extra: res.extra, combos: out.length, baseRate, found: found.length, held: found.filter((x) => x.holds).length, rows: out };
}

const pct = (x: number) => `${(x * 100).toFixed(3)} %`;
const tfs = (process.argv.includes('--tf') ? process.argv[process.argv.indexOf('--tf') + 1] : '15m,1h,4h,1d').split(',');
fs.mkdirSync(OUT, { recursive: true });
const report: string[] = [];
for (const tf of tfs) {
  console.log(`— ${tf}`);
  const r = read(tf, run(tf));
  fs.writeFileSync(path.join(OUT, `study-${tf}.json`), JSON.stringify(r));
  report.push(`\n=== ${tf} · ${r.markets.join(', ')}${r.extra.length ? ` (+ ${r.extra.join(', ')} sur le contrôle)` : ''}`);
  report.push(`${r.combos} essais · ${r.found} trouvés sur 2020-01 → 2024-08 · ${r.held} tiennent sur 2024-09 → aujourd’hui · taux de base (gagnant avant ⇒ gagnant après) ${(r.baseRate * 100).toFixed(0)} %`);
  for (const x of r.rows.filter((x) => x.found).sort((a, b) => b.oos.t - a.oos.t)) {
    report.push(`${x.holds ? 'TIENT ' : '      '} ${x.dir > 0 ? 'achat' : 'vente'} ${x.h} bougie(s) · ${x.label}${x.filter !== 'none' ? ` · ${FILTER_LABEL[x.filter]}` : ''}`);
    report.push(`        avant : ${x.is.n} trades, ${(x.is.win * 100).toFixed(0)} % gagnants, ${pct(x.is.r)} / trade, ${x.is.a.toFixed(3)} ATR (référence ${x.is.base.toFixed(3)}), t ${x.is.t.toFixed(1)}, ${x.is.pos}/${r.markets.length} marchés positifs`);
    report.push(`        après : ${x.oos.n} trades, ${(x.oos.win * 100).toFixed(0)} % gagnants, ${pct(x.oos.r)} / trade, ${x.oos.a.toFixed(3)} ATR (référence ${x.oos.base.toFixed(3)}), t ${x.oos.t.toFixed(1)}, ${x.oos.pos}/${r.markets.length} marchés positifs${r.extra.length ? ` · Dow et Russell : ${x.extra.n} trades, ${pct(x.extra.r)}` : ''}`);
  }
}
fs.writeFileSync(path.join(OUT, 'study-report.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
