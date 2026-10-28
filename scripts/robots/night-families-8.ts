import { type Family, type Order, type Variant } from './night-lib';

// The night lab's eighth batch: classic trend following on daily bars for every class, the
// last hope outside crypto. Time-series momentum (the sign of the last N days' return, held
// H days) and moving-average crosses, each with a wide stop.

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);

export const TS_MOMENTUM: Family = {
  id: 'tsmom', label: 'Momentum de tendance (signe du rendement sur N jours)', tfs: ['1d'],
  variants: () => {
    const out: Variant[] = [];
    for (const look of [20, 60, 120]) for (const hold of [5, 20]) for (const stopK of [3, 5]) for (const side of SIDES) {
      out.push({
        key: `tsmom|${look}|${hold}|${stopK}|${side}`,
        label: `Dans le sens du rendement des ${look} derniers jours · ${hold} jours · stop ${stopK} ATR${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          // a decision every `hold` days (the trade is out before the next one)
          for (let i = Math.max(x.start, look); i < x.n; i += hold) {
            const d: 1 | -1 = b.c[i] > b.c[i - look] ? 1 : -1;
            if (!sideOk(side, d)) continue;
            od.push({ i, dir: d, stop: b.c[i] - d * stopK * atr[i], target: NaN, maxBars: hold });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const MA_CROSS: Family = {
  id: 'macross', label: 'Croisement de moyennes mobiles (journalier)', tfs: ['1d', '4h'],
  variants: () => {
    const out: Variant[] = [];
    for (const [f, s] of [[10, 50], [20, 100], [50, 200]] as [number, number][]) for (const trail of [3, 5]) for (const side of SIDES) {
      out.push({
        key: `macross|${f}|${s}|${trail}|${side}`,
        label: `Moyenne ${f} qui croise la moyenne ${s} · stop initial et suiveur ${trail} ATR, sortie au croisement inverse${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          const ma = (len: number) => {
            const o = new Float64Array(x.n).fill(NaN);
            let sum = 0;
            for (let i = 0; i < x.n; i++) { sum += b.c[i]; if (i >= len) sum -= b.c[i - len]; if (i >= len - 1) o[i] = sum / len; }
            return o;
          };
          const fa = ma(f), sl = ma(s);
          for (let i = x.start; i < x.n; i++) {
            const up = fa[i] > sl[i] && fa[i - 1] <= sl[i - 1], dn = fa[i] < sl[i] && fa[i - 1] >= sl[i - 1];
            if (!up && !dn) continue;
            const d: 1 | -1 = up ? 1 : -1;
            if (!sideOk(side, d)) continue;
            // out at the opposite cross at the latest
            let j = i + 1;
            while (j < x.n && (d > 0 ? fa[j] >= sl[j] : fa[j] <= sl[j])) j++;
            od.push({ i, dir: d, stop: b.c[i] - d * trail * atr[i], target: NaN, trail, exitAt: Math.min(j, x.n - 1) });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_8: Record<string, Family> = { tsmom: TS_MOMENTUM, macross: MA_CROSS };
