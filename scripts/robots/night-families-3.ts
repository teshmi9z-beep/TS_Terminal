import { type Ctx, type Family, type Order, type Variant } from './night-lib';

// The night lab's third batch: calendar and session effects (turn of the month, the
// indices' last half hour, overnight against day), breakouts after a volatility squeeze,
// and pivot breakouts only in the direction of the daily trend, for every class.

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);
const rT = (entry: number, stop: number, d: 1 | -1, k: number) => entry + d * k * Math.abs(entry - stop);

// ---------------------------------------------------------------- turn of the month
// long from the close `before` trading days before the month's end, held `hold` days
export const TURN_OF_MONTH: Family = {
  id: 'tom', label: 'Fin et début de mois (achat)', tfs: ['1d'],
  variants: () => {
    const out: Variant[] = [];
    for (const before of [1, 2, 3]) for (const hold of [3, 4, 6]) for (const stopK of [2, 4]) {
      out.push({
        key: `tom|${before}|${hold}|${stopK}`,
        label: `Achat à la clôture ${before} jour${before > 1 ? 's' : ''} avant la fin du mois · ${hold} jours · stop ${stopK} ATR`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          const month = (i: number) => new Date(b.t[i] * 1000).getUTCMonth();
          for (let i = x.start; i + before < x.n; i++) {
            // the bar `before` bars ahead is the month's last one
            const k = i + before;
            if (month(k) === month(i) && k + 1 < x.n && month(k + 1) !== month(k)) {
              od.push({ i, dir: 1, stop: b.c[i] - stopK * atr[i], target: NaN, maxBars: hold });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- the indices' last half hour
// the move since the previous cash close (or since the open) sets the side of the last 30 minutes
const CASH: Record<string, [number, number]> = { SPX500: [9.5, 16], NDX100: [9.5, 16], DAX40: [3, 11.5], CAC40: [3, 11.5], FTSE100: [3, 11.5] };
export const LAST_HALF_HOUR: Family = {
  id: 'lasthh', label: 'Indices : la séance donne le sens de la dernière demi-heure', tfs: ['5m', '15m'],
  variants: () => {
    const out: Variant[] = [];
    for (const from of ['close', 'open', 'first30']) for (const minMove of [0, 0.5, 1]) for (const side of SIDES) {
      out.push({
        key: `lasthh|${from}|${minMove}|${side}`,
        label: `Dernière demi-heure dans le sens du mouvement ${from === 'close' ? 'depuis la clôture de la veille' : from === 'open' ? 'depuis l’ouverture' : 'des 30 premières minutes'}${minMove ? ` (au moins ${minMove} ATR)` : ''} · stop 1 ATR${SIDE_FR[side]}`,
        orders: (x) => {
          const cash = CASH[x.m.sym];
          if (!cash) return [];
          const { b, atr } = x, od: Order[] = [];
          let prevClose = NaN, open = NaN, first = NaN;
          for (let i = x.start; i < x.n; i++) {
            const s = x.ny[i], e = s + x.tfSec;
            if (s === cash[0] * 3600) open = b.o[i];
            if (e === cash[0] * 3600 + 1800) first = b.c[i];
            if (e === cash[1] * 3600 - 1800) {
              const ref = from === 'close' ? prevClose : open;
              const move = from === 'first30' ? first - open : b.c[i] - ref;
              if (!Number.isNaN(move) && Math.abs(move) >= minMove * atr[i] && move !== 0) {
                const d: 1 | -1 = move > 0 ? 1 : -1;
                let end = i;
                while (end + 1 < x.n && x.nyDate[end + 1] === x.nyDate[i] && x.ny[end + 1] + x.tfSec <= cash[1] * 3600) end++;
                if (sideOk(side, d)) od.push({ i, dir: d, stop: b.c[i] - d * atr[i], target: NaN, exitAt: end });
              }
            }
            if (e === cash[1] * 3600) { prevClose = b.c[i]; open = NaN; first = NaN; }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- overnight against day
export const OVERNIGHT: Family = {
  id: 'night', label: 'Indices : la nuit (clôture → ouverture) contre la séance', tfs: ['15m'],
  variants: () => {
    const out: Variant[] = [];
    for (const part of ['night', 'day']) for (const stopK of [1, 2]) {
      out.push({
        key: `night|${part}|${stopK}`,
        label: `Achat ${part === 'night' ? 'à la clôture au comptant, vente à l’ouverture suivante' : 'à l’ouverture au comptant, vente à la clôture'} · stop ${stopK * 4} ATR (15 min)`,
        orders: (x) => {
          const cash = CASH[x.m.sym];
          if (!cash) return [];
          const { b, atr } = x, od: Order[] = [];
          const at = part === 'night' ? cash[1] : cash[0], until = part === 'night' ? cash[0] : cash[1];
          for (let i = x.start; i < x.n; i++) {
            if (x.ny[i] + x.tfSec !== at * 3600) continue;
            let end = i + 1;
            while (end < x.n && x.ny[end] + x.tfSec !== until * 3600) end++;
            if (end >= x.n || end - i > 200) continue;
            od.push({ i, dir: 1, stop: b.c[i] - stopK * atr[i] * 4, target: NaN, exitAt: end });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- squeeze breakouts
// an inside bar or the narrowest of 7 bars; the first close beyond its range within 5
// bars: that way, with a chandelier stop
export const SQUEEZE: Family = {
  id: 'squeeze', label: 'Cassure après contraction (inside bar / NR7) avec stop suiveur', tfs: ['1h', '4h', '1d'],
  variants: () => {
    const out: Variant[] = [];
    for (const kind of ['inside', 'nr7']) for (const trail of [2, 3]) for (const tgt of ['trail', '2R']) for (const side of SIDES) {
      out.push({
        key: `squeeze|${kind}|${trail}|${tgt}|${side}`,
        label: `${kind === 'inside' ? 'Inside bar' : 'Bougie la plus étroite des 7 (NR7)'} puis clôture hors de son range · stop à l’autre bord${tgt === 'trail' ? `, suiveur ${trail} ATR` : `, objectif 2 R (${trail} ATR de suivi)`}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          let hi = NaN, lo = NaN, since = -1;
          for (let i = x.start; i < x.n; i++) {
            if (since >= 0 && i - since <= 5 && !Number.isNaN(hi)) {
              const d: 1 | -1 | 0 = b.c[i] > hi ? 1 : b.c[i] < lo ? -1 : 0;
              if (d) {
                since = -1;
                if (sideOk(side, d)) {
                  const stop = d > 0 ? lo : hi;
                  od.push({ i, dir: d, stop, target: tgt === '2R' ? rT(b.c[i], stop, d, 2) : NaN, trail, maxBars: 200 });
                }
              }
            }
            const rg = b.h[i] - b.l[i];
            let squeeze = false;
            if (kind === 'inside') squeeze = b.h[i] < b.h[i - 1] && b.l[i] > b.l[i - 1];
            else { squeeze = true; for (let j = i - 6; j < i; j++) if (b.h[j] - b.l[j] <= rg) { squeeze = false; break; } }
            if (squeeze) { hi = b.h[i]; lo = b.l[i]; since = i; }
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- pivots with the daily trend
// the break of R1 / R2 (S1 / S2) only when the previous day closed above (below) the average
// of the last 20 daily closes; the stop at the level behind, out by the day's end
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
export const PIVOT_TREND: Family = {
  id: 'pivtrend', label: 'Cassure de pivots dans le sens de la tendance journalière', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const lvl of ['R1', 'R2', 'H4']) for (const len of [20, 50]) for (const tg of ['eod', '2R']) for (const side of SIDES) {
      out.push({
        key: `pivtrend|${lvl}|${len}|${tg}|${side}`,
        label: `Cassure de ${lvl === 'H4' ? 'Camarilla H4 / L4' : `${lvl} / S${lvl[1]}`} en clôture, seulement dans le sens de la tendance (clôture de la veille / moyenne ${len} jours) · stop au niveau d’avant · ${tg === 'eod' ? 'sortie en fin de journée' : 'objectif 2 R'}${SIDE_FR[side]}`,
        orders: (x) => {
          const { b } = x, tr = dailyTrend(x, len), od: Order[] = [];
          let doneL = -1, doneS = -1;
          for (let i = x.start; i < x.n; i++) {
            if (Number.isNaN(x.pdh[i]) || !tr[i]) continue;
            const H = x.pdh[i], L = x.pdl[i], C = x.pdc[i], P = (H + L + C) / 3, rg = H - L;
            const up = lvl === 'R1' ? [2 * P - L, P] : lvl === 'R2' ? [P + rg, 2 * P - L] : [C + (1.1 * rg) / 2, C + (1.1 * rg) / 4];
            const dn = lvl === 'R1' ? [2 * P - H, P] : lvl === 'R2' ? [P - rg, 2 * P - H] : [C - (1.1 * rg) / 2, C - (1.1 * rg) / 4];
            if (tr[i] > 0 && sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] <= up[0] && b.c[i] > up[0]) {
              doneL = x.day[i];
              od.push({ i, dir: 1, stop: up[1], target: tg === 'eod' ? NaN : rT(b.c[i], up[1], 1, 2), exitAt: x.dayEnd[i] });
            }
            if (tr[i] < 0 && sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] >= dn[0] && b.c[i] < dn[0]) {
              doneS = x.day[i];
              od.push({ i, dir: -1, stop: dn[1], target: tg === 'eod' ? NaN : rT(b.c[i], dn[1], -1, 2), exitAt: x.dayEnd[i] });
            }
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_3: Record<string, Family> = { tom: TURN_OF_MONTH, lasthh: LAST_HALF_HOUR, night: OVERNIGHT, squeeze: SQUEEZE, pivtrend: PIVOT_TREND };
