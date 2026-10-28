import { type Ctx, type Family, type Order, type Variant } from './night-lib';

// The night lab's fifth batch: more of the levels traders watch. Monthly pivots, Fibonacci
// pivots, round numbers and the previous month's high / low, broken in the direction of
// the trend or not.

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);
const rT = (entry: number, stop: number, d: 1 | -1, k: number) => entry + d * k * Math.abs(entry - stop);

// the month of each bar's trading day, the previous month's high / low / close, the month's
// last bar, and the monthly trend (previous close against the average of `len` monthly closes)
function monthly(x: Ctx, len: number) {
  const key = `monthly:${len}`;
  const hit = x.cache.get(key) as ReturnType<typeof build> | undefined;
  if (hit) return hit;
  const r = build();
  x.cache.set(key, r);
  return r;
  function build() {
    const { b, n, day } = x;
    const mon = new Int32Array(n);
    for (let i = 0; i < n; i++) { const d = new Date(day[i] * 86400000); mon[i] = d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    const pmh = new Float64Array(n).fill(NaN), pml = new Float64Array(n).fill(NaN), pmc = new Float64Array(n).fill(NaN), trend = new Int8Array(n), monEnd = new Int32Array(n);
    let h = -Infinity, l = Infinity, lh = NaN, ll = NaN, lc = NaN;
    const closes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i && mon[i] !== mon[i - 1]) { lh = h; ll = l; lc = b.c[i - 1]; closes.push(lc); h = -Infinity; l = Infinity; }
      pmh[i] = lh; pml[i] = ll; pmc[i] = lc;
      if (closes.length >= len) { let s = 0; for (let k = closes.length - len; k < closes.length; k++) s += closes[k]; trend[i] = lc > s / len ? 1 : -1; }
      h = Math.max(h, b.h[i]); l = Math.min(l, b.l[i]);
    }
    for (let i = n - 1; i >= 0; i--) monEnd[i] = i === n - 1 || mon[i + 1] !== mon[i] ? i : monEnd[i + 1];
    return { mon, pmh, pml, pmc, trend, monEnd };
  }
}

// the daily trend: the previous day's close against the average of `len` daily closes
function dailyTrend(x: Ctx, len: number): Int8Array {
  const key = `dtrend:${len}`;
  const hit = x.cache.get(key) as Int8Array | undefined;
  if (hit) return hit;
  const out = new Int8Array(x.n);
  const closes: number[] = [];
  for (let i = 1; i < x.n; i++) {
    if (x.day[i] !== x.day[i - 1] && !Number.isNaN(x.pdc[i])) closes.push(x.pdc[i]);
    if (closes.length >= len) {
      let s = 0;
      for (let k = closes.length - len; k < closes.length; k++) s += closes[k];
      out[i] = x.pdc[i] > s / len ? 1 : -1;
    }
  }
  x.cache.set(key, out);
  return out;
}

export const MONTHLY_PIVOTS: Family = {
  id: 'pivmonth', label: 'Pivots mensuels cassés (sortie en fin de mois)', tfs: ['4h', '1d'],
  variants: () => {
    const out: Variant[] = [];
    for (const lvl of ['R1', 'R2', 'H4']) for (const len of [0, 6]) for (const side of SIDES) {
      out.push({
        key: `pivmonth|${lvl}|${len}|${side}`,
        label: `Cassure du pivot mensuel ${lvl === 'H4' ? 'Camarilla H4 / L4' : `${lvl} / S${lvl[1]}`} en clôture${len ? ' dans le sens de la tendance (moyenne 6 mois)' : ''} · stop au niveau d’avant · sortie en fin de mois${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, m = monthly(x, len || 6), od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = m.pmh[i], L = m.pml[i], C = m.pmc[i];
            if (Number.isNaN(H) || (len && !m.trend[i])) continue;
            const P = (H + L + C) / 3, rg = H - L;
            const up = lvl === 'R1' ? [2 * P - L, P] : lvl === 'R2' ? [P + rg, 2 * P - L] : [C + (1.1 * rg) / 2, C + (1.1 * rg) / 4];
            const dn = lvl === 'R1' ? [2 * P - H, P] : lvl === 'R2' ? [P - rg, 2 * P - H] : [C - (1.1 * rg) / 2, C - (1.1 * rg) / 4];
            if ((!len || m.trend[i] > 0) && sideOk(side, 1) && m.mon[i] !== doneL && b.c[i - 1] <= up[0] && b.c[i] > up[0]) {
              doneL = m.mon[i];
              od.push({ i, dir: 1, stop: up[1], target: NaN, exitAt: m.monEnd[i] });
            }
            if ((!len || m.trend[i] < 0) && sideOk(side, -1) && m.mon[i] !== doneS && b.c[i - 1] >= dn[0] && b.c[i] < dn[0]) {
              doneS = m.mon[i];
              od.push({ i, dir: -1, stop: dn[1], target: NaN, exitAt: m.monEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// Fibonacci pivots: P ± 0.382, 0.618 and 1 × the previous day's range
export const FIB_PIVOTS: Family = {
  id: 'pivfib', label: 'Pivots de Fibonacci journaliers cassés', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const k of [1, 2, 3]) for (const len of [0, 50]) for (const tg of ['eod', '2R']) for (const side of SIDES) {
      out.push({
        key: `pivfib|${k}|${len}|${tg}|${side}`,
        label: `Cassure du pivot de Fibonacci R${k} / S${k} (P ± ${[0.382, 0.618, 1][k - 1]} × range de la veille) en clôture${len ? ' dans le sens de la tendance (50 jours)' : ''} · stop au niveau d’avant · ${tg === 'eod' ? 'sortie en fin de journée' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, tr = len ? dailyTrend(x, len) : null, od: Order[] = [];
          const f = [0, 0.382, 0.618, 1];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = x.pdh[i], L = x.pdl[i], C = x.pdc[i];
            if (Number.isNaN(H) || (tr && !tr[i])) continue;
            const P = (H + L + C) / 3, rg = H - L;
            const u = P + f[k] * rg, us = P + f[k - 1] * rg, v = P - f[k] * rg, vs = P - f[k - 1] * rg;
            if ((!tr || tr[i] > 0) && sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] <= u && b.c[i] > u) {
              doneL = x.day[i];
              od.push({ i, dir: 1, stop: us, target: tg === 'eod' ? NaN : rT(b.c[i], us, 1, 2), exitAt: x.dayEnd[i] });
            }
            if ((!tr || tr[i] < 0) && sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] >= v && b.c[i] < v) {
              doneS = x.day[i];
              od.push({ i, dir: -1, stop: vs, target: tg === 'eod' ? NaN : rT(b.c[i], vs, -1, 2), exitAt: x.dayEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// round numbers: a step of a tenth (or half) of the price's power of ten (BTC 80 000:
// 1 000 / 5 000; EURUSD 1.14: 0.01 / 0.05); the first close across one that day
export const ROUND_NUMBERS: Family = {
  id: 'round', label: 'Cassure des chiffres ronds', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const big of [0, 1]) for (const len of [0, 50]) for (const tg of ['eod', '2R']) for (const side of SIDES) {
      out.push({
        key: `round|${big}|${len}|${tg}|${side}`,
        label: `Clôture au-delà d’un chiffre rond (${big ? 'demi-puissance de 10, ex. BTC 5 000, EURUSD 0,05' : 'dixième de puissance de 10, ex. BTC 1 000, EURUSD 0,01'})${len ? ' dans le sens de la tendance (50 jours)' : ''} · stop 1,5 ATR · ${tg === 'eod' ? 'sortie en fin de journée' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, tr = len ? dailyTrend(x, len) : null, od: Order[] = [];
          let done = -1;
          for (let i = x.start; i < x.n; i++) {
            if (x.day[i] === done || (tr && !tr[i])) continue;
            const step = Math.pow(10, Math.floor(Math.log10(b.c[i - 1])) - 1) * (big ? 5 : 1);
            const lvl = Math.ceil(b.c[i - 1] / step) * step;
            const lvlDn = Math.floor(b.c[i - 1] / step) * step;
            const up = b.c[i] > lvl && b.c[i - 1] <= lvl, dn = b.c[i] < lvlDn && b.c[i - 1] >= lvlDn;
            if (!up && !dn) continue;
            const d: 1 | -1 = up ? 1 : -1;
            if ((tr && tr[i] !== d) || !sideOk(side, d)) continue;
            done = x.day[i];
            const stop = b.c[i] - d * 1.5 * atr[i];
            od.push({ i, dir: d, stop, target: tg === 'eod' ? NaN : rT(b.c[i], stop, d, 2), exitAt: x.dayEnd[i] });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// the previous month's high / low broken in close: that way, a chandelier stop of 3 ATR
export const PREV_MONTH: Family = {
  id: 'pmhl', label: 'Cassure du plus haut / plus bas du mois précédent (stop suiveur)', tfs: ['4h', '1d'],
  variants: () => {
    const out: Variant[] = [];
    for (const len of [0, 6]) for (const trail of [3, 4]) for (const side of SIDES) {
      out.push({
        key: `pmhl|${len}|${trail}|${side}`,
        label: `Clôture au-delà du plus haut (bas) du mois précédent${len ? ' dans le sens de la tendance (6 mois)' : ''} · stop initial et suiveur ${trail} ATR${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, m = monthly(x, len || 6), od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = m.pmh[i], L = m.pml[i];
            if (Number.isNaN(H) || (len && !m.trend[i])) continue;
            if ((!len || m.trend[i] > 0) && sideOk(side, 1) && m.mon[i] !== doneL && b.c[i - 1] <= H && b.c[i] > H) {
              doneL = m.mon[i];
              od.push({ i, dir: 1, stop: b.c[i] - trail * atr[i], target: NaN, trail });
            }
            if ((!len || m.trend[i] < 0) && sideOk(side, -1) && m.mon[i] !== doneS && b.c[i - 1] >= L && b.c[i] < L) {
              doneS = m.mon[i];
              od.push({ i, dir: -1, stop: b.c[i] + trail * atr[i], target: NaN, trail });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_5: Record<string, Family> = { pivmonth: MONTHLY_PIVOTS, pivfib: FIB_PIVOTS, round: ROUND_NUMBERS, pmhl: PREV_MONTH };
