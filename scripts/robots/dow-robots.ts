import fs from 'node:fs';
import path from 'node:path';
import { dowBars, dowRobotTrades } from '../../src/robots/dowBacktest';
import type { DowTrade } from '../../src/robots/dow';
import { MM_LABELS, applyMoney, statsOf, type LegTrade, type MoneyMgmt } from '../../src/robots/engine';
import type { RobotStrategy } from '../../src/robots/report';
import { readDataset, COLS } from './dataset';

// The Dow structure robots kept by the study (public/robots/dow.json, "picks") as full reports for
// the Robots page (public/robots/dow-robots.json), in the lab robots' shape: the page lists them,
// opens their chart and replays them in the strategy tester like the others. Each robot is its
// indicator settings run on the lab's bars since 2020 (src/robots/dowBacktest.ts); tuning on the
// first 70 % of the bars, check on the rest, as the study. Run after dow-publish.
// Usage: node robots/.build/dow-robots.mjs

type S = { n: number; ry: number; pf: number; win: number; dd: number; exp: number };
type Year = [number, number, number];
type Pick = {
  id: string; symbol: string; market: string; tf: string; source: string; label: string;
  inputs: Record<string, number | string | boolean>; is: S | null; oos: S | null; years: Year[];
  wf: { total: number; steps: Year[] }; luck?: { is: number | null; oos: number | null };
};
const study = JSON.parse(fs.readFileSync(path.resolve('public/robots/dow.json'), 'utf8')) as { split: number; picks: Pick[] };
const TF_NAME: Record<string, string> = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '1h': '1 h', '4h': '4 h', '1d': 'jour' };
const REASON: Record<DowTrade['reason'], LegTrade['reason']> = { stop: 'stop', objectif: 'target', retournement: 'opposite', fin: 'end' };
const sR = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} R`;

const out: RobotStrategy[] = [];
for (const p of study.picks) {
  const file = path.resolve('robots/data', `${p.id}.bin`);
  if (!fs.existsSync(file)) { console.log(`${p.id} : fichier absent`); continue; }
  const { rows } = readDataset(file);
  const list: number[][] = [];
  for (let i = 0; i < rows.length / COLS; i++) list.push(Array.from(rows.subarray(i * COLS, i * COLS + 6)));
  const b = dowBars(list, p.source, p.market, p.tf);
  const trades = dowRobotTrades(b, { type: 'DOW_STRUCTURE', inputs: p.inputs });
  const legs: LegTrade[] = trades.map((t, g) => ({
    leg: 0, group: g, side: t.up ? 1 : -1, entryIdx: t.entryIdx, exitIdx: t.exitIdx, entry: t.entry,
    stopDist: Math.abs(t.entry - t.stop), exit: t.exit, stop: t.stop, r: t.r, reason: REASON[t.reason],
  }));
  const split = Math.floor(b.n * study.split);
  const full = statsOf(legs), is = statsOf(legs, 0, split), oos = statsOf(legs, split);
  const money = (Object.keys(MM_LABELS) as MoneyMgmt[]).map((mm) => {
    const x = applyMoney(legs, mm);
    return { mm, label: MM_LABELS[mm], netProfit: x.netProfit, netPct: x.netPct, maxDDPct: x.maxDDPct, winRate: x.winRate, ratio: x.ratio, profitFactor: x.profitFactor, trades: x.trades, finalEquity: x.finalEquity };
  });
  const fixed = applyMoney(legs, 'fixed');
  const years = (b.t[b.n - 1] - b.t[0]) / (365.25 * 86400);
  const posYears = p.wf.steps.filter(([, , r]) => r > 0).length;
  const cost = Number(p.inputs.cost) / 100;
  const sweep = String(p.inputs.mode).startsWith('Prise');
  out.push({
    id: `dow_${p.id}`, set: 'dow', kind: 'dow', dataset: p.id, inputs: p.inputs,
    name: `Structure Dow · ${p.symbol} ${TF_NAME[p.tf] ?? p.tf}`,
    symbol: p.symbol, market: p.market, source: p.source, tf: p.tf,
    signal: { id: 'dow', label: p.label, family: 'dow' },
    filter: { id: 'dow_trend', label: `Dans le sens de la structure (cassure en clôture franche) · ${p.inputs.hours ? `heures actives ${p.inputs.hours} (Paris)` : 'toutes les heures'} · tendance supérieure : ${String(p.inputs.htf).toLowerCase()}` },
    stop: { id: 'dow_stop', label: sweep ? 'Au-delà de la mèche qui a pris la liquidité, + 0,1 ATR' : 'Au-delà de la boîte, + 0,1 ATR' },
    dir: 0, dirLabel: 'Achat et vente', legs: { tpR: Number(p.inputs.minR), trailK: 0 }, cost,
    years, annualPct: (Math.pow(fixed.finalEquity / 10_000, 1 / years) - 1) * 100,
    robust: { passed: posYears, total: p.wf.steps.length }, alsoOn: [],
    robustText: `walk-forward depuis 2023 ${sR(p.wf.total)}, ${posYears} années positives sur ${p.wf.steps.length}${p.luck?.oos != null ? ` · bat ${Math.round(p.luck.oos * 100)} % des tirages au hasard en validation` : ''}`,
    period: { from: b.t[0], to: b.t[b.n - 1], split: b.t[split] },
    stats: { full, is, oos, legs: [full] },
    money, bestMM: [...money].sort((a, z) => z.netProfit - a.netProfit)[0].mm,
    equity: [[b.t[0], 10_000], ...fixed.curve.map(([i, e]): [number, number] => [b.t[i], e])],
    recent: trades.slice(-12).reverse().map((t, k) => ({ time: b.t[t.entryIdx], side: t.up ? 1 : -1, entry: t.entry, legs: [t.r], eur: fixed.pnl[trades.length - 1 - k] })),
  });
  console.log(`${p.id.padEnd(20)} ${full.trades} trades (étude : réglage ${p.is?.n ?? '—'}, validation ${p.oos?.n ?? '—'} · ici ${is.trades} / ${oos.trades}), ${full.totalR.toFixed(1)} R, ${fixed.netPct.toFixed(1)} %`);
}
fs.writeFileSync(path.resolve('public/robots/dow-robots.json'), JSON.stringify({ generatedAt: Date.now(), strategies: out }));
console.log('écrit public/robots/dow-robots.json');
