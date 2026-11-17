// Publishes the flux grid study (robots/fluxgrid/etude.json and variantes.json from
// fluxgrid-study.ts, courbes.json from fluxgrid-curves.ts) for the "Robots de trading" tab:
// public/robots/fluxgrid.json, read by FluxGridCard. What each choice changes, every setting
// of the 6 groups (entry timeframe x market class) with its tuning / check results and per
// market, the account curves of the user's rule with and without its guards and of the least
// bad variant, and the last baskets of the user's rule.
//   node scripts/robots/fluxgrid-publish.mjs

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'robots', 'fluxgrid');
const OUT = join(ROOT, 'public', 'robots', 'fluxgrid.json');
const read = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

const TF_ORDER = ['5m', '15m'];
const CLS_ORDER = ['Index', 'Forex', 'Commodity'];
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

// the main grid and the variants (first order half-way, bigger legs), one row per setting
const seen = new Set();
const rows = [...read('etude.json'), ...read('variantes.json')].filter((r) => {
  const k = `${r.tf}|${r.cls}|${r.key}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const groups = [...new Set(rows.map((r) => `${r.tf}|${r.cls}`))]
  .map((k) => { const [tf, cls] = k.split('|'); return { k, tf, cls }; })
  .sort((a, z) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(z.tf) || CLS_ORDER.indexOf(a.cls) - CLS_ORDER.indexOf(z.cls));

// the setting labels (fluxgrid-lib.ts labelOf, plus the options) in English, for the EN button
const EN = [
  [/^(\d+) entrées, tailles égales$/, '$1 orders, equal sizes'], [/^(\d+) entrées, tailles 1-2-3…$/, '$1 orders, sizes 1-2-3…'],
  [/^(\d+) entrées, tailles doublées 1-2-4…$/, '$1 orders, doubled sizes 1-2-4…'],
  [/^objectif : retour au bout de la jambe$/, 'target: back to the end of the leg'], [/^objectif : mi-chemin vers le bout de la jambe$/, 'target: half-way to the end of the leg'],
  [/^invalidation : flux qui change de couleur$/, 'invalidation: the flow changing colour'], [/^invalidation : stop au-delà du nuage$/, 'invalidation: stop past the cloud'],
  [/^sans garde-fou$/, 'no guard'], [/^pas sur gros niveau jour \/ semaine$/, 'not on a big daily / weekly level'], [/^pas après grande mèche$/, 'not after a big wick'],
  [/^ni gros niveau, ni grande mèche$/, 'neither big level nor big wick'], [/^1re entrée à mi-chemin du flux$/, 'first order half-way to the flow'],
  [/^jambe d’au moins (\d+) ATR 1 h$/, 'leg of at least $1 hourly ATR'],
];
const english = (label) => label.split(' · ').map((p) => { const hit = EN.find(([re]) => re.test(p)); return hit ? p.replace(hit[0], hit[1]) : p; }).join(' · ');
const labelOf = (r) => {
  const extra = [];
  if (/\|f0\.5/.test(r.key)) extra.push('1re entrée à mi-chemin du flux');
  const z = r.key.match(/\|z(\d+)/);
  if (z) extra.push(`jambe d’au moins ${z[1]} ATR 1 h`);
  return [r.label, ...extra].join(' · ');
};
// a period: [baskets, R a basket, t, markets positive, markets with baskets, win rate, worst basket]
const side = (s) => [s.n, r3(s.r), r3(s.t), s.pos, s.with, r3(s.win), r3(s.worst)];

const out = {
  generatedAt: Date.now(),
  from: '2020-01-01', split: '2024-09-01',
  groups: groups.map((g) => {
    const rs = rows.filter((r) => r.tf === g.tf && r.cls === g.cls);
    return { tf: g.tf, cls: g.cls, markets: rs[0].markets, settings: rs.length, found: rs.filter((r) => r.found).length, holds: rs.filter((r) => r.holds).length,
      is: r3(rs.reduce((a, r) => a + r.is.r * r.is.n, 0) / rs.reduce((a, r) => a + r.is.n, 0)), oos: r3(rs.reduce((a, r) => a + r.oos.r * r.oos.n, 0) / rs.reduce((a, r) => a + r.oos.n, 0)) };
  }),
  rows: rows.map((r) => {
    const l = labelOf(r);
    return {
      g: groups.findIndex((g) => g.tf === r.tf && g.cls === r.cls), k: r.key, l, le: english(l),
      is: side(r.is), oos: side(r.oos), gross: r3(r.all.gross), fills: r3(r.all.fills), cut: r3(r.all.cut),
      per: r.per.map((p) => [p.sym, p.isN, r3(p.isR), p.oosN, r3(p.oosR), r3(p.worst)]),
      y: Object.entries(r.years).map(([y, v]) => [Number(y), r3(v)]),
    };
  }),
};

// what each choice changes: basket-weighted R a basket, tuning and check, per entry timeframe
const parts = (k) => { const [levels, size, tp, stop, guard, ...opt] = k.split('|'); return { levels, size, tp, stop, guard, from: opt.find((o) => o[0] === 'f') ?? 'f-', zone: opt.find((o) => o[0] === 'z') ?? 'z1' }; };
const CHOICES = [
  ['guard', 'Garde-fous', [['none', 'Aucun'], ['level', 'Gros niveaux jour / semaine'], ['wick', 'Grandes mèches'], ['both', 'Les deux']]],
  ['size', 'Tailles', [['flat', 'Égales'], ['lin', '1-2-3…'], ['mart', 'Doublées (martingale)']]],
  ['stop', 'Invalidation', [['flip', 'Flux qui change de couleur'], ['cloud', 'Stop au-delà du nuage']]],
  ['tp', 'Objectif', [['low', 'Bout de la jambe'], ['mid', 'Mi-chemin']]],
  ['zone', 'Jambe minimale', [['z1', '1 ATR 1 h'], ['z2', '2 ATR 1 h'], ['z3', '3 ATR 1 h']]],
  ['from', 'Première entrée', [['f-', 'Près du bout de la jambe'], ['f0.5', 'À mi-chemin du flux']]],
];
out.choices = CHOICES.map(([key, name, opts]) => ({
  key, name,
  opts: opts.map(([v, label]) => {
    const res = {};
    for (const tf of TF_ORDER) {
      // the main grid for its own choices, the variants for the leg and the first order
      const src = key === 'zone' || key === 'from' ? read('variantes.json') : read('etude.json');
      const rs = src.filter((r) => r.tf === tf && parts(r.key)[key] === v);
      const n = (p) => rs.reduce((a, r) => a + r[p].n, 0), s = (p) => rs.reduce((a, r) => a + r[p].r * r[p].n, 0);
      res[tf] = [r3(s('is') / n('is')), r3(s('oos') / n('oos')), n('is') + n('oos')];
    }
    return { v, label, ...res };
  }),
}));

// the account curves (1 R = 1 % of a 10,000 € account per basket), R summed over the class
const c = read('courbes.json');
out.curves = c.curves.map(({ id, key }) => {
  const label = labelOf({ key, label: rows.find((r) => r.key === key)?.label ?? key });
  return {
    id, key, l: label, le: english(label),
    groups: Object.fromEntries(Object.entries(c.out[id]).map(([g, v]) => {
      let cum = 0;
      return [g, { n: v.n, win: r3(v.wins / v.n), total: r3(v.total), worst: r3(v.worst), is: r3(v.isR / v.isN), oos: r3(v.oosR / v.oosN), pts: v.months.map(([t, r]) => [t, r3((cum += r))]) }];
    })),
  };
});
out.recent = c.recent;
out.markets = Object.fromEntries(CLS_ORDER.map((cls) => [cls, [...new Set(rows.filter((r) => r.cls === cls).flatMap((r) => r.per.map((p) => p.sym)))]]));

// the inverse (fluxrev-study.ts: inverse.json for 5 min to 1 h, inverse-swing.json for 4 h and
// the day): trading the turn where the guards keep the grid out; per entry timeframe and
// signal, trade-weighted over every target, leg and stop, the result, the random twins',
// before costs, and the share of random draws beaten on each period. On 4 h the flux of 4 h
// (the daily one is in the report), on the day the daily one; there the 1 h / 4 h wicks are
// the bars' own, so a single wick line
if (existsSync(join(DIR, 'inverse.json'))) {
  const both = [...read('inverse.json'), ...(existsSync(join(DIR, 'inverse-swing.json')) ? read('inverse-swing.json') : [])];
  // from 1 h up, the 1 h / 4 h wicks are the bars' own: the htf settings repeat the any ones
  const inv = both.filter((r) => r.tf === '5m' || r.tf === '15m' || !r.key.split('|').includes('htf'));
  const hammer = both.filter((r) => r.key.startsWith('both|htf|'));
  const SIGNALS = [['wick|any', 'Grande mèche au bout de la jambe (5 / 15 min, 1 h, 4 h)'], ['wick|htf', 'Grande mèche 1 h ou 4 h'], ['level|any', 'Gros niveau, clôture revenue au-dessus'], ['both|htf', 'Marteau 1 h ou 4 h sur un gros niveau'], ['either|any', 'Mèche ou gros niveau']];
  const FLUX = { '5m': '', '15m': '', '1h': '', '4h': '|F4h', '1d': '|F1d' };
  const w = (rs, p, f) => r3(rs.reduce((a, r) => a + f(r[p]) * r[p].n, 0) / rs.reduce((a, r) => a + r[p].n, 0));
  const tfs = ['5m', '15m', '1h', '4h', '1d'].filter((tf) => inv.some((r) => r.tf === tf));
  out.inverse = {
    settings: new Set(inv.map((r) => `${r.tf}|${r.key}`)).size,
    groups: [...new Set(inv.map((r) => `${r.tf}|${r.cls}`))].length,
    found: inv.filter((r) => r.found).length, holds: inv.filter((r) => r.holds).length,
    // the settings found on the tuning: where, and what they did after
    foundIn: [...new Set(inv.filter((r) => r.found).map((r) => `${r.tf}|${r.cls}`))].map((g) => {
      const rs = inv.filter((r) => r.found && `${r.tf}|${r.cls}` === g);
      return { tf: rs[0].tf, cls: rs[0].cls, n: rs.length, is: w(rs, 'is', (s) => s.r), oos: w(rs, 'oos', (s) => s.r), oosRnd: w(rs, 'oos', (s) => s.rnd) };
    }),
    signals: tfs.flatMap((tf) => SIGNALS.filter(([k]) => k !== 'wick|htf' || tf === '5m' || tf === '15m').map(([k, label]) => {
      const rs = (k === 'both|htf' ? hammer : inv).filter((r) => r.tf === tf && r.key.startsWith(`${k}|`) && (FLUX[tf] ? r.key.endsWith(FLUX[tf]) : !r.key.includes('|F')));
      return { tf, k, label,
        is: w(rs, 'is', (s) => s.r), isRnd: w(rs, 'is', (s) => s.rnd), isGross: w(rs, 'is', (s) => s.gross),
        oos: w(rs, 'oos', (s) => s.r), oosRnd: w(rs, 'oos', (s) => s.rnd), oosGross: w(rs, 'oos', (s) => s.gross),
        beat: r3(rs.reduce((a, r) => a + r.is.beat, 0) / rs.length), beatOos: r3(rs.reduce((a, r) => a + r.oos.beat, 0) / rs.length) };
    })),
  };
}

writeFileSync(OUT, JSON.stringify(out));
console.log(`fluxgrid.json : ${out.rows.length} réglages, ${out.groups.length} groupes, ${(JSON.stringify(out).length / 1024).toFixed(0)} Ko`);
