import { fmt, isOf, load15, MARKETS, nbKey, nbTrades, noise, oosOf, resetSlots, sessions, SESSIONS, SESSIONS_OF, stat, years, type NbSet } from './pa-lib';

// The noise band before costs, market by market: where the raw effect is, if anywhere.
// node robots/.build/pa-gross.mjs [cost multiplier, 0 by default]
const mult = Number(process.argv[2] ?? 0);
const sets: NbSet[] = [
  { k: 1, step: 2, exit: 'eod', side: 0, look: 14 }, { k: 1, step: 2, exit: 'band', side: 0, look: 14 },
  { k: 1.5, step: 2, exit: 'eod', side: 0, look: 14 }, { k: 1.5, step: 2, exit: 'open', side: 0, look: 14 },
];
for (const m of MARKETS) {
  const b = load15(m);
  for (const sk of SESSIONS_OF(m)) {
    const se = sessions(b, SESSIONS[sk]);
    const sig = noise(b, se, 14);
    console.log(`\n${m.sym} / ${sk}  (${se.days.length} séances)`);
    for (const s of sets) {
      const ts = nbTrades(b, se, sig, s, m.cost * mult); resetSlots();
      const cost = ts.length ? ts.reduce((a, t) => a + (mult ? t.costR / mult : 0), 0) / ts.length : 0;
      console.log(`  ${nbKey(s).padEnd(22)} avant ${fmt(stat(isOf(ts)))} | après ${fmt(stat(oosOf(ts)))} | ${years(ts)}${mult ? ` | frais labo ${cost.toFixed(3)} R` : ''}`);
    }
  }
}
