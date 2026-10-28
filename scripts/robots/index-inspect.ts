import fs from 'node:fs';
import path from 'node:path';
import { readHeader, TEST_FROM } from './dataset';
import { atr14, COST, DATA as DATA_DIR, load, markets, sma, SPLIT, type Bars } from './index-lib';

// A close look at the daily configurations the index study kept (index-study.ts), on the
// user's eight main-list indices: the settings next to them, year by year, against random
// days, with the indices' common days counted once, with a stop, and on the other indices
// on disk, which the study never saw.
// Usage: node robots/.build/index-inspect.mjs

type Trade = { m: number; entry: number; exit: number; t: number; r: number; a: number; excess: number };
type Signal = (b: Bars, i: number, atr: Float64Array) => boolean;
type Opts = { h: number; trend: number; stop?: number };

const M = markets('1d').core;
const market = (name: string, file: string) => {
  const b = load(file);
  return { name, b, atr: atr14(b), smas: new Map<number, Float64Array>(), start: Math.max(210, b.t.findIndex((t) => t >= TEST_FROM)) };
};
// the markets the functions below work on (the main list first, the other indices at the end)
const DATA = M.map((m) => market(m.name, m.file));
const smaOf = (k: number, len: number) => {
  const d = DATA[k];
  let s = d.smas.get(len);
  if (!s) { s = sma(d.b.c, len); d.smas.set(len, s); }
  return s;
};

// the trades of a signal: entry at the next open, exit at the close h days later (or at the
// stop, k ATR from the entry), no new trade while one is open; trend: only above that
// moving average (0: always)
function trades(sig: Signal, o: Opts): Trade[] {
  const out: Trade[] = [];
  DATA.forEach((d, k) => {
    const { b, atr, start } = d;
    const ma = o.trend ? smaOf(k, o.trend) : null;
    let next = 0;
    for (let i = start; i + o.h < b.n; i++) {
      if (i < next || (ma && !(b.c[i] > ma[i])) || !sig(b, i, atr)) continue;
      const e = i + 1;
      let x = i + o.h, px = b.c[x];
      if (o.stop) {
        const stop = b.o[e] - o.stop * atr[i];
        for (let j = e; j <= i + o.h; j++) {
          if (b.l[j] <= stop) { x = j; px = Math.min(b.o[j], stop); break; }
        }
      }
      const r = px / b.o[e] - 1 - 2 * COST;
      out.push({ m: k, entry: e, exit: x, t: b.t[e], r, a: r / (atr[i] / b.c[i]), excess: 0 });
      next = x;
    }
  });
  return out;
}

// being in the market over the same kind of days (the reference): the mean per market and period
function reference(o: Opts): { is: number[]; oos: number[] } {
  const all = trades(() => true, { h: o.h, trend: o.trend });
  const mean = (k: number, oos: boolean) => {
    const x = all.filter((t) => t.m === k && (t.t >= SPLIT) === oos);
    return x.length ? x.reduce((s, t) => s + t.a, 0) / x.length : 0;
  };
  return { is: DATA.map((_, k) => mean(k, false)), oos: DATA.map((_, k) => mean(k, true)) };
}

type Stat = { n: number; days: number; win: number; r: number; a: number; ex: number; tDays: number; pos: number };
function stat(list: Trade[], ref: number[]): Stat {
  if (!list.length) return { n: 0, days: 0, win: 0, r: 0, a: 0, ex: 0, tDays: 0, pos: 0 };
  for (const t of list) t.excess = t.a - ref[t.m];
  // the indices move together: one value per entry day (the mean of that day's trades)
  const byDay = new Map<number, number[]>();
  for (const t of list) {
    const d = Math.floor(t.t / 86400);
    const v = byDay.get(d) ?? [];
    v.push(t.excess);
    byDay.set(d, v);
  }
  const days = [...byDay.values()].map((v) => v.reduce((s, x) => s + x, 0) / v.length);
  const m = days.reduce((s, x) => s + x, 0) / days.length;
  const sd = Math.sqrt(days.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, days.length - 1));
  const pos = DATA.filter((_, k) => { const x = list.filter((t) => t.m === k); return x.length >= 3 && x.reduce((s, t) => s + t.r, 0) > 0; }).length;
  return {
    n: list.length, days: days.length, win: list.filter((t) => t.r > 0).length / list.length,
    r: list.reduce((s, t) => s + t.r, 0) / list.length, a: list.reduce((s, t) => s + t.a, 0) / list.length,
    ex: list.reduce((s, t) => s + t.excess, 0) / list.length, tDays: sd > 0 ? m / (sd / Math.sqrt(days.length)) : 0, pos,
  };
}
function both(sig: Signal, o: Opts) {
  const ref = reference(o);
  const list = trades(sig, o);
  return { is: stat(list.filter((t) => t.t < SPLIT), ref.is), oos: stat(list.filter((t) => t.t >= SPLIT), ref.oos), list, ref };
}
const f2 = (x: number) => (x >= 0 ? ' ' : '') + x.toFixed(2);
const line = (s: Stat) => `${String(s.n).padStart(4)} trades (${String(s.days).padStart(3)} jours) · ${(s.win * 100).toFixed(0)} % gagnants · ${(s.r * 100).toFixed(2).padStart(5)} % · ${f2(s.a)} ATR · écart ${f2(s.ex)} ATR · t(jours) ${f2(s.tDays)} · ${s.pos}/${DATA.length}`;

// the signals
const strongClose = (top: number, minRange: number): Signal => (b, i, atr) => {
  const rg = b.h[i] - b.l[i];
  return rg > minRange * atr[i - 1] && b.h[i] - b.c[i] <= top * rg;
};
const inside: Signal = (b, i) => b.h[i] < b.h[i - 1] && b.l[i] > b.l[i - 1];
const outsideBear: Signal = (b, i) => b.h[i] > b.h[i - 1] && b.l[i] < b.l[i - 1] && b.c[i] < b.o[i];

const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

say('=== Réglages voisins (avant : 2020-01 → 2024-08 · après : 2024-09 → aujourd’hui ; écart = gain en ATR moins celui d’être dans le marché les mêmes jours)');
const grid: [string, Signal, Opts][] = [];
for (const top of [0.1, 0.2, 0.3]) for (const mr of [0.5, 1, 1.5]) for (const h of [5, 10, 20]) for (const trend of [0, 200]) {
  grid.push([`clôture forte (haut ${top * 100} %, bougie > ${mr} ATR) · ${h} j${trend ? ' · > MM200' : ''}`, strongClose(top, mr), { h, trend }]);
}
for (const h of [3, 5, 10, 15, 20]) for (const trend of [0, 50, 100, 200]) grid.push([`inside bar · ${h} j${trend ? ` · > MM${trend}` : ''}`, inside, { h, trend }]);
for (const h of [3, 5, 10]) for (const trend of [0, 200]) grid.push([`outside bar baissière · ${h} j${trend ? ' · > MM200' : ''}`, outsideBear, { h, trend }]);
for (const [name, sig, o] of grid) {
  const r = both(sig, o);
  say(`${name}\n   avant ${line(r.is)}\n   après ${line(r.oos)}`);
}

// year by year, and against random days, for the finalists
const finalists: [string, Signal, Opts][] = [
  ['clôture forte (haut 10 %, > 1 ATR) · 10 j · > MM200', strongClose(0.1, 1), { h: 10, trend: 200 }],
  ['inside bar · 10 j · > MM200', inside, { h: 10, trend: 200 }],
  ['l’un ou l’autre · 10 j · > MM200', (b, i, a) => strongClose(0.1, 1)(b, i, a) || inside(b, i, a), { h: 10, trend: 200 }],
];
for (const [name, sig, o] of finalists) {
  const r = both(sig, o);
  say(`\n=== ${name}`);
  for (let y = 2020; y <= 2026; y++) {
    const a = Date.UTC(y, 0, 1) / 1000, z = Date.UTC(y + 1, 0, 1) / 1000;
    const x = r.list.filter((t) => t.t >= a && t.t < z);
    const ex = x.length ? x.reduce((s, t) => s + t.excess, 0) / x.length : 0;
    say(`  ${y} : ${String(x.length).padStart(3)} trades · ${(x.length ? (x.reduce((s, t) => s + t.r, 0) / x.length) * 100 : 0).toFixed(2)} % par trade · écart ${f2(ex)} ATR`);
  }
  // random days: the same number of trades per market and period, drawn among the days
  // above the average, 2 000 times; how often chance does as well
  const pool = trades(() => true, { h: 1, trend: o.trend });
  for (const [label, oos] of [['avant', false], ['après', true]] as const) {
    const real = r.list.filter((t) => (t.t >= SPLIT) === oos);
    const want = DATA.map((_, k) => real.filter((t) => t.m === k).length);
    const days = DATA.map((_, k) => pool.filter((t) => t.m === k && (t.t >= SPLIT) === oos).map((t) => t.entry));
    const realMean = real.reduce((s, t) => s + t.a, 0) / real.length;
    let beat = 0;
    for (let run = 0; run < 2000; run++) {
      let s = 0, n = 0;
      DATA.forEach((d, k) => {
        for (let j = 0; j < want[k]; j++) {
          const e = days[k][Math.floor(Math.random() * days[k].length)];
          const x = Math.min(d.b.n - 1, e + o.h - 1);
          const rr = d.b.c[x] / d.b.o[e] - 1 - 2 * COST;
          s += rr / (d.atr[e - 1] / d.b.c[e - 1]); n++;
        }
      });
      if (s / n >= realMean) beat++;
    }
    say(`  hasard (${label}) : des jours pris au hasard font aussi bien ${(beat / 20).toFixed(1)} % du temps`);
  }
  for (const stop of [1.5, 2, 3]) {
    const s = both(sig, { ...o, stop });
    say(`  stop à ${stop} ATR : avant ${line(s.is)}\n                après ${line(s.oos)}`);
  }
}

// the other indices on disk (Yahoo daily), never used by the study: since 2020 all is a check
const skip = new Set([...M.map((m) => m.sym), 'DXY', 'VIX']);
const others = fs.readdirSync(DATA_DIR).filter((f) => /^yf_.*_1d.bin$/.test(f)).map((f) => path.join(DATA_DIR, f))
  .map((file) => ({ file, meta: readHeader(file).meta }))
  .filter((x) => x.meta.market === 'Index' && !skip.has(x.meta.symbol));
DATA.splice(0, DATA.length, ...others.map((x) => market(x.meta.symbol, x.file)));
say(`
=== Les autres indices (${DATA.length}, jamais vus par l’étude), depuis 2020`);
for (const [name, sig, o] of finalists) {
  const all = trades(() => true, { h: o.h, trend: o.trend });
  const ref = DATA.map((_, k) => { const x = all.filter((t) => t.m === k); return x.length ? x.reduce((s, t) => s + t.a, 0) / x.length : 0; });
  const list = trades(sig, o);
  const st = stat(list, ref);
  const beat = DATA.filter((_, k) => { const x = list.filter((t) => t.m === k); return x.length >= 3 && x.reduce((s, t) => s + t.a, 0) / x.length > ref[k]; }).length;
  say(`${name}
   ${line(st)} · bat la référence sur ${beat}/${DATA.length}`);
}
// the regime alone: the next days above and below the 200-day average, on all the indices
DATA.push(...M.map((m) => market(m.name, m.file)));
say(`
=== Le régime seul, sur les ${DATA.length} indices depuis 2020 : les jours suivants au-dessus / sous la moyenne 200`);
for (const h of [1, 5, 10, 20]) {
  let better = 0, calmer = 0;
  const up: number[] = [], dn: number[] = [], upSd: number[] = [], dnSd: number[] = [];
  DATA.forEach((d, k) => {
    const ma = smaOf(k, 200);
    const ru: number[] = [], rd: number[] = [];
    for (let i = d.start; i + h < d.b.n; i++) {
      if (!(ma[i] > 0)) continue;
      const r = d.b.c[i + h] / d.b.c[i] - 1;
      (d.b.c[i] > ma[i] ? ru : rd).push(r);
    }
    const mean = (x: number[]) => x.reduce((s2, v) => s2 + v, 0) / Math.max(1, x.length);
    const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(x.reduce((s2, v) => s2 + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };
    if (ru.length < 20 || rd.length < 20) return;
    up.push(mean(ru)); dn.push(mean(rd)); upSd.push(sd(ru)); dnSd.push(sd(rd));
    if (mean(ru) > mean(rd)) better++;
    if (sd(ru) < sd(rd)) calmer++;
  });
  const avg = (x: number[]) => (x.reduce((s2, v) => s2 + v, 0) / x.length) * 100;
  say(`  ${String(h).padStart(2)} j : au-dessus ${avg(up).toFixed(2)} % (écart-type ${avg(upSd).toFixed(2)} %) · en dessous ${avg(dn).toFixed(2)} % (écart-type ${avg(dnSd).toFixed(2)} %) · meilleur au-dessus sur ${better}/${up.length} · plus calme au-dessus sur ${calmer}/${up.length}`);
}
fs.writeFileSync('robots/index/inspect-1d.txt', out.join('\n') + '\n');
