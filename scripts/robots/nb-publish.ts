import fs from 'node:fs';
import path from 'node:path';
import { NB_LOAD_FROM, NB_MARKETS, NB_RULE, NB_SESSIONS, NB_TRADE_FROM, nbBacktest, type NbBtTrade, type NbRule } from '../../src/robots/noiseBand';
import { MM_LABELS, applyMoney, statsOf, type LegTrade, type MoneyMgmt } from '../../src/robots/engine';
import type { RobotStrategy } from '../../src/robots/report';
import { readDataset, COLS } from './dataset';

// Publishes the noise-band robots for the Robots page (public/robots/nb.json): one per market
// the walk-forward of the price-action study kept longest, in the shape of the lab's robots, so
// the page lists them, opens their chart and replays them in the strategy tester. The rule is
// src/robots/noiseBand.ts on the lab's 15-minute bars, at tight costs; tuning 2020-01 → 2024-08,
// check after. The markets were chosen with hindsight: NOT PROVEN (robots/pa/PRICE-ACTION.md).
// Usage: node robots/.build/nb-publish.mjs          (add "variantes" to compare the stops)

const SPLIT = Date.UTC(2024, 8, 1) / 1000;
const OUT = path.resolve('public/robots/nb.json');
// neighbouring settings for the robustness line
const NEIGHBOURS: Partial<NbRule>[] = [{ k: 1 }, { k: 1.5 }, { look: 10 }, { look: 20 }, { stopU: 1.5 }, { stopU: 3 }, { targetU: 2 }];

function bars(id: string) {
  const { rows } = readDataset(path.resolve('robots/data', `${id}.bin`));
  const all = rows.length / COLS;
  let s = 0;
  while (s < all && rows[s * COLS] < NB_LOAD_FROM) s++;
  const n = all - s;
  const b = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), n };
  for (let i = 0; i < n; i++) { const k = (s + i) * COLS; b.t[i] = rows[k]; b.o[i] = rows[k + 1]; b.h[i] = rows[k + 2]; b.l[i] = rows[k + 3]; b.c[i] = rows[k + 4]; }
  return b;
}
type B = ReturnType<typeof bars>;

// the lab's leg trades: two entries per signal (A to +1 unit, B to the session's end)
const REASON: Record<NbBtTrade['legs'][0]['reason'], LegTrade['reason']> = { stop: 'stop', objectif: 'target', 'clôture': 'end', 'en cours': 'end' };
const legsOf = (ts: NbBtTrade[]): LegTrade[] => ts.flatMap((t, g) => t.legs.map((l, k): LegTrade => ({
  leg: l.leg, group: g, side: t.side, entryIdx: t.entryBar, exitIdx: l.exitBar, entry: t.entry, stopDist: t.risk,
  exit: l.exit, stop: t.stop, r: t.net[k], reason: REASON[l.reason],
})));
const splitOf = (b: B) => { let s = 0; while (s < b.n && b.t[s] < SPLIT) s++; return s; };
const positiveBoth = (b: B, legs: LegTrade[]) => statsOf(legs, 0, splitOf(b)).totalR > 0 && statsOf(legs, splitOf(b)).totalR > 0;

const runs = NB_MARKETS.map((m) => { const b = bars(m.dataset); return { m, b, trades: nbBacktest(b, m.session, m.cost) }; });

if (process.argv.includes('variantes')) {
  for (const v of [{}, { stopU: 1 }, { stopU: 1.5 }, { stopU: 3 }, { targetU: 0.5 }, { targetU: 2 }, { k: 1 }, { k: 1.5 }, { look: 10 }, { look: 20 }] as Partial<NbRule>[]) {
    let line = `${JSON.stringify(v).padEnd(16)}`, tot = 0, dd = 0;
    for (const r of runs) {
      const legs = legsOf(nbBacktest(r.b, r.m.session, r.m.cost, NB_TRADE_FROM, { ...NB_RULE, ...v }));
      const s = statsOf(legs), is = statsOf(legs, 0, splitOf(r.b)), oos = statsOf(legs, splitOf(r.b));
      line += ` | ${r.m.symbol} ${s.totalR.toFixed(0)} R (${is.totalR.toFixed(0)} / ${oos.totalR.toFixed(0)}) dd ${s.maxDDR.toFixed(0)}`;
      tot += s.totalR; dd += s.maxDDR;
    }
    console.log(`${line} | total ${tot.toFixed(0)} R, creux cumulés ${dd.toFixed(0)}`);
  }
  process.exit(0);
}

const out: RobotStrategy[] = [];
const pc = (v: number) => `${String(+(v * 100).toFixed(4)).replace('.', ',')} %`;
for (const r of runs) {
  const { m, b, trades } = r;
  const legs = legsOf(trades);
  const split = splitOf(b);
  const full = statsOf(legs), is = statsOf(legs, 0, split), oos = statsOf(legs, split);
  const money = (Object.keys(MM_LABELS) as MoneyMgmt[]).map((mm) => {
    const x = applyMoney(legs, mm);
    return { mm, label: MM_LABELS[mm], netProfit: x.netProfit, netPct: x.netPct, maxDDPct: x.maxDDPct, winRate: x.winRate, ratio: x.ratio, profitFactor: x.profitFactor, trades: x.trades, finalEquity: x.finalEquity };
  });
  const fixed = applyMoney(legs, 'fixed');
  const bestMM = [...money].sort((a, z) => z.netProfit - a.netProfit)[0].mm;
  const years = (b.t[b.n - 1] - NB_TRADE_FROM) / (365.25 * 86400);
  const robustPassed = NEIGHBOURS.filter((n) => positiveBoth(b, legsOf(nbBacktest(b, m.session, m.cost, NB_TRADE_FROM, { ...NB_RULE, ...n })))).length;
  const alsoOn = runs.filter((o) => o !== r && positiveBoth(o.b, legsOf(o.trades))).map((o) => o.m.name);
  const legStats = [0, 1].map((k) => statsOf(legs.filter((l) => l.leg === k)));
  out.push({
    id: m.id, set: 'nb', kind: 'nb', future: m.live, dataset: m.dataset,
    inputs: { session: NB_SESSIONS[m.session].label, k: NB_RULE.k, look: NB_RULE.look, stopU: NB_RULE.stopU, targetU: NB_RULE.targetU, cost: +(m.cost * 100).toFixed(4), robot: true },
    name: `Bande de bruit · ${m.name}`,
    symbol: m.symbol, market: m.market, source: m.source, tf: '15m',
    signal: { id: 'nb_break', label: `Clôture 15 min hors de la bande de bruit (référence ± ${String(NB_RULE.k).replace('.', ',')} × l’écart habituel à cette heure, ${NB_RULE.look} séances), toutes les 30 min, dans son sens`, family: 'nb' },
    filter: { id: 'nb_session', label: `${NB_SESSIONS[m.session].label} · une seule fois par séance · rien gardé la nuit` },
    stop: { id: 'nb_stop', label: `${NB_RULE.stopU} fois le mouvement habituel d’une séance derrière l’entrée` },
    dir: 0, dirLabel: 'Achat et vente', legs: { tpR: NB_RULE.targetU / NB_RULE.stopU, trailK: 0 }, cost: m.cost,
    years, annualPct: (Math.pow(fixed.finalEquity / 10_000, 1 / years) - 1) * 100,
    robust: { passed: robustPassed, total: NEIGHBOURS.length }, alsoOn,
    period: { from: b.t[0], to: b.t[b.n - 1], split: SPLIT },
    stats: { full, is, oos, legs: legStats },
    money, bestMM,
    equity: [[NB_TRADE_FROM, 10_000], ...fixed.curve.map(([i, e]): [number, number] => [b.t[i], e])],
    recent: trades.slice(-12).reverse().map((t, k) => { const i = trades.length - 1 - k; return { time: b.t[t.entryBar], side: t.side, entry: t.entry, legs: [...t.net], eur: fixed.pnl[2 * i] + fixed.pnl[2 * i + 1] }; }),
  });
  console.log(`${m.name.padEnd(12)} ${trades.length} signaux, ${full.totalR.toFixed(1)} R (réglage ${is.totalR.toFixed(1)}, contrôle ${oos.totalR.toFixed(1)}), ${fixed.netPct.toFixed(1)} %, creux ${fixed.maxDDPct.toFixed(1)} %, voisins ${robustPassed}/${NEIGHBOURS.length}, frais ${pc(m.cost)}`);
}
// each market's result per year, for the study's card
const yearsR = new Map<number, number>();
for (const r of runs) for (const t of r.trades) { const y = new Date(r.b.t[t.entryBar] * 1000).getUTCFullYear(); yearsR.set(y, (yearsR.get(y) ?? 0) + t.net[0] + t.net[1]); }
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: Date.now(), rule: NB_RULE, split: SPLIT, years: [...yearsR].sort((a, z) => a[0] - z[0]).map(([y, v]) => [y, Math.round(v)]), strategies: out }));
console.log(`années : ${[...yearsR].sort((a, z) => a[0] - z[0]).map(([y, v]) => `${y} ${v.toFixed(0)}`).join(' · ')}`);
console.log(`écrit ${OUT}`);
