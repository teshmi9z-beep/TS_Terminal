import { toBars } from '../../src/robots/features';
import { simulate, applyMoney } from '../../src/robots/engine';

// Hand-made bars whose result is known: a long entered at 100 with a 10 risk.
// A (target 1 R) +1; C: 1/3 at 110, 1/3 at 120, last third stopped at +1 R (110) = 4/3;
// B: stop at +1 R after 120, then the ATR trail (2 x 1 under the 120 close) = 118 -> +1.8
const rows = [
  [-1, 100, 100, 100, 100, 1],
  [0, 100, 100, 100, 100, 1],
  [1, 100, 105, 99, 104, 1],
  [2, 104, 112, 103, 111, 1],
  [3, 111, 121, 110, 120, 1],
  [4, 120, 120, 105, 106, 1],
  [5, 106, 107, 100, 101, 1],
];
const b = toBars(rows);
const n = b.n;
const sig = new Int8Array(n); sig[1] = 1;
const ones = new Uint8Array(n).fill(1);
const stop = new Float64Array(n).fill(10);
const atr = new Float64Array(n).fill(1);
const trades = simulate(b, { sig, allowLong: ones, allowShort: ones, stopLong: stop, stopShort: stop, dir: 0, legs: { tpR: 1, trailK: 2 }, cost: 0, atr, warmup: 0 });
const got = trades.map((t) => `${'ABC'[t.leg]} ${t.r.toFixed(3)} ${t.reason} sortie barre ${t.exitIdx}`);
console.log(got.join('\n'));
const ok = Math.abs(trades[0].r - 1) < 1e-9 && Math.abs(trades[1].r - 1.8) < 1e-9 && Math.abs(trades[2].r - 4 / 3) < 1e-9;
console.log(ok ? 'OK' : 'ÉCHEC');

// a short stopped by a gap: entry 100, risk 10, opens at 115 -> -1.5 R on every leg
const rows2 = [[-1, 100, 100, 100, 100, 1], [0, 100, 100, 100, 100, 1], [1, 100, 101, 97, 100, 1], [2, 115, 116, 114, 115, 1], [3, 115, 115, 115, 115, 1]];
const b2 = toBars(rows2);
const sig2 = new Int8Array(5); sig2[1] = -1;
const t2 = simulate(b2, { sig: sig2, allowLong: new Uint8Array(5).fill(1), allowShort: new Uint8Array(5).fill(1), stopLong: new Float64Array(5).fill(10), stopShort: new Float64Array(5).fill(10), dir: 0, legs: { tpR: 1.5, trailK: 3 }, cost: 0, atr: new Float64Array(5).fill(1), warmup: 0 });
console.log(t2.map((t) => `${'ABC'[t.leg]} ${t.r.toFixed(3)} ${t.reason}`).join(' | '), t2.every((t) => Math.abs(t.r + 1.5) < 1e-9) ? 'OK' : 'ÉCHEC');

// money: 0.3 % of 10 000 = 30 € per entry -> (1 + 1.8 + 4/3) x 30 = 124 €
const m = applyMoney(trades, 'fixed');
console.log(`argent ${m.netProfit.toFixed(2)} €`, Math.abs(m.netProfit - (30 + 30.09 * 1.8 + 30.1452 * 4 / 3)) < 1 ? 'OK' : 'à vérifier');
