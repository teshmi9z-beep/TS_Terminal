import fs from 'node:fs';
import path from 'node:path';

// Reads robots/dow/results/<plan>/*.json (see dow-study.ts) and tells:
// - for each market, the setting that did best on the tuning part (70 %), and what it
//   did on the check part (30 %, never used to choose);
// - the settings that pass on many markets of a class and timeframe group at once;
// - what each option does on average (box, entry, exit, swing, costs, liquidity, hours).
// Usage: node robots/.build/dow-report.mjs <plan> [--json out.json]

type Stats = { n: number; wins: number; sumR: number; gross: number; loss: number; maxDD: number; days: number; cost?: number };
type Result = { id: string; rows: [string, Stats, Stats][]; bars: number; from: number; to: number; split: number; spec: { symbol: string; market: string; tf: string; source: string; cost: number } };

const plan = process.argv[2];
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const dir = path.resolve('robots/dow/results', plan);
const results: Result[] = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const pf = (s: Stats) => (s.loss > 0 ? s.gross / s.loss : s.gross > 0 ? 99 : 0);
const perYear = (s: Stats) => (s.days > 0 ? (s.sumR / s.days) * 365 : 0);
const exp = (s: Stats) => (s.n ? s.sumR / s.n : 0);
// minimum trades: fewer on the slow timeframes
const minIS = (tf: string) => (tf === '1d' ? 30 : tf === '4h' ? 50 : tf === '1h' ? 60 : tf === '15m' ? 100 : 150);
const minOOS = (tf: string) => Math.round(minIS(tf) / 2.5);
const passIS = (s: Stats, tf: string) => s.n >= minIS(tf) && s.sumR > 0 && pf(s) >= 1.15;
const passOOS = (s: Stats, tf: string) => s.n >= minOOS(tf) && s.sumR > 0 && pf(s) >= 1.05;
const group = (tf: string) => (/T$/.test(tf) ? 'ticks' : tf === '1m' || tf === '5m' ? 'scalping' : 'intraday');
const fmt = (v: number, d = 2) => v.toFixed(d);

// ---------------------------------------------------------------- best per market
console.log(`\n=== ${plan} : ${results.length} marchés × ${results[0]?.rows.length ?? 0} réglages ===\n`);
console.log('Meilleur réglage par marché (choisi sur le réglage, vérifié sur la validation)');
const best: { id: string; tf: string; market: string; k: string; is: Stats; oos: Stats }[] = [];
for (const r of results.sort((a, z) => a.spec.market.localeCompare(z.spec.market) || a.id.localeCompare(z.id))) {
  const ok = r.rows.filter(([, is]) => passIS(is, r.spec.tf));
  if (!ok.length) { console.log(`  ${r.id.padEnd(28)} aucun réglage gagnant en réglage`); continue; }
  const [k, is, oos] = ok.sort((a, z) => perYear(z[1]) - perYear(a[1]))[0];
  best.push({ id: r.id, tf: r.spec.tf, market: r.spec.market, k, is, oos });
  const half = oos.cost !== undefined ? ` (frais ÷ 2 : ${fmt((((oos.sumR + 0.5 * oos.cost) / Math.max(1, oos.days)) * 365), 0)})` : '';
  console.log(`  ${r.id.padEnd(28)} ${k.padEnd(44)} réglage ${fmt(perYear(is), 0).padStart(5)} R/an PF ${fmt(pf(is))} (${is.n}) | validation ${fmt(perYear(oos), 0).padStart(5)} R/an PF ${fmt(pf(oos))} (${oos.n})${half} ${passOOS(oos, r.spec.tf) ? 'OK' : '—'}`);
}
const held = best.filter((b) => passOOS(b.oos, b.tf));
console.log(`\n  ${held.length} / ${best.length} meilleurs réglages tiennent en validation (sur ${results.length} marchés)`);
// the base rate: of every setting winning its tuning part, the share that also holds the
// check. The tuning part's best doing no better than that is luck, not skill
let isOk = 0, both = 0;
for (const r of results) for (const [, is, oos] of r.rows) if (passIS(is, r.spec.tf)) { isOk++; if (passOOS(oos, r.spec.tf)) both++; }
console.log(`  taux de base : ${both} / ${isOk} réglages gagnants en réglage tiennent aussi la validation (${fmt((both / Math.max(1, isOk)) * 100, 0)} %) ; meilleurs : ${fmt((held.length / Math.max(1, best.length)) * 100, 0)} %`);

// ---------------------------------------------------------------- settings general to a class
console.log('\nRéglages qui passent sur plusieurs marchés à la fois (réglage ET validation)');
type Gen = { k: string; cls: string; markets: number; pass: number; posOOS: number; expOOS: number; ryOOS: number; on: string[] };
const gens: Gen[] = [];
const classes = new Map<string, Result[]>();
for (const r of results) {
  const cls = `${r.spec.market} · ${group(r.spec.tf)}`;
  if (!classes.has(cls)) classes.set(cls, []);
  classes.get(cls)!.push(r);
}
for (const [cls, rs] of classes) {
  const keys = rs[0].rows.map(([k]) => k);
  for (let v = 0; v < keys.length; v++) {
    let pass = 0, pos = 0, e = 0, ry = 0;
    const on: string[] = [];
    for (const r of rs) {
      const row = r.rows[v];
      if (!row || row[0] !== keys[v]) continue;
      const [, is, oos] = row;
      if (passIS(is, r.spec.tf) && passOOS(oos, r.spec.tf)) { pass++; on.push(`${r.spec.symbol} ${r.spec.tf}`); }
      if (oos.sumR > 0) pos++;
      e += exp(oos); ry += perYear(oos);
    }
    gens.push({ k: keys[v], cls, markets: rs.length, pass, posOOS: pos / rs.length, expOOS: e / rs.length, ryOOS: ry / rs.length, on });
  }
}
for (const cls of [...classes.keys()].sort()) {
  const top = gens.filter((g) => g.cls === cls).sort((a, z) => z.pass - a.pass || z.expOOS - a.expOOS).slice(0, 5);
  console.log(`  ${cls} (${top[0]?.markets ?? 0} marchés)`);
  for (const g of top) console.log(`    ${g.k.padEnd(40)} ${g.pass} passent · validation positive ${fmt(g.posOOS * 100, 0)} % · ${fmt(g.expOOS, 3)} R/trade · ${fmt(g.ryOOS, 1)} R/an${g.on.length ? ` · ${g.on.slice(0, 6).join(', ')}` : ''}`);
}

// ---------------------------------------------------------------- the method's raw edge
// R a trade before costs (the costs added back), by class and timeframe: whether the
// structure itself has an edge the costs then eat
console.log('\nAvantage brut (sans frais), validation : R par trade, moyenne des réglages / meilleur réglage du réglage');
const raw = new Map<string, { e: number; n: number; eNet: number; bestRaw: number; nb: number }>();
for (const r of results) {
  const k = `${r.spec.market.padEnd(9)} ${r.spec.tf.padStart(5)}`;
  const a = raw.get(k) ?? { e: 0, n: 0, eNet: 0, bestRaw: 0, nb: 0 };
  for (const [, , oos] of r.rows) if (oos.n) { a.e += (oos.sumR + (oos.cost ?? 0)) / oos.n; a.eNet += oos.sumR / oos.n; a.n++; }
  // the setting best on the tuning part before costs: its check result before costs
  const bestIS = [...r.rows].filter(([, is]) => is.n >= 50).sort((x, z) => (z[1].sumR + (z[1].cost ?? 0)) / z[1].n - (x[1].sumR + (x[1].cost ?? 0)) / x[1].n)[0];
  if (bestIS && bestIS[2].n) { a.bestRaw += (bestIS[2].sumR + (bestIS[2].cost ?? 0)) / bestIS[2].n; a.nb++; }
  raw.set(k, a);
}
for (const [k, a] of [...raw].sort()) console.log(`  ${k} : sans frais ${fmt(a.e / Math.max(1, a.n), 3)} R · avec frais ${fmt(a.eNet / Math.max(1, a.n), 3)} R · meilleur du réglage sans frais ${fmt(a.bestRaw / Math.max(1, a.nb), 3)} R`);

// ---------------------------------------------------------------- what each option does
console.log('\nEffet de chaque option (moyenne sur tous les marchés, validation, R par trade)');
const names = ['swing', 'body', 'box', 'entry', 'target', 'targetR', 'liq', 'hours', 'maxAge', 'maxCostR', 'be', 'minLeg', 'htf', 'mode'];
for (const g of ['scalping', 'intraday', 'ticks']) {
  const rs = results.filter((r) => group(r.spec.tf) === g);
  if (!rs.length) continue;
  console.log(`  ${g} (${rs.length} marchés)`);
  for (let p = 0; p < names.length; p++) {
    const acc = new Map<string, { e: number; n: number; pos: number }>();
    for (const r of rs) for (const [k, , oos] of r.rows) {
      const val = k.split('|')[p];
      const a = acc.get(val) ?? { e: 0, n: 0, pos: 0 };
      a.e += exp(oos); a.n++; if (oos.sumR > 0) a.pos++;
      acc.set(val, a);
    }
    if (acc.size < 2) continue;
    console.log(`    ${names[p].padEnd(9)} ${[...acc].map(([v, a]) => `${v}: ${fmt(a.e / a.n, 3)} R (${fmt((a.pos / a.n) * 100, 0)} % +)`).join(' · ')}`);
  }
}

// the base settings of the next stage, chosen on the tuning part only: for each timeframe
// group, the structures passing on the most markets in tuning, then the best tuning result
const baseOut = arg('--base');
if (baseOut) {
  const base: Record<string, string[]> = {};
  for (const g of ['scalping', 'intraday', 'ticks']) {
    const rs = results.filter((r) => group(r.spec.tf) === g);
    if (!rs.length) continue;
    const score = new Map<string, { pass: number; e: number }>();
    for (const r of rs) for (const [k, is] of r.rows) {
      const a = score.get(k) ?? { pass: 0, e: 0 };
      if (passIS(is, r.spec.tf)) a.pass++;
      a.e += exp(is) / rs.length;
      score.set(k, a);
    }
    const ranked = [...score].sort((a, z) => z[1].pass - a[1].pass || z[1].e - a[1].e);
    // 10 settings, at least 2 of each box
    const pick: string[] = [];
    for (const box of ['candle', 'fib', 'range']) pick.push(...ranked.filter(([k]) => k.split('|')[2] === box).slice(0, 2).map(([k]) => k));
    for (const [k] of ranked) { if (pick.length >= 10) break; if (!pick.includes(k)) pick.push(k); }
    base[g] = pick;
    console.log(`\nBase de l'étape suivante (${g}) : ${pick.join('  ')}`);
    // and for each class of market: its own 6 best on the tuning part
    for (const m of [...new Set(rs.map((r) => r.spec.market))]) {
      const rm = rs.filter((r) => r.spec.market === m);
      const sc = new Map<string, { pass: number; e: number }>();
      for (const r of rm) for (const [k, is] of r.rows) {
        const a = sc.get(k) ?? { pass: 0, e: 0 };
        if (passIS(is, r.spec.tf)) a.pass++;
        a.e += exp(is) / rm.length;
        sc.set(k, a);
      }
      base[`${m}|${g}`] = [...sc].sort((a, z) => z[1].pass - a[1].pass || z[1].e - a[1].e).slice(0, 6).map(([k]) => k);
      console.log(`  ${m} : ${base[`${m}|${g}`].join('  ')}`);
    }
  }
  fs.writeFileSync(baseOut, JSON.stringify(base, null, 1));
}

const out = arg('--json');
if (out) fs.writeFileSync(out, JSON.stringify({ plan, best, gens: gens.filter((g) => g.pass > 0).sort((a, z) => z.pass - a.pass || z.expOOS - a.expOOS).slice(0, 400) }, null, 1));
