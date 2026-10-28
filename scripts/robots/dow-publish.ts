import fs from 'node:fs';
import path from 'node:path';
import { dowRun } from '../../src/robots/dow';
import { dowInputs, dowLabel } from '../../src/indicators/custom/dowStructure';
import { allowFor, load, luckTest, specs, variantOf, yearly, type Stats } from './dow-lib';

// Publishes the Dow structure study for the Robots page (public/robots/dow.json):
// - every market: the setting best on the tuning part (70 %) and its check (30 %), and its
//   walk-forward (each year from 2023 traded with the best setting of the years before it);
// - the robots kept: a walk-forward of 5 R at least, 60 % of its test years positive,
//   with the setting to trade now (the best of every year so far), its year by year result,
//   and the share of random-entry runs it beats;
// - the markets' active hours; the method's raw edge, before and after costs.
// robots/dow/verdict.json holds the study's conclusions in words.
// Usage: node robots/.build/dow-publish.mjs s1,s2,s3,t1,w1

type Row = [string, Stats, Stats];
type Result = { id: string; rows: Row[]; profile: number[]; spec: { symbol: string; market: string; tf: string; source: string; cost: number } };
type Wf = { id: string; steps: { year: number; key: string | null; trades: number; R: number }[]; current: string | null; currentR: number };

const plans = (process.argv[2] ?? 's1').split(',');
const byId = new Map<string, Result>();
for (const plan of plans) {
  const dir = path.resolve('robots/dow/results', plan);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Result;
    const had = byId.get(r.id);
    if (!had) { byId.set(r.id, r); continue; }
    const keys = new Set(had.rows.map(([k]) => k));
    for (const row of r.rows) if (!keys.has(row[0])) had.rows.push(row);
  }
}
// --wf: the walk-forward over every setting of the night (robots/dow/wf); --wf-check: the one
// over stage 1's settings only (robots/dow/wf-s1). A robot must win in both: its result
// mustn't hang on the settings left to choose from
const argOf = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const WF_DIR = path.resolve(argOf('--wf') ?? 'robots/dow/wf');
const WF_ALL = argOf('--wf-check') ? path.resolve(argOf('--wf-check')!) : null;
const wfOf = (id: string, dir = WF_DIR): Wf | null => {
  const f = path.join(dir, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const pf = (s: Stats) => (s.loss > 0 ? s.gross / s.loss : s.gross > 0 ? 99 : 0);
const perYear = (s: Stats) => (s.days > 0 ? (s.sumR / s.days) * 365 : 0);
const minIS = (tf: string) => (tf === '1d' ? 30 : tf === '4h' ? 50 : tf === '1h' ? 60 : tf === '15m' ? 100 : 150);
const passIS = (s: Stats, tf: string) => s.n >= minIS(tf) && s.sumR > 0 && pf(s) >= 1.15;
const passOOS = (s: Stats, tf: string) => s.n >= Math.round(minIS(tf) / 2.5) && s.sumR > 0 && pf(s) >= 1.05;
const brief = (s: Stats) => ({ n: s.n, ry: perYear(s), pf: Math.min(pf(s), 99), win: s.n ? (s.wins / s.n) * 100 : 0, dd: s.maxDD, exp: s.n ? s.sumR / s.n : 0 });
const hoursOf = (profile: number[], cut: number) => {
  const sorted = [...profile].sort((a, z) => a - z);
  return profile.map((v, h) => (v >= sorted[cut] ? h : -1)).filter((h) => h >= 0);
};
const round = (v: number) => Math.round(v * 10) / 10;

// the walk-forward of every market of a class and timeframe added up: the method's result
// without choosing the markets after the fact
const wfClasses = new Map<string, { market: string; tf: string; total: number; markets: number; positive: number; years: Record<number, number> }>();
for (const r of byId.values()) {
  const wf = wfOf(r.id);
  if (!wf) continue;
  const k = `${r.spec.market}|${r.spec.tf}`;
  const c = wfClasses.get(k) ?? { market: r.spec.market, tf: r.spec.tf, total: 0, markets: 0, positive: 0, years: {} };
  const R = wf.steps.reduce((a, s) => a + s.R, 0);
  c.total += R; c.markets++; if (R > 0) c.positive++;
  for (const s of wf.steps) c.years[s.year] = (c.years[s.year] ?? 0) + s.R;
  wfClasses.set(k, c);
}

// the same with stage 1's settings only to choose from
const wfAllClasses = new Map<string, number>();
if (WF_ALL) for (const r of byId.values()) {
  const wf = wfOf(r.id, WF_ALL);
  if (!wf) continue;
  const k = `${r.spec.market}|${r.spec.tf}`;
  wfAllClasses.set(k, (wfAllClasses.get(k) ?? 0) + wf.steps.reduce((a, s) => a + s.R, 0));
}

const all = specs();
const markets: unknown[] = [];
// the kept robots' walk-forward trades (each year with the setting chosen on the years
// before), for the one-account portfolio
// costR: the costs paid, in R (for the result at higher costs)
const wfTrades: { entry: number; exit: number; r: number; costR: number; who: string }[] = [];
const picks: { wf: { total: number } }[] = [];
for (const r of [...byId.values()].sort((a, z) => a.id.localeCompare(z.id))) {
  const tf = r.spec.tf;
  const ok = r.rows.filter(([, is]) => passIS(is, tf)).sort((a, z) => perYear(z[1]) - perYear(a[1]));
  const best = ok[0];
  const v = best ? variantOf(best[0]) : null;
  const wf = wfOf(r.id);
  const tested = wf ? wf.steps.filter((s) => s.trades >= 5) : [];
  const wfTotal = wf ? wf.steps.reduce((a, s) => a + s.R, 0) : null;
  markets.push({
    id: r.id, symbol: r.spec.symbol, market: r.spec.market, tf, key: best?.[0] ?? null, label: v ? dowLabel(v) : '',
    is: best ? brief(best[1]) : null, oos: best ? brief(best[2]) : null, ok: !!best && passOOS(best[2], tf),
    wf: wfTotal === null ? null : round(wfTotal), wfYears: wf ? wf.steps.map((s) => [s.year, s.trades, round(s.R)]) : [],
  });
  // a robot: re-tuned once a year, it would have made money, most test years
  // (at least 5 R over the test years: a few R is no edge), in a class whose markets
  // together make money in walk-forward, half of them at least (a winner in a losing class is luck)
  if (!wf || !wf.current || tested.length < 3 || !(wfTotal! >= 5)) continue;
  const cls = wfClasses.get(`${r.spec.market}|${tf}`);
  if (!cls || cls.total <= 0 || cls.positive < cls.markets / 2) { console.log(`${r.id} : walk-forward ${wfTotal!.toFixed(1)} R mais sa classe ne gagne pas (${cls?.total.toFixed(0)} R, ${cls?.positive} marchés positifs sur ${cls?.markets}), écarté`); continue; }
  // and the same with stage 1's settings only: the market and its class positive too
  if (WF_ALL) {
    const alt = wfOf(r.id, WF_ALL), altR = alt ? alt.steps.reduce((a, s) => a + s.R, 0) : 0, altCls = wfAllClasses.get(`${r.spec.market}|${tf}`) ?? 0;
    if (!(altR > 0) || !(altCls > 0)) { console.log(`${r.id} : walk-forward ${wfTotal!.toFixed(1)} R, mais ${altR.toFixed(1)} R (classe ${altCls.toFixed(0)} R) avec les réglages de départ, écarté`); continue; }
  }
  const positive = tested.filter((s) => s.R > 0).length / tested.length;
  if (positive < 0.6) { console.log(`${r.id} : walk-forward ${wfTotal!.toFixed(1)} R mais ${Math.round(positive * 100)} % d'années positives, écarté`); continue; }
  const k = wf.current;
  const spec = all.find((s) => s.id === r.id);
  if (!spec) continue;
  const b = load(spec)!;
  const vk = variantOf(k);
  const res = dowRun(b, { ...vk, cost: spec.cost }, allowFor(b, spec, vk));
  const years = yearly(res.trades, b, spec.cost).map(([y, s]) => [y, s.n, round(s.sumR)] as [number, number, number]);
  const runs = new Map<string, ReturnType<typeof dowRun>>();
  for (const st of wf.steps) {
    if (!st.key) continue;
    if (!runs.has(st.key)) { const vs = variantOf(st.key); runs.set(st.key, dowRun(b, { ...vs, cost: spec.cost }, allowFor(b, spec, vs))); }
    for (const t of runs.get(st.key)!.trades) {
      if (new Date(b.t[t.entryIdx] * 1000).getUTCFullYear() !== st.year) continue;
      wfTrades.push({ entry: b.t[t.entryIdx], exit: b.t[t.exitIdx], r: t.r, costR: (spec.cost * (t.entry + t.exit)) / Math.abs(t.entry - t.stop), who: `${r.spec.symbol} ${tf}` });
    }
  }
  const row = r.rows.find(([x]) => x === k);
  const luck = luckTest(b, spec, vk, res.trades);
  const hours = vk.hours === 'all' ? [] : hoursOf(r.profile, vk.hours === 'med' ? 12 : 16);
  picks.push({
    id: r.id, symbol: r.spec.symbol, market: r.spec.market, tf, source: r.spec.source, key: k, label: dowLabel(vk),
    inputs: dowInputs(vk, tf, hours, r.spec.cost), is: row ? brief(row[1]) : null, oos: row ? brief(row[2]) : null, years,
    wf: { total: round(wfTotal!), steps: wf.steps.map((s) => [s.year, s.trades, round(s.R)]) },
    note: /T$/.test(tf) && r.spec.source === 'HistData' ? 'Ticks HistData : la plateforme ouvre ce marché en 1 minute (pas de flux de ticks)' : undefined,
    luck: { is: luck.is, oos: luck.oos },
  } as { wf: { total: number } });
  console.log(`${r.id} ${k} : retenu (walk-forward ${wfTotal!.toFixed(1)} R, ${Math.round(positive * 100)} % d'années positives)`);
}
picks.sort((a, z) => z.wf.total - a.wf.total);

// the kept robots together on one 10 000 € account from 2023: 0.5 % of the account risked a
// trade (its value when the trade opens), the result booked when it closes
const RISK = 0.005, START = 10_000;
type Ev = { t: number; kind: 0 | 1; i: number };
const evs: Ev[] = wfTrades.flatMap((x, i) => [{ t: x.entry, kind: 1 as const, i }, { t: x.exit, kind: 0 as const, i }]).sort((a, z) => a.t - z.t || a.kind - z.kind);
let equity = START, peak = START, maxDD = 0;
const risked = new Map<number, number>();
const curve: [number, number][] = [];
const byYear = new Map<number, { from: number; to: number }>();
for (const e of evs) {
  if (e.kind === 1) { risked.set(e.i, equity * RISK); continue; }
  equity += (risked.get(e.i) ?? equity * RISK) * wfTrades[e.i].r;
  peak = Math.max(peak, equity);
  maxDD = Math.max(maxDD, (peak - equity) / peak);
  curve.push([e.t, Math.round(equity)]);
  const y = new Date(e.t * 1000).getUTCFullYear();
  const py = byYear.get(y) ?? { from: curve.length > 1 ? curve[curve.length - 2][1] : START, to: equity };
  py.to = equity;
  byYear.set(y, py);
}
// the same trades in 1 000 random orders (one after the other): the drawdown the order alone
// can make, median and 1 in 20
const ddOf = (rs: number[]) => {
  let eq = START, pk = START, dd = 0;
  for (const x of rs) { eq += eq * RISK * x; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); }
  return dd;
};
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const dds: number[] = [];
const rs = wfTrades.map((x) => x.r);
for (let k = 0; k < 1000 && rs.length; k++) {
  const a = rs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  dds.push(ddOf(a));
}
dds.sort((x, z) => x - z);
// and with costs half as high again (wider spreads, worse fills)
let eq15 = START;
const risked15 = new Map<number, number>();
for (const e of evs) {
  if (e.kind === 1) { risked15.set(e.i, eq15 * RISK); continue; }
  eq15 += (risked15.get(e.i) ?? eq15 * RISK) * (wfTrades[e.i].r - 0.5 * wfTrades[e.i].costR);
}
const portfolio = wfTrades.length ? {
  start: START, risk: RISK, trades: wfTrades.length, final: Math.round(equity), maxDD: Math.round(maxDD * 1000) / 10,
  ddMedian: Math.round(dds[dds.length >> 1] * 1000) / 10, dd95: Math.round(dds[Math.floor(dds.length * 0.95)] * 1000) / 10,
  finalCosts15: Math.round(eq15),
  years: [...byYear].sort((a, z) => a[0] - z[0]).map(([y, p]) => [y, Math.round(((p.to - p.from) / p.from) * 1000) / 10]),
  curve,
} : null;
if (portfolio) console.log(`portefeuille : ${portfolio.trades} trades, 10 000 € -> ${portfolio.final} € (frais × 1,5 : ${portfolio.finalCosts15} €), pire creux ${portfolio.maxDD} % (ordre au hasard : médiane ${portfolio.ddMedian} %, 1 fois sur 20 ${portfolio.dd95} %), par an ${portfolio.years.map(([y, p]) => `${y} ${p} %`).join(' · ')}`);

// active hours: one profile a symbol (15 minutes, else the finest)
const hours: unknown[] = [];
const seen = new Set<string>();
for (const tf of ['15m', '1m', '5m', '1h']) {
  for (const r of byId.values()) {
    if (r.spec.tf !== tf || seen.has(r.spec.symbol) || !r.profile) continue;
    seen.add(r.spec.symbol);
    hours.push({ symbol: r.spec.symbol, market: r.spec.market, profile: r.profile, med: hoursOf(r.profile, 12), top: hoursOf(r.profile, 16) });
  }
}

// raw edge: R a trade before and after costs, the average of every setting of the first stages
const raw: unknown[] = [];
const acc = new Map<string, { market: string; tf: string; raw: number; net: number; n: number }>();
for (const plan of plans.filter((p) => p === 's1' || p === 't1')) {
  const dir = path.resolve('robots/dow/results', plan);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Result;
    const k = `${r.spec.market}|${r.spec.tf}`;
    const a = acc.get(k) ?? { market: r.spec.market, tf: r.spec.tf, raw: 0, net: 0, n: 0 };
    for (const [, , oos] of r.rows) if (oos.n) { a.raw += (oos.sumR + oos.cost) / oos.n; a.net += oos.sumR / oos.n; a.n++; }
    acc.set(k, a);
  }
}
const TF_ORDER = ['150T', '250T', '500T', '1000T', '1m', '5m', '15m', '1h', '4h'];
for (const a of [...acc.values()].sort((x, z) => x.market.localeCompare(z.market) || TF_ORDER.indexOf(x.tf) - TF_ORDER.indexOf(z.tf))) raw.push({ market: a.market, tf: a.tf, raw: a.raw / a.n, net: a.net / a.n });

const verdictFile = path.resolve('robots/dow/verdict.json');
const verdict = fs.existsSync(verdictFile) ? JSON.parse(fs.readFileSync(verdictFile, 'utf8')) : [];
const classes = [...wfClasses.values()].sort((a, z) => a.market.localeCompare(z.market) || TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(z.tf))
  .map((c) => ({
    ...c, total: round(c.total), years: Object.entries(c.years).map(([y, R]) => [Number(y), round(R)]),
    all: wfAllClasses.has(`${c.market}|${c.tf}`) ? round(wfAllClasses.get(`${c.market}|${c.tf}`)!) : null,
  }));
const out = { generatedAt: Date.now(), from: Date.UTC(2020, 0, 1) / 1000, split: 0.7, plans, verdict, picks, markets, hours, raw, classes, portfolio };
fs.writeFileSync(path.resolve('public/robots/dow.json'), JSON.stringify(out));
console.log(`public/robots/dow.json : ${picks.length} robots retenus, ${markets.length} marchés`);
