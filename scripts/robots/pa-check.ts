import fs from 'node:fs';
import {
  fadeKey, fadeTrades, fmt, load15, MARKETS, nbKey, nbTrades, noise, oosOf, isOf, resetSlots, rng, sessions, SESSIONS, SESSIONS_OF, stat, years,
  type Bars, type FadeSet, type Market, type NbSet, type Sess, type Trade,
} from './pa-lib';
import { TIGHT } from './pa-check-costs';

// The noise band, strict check. Walk-forward without hindsight: each year from 2022, a market
// and session is traded only if one of 9 settings had t > 1.5 on all the years before, with
// that setting. Costs: what a tight venue takes today (a micro future, or a CFD at a broker
// like IG in the market's main hours), then 2x and 3x, and the lab's usual costs.
// node robots/.build/pa-check.mjs
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };

const sets: NbSet[] = [];
for (const k of [1, 1.25, 1.5]) for (const exit of ['eod', 'open', 'band'] as const) sets.push({ k, step: 2, exit, side: 0, look: 14 });

type Leg = { m: Market; sk: string; b: Bars; se: Sess; sig: Float64Array[] };
const legs: Leg[] = [];
for (const m of MARKETS) {
  if (!(m.sym in TIGHT)) continue;
  const b = load15(m);
  for (const sk of SESSIONS_OF(m)) { const se = sessions(b, SESSIONS[sk]); legs.push({ m, sk, b, se, sig: noise(b, se, 14) }); }
}
const fades: FadeSet[] = [];
for (const k of [1, 1.5]) for (const exit of ['eod', 'open'] as const) fades.push({ k, exit, stop: 1.5, look: 14 });
// PA_MODE=mom: the momentum settings only; fade: the fades only; default: both
const MODE = process.env.PA_MODE ?? 'both';
const yr = (t: number) => new Date(t * 1000).getUTCFullYear();

function walk(costOf: (m: Market) => number, log = false): { all: Trade[]; picks: Map<string, string[]>; slots: Map<string, { slot: number; dir: number }[]> } {
  const all: Trade[] = [];
  const picks = new Map<string, string[]>(), slots = new Map<string, { slot: number; dir: number }[]>();
  for (const L of legs) {
    const res = [
      ...(MODE !== 'fade' ? sets : []).map((s) => { const ts = nbTrades(L.b, L.se, L.sig, s, costOf(L.m)); const sl = resetSlots(); return { key: nbKey(s).split('|').slice(0, 3).join('|'), ts, sl }; }),
      ...(MODE !== 'mom' ? fades : []).map((s) => { const ts = fadeTrades(L.b, L.se, L.sig, s, costOf(L.m)); const sl = resetSlots(); return { key: fadeKey(s), ts, sl }; }),
    ];
    const name = `${L.m.sym}/${L.sk}`;
    for (let Y = 2022; Y <= 2026; Y++) {
      let best: (typeof res)[0] | undefined, bt = 1.5;
      for (const r of res) { const t = stat(r.ts.filter((x) => yr(x.t) < Y)).t; if (t > bt) { bt = t; best = r; } }
      if (!best) continue;
      const got = best.ts.filter((x) => yr(x.t) === Y).map((x) => ({ ...x, sym: name }));
      all.push(...got);
      picks.set(name, [...(picks.get(name) ?? []), `${Y}:${best.key} ${got.reduce((a, x) => a + x.r, 0).toFixed(0)}R`]);
      // the slots and sides of that setting's entries of the year, for the twins
      const idx = best.ts.map((x, i) => (yr(x.t) === Y ? i : -1)).filter((i) => i >= 0);
      slots.set(`${name}:${Y}`, idx.map((i) => best!.sl[i]));
    }
  }
  if (log) for (const [k, v] of picks) say(`  ${k.padEnd(12)} ${v.join(' · ')}`);
  return { all, picks, slots };
}

say('================ BANDE DE BRUIT : walk-forward 2022 → 2026 (marché et réglage choisis sur les années d’avant) ================');
say('\nFrais serrés (future micro ou CFD en heures principales) :');
const base = walk((m) => TIGHT[m.sym], true);
const by = new Map<string, Trade[]>();
for (const t of base.all) by.set(t.sym!, [...(by.get(t.sym!) ?? []), t]);
say('\nPar marché :');
for (const [k, v] of by) say(`  ${k.padEnd(12)} ${fmt(stat(v))} | ${years(v)}`);
say(`\nENSEMBLE  ${fmt(stat(base.all))}`);
say(`années : ${years(base.all)}`);
for (const [label, f] of [['frais × 2', (m: Market) => 2 * TIGHT[m.sym]], ['frais × 3', (m: Market) => 3 * TIGHT[m.sym]], ['frais du labo', (m: Market) => m.cost], ['sans frais', () => 0]] as [string, (m: Market) => number][]) {
  const w = walk(f);
  say(`${label.padEnd(14)} ${fmt(stat(w.all))} | ${years(w.all)}`);
}

// random twins of the walk-forward's trades: the same markets and years, as many entries on
// random days of that year at the same times of day and sides, held to the session's end
{
  const next = rng(4242);
  const real = stat(base.all).avg;
  let better = 0, mean = 0;
  const D = 200;
  for (let d = 0; d < D; d++) {
    let sum = 0, n = 0;
    for (const L of legs) {
      const name = `${L.m.sym}/${L.sk}`;
      for (let Y = 2022; Y <= 2026; Y++) {
        const like = base.slots.get(`${name}:${Y}`);
        if (!like?.length) continue;
        const days = L.se.days.map((x, i) => i).filter((i) => yr(L.b.t[L.se.days[i].idx[0]]) === Y);
        const cost = TIGHT[L.m.sym];
        for (const e of like) {
          const di = days[Math.floor(next() * days.length)], D0 = L.se.days[di];
          const unit = 1.25 * L.sig[di][L.se.slots - 1];
          const i0 = D0.idx[e.slot], i1 = D0.idx[L.se.slots - 1];
          if (i0 < 0 || !(unit > 0)) continue;
          sum += (e.dir * (L.b.c[i1] / L.b.c[i0] - 1) - 2 * cost) / unit; n++;
        }
      }
    }
    const a = sum / n;
    mean += a / D;
    if (a >= real) better++;
  }
  say(`\nJumeaux au hasard (mêmes marchés, années, heures, sens ; 200 tirages) : ${mean.toFixed(3)} R en moyenne ; aussi bons que le vrai : ${((100 * better) / D).toFixed(1)} %`);
}

// one fixed rule for everyone, no choice at all: k = 1, 30 min, held to the session's end
say('\n================ Règle fixe sans aucun choix (k = 1, 30 min, sortie fin de séance), frais serrés ================');
for (const L of MODE === 'fixe' ? legs : []) {
  const ts = nbTrades(L.b, L.se, L.sig, { k: 1, step: 2, exit: 'eod', side: 0, look: 14 }, TIGHT[L.m.sym]); resetSlots();
  say(`  ${(L.m.sym + '/' + L.sk).padEnd(12)} avant ${fmt(stat(isOf(ts)))} | après ${fmt(stat(oosOf(ts)))}`);
}
fs.mkdirSync('robots/pa', { recursive: true });
fs.writeFileSync(`robots/pa/walk-forward-${MODE}.txt`, lines.join('\n'));
fs.writeFileSync(`robots/pa/wf-trades-${MODE}.json`, JSON.stringify(base.all));
