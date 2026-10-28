import { swings, type Ctx, type Family, type Order, type Variant } from './night-lib';

// The night lab's second batch (see night-families.ts for the first): ICT market structure
// shift after a liquidity sweep with an entry on the retrace, support / resistance zones
// from clusters of swings, automatic trend lines, the London move carried into New York,
// the indices' opening gap, and Donchian breakouts with a trailing stop.

type Side = 'both' | 'long' | 'short';
const SIDES: Side[] = ['both', 'long', 'short'];
const SIDE_FR: Record<Side, string> = { both: '', long: ' · achats seuls', short: ' · ventes seules' };
const sideOk = (s: Side, d: 1 | -1) => s === 'both' || (s === 'long' ? d > 0 : d < 0);
const rT = (entry: number, stop: number, d: 1 | -1, k: number) => entry + d * k * Math.abs(entry - stop);
const inKz = (x: Ctx, i: number) => { const s = x.ny[i] / 3600; return (s >= 2 && s < 5) || (s >= 7 && s < 10); };

// ---------------------------------------------------------------- ICT: sweep, MSS, retrace
// a confirmed swing low is taken (sell-side liquidity), then within `within` bars a close
// above the last swing high shifts the structure up: the leg from the sweep's low to that
// close is the displacement. Entry: a limit at the leg's OTE (62 % or 70.5 % retrace) or
// at the top of the leg's last bullish FVG; the stop under the sweep's low (mirror for sells)
type MssEntry = 'ote62' | 'ote705' | 'fvg';
const MSS_ENTRY_FR: Record<MssEntry, string> = { ote62: 'retour à 62 % de la jambe (OTE)', ote705: 'retour à 70,5 % de la jambe (OTE)', fvg: 'retour dans le dernier FVG de la jambe' };
export const MSS: Family = {
  id: 'mss', label: 'ICT : prise de liquidité, cassure de structure (MSS), entrée au retour (OTE / FVG)', tfs: ['5m', '15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const k of [2, 3]) for (const en of ['ote62', 'ote705', 'fvg'] as MssEntry[]) for (const tg of ['2R', '3R', 'leg']) for (const kz of [0, 1]) for (const side of SIDES) {
      out.push({
        key: `mss|${k}|${en}|${tg}|${kz}|${side}`,
        label: `Prise d’un creux (sommet) de ${k} bougies puis cassure de structure en clôture · ${MSS_ENTRY_FR[en]} · stop derrière la mèche de la prise · ${tg === 'leg' ? 'objectif au bout de la jambe' : `objectif ${tg}`}${kz ? ' · cassure dans les kill zones' : ''}${SIDE_FR[side]}`,
        orders: (x) => mssOrders(x, k, en, tg, kz === 1, side),
      });
    }
    return out;
  },
};
function mssOrders(x: Ctx, k: number, en: MssEntry, tg: string, kz: boolean, side: Side): Order[] {
  const { b, atr } = x, { hiAt, loAt } = swings(x, k), od: Order[] = [];
  const within = 20;
  // the pending sweep of each side: the bar it happened and its extreme
  let sl = -1, slExt = Infinity, sh = -1, shExt = -Infinity;
  let takenLo = -1, takenHi = -1;
  for (let i = x.start; i < x.n; i++) {
    const lo = loAt[i], hi = hiAt[i];
    // sell-side sweep: the low goes under the last swing low (each swing taken once)
    if (lo >= 0 && lo !== takenLo && b.l[i] < b.l[lo]) { takenLo = lo; sl = i; slExt = b.l[i]; }
    if (hi >= 0 && hi !== takenHi && b.h[i] > b.h[hi]) { takenHi = hi; sh = i; shExt = b.h[i]; }
    if (sl >= 0) slExt = Math.min(slExt, b.l[i]);
    if (sh >= 0) shExt = Math.max(shExt, b.h[i]);
    // bullish shift: after the sweep, a close above the last swing high
    if (sl >= 0 && i - sl <= within && hi >= 0 && b.c[i] > b.h[hi] && b.c[i - 1] <= b.h[hi] && (!kz || inKz(x, i))) {
      const d = 1 as const;
      if (sideOk(side, d)) {
        const legLo = slExt, legHi = Math.max(b.h[i], b.c[i]);
        let entry = NaN;
        if (en === 'fvg') { for (let j = i; j >= Math.max(sl + 2, i - within); j--) if (b.l[j] > b.h[j - 2]) { entry = b.l[j]; break; } }
        else entry = legHi - (en === 'ote62' ? 0.62 : 0.705) * (legHi - legLo);
        const stop = legLo - 0.1 * atr[i];
        if (!Number.isNaN(entry) && entry > stop) od.push({ i, dir: d, entry, expire: 20, stop, target: tg === 'leg' ? legHi : rT(entry, stop, d, tg === '2R' ? 2 : 3), maxBars: 96 });
      }
      sl = -1; slExt = Infinity;
    }
    if (sh >= 0 && i - sh <= within && lo >= 0 && b.c[i] < b.l[lo] && b.c[i - 1] >= b.l[lo] && (!kz || inKz(x, i))) {
      const d = -1 as const;
      if (sideOk(side, d)) {
        const legHi = shExt, legLo = Math.min(b.l[i], b.c[i]);
        let entry = NaN;
        if (en === 'fvg') { for (let j = i; j >= Math.max(sh + 2, i - within); j--) if (b.h[j] < b.l[j - 2]) { entry = b.h[j]; break; } }
        else entry = legLo + (en === 'ote62' ? 0.62 : 0.705) * (legHi - legLo);
        const stop = legHi + 0.1 * atr[i];
        if (!Number.isNaN(entry) && entry < stop) od.push({ i, dir: d, entry, expire: 20, stop, target: tg === 'leg' ? legLo : rT(entry, stop, d, tg === '2R' ? 2 : 3), maxBars: 96 });
      }
      sh = -1; shExt = -Infinity;
    }
    if (sl >= 0 && i - sl > within) { sl = -1; slExt = Infinity; }
    if (sh >= 0 && i - sh > within) { sh = -1; shExt = -Infinity; }
  }
  return od.sort((a, c) => a.i - c.i);
}

// ---------------------------------------------------------------- support / resistance zones
// a zone: at least `touches` confirmed swings (highs or lows alike) within ¼ ATR of each other
// among the last `look` bars; bounce: the bar pokes into the zone from above and closes back
// above it (support; the mirror for resistance); break: the first close through it
export const SR: Family = {
  id: 'sr', label: 'Supports et résistances (grappes de sommets et de creux)', tfs: ['15m', '1h', '4h'],
  variants: (tf) => {
    const out: Variant[] = [];
    const hold = tf === '4h' ? 30 : tf === '1h' ? 48 : 96;
    for (const touches of [2, 3]) for (const look of [100, 300]) for (const mode of ['bounce', 'break']) for (const tg of ['1R', '2R', '3R']) for (const side of SIDES) {
      out.push({
        key: `sr|${touches}|${look}|${mode}|${tg}|${side}`,
        label: `${mode === 'bounce' ? 'Rebond sur' : 'Cassure en clôture de'} une zone touchée ${touches} fois (sommets / creux des ${look} dernières bougies) · objectif ${tg} · ${hold} bougies au plus${SIDE_FR[side]}`,
        orders: (x) => srOrders(x, touches, look, mode === 'bounce', tg, hold, side),
      });
    }
    return out;
  },
};
// the nearest zone under and over the previous close at each bar (computed once per setting)
function srZones(x: Ctx, touches: number, look: number): { sup: Float64Array; res: Float64Array } {
  const key = `sr:${touches}:${look}`;
  const hit = x.cache.get(key) as { sup: Float64Array; res: Float64Array } | undefined;
  if (hit) return hit;
  const { b, atr } = x, { hiAt, loAt } = swings(x, 3);
  const sup = new Float64Array(x.n).fill(NaN), res = new Float64Array(x.n).fill(NaN);
  const pts: { idx: number; p: number }[] = [];
  let lastH = -1, lastL = -1, sorted: number[] = [], dirty = true;
  for (let i = x.start; i < x.n; i++) {
    if (hiAt[i] !== lastH && hiAt[i] >= 0) { lastH = hiAt[i]; pts.push({ idx: lastH, p: b.h[lastH] }); dirty = true; }
    if (loAt[i] !== lastL && loAt[i] >= 0) { lastL = loAt[i]; pts.push({ idx: lastL, p: b.l[lastL] }); dirty = true; }
    while (pts.length && pts[0].idx < i - look) { pts.shift(); dirty = true; }
    if (dirty) { sorted = pts.map((q) => q.p).sort((p, q) => p - q); dirty = false; }
    const tol = 0.25 * atr[i], ref = b.c[i - 1];
    // a swing price with enough others within the tolerance (two pointers on the sorted prices)
    let lo = 0, hi = 0;
    for (let a = 0; a < sorted.length; a++) {
      const p = sorted[a];
      while (sorted[lo] < p - tol) lo++;
      if (hi < a) hi = a;
      while (hi + 1 < sorted.length && sorted[hi + 1] <= p + tol) hi++;
      if (hi - lo + 1 < touches) continue;
      if (p < ref) sup[i] = p;
      else if (p > ref && Number.isNaN(res[i])) res[i] = p;
    }
  }
  const r = { sup, res };
  x.cache.set(key, r);
  return r;
}

function srOrders(x: Ctx, touches: number, look: number, bounce: boolean, tg: string, hold: number, side: Side): Order[] {
  const { b, atr } = x, zones = srZones(x, touches, look), od: Order[] = [];
  const k = tg === '1R' ? 1 : tg === '2R' ? 2 : 3;
  for (let i = x.start; i < x.n; i++) {
    const tol = 0.25 * atr[i], sup = zones.sup[i], res = zones.res[i];
    const pad = 0.1 * atr[i];
    if (bounce) {
      if (!Number.isNaN(sup) && sideOk(side, 1) && b.l[i] <= sup + tol && b.c[i] > sup + tol) {
        const stop = Math.min(b.l[i], sup - tol) - pad;
        od.push({ i, dir: 1, stop, target: rT(b.c[i], stop, 1, k), maxBars: hold });
      }
      if (!Number.isNaN(res) && sideOk(side, -1) && b.h[i] >= res - tol && b.c[i] < res - tol) {
        const stop = Math.max(b.h[i], res + tol) + pad;
        od.push({ i, dir: -1, stop, target: rT(b.c[i], stop, -1, k), maxBars: hold });
      }
    } else {
      if (!Number.isNaN(res) && sideOk(side, 1) && b.c[i] > res + tol) {
        const stop = b.l[i] - pad;
        od.push({ i, dir: 1, stop, target: rT(b.c[i], stop, 1, k), maxBars: hold });
      }
      if (!Number.isNaN(sup) && sideOk(side, -1) && b.c[i] < sup - tol) {
        const stop = b.h[i] + pad;
        od.push({ i, dir: -1, stop, target: rT(b.c[i], stop, -1, k), maxBars: hold });
      }
    }
  }
  return od;
}

// ---------------------------------------------------------------- automatic trend lines
// a rising line through the last two confirmed swing lows (the second higher), a falling one
// through the last two swing highs (the second lower). Bounce: the bar touches the line and
// closes back on its side; break: the first close through it (the other way)
export const TRENDLINES: Family = {
  id: 'tl', label: 'Lignes de tendance automatiques (deux derniers creux / sommets)', tfs: ['15m', '1h', '4h'],
  variants: (tf) => {
    const out: Variant[] = [];
    const hold = tf === '4h' ? 30 : tf === '1h' ? 48 : 96;
    for (const k of [3, 5]) for (const mode of ['bounce', 'break']) for (const tg of ['1R', '2R', '3R']) for (const side of SIDES) {
      out.push({
        key: `tl|${k}|${mode}|${tg}|${side}`,
        label: `${mode === 'bounce' ? 'Rebond sur' : 'Cassure en clôture de'} la ligne de tendance (creux / sommets de ${k} bougies) · objectif ${tg} · ${hold} bougies au plus${SIDE_FR[side]}`,
        orders: (x) => tlOrders(x, k, mode === 'bounce', tg === '1R' ? 1 : tg === '2R' ? 2 : 3, hold, side),
      });
    }
    return out;
  },
};
function tlOrders(x: Ctx, k: number, bounce: boolean, kr: number, hold: number, side: Side): Order[] {
  const { b, atr } = x, { hiAt, loAt } = swings(x, k), od: Order[] = [];
  let l1 = -1, l2 = -1, h1 = -1, h2 = -1, lastL = -1, lastH = -1;
  let upBroken = true, dnBroken = true;
  for (let i = x.start; i < x.n; i++) {
    if (loAt[i] !== lastL && loAt[i] >= 0) { lastL = loAt[i]; l1 = l2; l2 = lastL; upBroken = !(l1 >= 0 && b.l[l2] > b.l[l1]); }
    if (hiAt[i] !== lastH && hiAt[i] >= 0) { lastH = hiAt[i]; h1 = h2; h2 = lastH; dnBroken = !(h1 >= 0 && b.h[h2] < b.h[h1]); }
    const pad = 0.1 * atr[i];
    if (!upBroken) {
      const slope = (b.l[l2] - b.l[l1]) / (l2 - l1), line = b.l[l2] + slope * (i - l2);
      if (b.c[i] < line) {
        upBroken = true;
        if (!bounce && sideOk(side, -1)) { const stop = b.h[i] + pad; od.push({ i, dir: -1, stop, target: rT(b.c[i], stop, -1, kr), maxBars: hold }); }
      } else if (bounce && sideOk(side, 1) && b.l[i] <= line + pad && b.c[i] > line) {
        const stop = Math.min(b.l[i], line) - 2 * pad;
        od.push({ i, dir: 1, stop, target: rT(b.c[i], stop, 1, kr), maxBars: hold });
      }
    }
    if (!dnBroken) {
      const slope = (b.h[h2] - b.h[h1]) / (h2 - h1), line = b.h[h2] + slope * (i - h2);
      if (b.c[i] > line) {
        dnBroken = true;
        if (!bounce && sideOk(side, 1)) { const stop = b.l[i] - pad; od.push({ i, dir: 1, stop, target: rT(b.c[i], stop, 1, kr), maxBars: hold }); }
      } else if (bounce && sideOk(side, -1) && b.h[i] >= line - pad && b.c[i] < line) {
        const stop = Math.max(b.h[i], line) + 2 * pad;
        od.push({ i, dir: -1, stop, target: rT(b.c[i], stop, -1, kr), maxBars: hold });
      }
    }
  }
  return od;
}

// ---------------------------------------------------------------- London into New York
// the move from London's open (3 h NY) to New York's (8 h NY; 9 h 30 for US indices), in
// ATR 14 of the day: carried on (or faded) from New York's open to the day's end
export const LONDON_NY: Family = {
  id: 'lonny', label: 'Le mouvement de Londres prolongé (ou effacé) à New York', tfs: ['15m', '1h'],
  variants: () => {
    const out: Variant[] = [];
    for (const minMove of [0.5, 1, 1.5]) for (const mode of ['follow', 'fade']) for (const stopK of [1, 2]) for (const side of SIDES) {
      out.push({
        key: `lonny|${minMove}|${mode}|${stopK}|${side}`,
        label: `Londres a bougé d’au moins ${minMove} ATR (3 h → ouverture de New York) : ${mode === 'follow' ? 'on suit' : 'on prend l’inverse'} à l’ouverture de New York · stop ${stopK} ATR · sortie en fin de journée${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          const nyOpen = x.m.sym === 'SPX500' || x.m.sym === 'NDX100' ? 9.5 * 3600 : 8 * 3600;
          let lonOpen = NaN, day = -1;
          for (let i = x.start; i < x.n; i++) {
            if (x.nyDate[i] !== day) { day = x.nyDate[i]; lonOpen = NaN; }
            if (x.ny[i] === 3 * 3600) lonOpen = b.o[i];
            // the signal on the bar just before New York's open, the entry at its open
            if (x.ny[i] + x.tfSec !== nyOpen || Number.isNaN(lonOpen)) continue;
            const move = (b.c[i] - lonOpen) / atr[i];
            if (Math.abs(move) < minMove) continue;
            const d: 1 | -1 = (move > 0) === (mode === 'follow') ? 1 : -1;
            if (!sideOk(side, d)) continue;
            od.push({ i, dir: d, stop: b.c[i] - d * stopK * atr[i], target: NaN, exitAt: x.dayEnd[i] });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- indices' opening gap
// the cash session opens away from the previous cash close (the CFD trades overnight):
// fade the gap toward that close, or follow it; out by the day's end
const CASH: Record<string, [number, number]> = { SPX500: [9.5, 16], NDX100: [9.5, 16], DAX40: [3, 11.5], CAC40: [3, 11.5], FTSE100: [3, 11.5] };
export const GAP: Family = {
  id: 'gap', label: 'Gap d’ouverture des indices (séance au comptant)', tfs: ['15m'],
  variants: () => {
    const out: Variant[] = [];
    for (const minGap of [0.25, 0.5, 1]) for (const mode of ['fade', 'follow']) for (const tg of ['fill', '1R', 'eod']) for (const side of SIDES) {
      if (mode === 'follow' && tg === 'fill') continue;
      out.push({
        key: `gap|${minGap}|${mode}|${tg}|${side}`,
        label: `Gap d’au moins ${minGap} ATR à l’ouverture au comptant : ${mode === 'fade' ? 'contre le gap' : 'dans le sens du gap'} · stop 1 ATR · ${tg === 'fill' ? 'objectif : la clôture de la veille' : tg === '1R' ? 'objectif 1 R' : 'sortie en fin de séance'}${SIDE_FR[side]}`,
        orders: (x) => {
          const cash = CASH[x.m.sym];
          if (!cash) return [];
          const { b, atr } = x, od: Order[] = [];
          let prevClose = NaN;
          for (let i = x.start; i < x.n; i++) {
            if (x.ny[i] + x.tfSec === cash[1] * 3600) prevClose = b.c[i];
            if (x.ny[i] + x.tfSec !== cash[0] * 3600 || Number.isNaN(prevClose)) continue;
            // the signal at the bar before the open: the gap is the next open against the last close;
            // the bar's own close stands in for the open
            const gap = (b.c[i] - prevClose) / atr[i];
            if (Math.abs(gap) < minGap) continue;
            const d: 1 | -1 = (gap > 0) === (mode === 'follow') ? 1 : -1;
            if (!sideOk(side, d)) continue;
            const stop = b.c[i] - d * atr[i];
            let end = i;
            while (end + 1 < x.n && x.nyDate[end + 1] === x.nyDate[i] && x.ny[end + 1] < cash[1] * 3600) end++;
            od.push({ i, dir: d, stop, target: tg === 'fill' ? prevClose : tg === '1R' ? rT(b.c[i], stop, d, 1) : NaN, exitAt: end });
          }
          return od;
        },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- Donchian breakouts
// a close above the highest high of `len` bars (below the lowest low): that way, with a
// chandelier trailing stop of `trail` ATR; optional turtle filter: only if the last breakout lost
export const DONCHIAN: Family = {
  id: 'donch', label: 'Cassures de Donchian (canal de N bougies) avec stop suiveur', tfs: ['1h', '4h', '1d'],
  variants: () => {
    const out: Variant[] = [];
    for (const len of [20, 55, 100]) for (const trail of [2, 3, 4]) for (const side of SIDES) {
      out.push({
        key: `donch|${len}|${trail}|${side}`,
        label: `Clôture au-delà du canal de ${len} bougies · stop initial et suiveur à ${trail} ATR${SIDE_FR[side]}`,
        orders: (x) => {
          const { b, atr } = x, od: Order[] = [];
          for (let i = Math.max(x.start, len + 1); i < x.n; i++) {
            let hh = -Infinity, ll = Infinity;
            for (let j = i - len; j < i; j++) { hh = Math.max(hh, b.h[j]); ll = Math.min(ll, b.l[j]); }
            const d: 1 | -1 | 0 = b.c[i] > hh ? 1 : b.c[i] < ll ? -1 : 0;
            if (!d || !sideOk(side, d)) continue;
            od.push({ i, dir: d, stop: b.c[i] - d * trail * atr[i], target: NaN, trail });
          }
          return od;
        },
      });
    }
    return out;
  },
};

export const FAMILIES_2: Record<string, Family> = { mss: MSS, sr: SR, tl: TRENDLINES, lonny: LONDON_NY, gap: GAP, donch: DONCHIAN };
