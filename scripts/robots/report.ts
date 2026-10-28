import fs from 'node:fs';
import path from 'node:path';
import { derive4h, Lab, CRITERIA, LEG_SETS, SPLIT, type Candidate, type DatasetFile, type DatasetSummary } from '../../src/robots/search';
import { FILTERS, SIGNALS, STOPS } from '../../src/robots/catalog';
import { applyMoney, statsOf, MM_LABELS, type MoneyMgmt, type Stats } from '../../src/robots/engine';
import type { GeneralSetting, RobotReport, RobotStrategy } from '../../src/robots/report';
import { between, fromArg, readDataset, toBarList } from './dataset';

// Builds public/robots/report.json (the "Robots" tab) from every round of the lab:
// the most profitable strategies that meet the criteria in both periods, each with
// its six money managements, its three legs and its equity curve.
// Every robot is measured again on the market since --from (2020 by default: the user's
// rule), its tuning / check split inside that window.
// Usage: node robots/.build/report.mjs [--keep 30] [--from 2020-01-01|all]

const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const KEEP = Number(arg('--keep') ?? 40);
const FROM = fromArg();
const RES = path.resolve('robots/results');
const DATA = path.resolve('robots/data');
const OUT = path.resolve('public/robots');
fs.mkdirSync(OUT, { recursive: true });

type Round = { round: string; ranAt: number; tested: number; summaries: DatasetSummary[]; candidates: Candidate[] };
const rounds: Round[] = fs.readdirSync(RES).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8')));

const keyOf = (c: Candidate) => `${c.ds}|${c.signal}|${c.filter}|${c.stop}|${c.dir}|${c.legs.tpR}|${c.legs.trailK}`;
const all = new Map<string, Candidate>();
for (const r of rounds) for (const c of r.candidates) all.set(keyOf(c), c);
// the latest summary of each dataset
const summaries = new Map<string, DatasetSummary>();
for (const r of rounds.sort((a, b) => a.ranAt - b.ranAt)) for (const s of r.summaries) summaries.set(s.id, s);

// robustness: how many neighbouring settings (other stops and exits) also pass;
// and the other markets / timeframes where the exact same robot passes
const hoodKey = (c: Candidate) => `${c.ds}|${c.signal}|${c.filter}|${c.dir}`;
const specKey = (c: Candidate) => `${c.signal}|${c.filter}|${c.stop}|${c.dir}|${c.legs.tpR}|${c.legs.trailK}`;
const hood = new Map<string, number>(), specs = new Map<string, string[]>();
for (const c of all.values()) {
  hood.set(hoodKey(c), (hood.get(hoodKey(c)) ?? 0) + 1);
  const l = specs.get(specKey(c)) ?? [];
  l.push(c.ds);
  specs.set(specKey(c), l);
}
// candidates of round 1 (6 stops x 6 exits) predate robustTotal
const NEIGHBOURS = 6 * LEG_SETS.length;
const dsName = (id: string) => { const p = id.split('_'); return `${p[1].replace(/USDT$/, 'USD')} ${p[2]}`; };

// null when the data is gone (an import deleted since)
function labOf(id: string): Lab | null {
  const derived = /^yahoo_.*_4h$/.test(id);
  const base = derived ? id.replace(/_4h$/, '_1h') : id;
  const file = [`${base}.bin`, `${base}.json`].map((f) => path.join(DATA, f)).find((f) => fs.existsSync(f));
  if (!file) return null;
  // the bars the search went through (the file may have grown since)
  const s = summaries.get(id);
  const { meta, rows } = readDataset(file);
  const from = Math.max(FROM, s?.from ?? 0), to = s?.to ?? Infinity;
  let ds: DatasetFile = { id: meta.id, market: meta.market, source: meta.source, symbol: meta.symbol, tf: meta.tf, bars: toBarList(!derived ? between(rows, from, to) : rows) };
  if (derived) ds = derive4h(ds);
  if (derived) ds.bars = ds.bars.filter((b) => b[0] >= from && b[0] <= to);
  // a warm-up and the minimum trades need some history
  if (ds.bars.length < 500) return null;
  return new Lab(ds);
}

const dirLabel = (d: number) => (d === 1 ? 'Achat seulement' : d === -1 ? 'Vente seulement' : 'Achat et vente');
const MMS = Object.keys(MM_LABELS) as MoneyMgmt[];

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}

// three selections: the best of every round, the Stoch Price Envelope range / trend robots
// of the night rounds ("night-*") and the hour-range ones ("hour-*"), shown apart in the tab
type Set_ = 'spe' | 'hr';
const setOfRound = (round: string): Set_ => (round.startsWith('hour-') ? 'hr' : 'spe');
const nightKeys = new Set<string>(), hourKeys = new Set<string>();
for (const r of rounds) {
  if (r.round.startsWith('night-')) for (const c of r.candidates) nightKeys.add(keyOf(c));
  if (r.round.startsWith('hour-')) for (const c of r.candidates) hourKeys.add(keyOf(c));
}
// the general rounds (general.mjs, a ranking in robots/general): settings that pass on several markets at once
const GEN = path.resolve('robots/general');
const genRounds = new Set(fs.existsSync(GEN) ? fs.readdirSync(GEN).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []);
// a robot counts as general when its setting passes on 20 % of its class's markets or more
const MIN_GENERAL_SHARE = 0.2;
type GenPick = { group: string; spec: Omit<Candidate, 'ds' | 'is' | 'oos' | 'full'>; passed: number; markets: number; share: number; posOOS: number; fullRY: number; on: string[] };
// when several general rounds of a selection covered a class and timeframe, the latest one
// counts (it may have run on repaired data or a larger grid)
type GenFile = { round: string; ranAt: number; groups: { group: string }[]; chosen: GenPick[] };
const genFiles = ([...genRounds].map((r) => JSON.parse(fs.readFileSync(path.join(GEN, `${r}.json`), 'utf8'))) as GenFile[]).sort((a, b) => a.ranAt - b.ranAt);
const genOwner = new Map<string, string>();
for (const f of genFiles) for (const g of f.groups) genOwner.set(`${setOfRound(f.round)}|${g.group}`, f.round);
const genChosen = genFiles.flatMap((f) => f.chosen.filter((c) => genOwner.get(`${setOfRound(f.round)}|${c.group}`) === f.round).map((c) => ({ ...c, set: setOfRound(f.round), ranAt: f.ranAt })));
const specOf = (c: Omit<Candidate, 'ds' | 'is' | 'oos' | 'full'>) => `${c.signal}|${c.filter}|${c.stop}|${c.dir}|${c.legs.tpR}|${c.legs.trailK}`;
const generalSpecs = new Set(genChosen.filter((g) => g.share >= MIN_GENERAL_SHARE).map((g) => `${g.set}|${g.group}|${specOf(g.spec)}`));
const generalKeys = new Set<string>();
for (const r of rounds) {
  if (!genRounds.has(r.round)) continue;
  const set = setOfRound(r.round);
  const groupOf = new Map(r.summaries.map((s) => [s.id, `${s.market}|${s.tf}`]));
  for (const c of r.candidates) {
    const group = groupOf.get(c.ds);
    if (group && genOwner.get(`${set}|${group}`) === r.round && generalSpecs.has(`${set}|${group}|${specOf(c)}`)) generalKeys.add(keyOf(c));
  }
}

// first pass: rank by total R, recompute the best few hundred in euros
// (the best 25 of each market / timeframe: total R favours the long histories)
const top25 = (cands: Iterable<Candidate>) => {
  const byDs = new Map<string, Candidate[]>();
  for (const c of cands) { const l = byDs.get(c.ds) ?? []; l.push(c); byDs.set(c.ds, l); }
  return [...byDs.values()].flatMap((l) => l.sort((a, b) => b.full.totalR - a.full.totalR).slice(0, 25));
};
const rankedMain = top25([...all.values()].filter((c) => !hourKeys.has(keyOf(c))));
const rankedNight = top25([...all.values()].filter((c) => nightKeys.has(keyOf(c)) && !generalKeys.has(keyOf(c))));
const rankedGeneral = top25([...all.values()].filter((c) => generalKeys.has(keyOf(c)) && !hourKeys.has(keyOf(c))));
const rankedHour = top25([...all.values()].filter((c) => hourKeys.has(keyOf(c)) && !generalKeys.has(keyOf(c))));
const rankedHourGeneral = top25([...all.values()].filter((c) => hourKeys.has(keyOf(c)) && generalKeys.has(keyOf(c))));
// one market at a time (hundreds of long histories do not fit in memory together)
const toBuild = new Map<string, Candidate[]>();
for (const c of [...rankedMain, ...rankedNight, ...rankedGeneral, ...rankedHour, ...rankedHourGeneral]) {
  const l = toBuild.get(c.ds) ?? [];
  if (!l.some((x) => keyOf(x) === keyOf(c))) l.push(c);
  toBuild.set(c.ds, l);
}
const builtByKey = new Map<string, RobotStrategy>();
for (const [dsId, cands] of toBuild) {
  const lab = labOf(dsId);
  if (!lab) continue;
  for (const c of cands) builtByKey.set(keyOf(c), buildOne(lab, c));
}

function buildOne(lab: Lab, c: Candidate): RobotStrategy {
  const trades = lab.run(c);
  const money = MMS.map((mm) => applyMoney(trades, mm));
  const fixed = money[0];
  const { b } = lab;
  const sg = SIGNALS.find((s) => s.id === c.signal)!, fl = FILTERS.find((f) => f.id === c.filter)!, st = STOPS.find((s) => s.id === c.stop)!;
  const best = [...money].sort((x, y) => y.netProfit / Math.max(1, y.maxDDPct) - x.netProfit / Math.max(1, x.maxDDPct))[0];
  // the last groups: entry time, side, each leg's R and the euros of the fixed rule
  const recent: RobotStrategy['recent'] = [];
  for (let k = trades.length - 1, taken = 0; k >= 0 && taken < 25;) {
    const g = trades[k].group;
    const legs: number[] = [0, 0, 0];
    let eur = 0, first = k;
    for (; k >= 0 && trades[k].group === g; k--) { legs[trades[k].leg] = trades[k].r; eur += fixed.pnl[k]; first = k; }
    const t = trades[first];
    recent.push({ time: b.t[t.entryIdx], side: t.side, entry: t.entry, legs, eur });
    taken++;
  }
  const years = Math.max(0.25, (b.t[b.n - 1] - b.t[0]) / (365.25 * 86400));
  return {
    id: keyOf(c),
    // under a year the return is not extrapolated
    years, annualPct: years >= 1 ? (Math.pow(Math.max(1e-9, fixed.finalEquity / 10_000), 1 / years) - 1) * 100 : fixed.netPct,
    name: `${sg.family} · ${lab.ds.symbol} ${lab.ds.tf}`,
    symbol: lab.ds.symbol, market: lab.ds.market, source: lab.ds.source, tf: lab.ds.tf,
    signal: { id: sg.id, label: sg.label, family: sg.family },
    filter: { id: fl.id, label: fl.label }, stop: { id: st.id, label: st.label },
    dir: c.dir, dirLabel: dirLabel(c.dir), legs: c.legs, cost: lab.cost,
    robust: { passed: c.robust ?? hood.get(hoodKey(c)) ?? 1, total: c.robustTotal ?? NEIGHBOURS },
    alsoOn: (specs.get(specKey(c)) ?? []).filter((d) => d !== c.ds).map(dsName),
    period: { from: b.t[0], to: b.t[b.n - 1], split: b.t[lab.split] },
    stats: {
      full: statsOf(trades), is: statsOf(trades, 0, lab.split), oos: statsOf(trades, lab.split),
      legs: [0, 1, 2].map((k) => statsOf(trades.filter((t) => t.leg === k))),
    },
    money: money.map((m) => ({
      mm: m.mm, label: MM_LABELS[m.mm], netProfit: m.netProfit, netPct: m.netPct, maxDDPct: m.maxDDPct,
      winRate: m.winRate, ratio: m.ratio, profitFactor: m.profitFactor, trades: m.trades, finalEquity: m.finalEquity,
    })),
    bestMM: best.mm,
    equity: downsample(fixed.curve.map(([i, v]) => [b.t[i], Math.round(v * 100) / 100] as [number, number]), 240),
    recent,
  };
}

// the most profitable per year (fixed 0.3 % rule, histories have different lengths), with
// at least 5 % of the neighbouring settings also passing; at most 2 per market /
// timeframe and 1 per signal on it. Two groups: a year of history or more (ranked by
// yearly return), and shorter histories (one market phase only, to confirm)
// the criteria again on the bars as they are now (a round may predate a data repair)
const meets = (s: Stats, min: number) => s.trades >= min && s.winRate > CRITERIA.winRate && s.ratio > CRITERIA.ratio && s.totalR > 0;
// indices that cannot be traded as such (the VIX's futures and CFDs move differently)
const UNTRADABLE = new Set(['VIX']);
// longYears: the history a robot needs to be in the first group; shortShare: the part of
// the selection left to shorter histories
function select(ranked: Candidate[], keep: number, { longYears = 1, shortShare = 1 / 3 } = {}): RobotStrategy[] {
  const built = ranked.map((c) => builtByKey.get(keyOf(c)))
    .filter((s): s is RobotStrategy => !!s && !UNTRADABLE.has(s.symbol) && meets(s.stats.is, CRITERIA.minTradesIS) && meets(s.stats.oos, CRITERIA.minTradesOOS));
  built.sort((a, b) => b.annualPct - a.annualPct);
  const perDs = new Map<string, number>(), seen = new Set<string>();
  const pick = (list: RobotStrategy[], max: number) => {
    const out: RobotStrategy[] = [];
    for (const s of list) {
      const ds = `${s.symbol}_${s.tf}_${s.source}`;
      const sk = `${ds}|${s.signal.id}`;
      const robust = s.robust.passed >= 2 && s.robust.passed / s.robust.total >= 0.05;
      if (!robust || seen.has(sk) || (perDs.get(ds) ?? 0) >= 2 || s.money[0].netPct <= 0) continue;
      seen.add(sk); perDs.set(ds, (perDs.get(ds) ?? 0) + 1);
      out.push(s);
      if (out.length >= max) break;
    }
    return out;
  };
  const short = Math.round(keep * shortShare);
  const long = built.filter((s) => s.years >= longYears);
  // every asset class first (its best 3), then the most profitable of any
  const classes = [...new Set(long.map((s) => s.market))];
  const firsts = classes.flatMap((m) => pick(long.filter((s) => s.market === m), 3));
  const longKept = [...firsts, ...pick(long, keep - short - firsts.length)].sort((a, b) => b.annualPct - a.annualPct);
  return [...longKept, ...(short ? pick(built.filter((s) => s.years < longYears), short) : [])];
}
const kept = select(rankedMain, KEEP).map((s, i) => ({ ...s, rank: i + 1 }));
// the night's selection: the robots of the general rounds first, then the others with 3
// years of history or more, then the shorter ones
const keptGeneral = select(rankedGeneral, 24, { longYears: 0, shortShare: 0 });
const keptNight = [...keptGeneral.map((s) => ({ ...s, general: true })), ...select(rankedNight, KEEP, { longYears: 3 }).filter((s) => !keptGeneral.some((g) => g.id === s.id))]
  .map((s, i) => ({ ...s, rank: i + 1, set: 'spe' as const }));
// the hour range: the same, from the "hour-*" rounds
const keptHourGeneral = select(rankedHourGeneral, 24, { longYears: 0, shortShare: 0 });
const keptHour = [...keptHourGeneral.map((s) => ({ ...s, general: true })), ...select(rankedHour, KEEP, { longYears: 3 }).filter((s) => !keptHourGeneral.some((g) => g.id === s.id))]
  .map((s, i) => ({ ...s, rank: i + 1, set: 'hr' as const }));

// the settings of the latest general round that pass on the most markets
const general: GeneralSetting[] = genChosen.map((c) => {
    const [market, tf] = c.group.split('|');
    const lbl = <T extends { id: string; label: string }>(xs: T[], id: string) => ({ id, label: xs.find((x) => x.id === id)?.label ?? id });
    return {
      set: c.set, market, tf, signal: lbl(SIGNALS, c.spec.signal), filter: lbl(FILTERS, c.spec.filter), stop: lbl(STOPS, c.spec.stop),
      dir: c.spec.dir, dirLabel: dirLabel(c.spec.dir), legs: c.spec.legs,
      passed: c.passed, markets: c.markets, posOOS: c.posOOS, fullRY: c.fullRY, on: c.on.map(dsName), ranAt: c.ranAt,
    };
  }).sort((a, b) => b.passed / b.markets - a.passed / a.markets);

const families: Record<string, { tested: number; passed: number }> = {};
for (const s of summaries.values()) for (const [f, v] of Object.entries(s.families)) {
  const x = (families[f] ??= { tested: 0, passed: 0 });
  x.tested += v.tested; x.passed += v.passed;
}

const report: RobotReport = {
  generatedAt: Date.now(),
  rounds: rounds.map((r) => ({ round: r.round, ranAt: r.ranAt, tested: r.tested })),
  tested: rounds.reduce((a, r) => a + r.tested, 0),
  criteria: { ...CRITERIA, split: SPLIT, capital: 10_000, riskPerEntryPct: 0.3, from: FROM },
  candidates: all.size,
  datasets: [...summaries.values()].sort((a, b) => a.id.localeCompare(b.id)),
  families,
  strategies: [...kept, ...keptNight, ...keptHour],
  general,
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report));
console.log(`rapport : ${kept.length} stratégies gardées sur ${all.size} candidates (${report.tested} tests), ${keptNight.length} Stoch Price Envelope range / tendance, ${keptHour.length} range horaire -> public/robots/report.json`);
