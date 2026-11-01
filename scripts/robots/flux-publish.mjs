// Publishes the flux study (robots/flux/live.json, from flux-study.ts with the time-ordered
// simulator) for the "Robots de trading" tab: public/robots/flux.json, read by FluxStudyCard.
// Every setting of the 27 groups (entry timeframe x flux timeframe x market class) with its
// tuning / check results, per market and per year, plus the family averages (trade-weighted,
// as in robots/flux/FLUX.md).
//   node scripts/robots/flux-publish.mjs [--from robots/flux/live.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const SRC = join(ROOT, arg('--from', 'robots/flux/live.json'));
const OUT = join(ROOT, 'public', 'robots', 'flux.json');

const TF_ORDER = ['5m', '15m', '1h', '4h', '1d'];
const CLS_ORDER = ['Index', 'Forex', 'Commodity'];
const FAMILIES = ['flip', 'pb', 'fib', 'ob', 'fvg'];
// the one lead the study left (indices, daily entries): see FLUX.md
const LEAD = { key: 'pb|F1d|fc|all|1R', tf: '1d', cls: 'Index' };

// the setting labels (flux-lib.ts labelOf) in English, part by part, for the EN button
const EN = [
  [/^Entrée au changement de flux$/, 'Entry on the flow change'], [/^sortie au changement de flux$/, 'exit on the flow change'],
  [/^flux (\w+)$/, 'flow $1'], [/^objectif (.+) R$/, 'target $1 R'],
  [/^Retour sur le nuage$/, 'Pullback to the cloud'], [/^mèche sur la MM(\d+)$/, 'wick on the MA$1'], [/^clôture au-dessus$/, 'close back above'],
  [/^1er retour seulement$/, 'first pullback only'], [/^tous les retours$/, 'every pullback'],
  [/^limite sur la MM(\d+) après (.+) ATR d’écart$/, 'limit on the MA$1 after a $2 ATR stretch'],
  [/^Retracement de Fibonacci$/, 'Fibonacci retracement'], [/^entrée au bord$/, 'entry at the edge'], [/^entrée au milieu$/, 'entry at the middle'],
  [/^trou ≥ (.+) ATR$/, 'gap ≥ $1 ATR'],
];
const english = (label) => label.split(' · ').map((p) => p.split(', ').map((q) => {
  const hit = EN.find(([re]) => re.test(q));
  return hit ? q.replace(hit[0], hit[1]) : q;
}).join(', ')).join(' · ');

const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
// a period's stats: [trades, R a trade, t, markets positive, markets with trades]
const stat = (s) => [s.n, r3(s.r), r3(s.t), s.pos, s.with];

const rows = JSON.parse(readFileSync(SRC, 'utf8'));
const groupKey = (r) => `${r.tf}|${r.fluxTf}|${r.cls}`;
const groups = [...new Set(rows.map(groupKey))]
  .map((k) => { const [tf, fluxTf, cls] = k.split('|'); return { k, tf, fluxTf, cls }; })
  .sort((a, z) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(z.tf) || TF_ORDER.indexOf(a.fluxTf) - TF_ORDER.indexOf(z.fluxTf) || CLS_ORDER.indexOf(a.cls) - CLS_ORDER.indexOf(z.cls));

// trade-weighted R a trade over a set of settings
const weighted = (rs, p) => {
  let n = 0, sum = 0;
  for (const r of rs) if (r[p].n) { n += r[p].n; sum += (r[p].r || 0) * r[p].n; }
  return n ? r3(sum / n) : null;
};

const markets = { Index: new Set(), Forex: new Set(), Commodity: new Set() };
const out = {
  generatedAt: Date.now(),
  from: '2020-01-01',
  split: '2024-09-01',
  groups: groups.map((g) => {
    const rs = rows.filter((r) => groupKey(r) === g.k);
    for (const r of rs) for (const p of r.per) markets[r.cls]?.add(p.sym);
    return {
      tf: g.tf, fluxTf: g.fluxTf, cls: g.cls, markets: Math.max(...rs.map((r) => r.markets)), settings: rs.length,
      found: rs.filter((r) => r.found).length, holds: rs.filter((r) => r.holds).length,
      is: weighted(rs, 'is'), oos: weighted(rs, 'oos'),
      // settings positive on the tuning (100 trades at least, as flux-study's base rate), and how many of them still are on the check
      posIS: rs.filter((r) => r.is.n >= 100 && r.is.r > 0).length, posBoth: rs.filter((r) => r.is.n >= 100 && r.is.r > 0 && r.oos.r > 0).length,
    };
  }),
  families: FAMILIES.map((f) => {
    const of = (swing) => rows.filter((r) => r.key.split('|')[0] === f && ['4h', '1d'].includes(r.tf) === swing);
    return { fam: f, intra: { is: weighted(of(false), 'is'), oos: weighted(of(false), 'oos') }, swing: { is: weighted(of(true), 'is'), oos: weighted(of(true), 'oos') } };
  }),
  rows: rows.map((r) => ({
    g: groups.findIndex((g) => g.k === groupKey(r)), k: r.key, l: r.label, le: english(r.label),
    is: stat(r.is), oos: stat(r.oos), all: [...stat(r.all), r2(r.all.win), r2(r.all.pf)],
    // per market: [symbol, tuning trades, tuning R a trade, check trades, check R a trade]
    per: r.per.map((p) => [p.sym, p.isN, r3(p.isR), p.oosN, r3(p.oosR)]),
    // per year: [year, R in total]
    y: Object.entries(r.years).map(([y, v]) => [Number(y), r2(v)]),
  })),
  lead: rows.findIndex((r) => r.key === LEAD.key && r.tf === LEAD.tf && r.cls === LEAD.cls),
  markets: Object.fromEntries(Object.entries(markets).map(([c, s]) => [c, [...s].sort()])),
};

writeFileSync(OUT, JSON.stringify(out));
console.log(`${out.rows.length} réglages, ${out.groups.length} groupes -> ${OUT} (${Math.round(JSON.stringify(out).length / 1024)} Ko)`);
