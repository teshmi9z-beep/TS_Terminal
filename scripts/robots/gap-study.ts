import fs from 'node:fs';
import path from 'node:path';
import { INDEX_FAMILIES, zoned, type IndexFamily } from '../../src/data/indexFamilies';

// The cash indices' opening gaps since 2020 (data: scripts/robots/gap-fetch.mjs): how often and
// how fast a gap fills (the price comes back to the previous close) by size and direction, how
// far it runs first, and whether fading it or following it pays after costs. 15-minute session
// bars from Interactive Brokers for 7 indices; the Dow, which IBKR doesn't serve, on daily bars
// only (filled or not by the close). Found on 2020-2023, checked on 2024 → now.
// Usage: node robots/.build/gap-study.mjs
// Writes robots/gaps/GAPS.txt, robots/gaps/gap-stats.json and the table the "Gap d'ouverture"
// indicator reads (src/indicators/custom/gapStats.ts).

const DATA = path.resolve('robots/gaps/data');
const OUT = path.resolve('robots/gaps');
const FROM = Date.UTC(2020, 0, 1) / 1000;
const SPLIT = Date.UTC(2024, 0, 1) / 1000;
// per side, as the lab counts an index CFD / future (fees + spread)
const COST = 0.0002;
export const BUCKETS = [0.1, 0.25, 0.5, 1];
const BUCKET_LABEL = ['0,1 – 0,25 %', '0,25 – 0,5 %', '0,5 – 1 %', '1 % et plus'];
const HORIZONS = [15, 30, 60, 120];
// minutes per bar of the intraday files
const BAR = 15;

type Row = [number, number, number, number, number];
type Session = { day: string; t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
type Gap = {
  index: string; day: string; t0: number; dir: 1 | -1; pct: number; bucket: number;
  prevClose: number; open: number;
  // minutes after the open when the previous close was touched (NaN: not that day)
  fillMin: number;
  // how far the price ran beyond the open, in the gap's direction, before the fill (or by the close), in gaps
  ext: number;
  // close of the day beyond the open, in the gap's direction
  cont: boolean;
  // the daily trend before the gap (close above its 50-day average: 1)
  trend: 1 | -1 | 0;
  weekday: number;
  // the session's bars after the open (for the trading rules)
  bars?: { h: number[]; l: number[]; c: number[]; o: number[]; t: number[] };
};

const read = (f: string): Row[] => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []);
const bucketOf = (p: number) => { let b = -1; BUCKETS.forEach((x, i) => { if (p >= x) b = i; }); return b; };

// the exchange's calendar day of each bar (the zone's offset looked up once per UTC day)
function dayKey(f: IndexFamily) {
  const cache = new Map<number, string[]>();
  return (t: number) => {
    const d = Math.floor(t / 86400);
    let hours = cache.get(d);
    if (!hours) { hours = []; cache.set(d, hours); }
    const h = Math.floor((t % 86400) / 3600);
    return (hours[h] ??= zoned(t, f.tz).day);
  };
}

function sessions(rows: Row[], f: IndexFamily): Session[] {
  const key = dayKey(f);
  const out: Session[] = [];
  for (const [t, o, h, l, c] of rows) {
    const day = key(t);
    let s = out[out.length - 1];
    if (!s || s.day !== day) { s = { day, t: [], o: [], h: [], l: [], c: [] }; out.push(s); }
    s.t.push(t); s.o.push(o); s.h.push(h); s.l.push(l); s.c.push(c);
  }
  // half days and holes of the feed: a session with fewer than a third of the usual bars is dropped
  const usual = [...out].map((s) => s.t.length).sort((a, b) => a - b)[Math.floor(out.length / 2)] ?? 0;
  return out.filter((s) => s.t.length >= usual / 3);
}

// the daily trend (close vs its 50-day average) known before each day
function trendByDay(daily: Row[]): Map<string, 1 | -1> {
  const m = new Map<string, 1 | -1>();
  let sum = 0;
  for (let i = 0; i < daily.length; i++) {
    sum += daily[i][4];
    if (i >= 50) sum -= daily[i - 50][4];
    if (i >= 50 && i + 1 < daily.length) m.set(new Date(daily[i + 1][0] * 1000).toISOString().slice(0, 10), daily[i][4] > sum / 50 ? 1 : -1);
  }
  return m;
}

function gapsIntraday(ticker: string, f: IndexFamily): Gap[] {
  const rows = read(path.join(DATA, `${ticker}_15m.json`));
  const trend = trendByDay(read(path.join(DATA, `${ticker}_1d.json`)));
  const ss = sessions(rows, f);
  const out: Gap[] = [];
  for (let k = 1; k < ss.length; k++) {
    const s = ss[k], prev = ss[k - 1];
    if (s.t[0] < FROM) continue;
    const prevClose = prev.c[prev.c.length - 1], open = s.o[0];
    const pct = ((open - prevClose) / prevClose) * 100;
    const b = bucketOf(Math.abs(pct));
    if (b < 0) continue;
    const dir: 1 | -1 = pct > 0 ? 1 : -1;
    let fillMin = NaN, best = open;
    for (let i = 0; i < s.t.length; i++) {
      if (dir > 0 ? s.l[i] <= prevClose : s.h[i] >= prevClose) { fillMin = (s.t[i] - s.t[0]) / 60 + BAR; break; }
      best = dir > 0 ? Math.max(best, s.h[i]) : Math.min(best, s.l[i]);
    }
    const gapSize = Math.abs(open - prevClose);
    out.push({
      index: ticker, day: s.day, t0: s.t[0], dir, pct, bucket: b, prevClose, open, fillMin,
      ext: Math.abs(best - open) / gapSize,
      cont: dir * (s.c[s.c.length - 1] - open) > 0,
      trend: trend.get(s.day) ?? 0,
      weekday: new Date(`${s.day}T12:00:00Z`).getUTCDay(),
      bars: { t: s.t, o: s.o, h: s.h, l: s.l, c: s.c },
    });
  }
  return out;
}

// the Dow from daily bars: filled by the close or not, no timing
function gapsDaily(ticker: string): Gap[] {
  const d = read(path.join(DATA, `${ticker}_1d.json`));
  const trend = trendByDay(d);
  const out: Gap[] = [];
  for (let i = 1; i < d.length; i++) {
    const [t, o, h, l, c] = d[i], prevClose = d[i - 1][4];
    if (t < FROM) continue;
    const pct = ((o - prevClose) / prevClose) * 100;
    const b = bucketOf(Math.abs(pct));
    if (b < 0) continue;
    const dir: 1 | -1 = pct > 0 ? 1 : -1;
    const filled = dir > 0 ? l <= prevClose : h >= prevClose;
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    out.push({
      index: ticker, day, t0: t, dir, pct, bucket: b, prevClose, open: o, fillMin: filled ? 999 : NaN,
      ext: NaN, cont: dir * (c - o) > 0, trend: trend.get(day) ?? 0, weekday: new Date(t * 1000).getUTCDay(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- statistics
type Stat = { n: number; fill: number[]; fillClose: number; medMin: number; ext50: number; ext75: number; cont: number };
const pctOf = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 10 : NaN);
const quantile = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function stat(gs: Gap[]): Stat {
  const n = gs.length, filled = gs.filter((g) => !Number.isNaN(g.fillMin));
  const timed = filled.filter((g) => g.fillMin < 999);
  return {
    n,
    fill: HORIZONS.map((m) => pctOf(timed.filter((g) => g.fillMin <= m).length, n)),
    fillClose: pctOf(filled.length, n),
    medMin: Math.round(quantile(timed.map((g) => g.fillMin), 0.5)),
    ext50: Math.round(quantile(gs.map((g) => g.ext).filter((x) => !Number.isNaN(x)), 0.5) * 100) / 100,
    ext75: Math.round(quantile(gs.map((g) => g.ext).filter((x) => !Number.isNaN(x)), 0.75) * 100) / 100,
    cont: pctOf(gs.filter((g) => g.cont).length, n),
  };
}

// ---------------------------------------------------------------- trading rules
type Trade = { r: number; t: number };
type Rule = { key: string; label: string; run: (g: Gap) => Trade | null };
const cost = (g: Gap, risk: number) => (2 * COST * g.open) / risk;

// fade: toward the previous close from the open (or `wait` bars later if not filled yet), stop
// `k` gaps beyond the entry, out at the target or at the close; a bar reaching both counts as stop
function fade(k: number, wait: number): Rule['run'] {
  return (g) => {
    const b = g.bars;
    if (!b || b.t.length <= wait + 1) return null;
    const gap = Math.abs(g.open - g.prevClose);
    for (let i = 0; i < wait; i++) if (g.dir > 0 ? b.l[i] <= g.prevClose : b.h[i] >= g.prevClose) return null;
    const entry = wait ? b.c[wait - 1] : g.open, d = -g.dir as 1 | -1;
    const stop = entry - d * k * gap, risk = k * gap, target = g.prevClose;
    if (d * (target - entry) <= 0) return null;
    for (let i = wait; i < b.t.length; i++) {
      if (d > 0 ? b.l[i] <= stop : b.h[i] >= stop) return { r: -1 - cost(g, risk), t: g.t0 };
      if (d > 0 ? b.h[i] >= target : b.l[i] <= target) return { r: (d * (target - entry)) / risk - cost(g, risk), t: g.t0 };
    }
    return { r: (d * (b.c[b.c.length - 1] - entry)) / risk - cost(g, risk), t: g.t0 };
  };
}

// go: with the gap after `wait` bars if not filled, stop at the previous close, out at the close
function go(wait: number): Rule['run'] {
  return (g) => {
    const b = g.bars;
    if (!b || b.t.length <= wait + 1) return null;
    for (let i = 0; i < wait; i++) if (g.dir > 0 ? b.l[i] <= g.prevClose : b.h[i] >= g.prevClose) return null;
    const entry = b.c[wait - 1], d = g.dir, stop = g.prevClose, risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    for (let i = wait; i < b.t.length; i++) if (d > 0 ? b.l[i] <= stop : b.h[i] >= stop) return { r: -1 - cost(g, risk), t: g.t0 };
    return { r: (d * (b.c[b.c.length - 1] - entry)) / risk - cost(g, risk), t: g.t0 };
  };
}

const RULES: Rule[] = [
  { key: 'fade1', label: 'Contre le gap à l’ouverture, objectif clôture de la veille, stop 1 gap', run: fade(1, 0) },
  { key: 'fade2', label: 'Contre le gap à l’ouverture, objectif clôture de la veille, stop 2 gaps', run: fade(2, 0) },
  { key: 'fade05', label: 'Contre le gap à l’ouverture, objectif clôture de la veille, stop 0,5 gap', run: fade(0.5, 0) },
  { key: 'fade1w', label: 'Contre le gap après 15 min s’il n’est pas comblé, stop 1 gap', run: fade(1, 1) },
  { key: 'go30', label: 'Avec le gap après 30 min s’il n’est pas comblé, stop clôture de la veille, sortie en fin de séance', run: go(2) },
];

type RS = { n: number; mean: number; t: number; win: number };
function rs(tr: Trade[]): RS {
  const n = tr.length;
  if (!n) return { n: 0, mean: NaN, t: NaN, win: NaN };
  const mean = tr.reduce((s, x) => s + x.r, 0) / n;
  const sd = Math.sqrt(tr.reduce((s, x) => s + (x.r - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, t: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0, win: pctOf(tr.filter((x) => x.r > 0).length, n) };
}

// ---------------------------------------------------------------- main
const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };
const fmt = (x: number, d = 1) => (Number.isNaN(x) ? '—' : x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pad = (s: string | number, w: number) => String(s).padStart(w);

const all: Gap[] = [];
const byIndex = new Map<string, Gap[]>();
for (const f of INDEX_FAMILIES) {
  const intraday = fs.existsSync(path.join(DATA, `${f.cash}_15m.json`));
  const gs = intraday ? gapsIntraday(f.cash, f) : gapsDaily(f.cash);
  byIndex.set(f.cash, gs);
  all.push(...gs);
}

say(`=== Gaps d'ouverture des indices cash depuis 2020 (${new Date().toISOString().slice(0, 10)})`);
say('Gap = ouverture − clôture de la veille ; comblé = le prix retouche la clôture de la veille. Gaps sous 0,1 % ignorés.');
say('Bougies 15 min de séance (IBKR) ; Dow en journalier (comblé ou non à la clôture, sans heure).');
say('');
const table: Record<string, Record<string, Stat[]>> = {};
for (const f of INDEX_FAMILIES) {
  const gs = byIndex.get(f.cash) ?? [];
  if (!gs.length) continue;
  const days = new Set(gs.map((g) => g.day)).size;
  say(`--- ${f.name} (${f.cash}) : ${gs.length} gaps de 0,1 % et plus, du ${gs[0].day} au ${gs[gs.length - 1].day} (${days} séances avec gap)`);
  say(`  sens    taille          n   comblé ≤15m ≤30m  ≤1h  ≤2h  clôture  médiane   extension méd./75 %   clôture au-delà de l'ouverture`);
  table[f.cash] = {};
  for (const dir of [1, -1] as const) {
    const row: Stat[] = [];
    BUCKETS.forEach((_, b) => {
      const st = stat(gs.filter((g) => g.dir === dir && g.bucket === b));
      row.push(st);
      say(`  ${dir > 0 ? 'hausse' : 'baisse'}  ${BUCKET_LABEL[b].padEnd(14)} ${pad(st.n, 4)}        ${st.fill.map((x) => pad(fmt(x, 0), 4)).join(' ')} ${pad(fmt(st.fillClose, 0), 6)} %  ${pad(Number.isNaN(st.medMin) ? '—' : `${st.medMin} min`, 7)}   ${pad(fmt(st.ext50, 2), 5)} / ${pad(fmt(st.ext75, 2), 5)} gap   ${pad(fmt(st.cont, 0), 4)} %`);
    });
    table[f.cash][dir > 0 ? 'up' : 'down'] = row;
  }
  // stability: filled by the close, 2020-2023 vs 2024 → now
  const early = stat(gs.filter((g) => g.t0 < SPLIT)), late = stat(gs.filter((g) => g.t0 >= SPLIT));
  say(`  comblés à la clôture : 2020-2023 ${fmt(early.fillClose, 0)} % (${early.n}), 2024 → ${fmt(late.fillClose, 0)} % (${late.n})`);
  say('');
}

// contexts, every index pooled, gaps of 0.25 % and more
say('--- Contextes (tous indices, gaps de 0,25 % et plus)');
const big = all.filter((g) => g.bucket >= 1);
const ctx: [string, (g: Gap) => boolean][] = [
  ['tous', () => true],
  ['gap dans le sens de la tendance 50 j', (g) => g.trend === g.dir],
  ['gap contre la tendance 50 j', (g) => g.trend === -g.dir],
  ['lundi', (g) => g.weekday === 1],
  ['autres jours', (g) => g.weekday !== 1],
  ['2020-2023', (g) => g.t0 < SPLIT],
  ['2024 → aujourd’hui', (g) => g.t0 >= SPLIT],
];
const ctxOut: { label: string; st: Stat }[] = [];
for (const [label, fn] of ctx) {
  const st = stat(big.filter(fn));
  ctxOut.push({ label, st });
  say(`  ${label.padEnd(38)} n ${pad(st.n, 5)}   comblé ≤1h ${pad(fmt(st.fill[2], 0), 3)} %   à la clôture ${pad(fmt(st.fillClose, 0), 3)} %   clôture au-delà de l'ouverture ${pad(fmt(st.cont, 0), 3)} %`);
}
say('');

// trading rules, per index and pooled, found / checked
say('--- Règles de trading (frais 0,02 % par côté, R = résultat / risque)');
const ruleOut: Record<string, Record<string, { found: RS; check: RS }>> = {};
for (const rule of RULES) {
  say(`  ${rule.label}`);
  ruleOut[rule.key] = {};
  const pooledF: Trade[] = [], pooledC: Trade[] = [];
  for (const f of INDEX_FAMILIES) {
    const tr = (byIndex.get(f.cash) ?? []).filter((g) => g.bucket >= 1).map(rule.run).filter((x): x is Trade => !!x);
    if (!tr.length) continue;
    const found = rs(tr.filter((x) => x.t < SPLIT)), check = rs(tr.filter((x) => x.t >= SPLIT));
    pooledF.push(...tr.filter((x) => x.t < SPLIT));
    pooledC.push(...tr.filter((x) => x.t >= SPLIT));
    ruleOut[rule.key][f.cash] = { found, check };
    say(`    ${f.name.padEnd(13)} 2020-23 n ${pad(found.n, 4)} ${pad(fmt(found.mean, 3), 7)} R t ${pad(fmt(found.t, 1), 5)} gagnants ${pad(fmt(found.win, 0), 3)} %   |   2024→ n ${pad(check.n, 4)} ${pad(fmt(check.mean, 3), 7)} R t ${pad(fmt(check.t, 1), 5)} gagnants ${pad(fmt(check.win, 0), 3)} %`);
  }
  const F = rs(pooledF), C = rs(pooledC);
  ruleOut[rule.key].all = { found: F, check: C };
  say(`    ${'TOUS'.padEnd(13)} 2020-23 n ${pad(F.n, 4)} ${pad(fmt(F.mean, 3), 7)} R t ${pad(fmt(F.t, 1), 5)} gagnants ${pad(fmt(F.win, 0), 3)} %   |   2024→ n ${pad(C.n, 4)} ${pad(fmt(C.mean, 3), 7)} R t ${pad(fmt(C.t, 1), 5)} gagnants ${pad(fmt(C.win, 0), 3)} %`);
  say('');
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'GAPS.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'gap-stats.json'), JSON.stringify({ date: new Date().toISOString().slice(0, 10), buckets: BUCKETS, horizons: HORIZONS, table, rules: ruleOut }, null, 1));

// the indicator's table: per index, per direction, per size: n, filled by 15/30/60/120 min and by
// the close, median minutes, extension 75 %, close beyond the open
const ts = [
  '// Generated by scripts/robots/gap-study.ts from the cash indices since 2020: do not edit by hand.',
  '// Per index, gap direction and size (0.1 / 0.25 / 0.5 / 1 %): [n, filled by 15 min, 30 min, 1 h, 2 h,',
  '// by the close (%), median minutes to fill, run beyond the open before the fill (75 % of cases, in gaps),',
  '// close beyond the open (%)]',
  `export const GAP_STATS_DATE = '${new Date().toISOString().slice(0, 10)}';`,
  `export const GAP_BUCKETS = ${JSON.stringify(BUCKETS)};`,
  'export const GAP_STATS: Record<string, { up: number[][]; down: number[][] }> = {',
  ...Object.entries(table).map(([k, v]) => `  ${k}: { up: ${JSON.stringify(v.up.map(row))}, down: ${JSON.stringify(v.down.map(row))} },`),
  '};',
  '',
];
function row(s: Stat): number[] { return [s.n, ...s.fill, s.fillClose, s.medMin, s.ext75, s.cont].map((x) => (Number.isNaN(x) ? -1 : x)); }
fs.writeFileSync(path.resolve('src/indicators/custom/gapStats.ts'), ts.join('\n'));
fs.writeFileSync(path.join(OUT, 'rapport-gaps.html'), report());
console.log('\nécrit : robots/gaps/GAPS.txt, gap-stats.json, rapport-gaps.html, src/indicators/custom/gapStats.ts');

// ---------------------------------------------------------------- the HTML report
function report(): string {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const cell = (x: number, d = 0, unit = '') => (Number.isNaN(x) || x < 0 ? '<td class="na">—</td>' : `<td>${fmt(x, d)}${unit}</td>`);
  // every index pooled (the intraday ones), per direction and size
  const timed = all.filter((g) => !Number.isNaN(g.ext));
  const pooled = [1, -1].map((dir) => BUCKETS.map((_, b) => stat(timed.filter((g) => g.dir === dir && g.bucket === b))));
  const small = stat(timed.filter((g) => g.bucket === 0)), large = stat(timed.filter((g) => g.bucket === 3));
  const verdict = (r: { found: RS; check: RS }) => {
    if (r.found.n < 30 || r.check.n < 20) return '<span class="tag">trop peu de cas</span>';
    if (r.found.mean > 0 && r.check.mean > 0 && r.found.t >= 2 && r.check.t >= 1) return '<span class="tag good">tient</span>';
    if (r.found.mean > 0 && r.check.mean <= 0) return '<span class="tag bad">ne tient pas après 2023</span>';
    if (r.found.mean > 0) return '<span class="tag">faible</span>';
    return '<span class="tag bad">perd</span>';
  };
  const sizeRows = (rows: Stat[]) => rows.map((st, b) => `<tr><th>${BUCKET_LABEL[b]}</th><td>${st.n}</td>${st.fill.map((x) => cell(x, 0, ' %')).join('')}${cell(st.fillClose, 0, ' %')}${cell(st.medMin, 0, ' min')}${cell(st.ext75, 2)}${cell(st.cont, 0, ' %')}</tr>`).join('');
  const head = '<tr><th>Taille</th><th>Cas</th><th>≤ 15 min</th><th>≤ 30 min</th><th>≤ 1 h</th><th>≤ 2 h</th><th>Clôture</th><th>Médiane</th><th>Ext. 75 %</th><th>Au-delà</th></tr>';
  const indexBlocks = INDEX_FAMILIES.filter((f) => table[f.cash]).map((f) => {
    const daily = !(byIndex.get(f.cash) ?? []).some((g) => !Number.isNaN(g.ext));
    return `<section class="card"><h3>${esc(f.name)}${daily ? ' <span class="tag">journalier : comblé ou non à la clôture</span>' : ''}</h3>
      <div class="two"><div><h4>Gaps haussiers</h4><div class="scroll"><table>${head}${sizeRows(table[f.cash].up)}</table></div></div>
      <div><h4>Gaps baissiers</h4><div class="scroll"><table>${head}${sizeRows(table[f.cash].down)}</table></div></div></div></section>`;
  }).join('');
  const ruleRows = RULES.map((r) => {
    const o = ruleOut[r.key]?.all;
    if (!o) return '';
    const per = INDEX_FAMILIES.map((f) => ruleOut[r.key][f.cash]).filter(Boolean);
    const holds = per.filter((x) => x.found.mean > 0 && x.check.mean > 0).length;
    return `<tr><th>${esc(r.label)}</th><td>${o.found.n}</td><td class="${o.found.mean > 0 ? 'pos' : 'neg'}">${fmt(o.found.mean, 3)} R</td><td>${fmt(o.found.t, 1)}</td><td>${o.check.n}</td><td class="${o.check.mean > 0 ? 'pos' : 'neg'}">${fmt(o.check.mean, 3)} R</td><td>${fmt(o.check.t, 1)}</td><td>${holds} / ${per.length}</td><td>${verdict(o)}</td></tr>`;
  }).join('');
  const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gaps d'ouverture</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1c1c1e;--muted:#6b6b70;--line:#e3e3e0;--good:#0a7d4f;--bad:#c2372f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111214;--card:#1a1b1e;--ink:#ececef;--muted:#9a9aa2;--line:#2c2d31;--good:#3ecf8e;--bad:#ff6b61}}
:root[data-theme="dark"]{--bg:#111214;--card:#1a1b1e;--ink:#ececef;--muted:#9a9aa2;--line:#2c2d31;--good:#3ecf8e;--bad:#ff6b61}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 60px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:34px 0 10px}h3{font-size:16px;margin:0 0 10px}h4{font-size:13px;margin:6px 0;color:var(--muted);font-weight:600}
.sub{color:var(--muted);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.kpi b{display:block;font-size:26px}.kpi span{color:var(--muted);font-size:13px}
.two{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}.two>div{min-width:0}@media(min-width:1000px){.two{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:5px 7px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child{text-align:left;white-space:normal;min-width:120px}tr th{font-weight:600}td.na{color:var(--muted)}
.pos{color:var(--good)}.neg{color:var(--bad)}.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;border:1px solid var(--line);color:var(--muted);font-weight:500}.tag.good{color:var(--good);border-color:var(--good)}.tag.bad{color:var(--bad);border-color:var(--bad)}
.note{color:var(--muted);font-size:13px}
</style></head><body><main>
<h1>Gaps d’ouverture des indices cash</h1>
<p class="sub">${all.length.toLocaleString('fr-FR')} gaps de 0,1 % et plus, de janvier 2020 au ${today} · 8 indices de la liste principale · bougies 15 min de séance (Interactive Brokers), Dow en journalier (Yahoo)</p>
<div class="kpis">
<div class="kpi"><b>${fmt(small.fillClose, 0)} %</b><span>des petits gaps (0,1 – 0,25 %) comblés dans la séance, ${fmt(small.fill[2], 0)} % dans l’heure</span></div>
<div class="kpi"><b>${fmt(large.fillClose, 0)} %</b><span>des gros gaps (1 % et plus) comblés dans la séance</span></div>
${ctxOut.slice(1, 3).map((c) => `<div class="kpi"><b>${fmt(c.st.fillClose, 0)} %</b><span>des gaps de 0,25 % et plus comblés, ${esc(c.label)} (${c.st.n} cas)</span></div>`).join('')}
</div>
<h2>Tous indices ensemble (hors Dow)</h2>
<section class="card"><div class="two"><div><h4>Gaps haussiers</h4><div class="scroll"><table>${head}${sizeRows(pooled[0])}</table></div></div><div><h4>Gaps baissiers</h4><div class="scroll"><table>${head}${sizeRows(pooled[1])}</table></div></div></div>
<p class="note">Comblé = le prix retouche la clôture de la veille dans la séance (≤ 15 min, 30 min, 1 h, 2 h, ou d’ici la clôture). Médiane = minutes jusqu’au comblement quand il a lieu. Ext. 75 % = jusqu’où le prix est allé dans le sens du gap avant de se retourner, dans 75 % des cas, en nombre de gaps (utile pour placer un stop). Au-delà = la séance finit plus loin que l’ouverture, dans le sens du gap.</p></section>
<h2>Contextes (gaps de 0,25 % et plus)</h2>
<section class="card scroll"><table><tr><th>Contexte</th><th>Cas</th><th>Comblé ≤ 1 h</th><th>À la clôture</th><th>Au-delà</th></tr>
${ctxOut.map((c) => `<tr><th>${esc(c.label)}</th><td>${c.st.n}</td>${cell(c.st.fill[2], 0, ' %')}${cell(c.st.fillClose, 0, ' %')}${cell(c.st.cont, 0, ' %')}</tr>`).join('')}</table>
<p class="note">Le Dow compte dans les colonnes « clôture » et « au-delà », pas dans « ≤ 1 h » (pas d’heure en journalier).</p></section>
<h2>Règles de trading testées</h2>
<section class="card scroll"><table><tr><th>Règle (gaps de 0,25 % et plus)</th><th>Cas 2020-23</th><th>Moyenne</th><th>t</th><th>Cas 2024 →</th><th>Moyenne</th><th>t</th><th>Indices positifs sur les 2 périodes</th><th>Verdict</th></tr>${ruleRows}</table>
<p class="note">Frais 0,02 % par côté (CFD ou future sur indice). R = gain ou perte divisé par le risque (distance du stop). Une règle « tient » si elle gagne sur 2020-2023 avec t ≥ 2 et encore sur 2024 → aujourd’hui avec t ≥ 1.</p></section>
<h2>Par indice</h2>${indexBlocks}
<p class="note">Données : scripts/robots/gap-fetch.mjs (IBKR, Yahoo). Étude : scripts/robots/gap-study.ts. Résultats bruts : robots/gaps/GAPS.txt. L’indicateur « Gap d’ouverture » lit ces chiffres.</p>
</main></body></html>`;
}
