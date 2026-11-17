import fs from 'node:fs';
import path from 'node:path';
import { DATA, load15, MARKETS, nbTrades, noise, resetSlots, rng, sessions, SESSIONS, stat, fmt, type Bars, type Market, type Sess, type Trade } from './pa-lib';
import { TIGHT } from './pa-check-costs';

// Money management on the noise band's walk-forward trades (robots/pa/wf-trades-mom.json,
// 2022 → 2026, tight costs), one 10 000 € account. Sizing rules never change which trades are
// taken (except the equity-curve filter and the daily cap); the trade-management variants
// (stop, partial exit, pyramid) are measured apart on a fixed rule.
// node robots/.build/pa-mm.mjs
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const trades = (JSON.parse(fs.readFileSync('robots/pa/wf-trades-mom.json', 'utf8')) as Trade[]).sort((a, z) => a.day - z.day || a.t - z.t);
const START = 10000;

type Rule = { name: string; size: (st: State) => number; take?: (st: State) => boolean };
type State = { eq: number; peak: number; hist: number[]; lastR: number; streakW: number; streakL: number; dayRisk: number };
type Out = { end: number; cagr: number; dd: number; worstYear: number; months: number; monthsUp: number; n: number };

// The trades of one day overlap (they all close at the session's end), so every size of a day
// is set from the account as it stood the evening before: equity, peak, past trades, and the
// streak of winning or losing days.
function runRule(ts: Trade[], rule: Rule, cap = Infinity): Out {
  const st: State = { eq: START, peak: START, hist: [], lastR: 0, streakW: 0, streakL: 0, dayRisk: 0 };
  let dd = 0, n = 0;
  const byYear = new Map<number, number>(), byMonth = new Map<string, number>();
  let yStart = START, curY = 0;
  for (let i = 0; i < ts.length;) {
    let j = i;
    while (j < ts.length && ts[j].day === ts[i].day) j++;
    const d = new Date(ts[i].t * 1000), Y = d.getUTCFullYear();
    if (Y !== curY) { if (curY) byYear.set(curY, st.eq / yStart - 1); curY = Y; yStart = st.eq; }
    const f0 = (rule.take ? rule.take(st) : true) ? rule.size(st) : 0;
    let risk = 0, pnl = 0, sumR = 0;
    for (let k = i; k < j; k++) {
      const f = Math.max(0, Math.min(f0, cap - risk));
      risk += f; pnl += st.eq * f * ts[k].r; sumR += ts[k].r;
      if (f > 0) n++;
    }
    st.eq += pnl;
    st.peak = Math.max(st.peak, st.eq);
    dd = Math.max(dd, 1 - st.eq / st.peak);
    // the paper record goes on whether the trades were taken or not
    for (let k = i; k < j; k++) st.hist.push(ts[k].r);
    if (sumR > 0) { st.streakW++; st.streakL = 0; } else { st.streakL++; st.streakW = 0; }
    const mk = `${Y}-${d.getUTCMonth()}`;
    byMonth.set(mk, (byMonth.get(mk) ?? 0) + pnl);
    i = j;
  }
  byYear.set(curY, st.eq / yStart - 1);
  const yrs = (ts[ts.length - 1].t - ts[0].t) / (365.25 * 86400);
  const mv = [...byMonth.values()];
  return { end: st.eq, cagr: Math.pow(st.eq / START, 1 / yrs) - 1, dd, worstYear: Math.min(...byYear.values()), months: mv.length, monthsUp: mv.filter((x) => x > 0).length, n };
}

const tail = (h: number[], n: number) => h.slice(Math.max(0, h.length - n));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const RULES: Rule[] = [
  { name: 'Fraction fixe 0,25 % par trade', size: () => 0.0025 },
  { name: 'Fraction fixe 0,5 %', size: () => 0.005 },
  { name: 'Fraction fixe 1 %', size: () => 0.01 },
  { name: 'Fraction fixe 2 %', size: () => 0.02 },
  { name: 'Montant fixe 50 € (sans intérêts composés)', size: (s) => 50 / s.eq },
  { name: 'Anti-martingale : 0,5 %, × 1,5 après un jour gagnant (max × 2)', size: (s) => 0.005 * Math.min(2, Math.pow(1.5, s.streakW)) },
  { name: 'Martingale : 0,5 %, × 2 après un jour perdant (max × 8)', size: (s) => 0.005 * Math.min(8, Math.pow(2, s.streakL)) },
  { name: 'Frein sur le creux : 0,5 %, ÷ 2 sous −5 %, ÷ 4 sous −10 %', size: (s) => { const d = 1 - s.eq / s.peak; return d > 0.1 ? 0.00125 : d > 0.05 ? 0.0025 : 0.005; } },
  // Kelly from the 300 trades before (nothing from the future): f = mean / variance of R, halved, 0 to 2 %
  { name: 'Demi-Kelly glissant (300 trades passés, max 2 %)', size: (s) => { const h = tail(s.hist, 300); if (h.length < 100) return 0.0025; const m = mean(h), v = mean(h.map((x) => (x - m) ** 2)); return Math.max(0, Math.min(0.02, (0.5 * m) / v)); } },
  { name: 'Quart-Kelly glissant (max 1 %)', size: (s) => { const h = tail(s.hist, 300); if (h.length < 100) return 0.0025; const m = mean(h), v = mean(h.map((x) => (x - m) ** 2)); return Math.max(0, Math.min(0.01, (0.25 * m) / v)); } },
  { name: 'Filtre de courbe : 0,5 % seulement si les 100 derniers trades gagnent', size: () => 0.005, take: (s) => s.hist.length < 100 || mean(tail(s.hist, 100)) > 0 },
];

say(`Trades du walk-forward : ${fmt(stat(trades))}`);
say(`\n${'Méthode'.padEnd(66)} ${'fin'.padStart(8)} ${'par an'.padStart(7)} ${'pire creux'.padStart(10)} ${'pire année'.padStart(10)} mois +  rendement/creux`);
const row = (name: string, o: Out) => say(`${name.padEnd(66)} ${o.end.toFixed(0).padStart(8)} ${(100 * o.cagr).toFixed(1).padStart(6)}% ${(100 * o.dd).toFixed(1).padStart(9)}% ${(100 * o.worstYear).toFixed(1).padStart(9)}% ${String(o.monthsUp).padStart(3)}/${o.months}  ${(o.cagr / o.dd).toFixed(2)}`);
for (const r of RULES) row(r.name, runRule(trades, r));
row('Fraction 0,5 % + plafond 1 % de risque par jour', runRule(trades, RULES[1], 0.01));
row('Fraction 1 % + plafond 2 % de risque par jour', runRule(trades, RULES[2], 0.02));

// what the future may look like: the trading days redrawn at random (2 000 times), 0.5 % a trade
{
  const days = new Map<number, Trade[]>();
  for (const t of trades) days.set(t.day, [...(days.get(t.day) ?? []), t]);
  const list = [...days.values()], next = rng(99);
  const perYear = Math.round(list.length / ((trades[trades.length - 1].t - trades[0].t) / (365.25 * 86400)));
  for (const f of [0.005, 0.01]) {
    const ends: number[] = [], dds: number[] = [];
    for (let k = 0; k < 2000; k++) {
      let eq = 1, peak = 1, dd = 0;
      for (let i = 0; i < perYear; i++) for (const t of list[Math.floor(next() * list.length)]) { eq *= 1 + f * t.r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
      ends.push(eq - 1); dds.push(dd);
    }
    ends.sort((a, z) => a - z); dds.sort((a, z) => a - z);
    const q = (a: number[], p: number) => (100 * a[Math.floor(p * a.length)]).toFixed(1);
    say(`\nUne année tirée au hasard, ${100 * f} % par trade (${perYear} jours de trades) : médiane ${q(ends, 0.5)} %, 1 an sur 10 sous ${q(ends, 0.1)} %, 1 sur 10 au-dessus de ${q(ends, 0.9)} % ; année perdante ${((100 * ends.filter((x) => x < 0).length) / ends.length).toFixed(0)} % du temps ; creux médian ${q(dds, 0.5)} %, 1 an sur 20 pire que ${q(dds, 0.95)} %`);
  }
}

// ---------------------------------------------------------------- trade management, fixed rule
// k = 1.25, every 30 min, out at the session's end, on the 4 legs the walk-forward kept longest;
// the variants: a hard stop, half out at +1 R, one add further out (pyramid). 2020 → 2026.
say('\n================ Gestion du trade (règle fixe k = 1,25, sortie fin de séance ; NDX, S&P, or NY, USDJPY Londres) ================');
type Mg = { name: string; stop?: number; half?: number; add?: number; be?: boolean };
const MG: Mg[] = [
  { name: 'Aucune gestion (sortie fin de séance)' },
  { name: 'Stop à −0,5 R' }, { name: 'Stop à −1 R' },
  { name: 'Stop −1 R, à zéro (break-even) après +1 R', stop: 1, be: true },
  { name: 'Moitié sortie à +1 R' }, { name: 'Moitié sortie à +2 R' },
  { name: 'Pyramide : + 50 % à +0,5 R' }, { name: 'Pyramide : + 100 % à +1 R' },
  { name: 'Pyramide + 50 % à +0,5 R, stop −1 R', add: 0.5, stop: 1 },
];
MG[1].stop = 0.5; MG[2].stop = 1; MG[4].half = 1; MG[5].half = 2; MG[6].add = 0.5; MG[7].add = 1;
const pick: [string, string][] = [['NDX100', 'us'], ['SPX500', 'us'], ['XAUUSD', 'nym'], ['USDJPY', 'ldn']];
function managed(b: Bars, se: Sess, sig: Float64Array[], cost: number, g: Mg): Trade[] {
  const out: Trade[] = [];
  const { slots, days } = se;
  for (let d = 0; d < days.length; d++) {
    const D = days[d], sg = sig[d], unit = 1.25 * sg[slots - 1], O = b.o[D.idx[0]];
    if (!(unit > 0) || b.t[D.idx[0]] < Date.UTC(2020, 0, 1) / 1000) continue;
    const up = Math.max(O, D.prevC), dn = Math.min(O, D.prevC);
    let pos = 0, entry = 0, et = 0, size = 0, r = 0, halfDone = false, addDone = false, stop = NaN;
    for (let j = 0; j < slots; j++) {
      const i = D.idx[j];
      if (i < 0) continue;
      const c = b.c[i], last = j === slots - 1;
      if (pos) {
        // the stop works inside the bar, at its price (a gap through it would cost more)
        const worst = pos > 0 ? b.l[i] : b.h[i];
        if (!Number.isNaN(stop) && pos * (worst - stop) <= 0) {
          r += size * ((pos * (stop / entry - 1)) / unit) - size * (2 * cost) / unit;
          out.push({ t: et, dir: pos, r, costR: 0, day: D.date }); pos = 0; break;
        }
        const g1 = (pos * (c / entry - 1)) / unit;
        if (g.half && !halfDone && g1 >= g.half) { r += 0.5 * g1 - 0.5 * (2 * cost) / unit; size -= 0.5; halfDone = true; }
        if (g.add && !addDone && g1 >= g.add && !last) {
          // the add is its own entry at this close
          const k = g.add >= 1 ? 1 : 0.5;
          r -= k * g1; size += k; addDone = true;
        }
        if (g.be && g1 >= 1) stop = entry;
        if (last) { r += size * g1 - size * (2 * cost) / unit; out.push({ t: et, dir: pos, r, costR: 0, day: D.date }); pos = 0; }
        continue;
      }
      if (last || (j + 1) % 2 || Number.isNaN(sg[j]) || out.length && out[out.length - 1].day === D.date) continue;
      if (c > up * (1 + 1.25 * sg[j])) pos = 1; else if (c < dn * (1 - 1.25 * sg[j])) pos = -1;
      if (pos) { entry = c; et = b.t[i] + 900; size = 1; r = 0; halfDone = addDone = false; stop = g.stop ? entry * (1 - pos * g.stop * unit) : NaN; }
    }
  }
  return out;
}
{
  const legs = pick.map(([sym, sk]) => { const m = MARKETS.find((x) => x.sym === sym)!; const b = load15(m); const se = sessions(b, SESSIONS[sk]); return { m, b, se, sig: noise(b, se, 14) }; });
  for (const g of MG) {
    const ts = legs.flatMap((L) => managed(L.b, L.se, L.sig, TIGHT[L.m.sym], g)).sort((a, z) => a.day - z.day || a.t - z.t);
    const s = stat(ts);
    const o = runRule(ts, RULES[1]);
    say(`${g.name.padEnd(44)} ${fmt(s)} | à 0,5 % : ${(100 * o.cagr).toFixed(1)} %/an, creux ${(100 * o.dd).toFixed(1)} %`);
  }
}

// ---------------------------------------------------------------- another source of prices
say('\n================ Même règle sur une autre source de prix (contrôle des données) ================');
{
  const alt: [string, string, string, string][] = [['XAUUSD', 'bnfut_XAUUSDT_15m.json', 'nym', 'or, perpétuel Binance'], ['NDX100', 'dl_ibkr_US100_15m.bin', 'us', 'Nasdaq, IBKR']];
  for (const [sym, file, sk, label] of alt) {
    const f = path.join(DATA, file);
    if (!fs.existsSync(f)) continue;
    const m0 = MARKETS.find((x) => x.sym === sym)!;
    const mA: Market = { ...m0, file: f, histdata: false };
    const res = [m0, mA].map((m) => { const b = load15(m); const se = sessions(b, SESSIONS[sk]); const ts = nbTrades(b, se, noise(b, se, 14), { k: 1.25, step: 2, exit: 'eod', side: 0, look: 14 }, TIGHT[sym]); resetSlots(); return { ts, from: b.t[0] }; });
    const from = res[1].ts[0]?.t ?? Infinity, to = Math.min(res[0].ts[res[0].ts.length - 1].t, res[1].ts[res[1].ts.length - 1]?.t ?? 0);
    const wd = (t: number) => { const w = new Date(t * 1000).getUTCDay(); return w >= 1 && w <= 5; };
    const cut = (ts: Trade[]) => ts.filter((t) => t.t >= from && t.t <= to && wd(t.t));
    say(`${label} depuis ${new Date(from * 1000).toISOString().slice(0, 10)} : HistData ${fmt(stat(cut(res[0].ts)))} | autre source ${fmt(stat(cut(res[1].ts)))}`);
  }
}
fs.writeFileSync('robots/pa/money-management.txt', lines.join('\n'));
