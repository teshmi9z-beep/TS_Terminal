import { sessionRange, type Ctx, type Family, type Order, type Variant } from './night-lib';
import { FAMILIES_2 } from './night-families-2';
import { FAMILIES_3 } from './night-families-3';
import { FAMILIES_4 } from './night-families-4';
import { FAMILIES_5 } from './night-families-5';
import { FAMILIES_6 } from './night-families-6';
import { FAMILIES_7 } from './night-families-7';
import { FAMILIES_8 } from './night-families-8';

// The setups of the night lab (see night-lib.ts). Each family gives variants: a setup
// with its target, hours and side. Levels come from the previous trading day / week
// or a session's range; a signal fires once per level and day; intraday trades are out
// by the end of the trading day (17:00 New York; midnight UTC for crypto).

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);

// New York hours windows
type Hours = 'all' | 'lon' | 'ny' | 'kz';
const HOURS_FR: Record<Hours, string> = { all: '', lon: ' · kill zone de Londres (2 h-5 h NY)', ny: ' · kill zone de New York (7 h-10 h NY)', kz: ' · kill zones Londres et New York' };
function inHours(x: Ctx, i: number, h: Hours) {
  if (h === 'all') return true;
  const s = x.ny[i] / 3600;
  const lon = s >= 2 && s < 5, ny = s >= 7 && s < 10;
  return h === 'lon' ? lon : h === 'ny' ? ny : lon || ny;
}

type Target = '1R' | '2R' | '3R' | 'eod' | 'lvl' | 'mid';
const TARGET_FR: Record<Target, string> = { '1R': 'objectif 1 R', '2R': 'objectif 2 R', '3R': 'objectif 3 R', eod: 'sortie en fin de journée', lvl: 'objectif au niveau suivant', mid: 'objectif au milieu' };
const rTarget = (entryRef: number, stop: number, d: 1 | -1, k: number) => entryRef + d * k * Math.abs(entryRef - stop);

// ---------------------------------------------------------------- pivot points
function pivots(x: Ctx, i: number) {
  const H = x.pdh[i], L = x.pdl[i], C = x.pdc[i];
  const P = (H + L + C) / 3, rg = H - L;
  return { P, R1: 2 * P - L, S1: 2 * P - H, R2: P + rg, S2: P - rg, H3: C + (1.1 * rg) / 4, L3: C - (1.1 * rg) / 4, H4: C + (1.1 * rg) / 2, L4: C - (1.1 * rg) / 2 };
}
type Piv = ReturnType<typeof pivots>;

export const PIVOTS: Family = {
  id: 'pivots', label: 'Points pivots (classiques et Camarilla)', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    // bounce: the bar dips through the support and closes back above it (a resistance for sells)
    const bounces: [string, string, (p: Piv) => [number, number], (p: Piv) => [number, number]][] = [
      ['S1R1', 'S1 / R1', (p) => [p.S1, p.P], (p) => [p.R1, p.P]],
      ['S2R2', 'S2 / R2', (p) => [p.S2, p.S1], (p) => [p.R2, p.R1]],
      ['L3H3', 'Camarilla L3 / H3', (p) => [p.L3, p.P], (p) => [p.H3, p.P]],
      ['P', 'le pivot P', (p) => [p.P, p.R1], (p) => [p.P, p.S1]],
    ];
    for (const [lk, lf, sup, res] of bounces) {
      for (const tg of ['lvl', '1R', '2R', 'eod'] as Target[]) for (const hr of ['all', 'kz'] as Hours[]) for (const side of SIDES) {
        out.push({
          key: `piv_bounce|${lk}|${tg}|${hr}|${side}`,
          label: `Rebond sur ${lf} (mèche au travers, clôture de retour) · ${TARGET_FR[tg]}${HOURS_FR[hr]}${SIDE_FR[side]}`,
          orders: (x) => {
            const { b, atr } = x, od: Order[] = [];
            let doneL = -1, doneS = -1;
            for (let i = x.start; i < x.n; i++) {
              if (Number.isNaN(x.pdh[i]) || !inHours(x, i, hr)) continue;
              const p = pivots(x, i), pad = 0.1 * atr[i];
              const [s, sNext] = sup(p), [r, rNext] = res(p);
              if (sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] > s && b.l[i] <= s && b.c[i] > s) {
                doneL = x.day[i];
                const stop = b.l[i] - pad;
                od.push({ i, dir: 1, stop, target: tg === 'lvl' ? sNext : tg === 'eod' ? NaN : rTarget(b.c[i], stop, 1, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
              }
              if (sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] < r && b.h[i] >= r && b.c[i] < r) {
                doneS = x.day[i];
                const stop = b.h[i] + pad;
                od.push({ i, dir: -1, stop, target: tg === 'lvl' ? rNext : tg === 'eod' ? NaN : rTarget(b.c[i], stop, -1, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
              }
            }
            return od;
          },
        });
      }
    }
    // break: the first close through the level; the stop at the level behind or under the bar
    const breaks: [string, string, (p: Piv) => [number, number, number], (p: Piv) => [number, number, number]][] = [
      ['R1S1', 'R1 / S1', (p) => [p.R1, p.P, p.R2], (p) => [p.S1, p.P, p.S2]],
      ['H4L4', 'Camarilla H4 / L4', (p) => [p.H4, p.H3, NaN], (p) => [p.L4, p.L3, NaN]],
      ['R2S2', 'R2 / S2', (p) => [p.R2, p.R1, NaN], (p) => [p.S2, p.S1, NaN]],
    ];
    for (const [lk, lf, up, dn] of breaks) {
      for (const st of ['lvl', 'bar']) for (const tg of ['lvl', '1R', '2R', 'eod'] as Target[]) for (const hr of ['all', 'kz'] as Hours[]) for (const side of SIDES) {
        if (tg === 'lvl' && lk !== 'R1S1') continue;
        out.push({
          key: `piv_break|${lk}|${st}|${tg}|${hr}|${side}`,
          label: `Cassure de ${lf} en clôture · stop ${st === 'lvl' ? 'au niveau d’avant' : 'sous la bougie'} · ${TARGET_FR[tg]}${HOURS_FR[hr]}${SIDE_FR[side]}`,
          orders: (x) => {
            const { b, atr } = x, od: Order[] = [];
            let doneL = -1, doneS = -1;
            for (let i = x.start; i < x.n; i++) {
              if (Number.isNaN(x.pdh[i]) || !inHours(x, i, hr)) continue;
              const p = pivots(x, i), pad = 0.1 * atr[i];
              const [u, uStop, uNext] = up(p), [v, vStop, vNext] = dn(p);
              if (sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] <= u && b.c[i] > u) {
                doneL = x.day[i];
                const stop = st === 'lvl' ? uStop : b.l[i] - pad;
                od.push({ i, dir: 1, stop, target: tg === 'lvl' ? uNext : tg === 'eod' ? NaN : rTarget(b.c[i], stop, 1, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
              }
              if (sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] >= v && b.c[i] < v) {
                doneS = x.day[i];
                const stop = st === 'lvl' ? vStop : b.h[i] + pad;
                od.push({ i, dir: -1, stop, target: tg === 'lvl' ? vNext : tg === 'eod' ? NaN : rTarget(b.c[i], stop, -1, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
              }
            }
            return od;
          },
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- liquidity levels
type Lvl = 'pd' | 'pw' | 'asia' | 'lon';
const LVL_FR: Record<Lvl, string> = { pd: 'plus haut / plus bas de la veille', pw: 'plus haut / plus bas de la semaine d’avant', asia: 'range asiatique (20 h-minuit NY)', lon: 'range de Londres (2 h-5 h NY)' };
function levels(x: Ctx, k: Lvl): { hi: ArrayLike<number>; lo: ArrayLike<number> } {
  if (k === 'pd') return { hi: x.pdh, lo: x.pdl };
  if (k === 'pw') return { hi: x.pwh, lo: x.pwl };
  return k === 'asia' ? sessionRange(x, 20, 0) : sessionRange(x, 2, 5);
}

export const LIQUIDITY: Family = {
  id: 'liq', label: 'Niveaux de liquidité : prise puis retour, ou cassure', tfs: ['5m', '15m', '1h'],
  variants: (tf) => {
    const out: Variant[] = [];
    for (const lv of ['pd', 'pw', 'asia', 'lon'] as Lvl[]) {
      if (tf === '1h' && (lv === 'asia' || lv === 'lon')) continue;
      // sweep: a wick through the level, the close back on the other side: the other way
      for (const tg of ['lvl', 'mid', '1R', '2R', 'eod'] as Target[]) for (const hr of ['all', 'lon', 'ny', 'kz'] as Hours[]) for (const side of SIDES) {
        if (lv === 'lon' && hr === 'lon') continue;
        out.push({
          key: `liq_sweep|${lv}|${tg}|${hr}|${side}`,
          label: `Prise de liquidité du ${LVL_FR[lv]}, clôture de retour : sens inverse · ${tg === 'lvl' ? 'objectif à l’autre bord' : TARGET_FR[tg]}${HOURS_FR[hr]}${SIDE_FR[side]}`,
          orders: (x) => sweeps(x, lv, tg, hr, side),
        });
      }
      // break: the first close beyond the level: that way
      for (const tg of ['1R', '2R', 'eod'] as Target[]) for (const hr of ['all', 'lon', 'ny', 'kz'] as Hours[]) for (const side of SIDES) {
        if (lv === 'lon' && hr === 'lon') continue;
        out.push({
          key: `liq_break|${lv}|${tg}|${hr}|${side}`,
          label: `Cassure en clôture du ${LVL_FR[lv]} · stop sous la bougie · ${TARGET_FR[tg]}${HOURS_FR[hr]}${SIDE_FR[side]}`,
          orders: (x) => {
            const { b, atr } = x, { hi, lo } = levels(x, lv), od: Order[] = [];
            let doneL = -1, doneS = -1;
            for (let i = x.start; i < x.n; i++) {
              const H = hi[i], L = lo[i];
              if (Number.isNaN(H) || !inHours(x, i, hr)) continue;
              const pad = 0.1 * atr[i];
              if (sideOk(side, 1) && x.day[i] !== doneL && b.c[i - 1] <= H && b.c[i] > H) {
                doneL = x.day[i];
                const stop = b.l[i] - pad;
                od.push({ i, dir: 1, stop, target: tg === 'eod' ? NaN : rTarget(b.c[i], stop, 1, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
              }
              if (sideOk(side, -1) && x.day[i] !== doneS && b.c[i - 1] >= L && b.c[i] < L) {
                doneS = x.day[i];
                const stop = b.h[i] + pad;
                od.push({ i, dir: -1, stop, target: tg === 'eod' ? NaN : rTarget(b.c[i], stop, -1, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
              }
            }
            return od;
          },
        });
      }
    }
    return out;
  },
};

function sweeps(x: Ctx, lv: Lvl, tg: Target, hr: Hours, side: Side): Order[] {
  const { b, atr } = x, { hi, lo } = levels(x, lv), od: Order[] = [];
  let doneL = -1, doneS = -1;
  for (let i = x.start; i < x.n; i++) {
    const H = hi[i], L = lo[i];
    if (Number.isNaN(H) || !inHours(x, i, hr)) continue;
    const pad = 0.1 * atr[i];
    // sell-side liquidity taken (below the low), the close back above: buy
    if (sideOk(side, 1) && x.day[i] !== doneL && b.l[i] < L && b.c[i] > L) {
      doneL = x.day[i];
      const stop = b.l[i] - pad;
      const target = tg === 'lvl' ? H : tg === 'mid' ? (H + L) / 2 : tg === 'eod' ? NaN : rTarget(b.c[i], stop, 1, tg === '1R' ? 1 : 2);
      od.push({ i, dir: 1, stop, target, exitAt: x.dayEnd[i] });
    }
    if (sideOk(side, -1) && x.day[i] !== doneS && b.h[i] > H && b.c[i] < H) {
      doneS = x.day[i];
      const stop = b.h[i] + pad;
      const target = tg === 'lvl' ? L : tg === 'mid' ? (H + L) / 2 : tg === 'eod' ? NaN : rTarget(b.c[i], stop, -1, tg === '1R' ? 1 : 2);
      od.push({ i, dir: -1, stop, target, exitAt: x.dayEnd[i] });
    }
  }
  return od;
}

// ---------------------------------------------------------------- ICT silver bullet
// the first fair value gap formed inside a New York hour window; a limit order at the gap's
// near edge until the window ends; the stop beyond the gap's first candle
type SbFilter = 'any' | 'sweep' | 'discount';
const SB_FR: Record<SbFilter, string> = { any: '', sweep: ' · après une prise de liquidité du jour (veille ou Asie) dans l’autre sens', discount: ' · achat sous l’ouverture de minuit, vente au-dessus' };
export const SILVER_BULLET: Family = {
  id: 'sb', label: 'ICT Silver Bullet (FVG dans une fenêtre horaire)', tfs: ['5m', '15m'],
  variants: () => {
    const out: Variant[] = [];
    for (const [w, wf] of [[3, '3 h-4 h NY'], [10, '10 h-11 h NY'], [14, '14 h-15 h NY']] as [number, string][]) {
      for (const gap of [0, 0.25]) for (const flt of ['any', 'sweep', 'discount'] as SbFilter[]) for (const tg of ['2R', '3R', 'eod'] as Target[]) for (const side of SIDES) {
        out.push({
          key: `sb|${w}|${gap}|${flt}|${tg}|${side}`,
          label: `Silver Bullet ${wf} : premier FVG${gap ? ' d’au moins ¼ ATR' : ''}, ordre limite au bord du FVG, stop derrière sa 1re bougie · ${TARGET_FR[tg]}${SB_FR[flt]}${SIDE_FR[side]}`,
          orders: (x) => {
            const { b, atr } = x, od: Order[] = [];
            const asia = sessionRange(x, 20, 0);
            let done = -1, dayLow = Infinity, dayHigh = -Infinity, curDay = -1;
            for (let i = x.start; i < x.n; i++) {
              if (x.nyDate[i] !== curDay) { curDay = x.nyDate[i]; dayLow = Infinity; dayHigh = -Infinity; }
              dayLow = Math.min(dayLow, b.l[i]); dayHigh = Math.max(dayHigh, b.h[i]);
              const s = x.ny[i];
              if (s < w * 3600 || s + x.tfSec > (w + 1) * 3600 || x.nyDate[i] === done) continue;
              const bull = b.l[i] - b.h[i - 2] > gap * atr[i], bear = b.l[i - 2] - b.h[i] > gap * atr[i];
              if (!bull && !bear) continue;
              const d: 1 | -1 = bull ? 1 : -1;
              if (!sideOk(side, d)) continue;
              if (flt === 'sweep') {
                const lo = Math.min(x.pdl[i], asia.lo[i]), hi = Math.max(x.pdh[i], asia.hi[i]);
                if (d > 0 ? !(dayLow < lo) : !(dayHigh > hi)) continue;
              }
              if (flt === 'discount' && (d > 0 ? !(b.c[i] < x.midOpen[i]) : !(b.c[i] > x.midOpen[i]))) continue;
              done = x.nyDate[i];
              const entry = d > 0 ? b.l[i] : b.h[i];
              const stop = d > 0 ? b.l[i - 2] - 0.1 * atr[i] : b.h[i - 2] + 0.1 * atr[i];
              // the window's last bar
              let wEnd = i;
              while (wEnd + 1 < x.n && x.nyDate[wEnd + 1] === x.nyDate[i] && x.ny[wEnd + 1] + x.tfSec <= (w + 1) * 3600) wEnd++;
              od.push({ i, dir: d, entry, expire: wEnd - i, stop, target: tg === 'eod' ? NaN : rTarget(entry, stop, d, tg === '2R' ? 2 : 3), exitAt: x.dayEnd[i] });
            }
            return od;
          },
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------- opening range breakout
// the session's first minutes make a range; the first close beyond it (within 4 hours) is traded
function opensOf(x: Ctx): [string, number, boolean][] {
  // [label, open in seconds, true: UTC time, false: New York time]
  const s = x.m.sym;
  if (s === 'SPX500' || s === 'NDX100') return [['ouverture de Wall Street (9 h 30 NY)', 9.5 * 3600, false]];
  if (s === 'DAX40' || s === 'CAC40' || s === 'FTSE100') return [['ouverture européenne (3 h NY)', 3 * 3600, false]];
  if (s === 'NIKKEI') return [['ouverture de Tokyo (0 h UTC)', 0, true]];
  if (s === 'HSI') return [['ouverture de Hong Kong (1 h 30 UTC)', 1.5 * 3600, true]];
  if (x.m.cls === 'Crypto') return [['minuit UTC', 0, true], ['ouverture de Wall Street (9 h 30 NY)', 9.5 * 3600, false]];
  return [['ouverture de Londres (3 h NY)', 3 * 3600, false], ['ouverture de New York (8 h NY)', 8 * 3600, false]];
}
export const ORB: Family = {
  id: 'orb', label: 'Range d’ouverture (ORB)', tfs: ['5m', '15m'],
  variants: (tf) => {
    const out: Variant[] = [];
    const step = tf === '5m' ? 300 : 900;
    for (const which of [0, 1]) for (const len of [15, 30, 60]) for (const st of ['opp', 'mid']) for (const tg of ['1R', '2R', 'eod'] as Target[]) for (const side of SIDES) {
      if (len * 60 < step) continue;
      out.push({
        key: `orb|${which}|${len}|${st}|${tg}|${side}`,
        label: `Range des ${len} premières minutes (${which ? '2e' : '1re'} ouverture de la liste du marché), cassure en clôture · stop ${st === 'opp' ? 'à l’autre bord' : 'au milieu'} · ${TARGET_FR[tg]}${SIDE_FR[side]}`,
        orders: (x) => {
          const opens = opensOf(x);
          if (which >= opens.length) return [];
          const [, at, utc] = opens[which];
          const { b } = x, od: Order[] = [];
          const sec = (i: number) => (utc ? ((b.t[i] % 86400) + 86400) % 86400 : x.ny[i]);
          let rh = -Infinity, rl = Infinity, filled = 0, day = -1, done = false, since = -1;
          for (let i = x.start; i < x.n; i++) {
            const s = sec(i);
            if (s >= at && s < at + len * 60) {
              // a new range starts at the open's bar
              if (s === at || day !== x.day[i]) { rh = -Infinity; rl = Infinity; filled = 0; done = false; day = x.day[i]; since = i; }
              rh = Math.max(rh, b.h[i]); rl = Math.min(rl, b.l[i]); filled++;
              continue;
            }
            if (done || day !== x.day[i] || filled * x.tfSec < len * 60 || i - since > (4 * 3600) / x.tfSec) continue;
            const up = b.c[i] > rh, dn = b.c[i] < rl;
            if (!up && !dn) continue;
            done = true;
            const d: 1 | -1 = up ? 1 : -1;
            if (!sideOk(side, d)) continue;
            const stop = st === 'opp' ? (d > 0 ? rl : rh) : (rh + rl) / 2;
            od.push({ i, dir: d, stop, target: tg === 'eod' ? NaN : rTarget(b.c[i], stop, d, tg === '1R' ? 1 : 2), exitAt: x.dayEnd[i] });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- candle range theory
// the bar takes the previous bar's high (low) and closes back inside its range: the other way,
// toward the previous bar's other end; out after a number of bars
export const CRT: Family = {
  id: 'crt', label: 'CRT : la bougie prend l’extrême de la précédente et referme dedans', tfs: ['1h', '4h', '1d'],
  variants: (tf) => {
    const out: Variant[] = [];
    const holds = tf === '1d' ? [5, 10] : tf === '4h' ? [6, 12] : [12, 24];
    for (const body of [0, 1]) for (const tg of ['lvl', 'mid', '1R', '2R'] as Target[]) for (const hold of holds) for (const side of SIDES) {
      out.push({
        key: `crt|${body}|${tg}|${hold}|${side}`,
        label: `CRT${body ? ' (bougie de la couleur du retour)' : ''} · ${tg === 'lvl' ? 'objectif à l’autre extrême de la bougie d’avant' : TARGET_FR[tg]} · ${hold} bougies au plus${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          for (let i = x.start; i < x.n; i++) {
            const pad = 0.1 * atr[i];
            const upTake = b.h[i] > b.h[i - 1] && b.c[i] < b.h[i - 1] && b.c[i] > b.l[i - 1] && (!body || b.c[i] < b.o[i]);
            const dnTake = b.l[i] < b.l[i - 1] && b.c[i] > b.l[i - 1] && b.c[i] < b.h[i - 1] && (!body || b.c[i] > b.o[i]);
            if (upTake === dnTake) continue;
            const d: 1 | -1 = dnTake ? 1 : -1;
            if (!sideOk(side, d)) continue;
            const stop = d > 0 ? b.l[i] - pad : b.h[i] + pad;
            const far = d > 0 ? b.h[i - 1] : b.l[i - 1];
            const target = tg === 'lvl' ? far : tg === 'mid' ? (b.h[i - 1] + b.l[i - 1]) / 2 : rTarget(b.c[i], stop, d, tg === '1R' ? 1 : 2);
            od.push({ i, dir: d, stop, target, maxBars: hold });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES: Record<string, Family> = { pivots: PIVOTS, liq: LIQUIDITY, sb: SILVER_BULLET, orb: ORB, crt: CRT, ...FAMILIES_2, ...FAMILIES_3, ...FAMILIES_4, ...FAMILIES_5, ...FAMILIES_6, ...FAMILIES_7, ...FAMILIES_8 };
