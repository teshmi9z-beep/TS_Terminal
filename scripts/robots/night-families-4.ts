import { type Ctx, type Family, type Order, type Variant } from './night-lib';

// The night lab's fourth batch: does "a level broken in the direction of the trend" work
// beyond crypto's daily pivots? Weekly pivots with the weekly trend, the previous day's
// high / low with the daily trend, and ICT's power of three around the midnight open.

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);
const rT = (entry: number, stop: number, d: 1 | -1, k: number) => entry + d * k * Math.abs(entry - stop);

// the previous week's close and the side of the weekly trend (previous close against the
// average of the last `len` weekly closes), and the last bar of each week
function weekly(x: Ctx, len: number): { pwc: Float64Array; trend: Int8Array; weekEnd: Int32Array } {
  const key = `weekly:${len}`;
  const hit = x.cache.get(key) as ReturnType<typeof weekly> | undefined;
  if (hit) return hit;
  const { b, n, week } = x;
  const pwc = new Float64Array(n).fill(NaN), trend = new Int8Array(n), weekEnd = new Int32Array(n);
  const closes: number[] = [];
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (i && week[i] !== week[i - 1]) { last = b.c[i - 1]; closes.push(last); }
    pwc[i] = last;
    if (closes.length >= len) {
      let s = 0;
      for (let k = closes.length - len; k < closes.length; k++) s += closes[k];
      trend[i] = last > s / len ? 1 : -1;
    }
  }
  for (let i = n - 1; i >= 0; i--) weekEnd[i] = i === n - 1 || week[i + 1] !== week[i] ? i : weekEnd[i + 1];
  const r = { pwc, trend, weekEnd };
  x.cache.set(key, r);
  return r;
}

export const WEEKLY_PIVOTS: Family = {
  id: 'pivweek', label: 'Pivots hebdomadaires cassés dans le sens de la tendance hebdomadaire', tfs: ['1h', '4h'],
  variants: () => {
    const out: Variant[] = [];
    for (const lvl of ['R1', 'R2', 'H4']) for (const len of [0, 10, 20]) for (const tg of ['eow', '2R']) for (const side of SIDES) {
      out.push({
        key: `pivweek|${lvl}|${len}|${tg}|${side}`,
        label: `Cassure du pivot hebdomadaire ${lvl === 'H4' ? 'Camarilla H4 / L4' : `${lvl} / S${lvl[1]}`} en clôture${len ? ` dans le sens de la tendance (clôture de la semaine d’avant / moyenne ${len} semaines)` : ''} · stop au niveau d’avant · ${tg === 'eow' ? 'sortie en fin de semaine' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, w = weekly(x, len || 10), od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = x.pwh[i], L = x.pwl[i], C = w.pwc[i];
            if (Number.isNaN(H) || Number.isNaN(C)) continue;
            const t = len ? w.trend[i] : 0;
            if (len && !t) continue;
            const P = (H + L + C) / 3, rg = H - L;
            const up = lvl === 'R1' ? [2 * P - L, P] : lvl === 'R2' ? [P + rg, 2 * P - L] : [C + (1.1 * rg) / 2, C + (1.1 * rg) / 4];
            const dn = lvl === 'R1' ? [2 * P - H, P] : lvl === 'R2' ? [P - rg, 2 * P - H] : [C - (1.1 * rg) / 2, C - (1.1 * rg) / 4];
            if ((!len || t > 0) && sideOk(side, 1) && x.week[i] !== doneL && b.c[i - 1] <= up[0] && b.c[i] > up[0]) {
              doneL = x.week[i];
              od.push({ i, dir: 1, stop: up[1], target: tg === 'eow' ? NaN : rT(b.c[i], up[1], 1, 2), exitAt: w.weekEnd[i] });
            }
            if ((!len || t < 0) && sideOk(side, -1) && x.week[i] !== doneS && b.c[i - 1] >= dn[0] && b.c[i] < dn[0]) {
              doneS = x.week[i];
              od.push({ i, dir: -1, stop: dn[1], target: tg === 'eow' ? NaN : rT(b.c[i], dn[1], -1, 2), exitAt: w.weekEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// the side of the daily trend: the previous day's close against the average of `len` daily closes
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

export const PD_TREND: Family = {
  id: 'pdtrend', label: 'Cassure du plus haut / plus bas de la veille dans le sens de la tendance', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const len of [20, 50]) for (const st of ['bar', 'mid']) for (const tg of ['eod', '2R']) for (const side of SIDES) {
      out.push({
        key: `pdtrend|${len}|${st}|${tg}|${side}`,
        label: `Cassure en clôture du plus haut (bas) de la veille dans le sens de la tendance (moyenne ${len} jours) · stop ${st === 'bar' ? 'sous la bougie' : 'au milieu du range de la veille'} · ${tg === 'eod' ? 'sortie en fin de journée' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, tr = dailyTrend(x, len), od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = x.pdh[i], L = x.pdl[i];
            if (Number.isNaN(H) || !tr[i]) continue;
            const pad = 0.1 * atr[i];
            if (tr[i] > 0 && sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] <= H && b.c[i] > H) {
              doneL = x.day[i];
              const stop = st === 'bar' ? b.l[i] - pad : (H + L) / 2;
              od.push({ i, dir: 1, stop, target: tg === 'eod' ? NaN : rT(b.c[i], stop, 1, 2), exitAt: x.dayEnd[i] });
            }
            if (tr[i] < 0 && sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] >= L && b.c[i] < L) {
              doneS = x.day[i];
              const stop = st === 'bar' ? b.h[i] + pad : (H + L) / 2;
              od.push({ i, dir: -1, stop, target: tg === 'eod' ? NaN : rT(b.c[i], stop, -1, 2), exitAt: x.dayEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ICT power of three: between midnight and 7:00 New York the price goes at least `depth` ATR
// under the midnight open (the manipulation); in New York's kill zone (7:00-11:00) the first
// close back above it is bought, the stop under the night's low (the mirror for sells)
export const POWER_OF_THREE: Family = {
  id: 'po3', label: 'ICT Power of 3 : manipulation sous l’ouverture de minuit, reprise à New York', tfs: ['5m', '15m'],
  variants: () => {
    const out: Variant[] = [];
    for (const depth of [1, 3]) for (const len of [0, 20]) for (const tg of ['2R', 'eod', 'pd']) for (const side of SIDES) {
      out.push({
        key: `po3|${depth}|${len}|${tg}|${side}`,
        label: `Le prix passe d’au moins ${depth} ATR sous (sur) l’ouverture de minuit NY avant 7 h, puis la première clôture de retour entre 7 h et 11 h NY${len ? ` dans le sens de la tendance (${len} jours)` : ''} · stop au-delà de l’extrême de la nuit · ${tg === '2R' ? 'objectif 2 R' : tg === 'eod' ? 'sortie en fin de journée' : 'objectif au plus haut (bas) de la veille'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, tr = len ? dailyTrend(x, len) : null, od: Order[] = [];
          let date = -1, lo = Infinity, hi = -Infinity, done = false;
          for (let i = x.start; i < x.n; i++) {
            if (x.nyDate[i] !== date) { date = x.nyDate[i]; lo = Infinity; hi = -Infinity; done = false; }
            const s = x.ny[i] / 3600, mo = x.midOpen[i];
            if (s < 7) { lo = Math.min(lo, b.l[i]); hi = Math.max(hi, b.h[i]); continue; }
            if (done || s >= 11 || Number.isNaN(mo)) continue;
            const pad = 0.1 * atr[i];
            const upOk = mo - lo >= depth * atr[i] && b.c[i] > mo && b.c[i - 1] <= mo && (!tr || tr[i] > 0);
            const dnOk = hi - mo >= depth * atr[i] && b.c[i] < mo && b.c[i - 1] >= mo && (!tr || tr[i] < 0);
            if (!upOk && !dnOk) continue;
            done = true;
            const d: 1 | -1 = upOk ? 1 : -1;
            if (!sideOk(side, d)) continue;
            const stop = d > 0 ? lo - pad : hi + pad;
            const target = tg === '2R' ? rT(b.c[i], stop, d, 2) : tg === 'pd' ? (d > 0 ? x.pdh[i] : x.pdl[i]) : NaN;
            od.push({ i, dir: d, stop, target, exitAt: x.dayEnd[i] });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_4: Record<string, Family> = { pivweek: WEEKLY_PIVOTS, pdtrend: PD_TREND, po3: POWER_OF_THREE };
