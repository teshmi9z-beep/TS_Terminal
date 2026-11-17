import fs from 'node:fs';
import {
  daily, fmt, isOf, load15, MARKETS, nbKey, nbTrades, noise, oosOf, resetSlots, rng, sessions, SESSIONS, SESSIONS_OF, stat, trendTrade, trendTrades, trKey, years,
  type Cls, type Daily, type Market, type NbSet, type Trade, type TrSet,
} from './pa-lib';

// node robots/.build/pa-study.mjs [nb] [trend] [fx] : the grids of the price-action study.
const what = process.argv.slice(2);
const run = (k: string) => !what.length || what.includes(k);
const lines: string[] = [];
const say = (s = '') => { console.log(s); lines.push(s); };
const CLS: Cls[] = ['Index', 'Forex', 'Commodity'];
const Y2020 = Date.UTC(2020, 0, 1) / 1000;

const data = MARKETS.map((m) => ({ m, b: load15(m) }));
say(`marchés : ${data.map((x) => x.m.sym).join(' ')}`);

// ------------------------------------------------------------------ 1. the noise band
if (run('nb')) {
  const sets: NbSet[] = [];
  for (const k of [0.75, 1, 1.25, 1.5]) for (const step of [1, 2]) for (const exit of ['band', 'open', 'eod'] as const) for (const side of [0, 1, -1] as const) sets.push({ k, step, exit, side, look: 14 });
  // group: class + session (+ futures costs for the markets that have a future)
  type G = { name: string; runs: { m: Market; cost: number; res: Map<string, Trade[]> }[] };
  const groups = new Map<string, G>();
  for (const { m, b } of data) {
    for (const sk of SESSIONS_OF(m)) {
      const se = sessions(b, SESSIONS[sk]);
      const sig = noise(b, se, 14);
      for (const fut of [false, true]) {
        if (fut && !m.costFut) continue;
        const cost = fut ? m.costFut! : m.cost;
        const gk = `${m.cls}/${m.cls === 'Index' ? (['us', 'eu'].includes(sk) ? 'us+eu' : 'asie') : sk}${fut ? '/future' : ''}`;
        const g = groups.get(gk) ?? groups.set(gk, { name: gk, runs: [] }).get(gk)!;
        const res = new Map<string, Trade[]>();
        for (const s of sets) { res.set(nbKey(s), nbTrades(b, se, sig, s, cost).map((t) => ({ ...t, sym: m.sym }))); resetSlots(); }
        g.runs.push({ m, cost, res });
      }
    }
  }
  say('\n================ 1. BANDE DE BRUIT (momentum intraday), 15 min ================');
  const keep: string[] = [];
  for (const g of groups.values()) {
    say(`\n--- ${g.name} : ${g.runs.map((r) => r.m.sym).join(' ')}`);
    const rows = sets.map((s) => {
      const key = nbKey(s), all = g.runs.flatMap((r) => r.res.get(key)!);
      const a = stat(isOf(all)), o = stat(oosOf(all));
      const posM = g.runs.filter((r) => stat(oosOf(r.res.get(key)!)).avg > 0 && stat(isOf(r.res.get(key)!)).avg > 0).length;
      return { key, a, o, posM, all };
    });
    const ok = rows.filter((r) => r.a.avg > 0 && r.o.avg > 0);
    say(`réglages positifs avant ET après : ${ok.length} / ${rows.length} ; positifs avant : ${rows.filter((r) => r.a.avg > 0).length}`);
    rows.sort((x, y) => y.a.t - x.a.t);
    for (const r of rows.slice(0, 6)) {
      say(`${r.key.padEnd(24)} avant ${fmt(r.a)} | après ${fmt(r.o)} | marchés + ${r.posM}/${g.runs.length}`);
      if (r.a.t > 2 && r.o.avg > 0) keep.push(`${g.name} ${r.key} : ${years(r.all)}`);
    }
  }
  say('\nAnnées des réglages t > 2 avant et positifs après :');
  for (const k of keep) say(k);
}

// ------------------------------------------------------------------ 2. daily trend following
const days = new Map<string, Daily>();
for (const { m, b } of data) days.set(m.sym, daily(b));
if (run('trend')) {
  say('\n================ 2. TENDANCE JOURNALIÈRE (Donchian, stop 2,5 ATR, financement CFD compté) ================');
  const sets: TrSet[] = [];
  for (const n of [20, 55, 100]) for (const exit of ['half', 'trail3', 'trail5'] as const) for (const side of [1, -1] as const) sets.push({ n, exit, side });
  for (const cls of CLS) {
    const ms = data.filter((x) => x.m.cls === cls);
    say(`\n--- ${cls} : ${ms.map((x) => x.m.sym).join(' ')}`);
    for (const s of sets) {
      const per = ms.map(({ m }) => trendTrades(days.get(m.sym)!, s, m, m.cost));
      const all = per.flat();
      // random twins: the same number of entries per market on random days, same side and exit
      const next = rng(777);
      let better = 0;
      const D = 100, real = stat(all).avg;
      let tw = 0;
      for (let k = 0; k < D; k++) {
        let sum = 0, cnt = 0;
        ms.forEach(({ m }, mi) => {
          const d = days.get(m.sym)!;
          const first = d.t.findIndex((t) => t >= Y2020);
          for (let q = 0; q < per[mi].length; q++) {
            const i = first + Math.floor(next() * (d.n - 2 - first));
            const r = trendTrade(d, i, s.side, s, m, m.cost)?.tr.r;
            if (r !== undefined) { sum += r; cnt++; }
          }
        });
        const a = cnt ? sum / cnt : 0;
        tw += a / D;
        if (a >= real) better++;
      }
      say(`${trKey(s).padEnd(18)} avant ${fmt(stat(isOf(all)))} | après ${fmt(stat(oosOf(all)))} | hasard ${(tw >= 0 ? '+' : '') + tw.toFixed(3)} R, aussi bon ${better}% | ${years(all)}`);
    }
  }
}

// ------------------------------------------------------------------ 3. relative strength of the 8 major currencies
if (run('fx')) {
  say('\n================ 3. FORCE RELATIVE DES 8 DEVISES (journalier) ================');
  const pairs = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'];
  // each currency's log price in dollars, on the common days
  const ds = pairs.map((p) => days.get(p)!);
  const sets = ds.map((d) => { const mp = new Map<number, number>(); d.t.forEach((t, i) => mp.set(t, i)); return mp; });
  const common = [...ds[0].t].filter((t) => sets.every((s) => s.has(t)));
  const cur = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'USD'];
  const lp = cur.map((_, ci) => common.map((t) => (ci === 7 ? 0 : (pairs[ci].startsWith('USD') ? -1 : 1) * Math.log(ds[ci].c[sets[ci].get(t)!]))));
  const n = common.length;
  for (const sign of [1, -1]) for (const N of [1, 5, 20, 60, 120]) for (const Hd of [1, 5, 20]) {
    const ts: Trade[] = [];
    for (let k = Math.max(N, 61); k + Hd < n; k += Hd) {
      if (common[k] < Y2020) continue;
      const mom = lp.map((s) => s[k] - s[k - N]);
      const order = cur.map((_, i) => i).sort((a, z) => mom[z] - mom[a]);
      const top = sign > 0 ? order[0] : order[7], bot = sign > 0 ? order[7] : order[0];
      const spread = (j: number) => lp[top][j] - lp[bot][j];
      // the risk unit: the spread's daily moves over 60 days, over the holding time
      let v = 0;
      for (let j = k - 59; j <= k; j++) v += (spread(j) - spread(j - 1)) ** 2;
      const unit = Math.sqrt(v / 60) * Math.sqrt(Hd);
      // two dollar legs (one when the dollar is in the pair) at 0.01 % a side, 1 % a year of financing
      const legs = top === 7 || bot === 7 ? 1 : 2;
      const cost = 2 * 0.0001 * legs + (0.01 / 365) * Hd * 1.4 * legs;
      ts.push({ t: common[k] + 86400, dir: 1, r: (spread(k + Hd) - spread(k) - cost) / unit, costR: cost / unit, day: common[k] / 86400 });
    }
    say(`${sign > 0 ? 'suivre' : 'contrer'} ${String(N).padStart(3)} j, tenu ${String(Hd).padStart(2)} j  avant ${fmt(stat(isOf(ts)))} | après ${fmt(stat(oosOf(ts)))}`);
  }
}
fs.mkdirSync('robots/pa', { recursive: true });
fs.writeFileSync(`robots/pa/etude-${what.join('-') || 'tout'}.txt`, lines.join('\n'));
