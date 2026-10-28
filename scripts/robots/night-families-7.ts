import { type Ctx, type Family, type Order, type Variant } from './night-lib';

// The night lab's seventh batch: the volatility breakout on the week (the week's open ± k ×
// the previous week's range, out at the week's end), and other exits for the daily one
// (the day's end, the next day's end, a trailing stop).

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);

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

// the week's open, the previous week's close, its last bar, and the weekly trend (the
// previous week's close against the average of `len` weekly closes)
function weekInfo(x: Ctx, len: number) {
  const key = `wk:${len}`;
  const hit = x.cache.get(key) as { wOpen: Float64Array; trend: Int8Array; wEnd: Int32Array } | undefined;
  if (hit) return hit;
  const { b, n, week } = x;
  const wOpen = new Float64Array(n).fill(NaN), trend = new Int8Array(n), wEnd = new Int32Array(n);
  const closes: number[] = [];
  let open = NaN;
  for (let i = 0; i < n; i++) {
    if (i === 0 || week[i] !== week[i - 1]) { if (i) closes.push(b.c[i - 1]); open = b.o[i]; }
    wOpen[i] = open;
    if (closes.length >= len) {
      let s = 0;
      for (let k = closes.length - len; k < closes.length; k++) s += closes[k];
      trend[i] = closes[closes.length - 1] > s / len ? 1 : -1;
    }
  }
  for (let i = n - 1; i >= 0; i--) wEnd[i] = i === n - 1 || week[i + 1] !== week[i] ? i : wEnd[i + 1];
  const r = { wOpen, trend, wEnd };
  x.cache.set(key, r);
  return r;
}

export const WEEKLY_VB: Family = {
  id: 'wvb', label: 'Cassure de volatilité hebdomadaire (sortie en fin de semaine)', tfs: ['1h', '4h'],
  variants: () => {
    const out: Variant[] = [];
    for (const k of [0.3, 0.5, 0.7]) for (const len of [0, 10]) for (const side of SIDES) {
      out.push({
        key: `wvb|${k}|${len}|${side}`,
        label: `Clôture au-delà de l’ouverture de la semaine ± ${k} × range de la semaine d’avant${len ? ' dans le sens de la tendance (10 semaines)' : ''} · stop à l’ouverture de la semaine · sortie en fin de semaine${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, w = weekInfo(x, len || 10), od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = x.pwh[i], L = x.pwl[i], O = w.wOpen[i];
            if (Number.isNaN(H) || x.week[i - 1] !== x.week[i] || (len && !w.trend[i])) continue;
            const up = O + k * (H - L), dn = O - k * (H - L);
            if ((!len || w.trend[i] > 0) && sideOk(side, 1) && x.week[i] !== doneL && b.c[i - 1] <= up && b.c[i] > up) {
              doneL = x.week[i];
              od.push({ i, dir: 1, stop: O, target: NaN, exitAt: w.wEnd[i] });
            }
            if ((!len || w.trend[i] < 0) && sideOk(side, -1) && x.week[i] !== doneS && b.c[i - 1] >= dn && b.c[i] < dn) {
              doneS = x.week[i];
              od.push({ i, dir: -1, stop: O, target: NaN, exitAt: w.wEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// the daily breakout (open + k × the previous day's range, the trend of 50 days, buys), with other exits
export const VB_EXITS: Family = {
  id: 'vbexit', label: 'Cassure de volatilité journalière : autres sorties', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const k of [0.3, 0.5]) for (const ex of ['eod', 'next', 'trail2', 'trail4', 'be']) {
      out.push({
        key: `vbexit|${k}|${ex}`,
        label: `Cassure de volatilité (ouverture + ${k} × range de la veille, tendance 50 jours, achats) · ${ex === 'eod' ? 'sortie en fin de journée' : ex === 'next' ? 'sortie en fin du jour suivant' : ex === 'be' ? 'sortie en fin de journée, mais stop suiveur à 2 ATR si le trade gagne' : `stop suiveur ${ex === 'trail2' ? 2 : 4} ATR, 2 jours au plus`}`,
        orders: (x) => {
          const { b } = x, tr = dailyTrend(x, 50), od: Order[] = [];
          let done = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = x.pdh[i], L = x.pdl[i], O = x.dOpen[i];
            if (Number.isNaN(H) || tr[i] <= 0 || x.day[i - 1] !== x.day[i] || x.day[i] === done) continue;
            const up = O + k * (H - L);
            if (!(b.c[i - 1] <= up && b.c[i] > up)) continue;
            done = x.day[i];
            const end = x.dayEnd[i];
            const nextEnd = end + 1 < x.n ? x.dayEnd[end + 1] : end;
            if (ex === 'eod') od.push({ i, dir: 1, stop: O, target: NaN, exitAt: end });
            else if (ex === 'next') od.push({ i, dir: 1, stop: O, target: NaN, exitAt: nextEnd });
            else if (ex === 'be') od.push({ i, dir: 1, stop: O, target: NaN, exitAt: end, trail: 2 });
            else od.push({ i, dir: 1, stop: O, target: NaN, exitAt: nextEnd, trail: ex === 'trail2' ? 2 : 4 });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_7: Record<string, Family> = { wvb: WEEKLY_VB, vbexit: VB_EXITS };
