// The Dow structure method, shared by the chart indicator "Structure de marché (Dow)" and
// the study that measures it (scripts/robots/dow-study.ts), so both see the same trades.
//
// Swing highs and lows (a high above the `swing` bars before it and not below the ones
// after, known `swing` bars later); the last swing high and low not broken yet are the
// levels to break. A clean close (a body of at least `body` of the bar, in the break's
// direction) beyond one sets the trend (BOS when it goes on, CHoCH when it turns). The
// leg that broke the level gives a box the price should come back to:
// - candle: the last opposite candle at the leg's origin (an order block);
// - fib: from the leg's origin to its middle (the "discount" half of the leg);
// - range: from the leg's origin up to the broken level (the retest of the old range).
// The entry is the price coming back into the box (on contact, or on a rejection candle
// closing out of it), the stop beyond the box's far side (or beyond nearby liquidity),
// the target the next liquidity, a fixed R multiple, or none; a clean break the other
// way closes the trade. Liquidity: the swings not taken yet, and equal highs / lows
// (swings within `eqTol` ATR of each other). Nothing reads the future.

export type DowBox = 'candle' | 'fib' | 'range';
// guard: no trade with liquidity between the entry and just beyond the stop (it would be
// taken first); beyond: the stop moved past that liquidity; sweep: only setups whose leg
// took liquidity first (a stop hunt, then the break)
export type DowLiq = 'none' | 'guard' | 'beyond' | 'sweep';
export type DowParams = {
  // trail: no target, the stop follows each new swing low (high when selling), Dow's way
  swing: number; body: number; box: DowBox; entry: 'contact' | 'reject';
  target: 'liq' | 'fixed' | 'none' | 'trail'; targetR: number; liq: DowLiq; dir: 0 | 1 | -1;
  eqTol: number; rangeTol: number; cost: number;
  // bars a box stays valid (0: until the trend turns)
  maxAge: number;
  // stop margin, in ATR 14
  pad: number;
  // no trade when both sides' costs exceed this share of the risk (0: no limit)
  maxCostR: number;
  // the stop moved to the entry once the trade gains 1 R
  be: boolean;
  // a box only from a leg of at least this many ATR 14 (0: any)
  minLeg: number;
  // box: the entry back into the box of the leg that broke the structure; sweep: the price
  // takes liquidity (a swing not taken yet, or equal highs / lows) with a wick and closes
  // back on the other side of it: the entry against the wick, the stop past its end;
  // sweepeq: the same with equal highs / lows only
  mode: 'box' | 'sweep' | 'sweepeq';
  // no entry while the price is inside a range (the last two highs and lows at the same levels)
  noRange: boolean;
};
export const DOW_DEFAULTS: DowParams = {
  swing: 3, body: 0.5, box: 'candle', entry: 'contact', target: 'liq', targetR: 1, liq: 'none', dir: 0,
  eqTol: 0.15, rangeTol: 0.5, cost: 0, maxAge: 0, pad: 0.1, maxCostR: 0, be: false, minLeg: 0, mode: 'box', noRange: false,
};

export type DowBars = { t: ArrayLike<number>; o: ArrayLike<number>; h: ArrayLike<number>; l: ArrayLike<number>; c: ArrayLike<number>; n: number };
export type DowTrade = {
  up: boolean; entryIdx: number; exitIdx: number; entry: number; exit: number; stop: number; target: number;
  reason: 'stop' | 'objectif' | 'retournement' | 'fin';
  // net of costs (both sides), in R
  r: number;
};
export type DowSwing = { up: boolean; idx: number; price: number; label: 'HH' | 'HL' | 'LH' | 'LL' | '' };
export type DowBreak = { up: boolean; from: number; idx: number; price: number; turn: boolean };
export type DowZone = { up: boolean; ob: number; origin: number; start: number; top: number; bottom: number; end: number; used: boolean; dead: boolean; swept: boolean };
export type DowLiqLine = { up: boolean; from: number; to: number; level: number; count: number; open: boolean; sweptAt: number };
export type DowRange = { from: number; to: number; top: number; bottom: number; open: boolean };
export type DowResult = {
  trades: DowTrade[];
  // with `draw`: what the chart shows
  swings: DowSwing[]; breaks: DowBreak[]; zones: DowZone[]; liqs: DowLiqLine[]; ranges: DowRange[];
  trend: Int8Array; refHigh: Float64Array; refLow: Float64Array;
  open: { up: boolean; idx: number; entry: number; stop: number; target: number; risk: number; first: number } | null;
};

type Swing = { up: boolean; idx: number; price: number };
// risk: the first stop's distance (R); stop: where it is now
type Pos = { up: boolean; idx: number; entry: number; stop: number; target: number; risk: number; first: number };

// Wilder's ATR 14 on every bar (the first bars use the average range so far)
export function atr14(b: DowBars): Float64Array {
  const out = new Float64Array(b.n);
  let avg = 0;
  for (let i = 0; i < b.n; i++) {
    const tr = i === 0 ? b.h[i] - b.l[i] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
    avg = i < 14 ? (avg * i + tr) / (i + 1) : (avg * 13 + tr) / 14;
    out[i] = avg;
  }
  return out;
}

// `allow`: bars where an entry may be taken: 0 none, 1 any, 2 buying only, 3 selling only (the
// active hours, the higher timeframe's trend); `draw`: keep what the chart needs
export function dowRun(b: DowBars, p: DowParams, allow?: Uint8Array, draw = false): DowResult {
  const { o, h, l, c, n } = b;
  const S = Math.max(1, Math.round(p.swing));
  const atr = atr14(b);
  const res: DowResult = {
    trades: [], swings: [], breaks: [], zones: [], liqs: [], ranges: [],
    trend: new Int8Array(draw ? n : 0), refHigh: new Float64Array(draw ? n : 0), refLow: new Float64Array(draw ? n : 0), open: null,
  };

  const isHigh = (q: number) => {
    for (let j = q - S; j <= q + S; j++) if (j !== q && (j < q ? h[j] >= h[q] : h[j] > h[q])) return false;
    return true;
  };
  const isLow = (q: number) => {
    for (let j = q - S; j <= q + S; j++) if (j !== q && (j < q ? l[j] <= l[q] : l[j] < l[q])) return false;
    return true;
  };
  const clean = (i: number, bull: boolean) => {
    const range = h[i] - l[i];
    return range > 0 && Math.abs(c[i] - o[i]) >= p.body * range && (bull ? c[i] > o[i] : c[i] < o[i]);
  };

  let lastHigh = null as Swing | null, lastLow = null as Swing | null;
  let refHigh = null as Swing | null, refLow = null as Swing | null;
  let trend = 0;
  const swings: Swing[] = [];
  // liquidity: swings not taken yet, and equal highs / lows
  const pools: Swing[] = [];
  let lines: DowLiqLine[] = [];
  let zone = null as DowZone | null;
  let range = null as DowRange | null;
  let pos = null as Pos | null;
  // last bar a high / low liquidity was taken
  let tookHigh = -1, tookLow = -1;
  // the lowest high and the highest low not taken yet: no pool is taken while the bar stays inside
  let minHigh = Infinity, maxLow = -Infinity;
  const bounds = () => {
    minHigh = Infinity; maxLow = -Infinity;
    for (const x of pools) if (x.up) { if (x.price < minHigh) minHigh = x.price; } else if (x.price > maxLow) maxLow = x.price;
  };

  const newSwing = (s: Swing, i: number) => {
    const prev = s.up ? lastHigh : lastLow;
    if (draw) {
      const label = !prev ? '' : s.up ? (s.price > prev.price ? 'HH' : 'LH') : (s.price > prev.price ? 'HL' : 'LL');
      res.swings.push({ ...s, label });
    }
    swings.push(s);
    if (swings.length > 8) swings.shift();
    if (s.up) { lastHigh = s; refHigh = s; } else { lastLow = s; refLow = s; }
    // the stop follows the swings made since the entry
    if (pos && p.target === 'trail' && s.idx > pos.idx && s.up !== pos.up) {
      const lvl = pos.up ? s.price - p.pad * atr[i] : s.price + p.pad * atr[i];
      if (pos.up ? lvl > pos.stop : lvl < pos.stop) pos.stop = lvl;
    }
    const tol = p.eqTol * atr[i];
    const had = lines.find((x) => x.up === s.up && Math.abs(x.level - s.price) <= tol);
    if (had) { had.count++; had.level = s.up ? Math.max(had.level, s.price) : Math.min(had.level, s.price); }
    else {
      let twin: Swing | undefined;
      for (let j = pools.length - 1; j >= 0 && !twin; j--) if (pools[j].up === s.up && Math.abs(pools[j].price - s.price) <= tol) twin = pools[j];
      if (twin) {
        const line: DowLiqLine = { up: s.up, from: twin.idx, to: i, level: s.up ? Math.max(twin.price, s.price) : Math.min(twin.price, s.price), count: 2, open: true, sweptAt: -1 };
        lines.push(line);
        if (draw) res.liqs.push(line);
        // the oldest levels stop counting (as the swings kept, the recent liquidity only)
        if (lines.length > 40) { const old = lines.shift()!; old.open = false; old.to = i; }
      }
    }
    pools.push(s);
    if (pools.length > 60) pools.shift();
    bounds();
    if (!draw && !p.noRange) return;
    // a range: the last two highs and the last two lows each within the tolerance
    const last4 = swings.slice(-4);
    const hs = last4.filter((w) => w.up).map((w) => w.price), ls = last4.filter((w) => !w.up).map((w) => w.price);
    const rt = p.rangeTol * atr[i];
    if (hs.length >= 2 && ls.length >= 2 && Math.max(...hs) - Math.min(...hs) <= rt && Math.max(...ls) - Math.min(...ls) <= rt && Math.min(...hs) > Math.max(...ls)) {
      const top = Math.max(...hs), bottom = Math.min(...ls), from = Math.min(...last4.map((w) => w.idx));
      if (range?.open && from <= range.to) { range.top = Math.max(range.top, top); range.bottom = Math.min(range.bottom, bottom); }
      else { range = { from, to: i, top, bottom, open: true }; if (draw) res.ranges.push(range); }
    }
  };

  const close = (i: number, price: number, reason: DowTrade['reason']) => {
    const q = pos!;
    const r = ((price - q.entry) * (q.up ? 1 : -1) - p.cost * (q.entry + price)) / q.risk;
    res.trades.push({ up: q.up, entryIdx: q.idx, exitIdx: i, entry: q.entry, exit: price, stop: q.first, target: q.target, reason, r });
    pos = null;
  };

  // the nearest liquidity at least targetR away in the trade's direction
  const liqTarget = (bull: boolean, entry: number, risk: number) => {
    let best = NaN;
    const far = (x: number) => (bull ? x >= entry + p.targetR * risk : x <= entry - p.targetR * risk);
    const nearer = (x: number) => Number.isNaN(best) || (bull ? x < best : x > best);
    for (const x of lines) if (x.up === bull && far(x.level) && nearer(x.level)) best = x.level;
    for (const x of pools) if (x.up === bull && far(x.price) && nearer(x.price)) best = x.price;
    return best;
  };
  // the liquidity on the stop's side between the entry and `beyond` past the stop (the
  // leg's own origin aside): the farthest such level, NaN when none
  const liqNearStop = (bull: boolean, entry: number, stop: number, beyond: number, origin: number) => {
    let far = NaN;
    const lo = bull ? stop - beyond : entry, hi = bull ? entry : stop + beyond;
    const check = (x: number) => { if (x > lo && x < hi && (Number.isNaN(far) || (bull ? x < far : x > far))) far = x; };
    for (const x of pools) if (x.up !== bull && x.idx !== origin) check(x.price);
    for (const x of lines) if (x.up !== bull) check(x.level);
    return far;
  };

  for (let i = 0; i < n; i++) {
    const q = i - S;
    if (q >= S) {
      if (isHigh(q)) newSwing({ up: true, idx: q, price: h[q] }, i);
      if (isLow(q)) newSwing({ up: false, idx: q, price: l[q] }, i);
    }

    // liquidity taken (and, for the sweep entries, the levels taken on this bar: the lowest
    // high one and the highest low one, all of which the close must take back)
    let sweptHigh = Infinity, sweptLow = -Infinity;
    if (lines.length) {
      let closed = false;
      for (const x of lines) {
        if (draw) x.to = i;
        if (x.up ? h[i] > x.level : l[i] < x.level) {
          x.open = false; x.sweptAt = i; x.to = i; closed = true;
          if (x.up) sweptHigh = Math.min(sweptHigh, x.level); else sweptLow = Math.max(sweptLow, x.level);
        }
      }
      if (closed) lines = lines.filter((x) => x.open);
    }
    if (h[i] > minHigh || l[i] < maxLow) {
      for (let j = pools.length - 1; j >= 0; j--) {
        const s = pools[j];
        if (s.up ? h[i] > s.price : l[i] < s.price) {
          if (s.up) tookHigh = i; else tookLow = i;
          if (p.mode === 'sweep') { if (s.up) sweptHigh = Math.min(sweptHigh, s.price); else sweptLow = Math.max(sweptLow, s.price); }
          pools.splice(j, 1);
        }
      }
      bounds();
    }
    if ((draw || p.noRange) && range?.open) {
      range.to = i;
      if ((c[i] > range.top && clean(i, true)) || (c[i] < range.bottom && clean(i, false))) range.open = false;
    }

    // the open trade: stop first, then target
    if (pos && i > pos.idx) {
      const P: Pos = pos;
      if (P.up ? l[i] <= P.stop : h[i] >= P.stop) close(i, P.up ? Math.min(o[i], P.stop) : Math.max(o[i], P.stop), 'stop');
      else if (!Number.isNaN(P.target) && (P.up ? h[i] >= P.target : l[i] <= P.target)) close(i, P.up ? Math.max(o[i], P.target) : Math.min(o[i], P.target), 'objectif');
      // 1 R gained: the stop to the entry (from the next bar on)
      else if (p.be && (P.up ? h[i] >= P.entry + P.risk && P.stop < P.entry : l[i] <= P.entry - P.risk && P.stop > P.entry)) P.stop = P.entry;
    }

    // a break of structure on a clean close
    for (let side = 0; side < 2; side++) {
      const bull = side === 0;
      const ref = bull ? refHigh : refLow;
      if (!ref || !(bull ? c[i] > ref.price : c[i] < ref.price) || !clean(i, bull)) continue;
      const turn = trend !== (bull ? 1 : -1);
      if (draw) res.breaks.push({ up: bull, from: ref.idx, idx: i, price: ref.price, turn });
      trend = bull ? 1 : -1;
      if (bull) refHigh = null; else refLow = null;
      if (pos && pos.up !== bull) close(i, c[i], 'retournement');
      // the leg's origin: its lowest low for a rise (highest high for a fall)
      let origin = ref.idx + 1;
      for (let j = ref.idx + 1; j <= i; j++) if (bull ? l[j] < l[origin] : h[j] > h[origin]) origin = j;
      // and its far end so far
      let far = origin;
      for (let j = origin + 1; j <= i; j++) if (bull ? h[j] > h[far] : l[j] < l[far]) far = j;
      let top: number, bottom: number, ob = origin;
      if (p.box === 'candle') {
        for (let j = origin; j >= Math.max(0, origin - 5); j--) if (bull ? c[j] < o[j] : c[j] > o[j]) { ob = j; break; }
        top = h[ob]; bottom = l[ob];
      } else {
        const ext = bull ? l[origin] : h[origin];
        const lvl = p.box === 'range' ? ref.price : ext + 0.5 * ((bull ? h[far] : l[far]) - ext);
        top = bull ? lvl : ext; bottom = bull ? ext : lvl;
      }
      if (zone && !zone.dead && !zone.used) zone.end = i;
      // a leg too small to count: the trend changes, no box
      if (p.minLeg > 0 && Math.abs((bull ? h[far] : l[far]) - (bull ? l[origin] : h[origin])) < p.minLeg * atr[i]) { zone = null; continue; }
      zone = { up: bull, ob, origin, start: i, top, bottom, end: i, used: false, dead: false, swept: (bull ? tookLow : tookHigh) > ref.idx };
      if (draw) res.zones.push(zone);
    }

    // a sweep: liquidity taken by a wick, the close back on the other side
    if (p.mode !== 'box' && !pos) {
      const a = allow ? allow[i] : 1;
      for (const up of [true, false]) {
        const lvl = up ? sweptLow : sweptHigh;
        if (!Number.isFinite(lvl) || !(up ? c[i] > lvl : c[i] < lvl)) continue;
        if (!((p.dir === 0 || p.dir === (up ? 1 : -1)) && (a === 1 || a === (up ? 2 : 3)))) continue;
        const entry = c[i], stop = up ? l[i] - p.pad * atr[i] : h[i] + p.pad * atr[i];
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || (p.maxCostR > 0 && (2 * p.cost * entry) / risk > p.maxCostR)) continue;
        const target = p.target === 'liq' ? liqTarget(up, entry, risk) : p.target === 'fixed' ? entry + (up ? 1 : -1) * p.targetR * risk : NaN;
        pos = { up, idx: i, entry, stop, target, risk, first: stop };
        break;
      }
    }

    // back into the box: the entry
    const z = zone;
    if (p.mode === 'box' && z && !z.used && !z.dead && i > z.start) {
      z.end = i;
      const up = z.up;
      const touched = up ? l[i] <= z.top : h[i] >= z.bottom;
      const through = up ? o[i] < z.bottom || c[i] < z.bottom : o[i] > z.top || c[i] > z.top;
      const a = allow ? allow[i] : 1;
      const ranging = p.noRange && !!range?.open && c[i] <= range.top && c[i] >= range.bottom;
      const allowed = (p.dir === 0 || p.dir === (up ? 1 : -1)) && (a === 1 || a === (up ? 2 : 3)) && (p.liq !== 'sweep' || z.swept) && !ranging;
      if (trend !== (up ? 1 : -1) || (p.maxAge > 0 && i - z.start > p.maxAge)) z.dead = true;
      else if (touched && allowed && !pos && !(up ? o[i] < z.bottom : o[i] > z.top)) {
        const pad = p.pad * atr[i];
        const reject = up ? c[i] > o[i] && c[i] > z.bottom : c[i] < o[i] && c[i] < z.top;
        if (p.entry === 'contact' || reject) {
          const contact = p.entry === 'contact';
          const entry = contact ? (up ? Math.min(o[i], z.top) : Math.max(o[i], z.bottom)) : c[i];
          let stop = up ? Math.min(z.bottom, contact ? z.bottom : l[i]) - pad : Math.max(z.top, contact ? z.top : h[i]) + pad;
          let risk = Math.abs(entry - stop);
          let skip = !(risk > 0);
          if (!skip && (p.liq === 'guard' || p.liq === 'beyond')) {
            const near = liqNearStop(up, entry, stop, (p.liq === 'guard' ? 0.5 : 1) * risk, z.origin);
            if (!Number.isNaN(near)) {
              if (p.liq === 'guard') skip = true;
              else {
                const moved = up ? near - pad : near + pad;
                if (Math.abs(entry - moved) > 2 * risk) skip = true;
                else if (up ? moved < stop : moved > stop) { stop = moved; risk = Math.abs(entry - stop); }
              }
            }
          }
          // the costs would eat the trade: too small a stop for this market
          if (!skip && p.maxCostR > 0 && (2 * p.cost * entry) / risk > p.maxCostR) skip = true;
          z.used = true;
          if (!skip) {
            const target = p.target === 'liq' ? liqTarget(up, entry, risk) : p.target === 'fixed' ? entry + (up ? 1 : -1) * p.targetR * risk : NaN;
            pos = { up, idx: i, entry, stop, target, risk, first: stop };
            // on a contact entry, the same bar may already reach the stop
            if (contact && (up ? l[i] <= stop : h[i] >= stop)) close(i, stop, 'stop');
          }
        }
      }
      if (!z.used && through) z.dead = true;
    }

    if (draw) {
      res.trend[i] = trend;
      res.refHigh[i] = refHigh ? refHigh.price : NaN;
      res.refLow[i] = refLow ? refLow.price : NaN;
    }
  }
  if (pos) {
    res.open = pos;
    if (!draw) close(n - 1, c[n - 1], 'fin');
  }
  return res;
}

// The Dow trend of a higher timeframe on each bar: the bars grouped by `seconds` (or by
// `bars` bars for tick charts), the trend (swing 3, clean close 50 %) of the last higher
// bar already complete when the bar opens (an entry may come during it).
export function dowHigherTrend(b: DowBars, seconds: number, bars = 20): Int8Array {
  const bucket = new Float64Array(b.n);
  for (let i = 0; i < b.n; i++) bucket[i] = seconds ? Math.floor(b.t[i] / seconds) : Math.floor(i / bars);
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  const idx = new Int32Array(b.n);
  for (let i = 0; i < b.n; i++) {
    if (i === 0 || bucket[i] !== bucket[i - 1]) { t.push(b.t[i]); o.push(b.o[i]); h.push(b.h[i]); l.push(b.l[i]); c.push(b.c[i]); }
    else { const k = t.length - 1; if (b.h[i] > h[k]) h[k] = b.h[i]; if (b.l[i] < l[k]) l[k] = b.l[i]; c[k] = b.c[i]; }
    idx[i] = t.length - 1;
  }
  const trend = dowRun({ n: t.length, t, o, h, l, c }, { ...DOW_DEFAULTS }, undefined, true).trend;
  const out = new Int8Array(b.n);
  for (let i = 1; i < b.n; i++) {
    const j = i - 1;
    const closed = bucket[i] !== bucket[j] ? idx[j] : idx[j] - 1;
    out[i] = closed >= 0 ? trend[closed] : 0;
  }
  return out;
}

// the entries allowed on each bar (see dowRun's `allow`): within the active hours, and in
// the higher timeframe's direction
export function dowAllow(n: number, hours?: ArrayLike<number>, htf?: Int8Array): Uint8Array | undefined {
  if (!hours && !htf) return undefined;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hours && !hours[i]) continue;
    out[i] = !htf ? 1 : htf[i] === 1 ? 2 : htf[i] === -1 ? 3 : 0;
  }
  return out;
}
