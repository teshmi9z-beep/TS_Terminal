import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FAMILIES } from '../../src/data/indexFamilies';
import { EM_RULE } from '../../src/robots/emRule';
import { EM_COST, EM_LOAD_FROM, EM_TRADE_FROM, emBacktest, vixReader, type EmBtTrade } from '../../src/robots/emBacktest';
import { MM_LABELS, applyMoney, statsOf, type LegTrade, type MoneyMgmt } from '../../src/robots/engine';
import type { RobotStrategy } from '../../src/robots/report';
import { readDataset, COLS } from './dataset';

// Publishes the Expected Move robots for the Robots page (public/robots/em.json): one per index,
// in the same shape as the lab's robots (report.json), so the page lists them, opens their
// chart and replays them in the strategy tester like the others. The rule is the study's
// (src/robots/emRule.ts), on the lab's 15-minute bars that follow the futures through the
// session; tuning 2020-07 → 2024-08, check after. Usage: node robots/.build/em-publish.mjs

const SPLIT = Date.UTC(2024, 8, 1) / 1000;
const OUT = path.resolve('public/robots/em.json');
type M = { dataset: string; symbol: string; future: string; fam: string; source: string; name: string };
const MARKETS: M[] = [
  { dataset: 'histdata_SPX500_15m', symbol: 'SPX500', future: 'US500', fam: 'spx', source: 'HistData', name: 'S&P 500' },
  { dataset: 'histdata_NDX100_15m', symbol: 'NDX100', future: 'US100', fam: 'ndx', source: 'HistData', name: 'Nasdaq 100' },
  { dataset: 'dl_ibkr_DJI_15m', symbol: 'DJI', future: 'US30', fam: 'dji', source: 'Interactive Brokers', name: 'Dow Jones' },
  // HistData's DAX misses half the sessions since 2020: the cash index from IBKR (the study's)
  { dataset: 'dl_ibkr_DAX40_15m', symbol: 'DAX40', future: 'DE40', fam: 'dax', source: 'Interactive Brokers', name: 'DAX 40' },
  { dataset: 'histdata_NIKKEI_15m', symbol: 'NIKKEI', future: 'J225', fam: 'nikkei', source: 'HistData', name: 'Nikkei 225' },
];
// neighbouring settings for the robustness line
const NEIGHBOURS = [{ stopEm: 0.1 }, { stopEm: 0.3 }, { targetR: 2 }, { targetR: 4 }, { lookback: 60 }, { vixMin: 18 }, { vixMin: 22 }];

function bars(id: string) {
  const { rows } = readDataset(path.resolve('robots/data', `${id}.bin`));
  const all = rows.length / COLS;
  let s = 0;
  while (s < all && rows[s * COLS] < EM_LOAD_FROM) s++;
  const n = all - s;
  const b = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), n };
  for (let i = 0; i < n; i++) { const k = (s + i) * COLS; b.t[i] = rows[k]; b.o[i] = rows[k + 1]; b.h[i] = rows[k + 2]; b.l[i] = rows[k + 3]; b.c[i] = rows[k + 4]; }
  return b;
}
const vixRows = (() => {
  const { rows } = readDataset(path.resolve('robots/data/yf_VIX_1d.bin'));
  const out: number[][] = [];
  for (let i = 0; i < rows.length / COLS; i++) out.push(Array.from(rows.subarray(i * COLS, i * COLS + 6)));
  return out;
})();

// the lab's leg trades (one entry per signal) of the robot's trades
const REASON: Record<EmBtTrade['reason'], LegTrade['reason']> = { stop: 'stop', objectif: 'target', 'clôture': 'end', 'en cours': 'end' };
const legsOf = (ts: EmBtTrade[]): LegTrade[] => ts.map((t, g) => ({
  leg: 0, group: g, side: t.side, entryIdx: t.entryBar, exitIdx: t.exitBar, entry: t.entry, stopDist: Math.abs(t.entry - t.stop),
  exit: t.exit, stop: t.stop, r: t.net, reason: REASON[t.reason],
}));

const out: RobotStrategy[] = [];
const runs = MARKETS.map((m) => {
  const f = INDEX_FAMILIES.find((x) => x.id === m.fam)!;
  const b = bars(m.dataset);
  const vix = vixReader(vixRows, f.tz === 'America/New_York');
  return { m, f, b, vix, trades: emBacktest(b, f, vix) };
});
const positiveBoth = (b: (typeof runs)[number]['b'], legs: LegTrade[]) => {
  let split = 0;
  while (split < b.n && b.t[split] < SPLIT) split++;
  return { split, ok: statsOf(legs, 0, split).totalR > 0 && statsOf(legs, split).totalR > 0 };
};
for (const r of runs) {
  const { m, f, b, vix, trades } = r;
  const legs = legsOf(trades);
  const { split } = positiveBoth(b, legs);
  const full = statsOf(legs), is = statsOf(legs, 0, split), oos = statsOf(legs, split);
  const money = (Object.keys(MM_LABELS) as MoneyMgmt[]).map((mm) => {
    const x = applyMoney(legs, mm);
    return { mm, label: MM_LABELS[mm], netProfit: x.netProfit, netPct: x.netPct, maxDDPct: x.maxDDPct, winRate: x.winRate, ratio: x.ratio, profitFactor: x.profitFactor, trades: x.trades, finalEquity: x.finalEquity };
  });
  const fixed = applyMoney(legs, 'fixed');
  const bestMM = [...money].sort((a, z) => z.netProfit - a.netProfit)[0].mm;
  const years = (b.t[b.n - 1] - EM_TRADE_FROM) / (365.25 * 86400);
  const robustPassed = NEIGHBOURS.filter((n) => positiveBoth(b, legsOf(emBacktest(b, f, vix, EM_TRADE_FROM, EM_COST, { ...EM_RULE, ...n }))).ok).length;
  const alsoOn = runs.filter((o) => o !== r && positiveBoth(o.b, legsOf(o.trades)).ok).map((o) => o.m.name);
  out.push({
    id: `em_${m.future}`, set: 'em', kind: 'em', future: m.future, dataset: m.dataset,
    name: `Expected Move · cassure confirmée · ${m.name}`,
    symbol: m.symbol, market: 'Index', source: m.source, tf: '15m',
    signal: { id: 'em_break', label: 'Clôture 15 min au-delà de la distance moyenne de l’Expected Move (vol. réalisée 20 j, 120 séances), dans son sens', family: 'em' },
    filter: { id: 'em_vix', label: 'VIX à 20 ou plus à l’ouverture cash (sinon pas de trade ce jour-là) · une fois par sens et par séance' },
    stop: { id: 'em_stop', label: '20 % de l’EM derrière le niveau franchi' },
    dir: 0, dirLabel: 'Achat et vente', legs: { tpR: EM_RULE.targetR, trailK: 0 }, cost: EM_COST,
    years, annualPct: (Math.pow(fixed.finalEquity / 10_000, 1 / years) - 1) * 100,
    robust: { passed: robustPassed, total: NEIGHBOURS.length }, alsoOn,
    period: { from: b.t[0], to: b.t[b.n - 1], split: SPLIT },
    stats: { full, is, oos, legs: [full] },
    money, bestMM,
    equity: [[EM_TRADE_FROM, 10_000], ...fixed.curve.map(([i, e]): [number, number] => [b.t[i], e])],
    recent: trades.slice(-12).reverse().map((t, k) => ({ time: b.t[t.entryBar], side: t.side, entry: t.entry, legs: [t.net], eur: fixed.pnl[trades.length - 1 - k] })),
  });
  console.log(`${m.name.padEnd(12)} ${full.trades} trades, ${full.totalR.toFixed(1)} R (réglage ${is.totalR.toFixed(1)}, contrôle ${oos.totalR.toFixed(1)}), ${fixed.netPct.toFixed(1)} %, voisins ${robustPassed}/${NEIGHBOURS.length}`);
}
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: Date.now(), rule: EM_RULE, cost: EM_COST, split: SPLIT, strategies: out }));
console.log(`écrit ${OUT}`);
