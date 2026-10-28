import { sessionRange, type Ctx, type Family, type Order, type Variant } from './night-lib';

// The night lab's sixth batch: Larry Williams' volatility breakout from the day's open,
// intraday dips bought in a daily uptrend, Monday's range broken for the week, and the Asian
// range broken in London in the direction of the daily trend.

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);
const rT = (entry: number, stop: number, d: 1 | -1, k: number) => entry + d * k * Math.abs(entry - stop);

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

// ---------------------------------------------------------------- volatility breakout
// the day's open ± k × the previous day's range; the stop at the open, out by the day's end
export const VOL_BREAKOUT: Family = {
  id: 'lwvb', label: 'Cassure de volatilité (ouverture du jour ± k × range de la veille)', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const k of [0.3, 0.5, 0.7]) for (const len of [0, 20, 50]) for (const tg of ['eod', '2R']) for (const side of SIDES) {
      out.push({
        key: `lwvb|${k}|${len}|${tg}|${side}`,
        label: `Clôture au-delà de l’ouverture du jour ± ${k} × range de la veille${len ? ` dans le sens de la tendance (${len} jours)` : ''} · stop à l’ouverture du jour · ${tg === 'eod' ? 'sortie en fin de journée' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, tr = len ? dailyTrend(x, len) : null, od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            const H = x.pdh[i], L = x.pdl[i], O = x.dOpen[i];
            if (Number.isNaN(H) || (tr && !tr[i]) || x.day[i - 1] !== x.day[i]) continue;
            const up = O + k * (H - L), dn = O - k * (H - L);
            if ((!tr || tr[i] > 0) && sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] <= up && b.c[i] > up) {
              doneL = x.day[i];
              od.push({ i, dir: 1, stop: O, target: tg === 'eod' ? NaN : rT(b.c[i], O, 1, 2), exitAt: x.dayEnd[i] });
            }
            if ((!tr || tr[i] < 0) && sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] >= dn && b.c[i] < dn) {
              doneS = x.day[i];
              od.push({ i, dir: -1, stop: O, target: tg === 'eod' ? NaN : rT(b.c[i], O, -1, 2), exitAt: x.dayEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- dips in a daily uptrend
// RSI 2 of the bars under `lvl` while the previous day closed over its average: buy, stop
// 2 ATR, out after `hold` bars (the mirror for sells in a downtrend)
function rsi2(x: Ctx): Float64Array {
  const hit = x.cache.get('rsi2') as Float64Array | undefined;
  if (hit) return hit;
  const { c } = x.b, out = new Float64Array(x.n).fill(NaN);
  let up = 0, dn = 0;
  for (let i = 1; i < x.n; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= 2) { up += u / 2; dn += w / 2; } else { up = (up + u) / 2; dn = (dn + w) / 2; }
    if (i >= 2) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  x.cache.set('rsi2', out);
  return out;
}
export const TREND_DIPS: Family = {
  id: 'dip', label: 'Repli intraday acheté dans une tendance journalière (RSI 2)', tfs: ['1h', '4h'],
  variants: (tf) => {
    const out: Variant[] = [];
    const holds = tf === '4h' ? [3, 6] : [6, 24];
    for (const lvl of [5, 10]) for (const len of [20, 50]) for (const hold of holds) for (const side of SIDES) {
      out.push({
        key: `dip|${lvl}|${len}|${hold}|${side}`,
        label: `RSI 2 sous ${lvl} (au-dessus de ${100 - lvl}) dans une tendance journalière haussière (baissière), moyenne ${len} jours · stop 2 ATR · ${hold} bougies au plus${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, r = rsi2(x), tr = dailyTrend(x, len), od: Order[] = [];
          for (let i = x.start; i < x.n; i++) {
            const d: 1 | -1 | 0 = tr[i] > 0 && r[i] < lvl ? 1 : tr[i] < 0 && r[i] > 100 - lvl ? -1 : 0;
            if (!d || !sideOk(side, d)) continue;
            od.push({ i, dir: d, stop: b.c[i] - d * 2 * atr[i], target: NaN, maxBars: hold });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- Monday's range
// the high / low of the week's first trading day; the first close beyond it later that week:
// that way, the stop at the other side (or the middle), out at the week's end
function weekEnds(x: Ctx): Int32Array {
  const hit = x.cache.get('weekEnd') as Int32Array | undefined;
  if (hit) return hit;
  const out = new Int32Array(x.n);
  for (let i = x.n - 1; i >= 0; i--) out[i] = i === x.n - 1 || x.week[i + 1] !== x.week[i] ? i : out[i + 1];
  x.cache.set('weekEnd', out);
  return out;
}
export const MONDAY_RANGE: Family = {
  id: 'monday', label: 'Cassure du range du lundi (sortie en fin de semaine)', tfs: ['1h', '4h'],
  variants: () => {
    const out: Variant[] = [];
    for (const st of ['opp', 'mid']) for (const len of [0, 20]) for (const side of SIDES) {
      out.push({
        key: `monday|${st}|${len}|${side}`,
        label: `Clôture au-delà du plus haut (bas) du premier jour de la semaine${len ? ' dans le sens de la tendance (20 jours)' : ''} · stop ${st === 'opp' ? 'à l’autre bord' : 'au milieu'} · sortie en fin de semaine${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, we = weekEnds(x), tr = len ? dailyTrend(x, len) : null, od: Order[] = [];
          let wk = -1, firstDay = -1, hi = -Infinity, lo = Infinity, done = false;
          for (let i = x.start; i < x.n; i++) {
            if (x.week[i] !== wk) { wk = x.week[i]; firstDay = x.day[i]; hi = -Infinity; lo = Infinity; done = false; }
            if (x.day[i] === firstDay) { hi = Math.max(hi, b.h[i]); lo = Math.min(lo, b.l[i]); continue; }
            if (done || !Number.isFinite(hi)) continue;
            const d: 1 | -1 | 0 = b.c[i] > hi ? 1 : b.c[i] < lo ? -1 : 0;
            if (!d) continue;
            done = true;
            if ((tr && tr[i] !== d) || !sideOk(side, d)) continue;
            const stop = st === 'opp' ? (d > 0 ? lo : hi) : (hi + lo) / 2;
            od.push({ i, dir: d, stop, target: NaN, exitAt: we[i] });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- Asian range in London, with the trend
export const ASIA_TREND: Family = {
  id: 'asiatrend', label: 'Cassure du range asiatique à Londres dans le sens de la tendance', tfs: ['15m'],
  variants: () => {
    const out: Variant[] = [];
    for (const len of [20, 50]) for (const st of ['opp', 'mid']) for (const tg of ['eod', '2R']) for (const side of SIDES) {
      out.push({
        key: `asiatrend|${len}|${st}|${tg}|${side}`,
        label: `Clôture au-delà du range asiatique (20 h-minuit NY) entre 2 h et 8 h NY, dans le sens de la tendance (${len} jours) · stop ${st === 'opp' ? 'à l’autre bord' : 'au milieu'} · ${tg === 'eod' ? 'sortie en fin de journée' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, rng = sessionRange(x, 20, 0), tr = dailyTrend(x, len), od: Order[] = [];
          let done = -1;
          for (let i = x.start; i < x.n; i++) {
            const s = x.ny[i] / 3600, H = rng.hi[i], L = rng.lo[i];
            if (s < 2 || s >= 8 || Number.isNaN(H) || x.nyDate[i] === done || !tr[i]) continue;
            const d: 1 | -1 | 0 = b.c[i] > H && b.c[i - 1] <= H ? 1 : b.c[i] < L && b.c[i - 1] >= L ? -1 : 0;
            if (!d) continue;
            done = x.nyDate[i];
            if (tr[i] !== d || !sideOk(side, d)) continue;
            const stop = st === 'opp' ? (d > 0 ? L : H) : (H + L) / 2;
            od.push({ i, dir: d, stop, target: tg === 'eod' ? NaN : rT(b.c[i], stop, d, 2), exitAt: x.dayEnd[i] });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_6: Record<string, Family> = { lwvb: VOL_BREAKOUT, dip: TREND_DIPS, monday: MONDAY_RANGE, asiatrend: ASIA_TREND };
