import type { Features } from './features';
import { DEC } from '../i18n/lang';

// What a robot is made of: an entry signal from one of the user's indicators, a
// market-regime filter (trade the trend, stay out of ranges) and a stop distance.
// Signals are read on a bar's close; the entry is at the next bar's open.

// hidden: left out of the robot indicator's list (variants of a visible signal)
export type Signal = { id: string; label: string; family: string; hidden?: boolean; make: (f: Features) => Int8Array };
// tfs: the only timeframes the filter applies to (a higher timeframe must be higher)
export type Filter = { id: string; label: string; intraday?: boolean; tfs?: string[]; make: (f: Features) => { long: Uint8Array; short: Uint8Array } };
// signal: the robot's entry signal, for stops placed from what the signal saw (the hour range)
export type Stop = { id: string; label: string; make: (f: Features, signal?: string) => { long: Float64Array; short: Float64Array } };

const cross = (a: Float64Array, b: Float64Array, i: number) => a[i - 1] <= b[i - 1] && a[i] > b[i];
const under = (a: Float64Array, b: Float64Array, i: number) => a[i - 1] >= b[i - 1] && a[i] < b[i];

function build(f: Features, fn: (i: number) => number): Int8Array {
  const out = new Int8Array(f.b.n);
  for (let i = 1; i < f.b.n; i++) out[i] = fn(i);
  return out;
}

// ---------------------------------------------------------------- signals

const tshSignals: Signal[] = [];
for (const src of ['WMA', 'EMA']) {
  for (const len of [10, 20, 40]) {
    const tag = `${src} ${len}`;
    tshSignals.push(
      { id: `tsh_sig_${src}${len}`, family: 'Tsh_Arrow', label: `Tsh_Arrow ${tag} · flèches de signal`, make: (f) => { const s = f.tsh(src, len); return build(f, (i) => (s.sigUp[i] ? 1 : s.sigDn[i] ? -1 : 0)); } },
      { id: `tsh_start_${src}${len}`, family: 'Tsh_Arrow', label: `Tsh_Arrow ${tag} · départs de tendance (points)`, make: (f) => { const s = f.tsh(src, len); return build(f, (i) => (s.startUp[i] ? 1 : s.startDn[i] ? -1 : 0)); } },
      { id: `tsh_macd_${src}${len}`, family: 'Tsh_Arrow', label: `Tsh_Arrow ${tag} · flèches DEMA MACD`, make: (f) => { const s = f.tsh(src, len); return build(f, (i) => (s.macdUp[i] ? 1 : s.macdDn[i] ? -1 : 0)); } },
      { id: `tsh_flip_${src}${len}`, family: 'Tsh_Arrow', label: `Tsh_Arrow ${tag} · changement de côté de la SuperTrend`, make: (f) => { const s = f.tsh(src, len); return build(f, (i) => (s.trend[i] === 1 && s.trend[i - 1] === -1 ? 1 : s.trend[i] === -1 && s.trend[i - 1] === 1 ? -1 : 0)); } },
    );
  }
}

const zlSignals: Signal[] = [
  ...[20, 50, 100, 200].map((p): Signal => ({
    id: `zl_cross_${p}`, family: 'ZLEMA', label: `Clôture qui croise la ZLEMA ${p}`,
    make: (f) => { const z = f.zlema(p), c = f.b.c; return build(f, (i) => (cross(c, z, i) ? 1 : under(c, z, i) ? -1 : 0)); },
  })),
  ...[[10, 50], [20, 100], [50, 200]].map(([a, b]): Signal => ({
    id: `zl_x_${a}_${b}`, family: 'ZLEMA', label: `ZLEMA ${a} qui croise la ZLEMA ${b}`,
    make: (f) => { const x = f.zlema(a), y = f.zlema(b); return build(f, (i) => (cross(x, y, i) ? 1 : under(x, y, i) ? -1 : 0)); },
  })),
  ...[20, 50].map((p): Signal => ({
    id: `zl_turn_${p}`, family: 'ZLEMA', label: `Retournement de pente de la ZLEMA ${p}`,
    make: (f) => {
      const z = f.zlema(p);
      return build(f, (i) => (i < 2 ? 0 : z[i] > z[i - 1] && z[i - 1] <= z[i - 2] ? 1 : z[i] < z[i - 1] && z[i - 1] >= z[i - 2] ? -1 : 0));
    },
  })),
];

const speSignals: Signal[] = [];
for (const k of [50, 100, 200]) {
  speSignals.push(
    {
      id: `spe_rev_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · retour au-dessus du plancher 1 % / sous le plafond 99 %`,
      make: (f) => { const e = f.spe(k, k), c = f.b.c; return build(f, (i) => (cross(c, e.p01, i) ? 1 : under(c, e.p99, i) ? -1 : 0)); },
    },
    {
      id: `spe_sig_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · clôture qui croise le signal`,
      make: (f) => { const e = f.spe(k, k), c = f.b.c; return build(f, (i) => (cross(c, e.sig, i) ? 1 : under(c, e.sig, i) ? -1 : 0)); },
    },
    {
      id: `spe_mid_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · clôture qui croise le milieu 50 %`,
      make: (f) => { const e = f.spe(k, k), c = f.b.c; return build(f, (i) => (cross(c, e.mid, i) ? 1 : under(c, e.mid, i) ? -1 : 0)); },
    },
    {
      // "escalier": a new k-bar high after a pause of 10 bars at least (or low)
      id: `spe_break_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · reprise de l’escalier (nouveau plus haut / plus bas après une pause)`,
      make: (f) => {
        const e = f.spe(k, k);
        let lastUp = -1, lastDn = -1;
        return build(f, (i) => {
          let s = 0;
          if (e.hh[i] > e.hh[i - 1]) { if (i - lastUp > 10) s = 1; lastUp = i; }
          if (e.ll[i] < e.ll[i - 1]) { if (i - lastDn > 10) s = -1; lastDn = i; }
          return s;
        });
      },
    },
  );
}

const srSignals: Signal[] = [];
for (const [lk, ld] of [[14, 3], [50, 10], [200, 200]]) {
  srSignals.push(
    {
      id: `sr_kd_${lk}`, family: 'Sto+RSI', label: `Sto+RSI ${lk}/${ld} · K qui croise D (sous 50 à l’achat, au-dessus à la vente)`,
      make: (f) => { const s = f.stoRsi(lk, ld); return build(f, (i) => (cross(s.k, s.d, i) && s.k[i] < 50 ? 1 : under(s.k, s.d, i) && s.k[i] > 50 ? -1 : 0)); },
    },
    {
      id: `sr_ext_${lk}`, family: 'Sto+RSI', label: `Sto+RSI ${lk}/${ld} · K qui ressort de la zone 20 / 80`,
      make: (f) => {
        const s = f.stoRsi(lk, ld);
        return build(f, (i) => (s.k[i - 1] <= 20 && s.k[i] > 20 ? 1 : s.k[i - 1] >= 80 && s.k[i] < 80 ? -1 : 0));
      },
    },
  );
}
srSignals.push({
  id: 'sr_rsi', family: 'Sto+RSI', label: 'Sto+RSI · RSI 14 qui ressort de 30 / 70',
  make: (f) => { const r = f.rsi(14); return build(f, (i) => (r[i - 1] <= 30 && r[i] > 30 ? 1 : r[i - 1] >= 70 && r[i] < 70 ? -1 : 0)); },
});

const haSignals: Signal[] = [
  ...[6, 12].map((len): Signal => ({
    id: `ha_lr_${len}`, family: 'HA', label: `HA régression linéaire ${len} · changement de couleur`,
    make: (f) => { const h = f.ha('Linear Regression', len); return build(f, (i) => (h[i] === 1 && h[i - 1] === -1 ? 1 : h[i] === -1 && h[i - 1] === 1 ? -1 : 0)); },
  })),
  {
    id: 'ha_ha', family: 'HA', label: 'Heikin Ashi · changement de couleur',
    make: (f) => { const h = f.ha('Heikin Ashi', 6); return build(f, (i) => (h[i] === 1 && h[i - 1] === -1 ? 1 : h[i] === -1 && h[i - 1] === 1 ? -1 : 0)); },
  },
];

// Imbalance (fair value gap): the price comes back into the last untouched gap and
// closes out of it in the gap's direction
const fvgSignals: Signal[] = [{
  id: 'fvg_retest', family: 'Imbalance', label: 'Imbalance · retour dans la dernière zone de déséquilibre puis rejet',
  make: (f) => {
    const { h, l, c } = f.b;
    let bull: { top: number; bot: number } | null = null, bear: { top: number; bot: number } | null = null;
    return build(f, (i) => {
      let s = 0;
      if (bull) {
        if (c[i] < bull.bot) bull = null;
        else if (l[i] <= bull.top && c[i] > bull.top) { s = 1; bull = null; }
      }
      if (bear) {
        if (c[i] > bear.top) bear = null;
        else if (h[i] >= bear.bot && c[i] < bear.bot) { s = -1; bear = null; }
      }
      if (i >= 2 && l[i] > h[i - 2]) bull = { top: l[i], bot: h[i - 2] };
      if (i >= 2 && h[i] < l[i - 2]) bear = { top: l[i - 2], bot: h[i] };
      return s;
    });
  },
}];

// round 2: the staircase with other windows and pauses
const stairSignals: Signal[] = [];
for (const k of [20, 30, 50, 100, 200]) {
  for (const pause of [5, 20, 40]) {
    stairSignals.push({
      id: `spe_break_${k}_p${pause}`, family: 'Stoch Price Envelope',
      label: `Stoch Price Envelope ${k} · reprise de l’escalier après ${pause} bougies de pause`,
      make: (f) => {
        const e = f.spe(k, k);
        let lastUp = -1, lastDn = -1;
        return build(f, (i) => {
          let s = 0;
          if (e.hh[i] > e.hh[i - 1]) { if (i - lastUp > pause) s = 1; lastUp = i; }
          if (e.ll[i] < e.ll[i - 1]) { if (i - lastDn > pause) s = -1; lastDn = i; }
          return s;
        });
      },
    });
  }
}
for (const k of [20, 30]) {
  stairSignals.push({
    id: `spe_break_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · reprise de l’escalier (nouveau plus haut / plus bas après une pause)`,
    make: (f) => {
      const e = f.spe(k, k);
      let lastUp = -1, lastDn = -1;
      return build(f, (i) => {
        let s = 0;
        if (e.hh[i] > e.hh[i - 1]) { if (i - lastUp > 10) s = 1; lastUp = i; }
        if (e.ll[i] < e.ll[i - 1]) { if (i - lastDn > 10) s = -1; lastDn = i; }
        return s;
      });
    },
  });
}

// Stoch Price Envelope, range or trend. The indicator's lines: the red ceiling (99 %),
// the green floor (1 %) and the orange signal. In a range the price swings between flat
// red and green lines and the orange line stays near the middle; in a trend the
// envelope climbs in steps and the price bounces between the orange line and the red
// one (the green one when falling).
type Env = ReturnType<Features['spe']>;
// the staircase's side on bar i: the last new extreme and where the orange line sits
const stairUp = (e: Env, age: { up: Int32Array; dn: Int32Array }, i: number) => age.up[i] < age.dn[i] && e.sigPct[i] > 50;
const stairDn = (e: Env, age: { up: Int32Array; dn: Int32Array }, i: number) => age.dn[i] < age.up[i] && e.sigPct[i] < 50;
const envSignals: Signal[] = [];
for (const k of [50, 100, 200]) {
  for (const line of ['sig', 'mid'] as const) {
    envSignals.push({
      id: `env_pb_${line}_${k}`, family: 'Stoch Price Envelope',
      label: `Stoch Price Envelope ${k} · tendance en escalier, rebond sur la ligne ${line === 'sig' ? 'orange (signal)' : 'du milieu 50 %'}`,
      make: (f) => {
        const e = f.spe(k, k), age = f.speAge(k), x = e[line], { h, l, c } = f.b;
        return build(f, (i) => (l[i] <= x[i] && l[i - 1] > x[i - 1] && c[i] > x[i] && stairUp(e, age, i) ? 1
          : h[i] >= x[i] && h[i - 1] < x[i - 1] && c[i] < x[i] && stairDn(e, age, i) ? -1 : 0));
      },
    });
  }
  for (const z of [5, 15]) {
    envSignals.push({
      id: `env_rev${z}_${k}`, family: 'Stoch Price Envelope',
      label: `Stoch Price Envelope ${k} · retour au-dessus des ${z} % bas du canal (achat près du vert) / sous les ${z} % hauts (vente près du rouge)`,
      make: (f) => {
        const e = f.spe(k, k), c = f.b.c;
        const lo = (i: number) => e.ll[i] + (z / 100) * (e.hh[i] - e.ll[i]), hi = (i: number) => e.hh[i] - (z / 100) * (e.hh[i] - e.ll[i]);
        return build(f, (i) => (c[i - 1] <= lo(i - 1) && c[i] > lo(i) ? 1 : c[i - 1] >= hi(i - 1) && c[i] < hi(i) ? -1 : 0));
      },
    });
  }
  envSignals.push({
    id: `env_osig_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · la ligne orange passe au-dessus / au-dessous du milieu`,
    make: (f) => { const s = f.spe(k, k).sigPct; return build(f, (i) => (s[i - 1] <= 50 && s[i] > 50 ? 1 : s[i - 1] >= 50 && s[i] < 50 ? -1 : 0)); },
  });
}
// with a confirmation (fewer, surer entries): in the staircase, a touch of the orange line
// then, within 5 bars, a close above the previous bar's high (below its low when falling);
// in the channel's bottom 15 % (top 15 %), a rising (falling) bar closing beyond the previous one
for (const k of [50, 100, 200]) {
  envSignals.push({
    id: `env_pbr_${k}`, family: 'Stoch Price Envelope',
    label: `Stoch Price Envelope ${k} · escalier, retour sur la ligne orange puis reprise (clôture au-delà de la bougie précédente)`,
    make: (f) => {
      const e = f.spe(k, k), age = f.speAge(k), x = e.sig, { o, h, l, c } = f.b;
      let touchUp = -99, touchDn = -99;
      return build(f, (i) => {
        if (stairUp(e, age, i) && l[i] <= x[i]) touchUp = i;
        if (stairDn(e, age, i) && h[i] >= x[i]) touchDn = i;
        if (i - touchUp <= 5 && i > touchUp && stairUp(e, age, i) && c[i] > h[i - 1] && c[i] > o[i] && c[i] > x[i]) { touchUp = -99; return 1; }
        if (i - touchDn <= 5 && i > touchDn && stairDn(e, age, i) && c[i] < l[i - 1] && c[i] < o[i] && c[i] < x[i]) { touchDn = -99; return -1; }
        return 0;
      });
    },
  });
  envSignals.push({
    id: `env_rrv_${k}`, family: 'Stoch Price Envelope',
    label: `Stoch Price Envelope ${k} · retournement confirmé au bord du canal (bas 15 % à l’achat, haut 15 % à la vente)`,
    make: (f) => {
      const e = f.spe(k, k), { o, h, l, c } = f.b;
      const zone = (i: number) => 0.15 * (e.hh[i] - e.ll[i]);
      const nearLow = (i: number) => l[i] <= e.ll[i] + zone(i), nearHigh = (i: number) => h[i] >= e.hh[i] - zone(i);
      return build(f, (i) => (i >= 3 && (nearLow(i) || nearLow(i - 1) || nearLow(i - 2)) && c[i] > o[i] && c[i] > h[i - 1] ? 1
        : i >= 3 && (nearHigh(i) || nearHigh(i - 1) || nearHigh(i - 2)) && c[i] < o[i] && c[i] < l[i - 1] ? -1 : 0));
    },
  });
}
for (const k of [20, 50]) {
  envSignals.push({
    id: `env_kx_${k}`, family: 'Stoch Price Envelope', label: `Stoch Price Envelope ${k} · stochastique qui ressort de 20 / 80`,
    make: (f) => { const s = f.spe(k, k).kPct; return build(f, (i) => (s[i - 1] <= 20 && s[i] > 20 ? 1 : s[i - 1] >= 80 && s[i] < 80 ? -1 : 0)); },
  });
}

// Hour range (the user's "XAUUSD 1H Closed Ref"): the candle of hour H, Paris time,
// makes a range; a close out of it gives the day its direction. Variants: the range's
// length, how long it stays valid, how clear the close must be, and whether only the
// first break counts or each change of side (the script's bias), or the first break
// taken the other way (late in the day, breaks come back into the range more often).
//   id: hr_<H>_<length>_<window>_<close>_<mode>
export const HR_LENGTHS: Record<string, number> = { '30m': 30, '1h': 60, '2h': 120, '4h': 240 };
const HR_LEN_LABEL: Record<string, string> = { '30m': '30 minutes', '1h': '1 heure', '2h': '2 heures', '4h': '4 heures' };
export const HR_WINDOWS = ['d', '4', '8'] as const;
const HR_WINDOW_LABEL: Record<string, string> = { d: 'jusqu’à 23 h', '4': 'pendant 4 h', '8': 'pendant 8 h' };
export const HR_CLOSES = ['c', 'm', 'b'] as const;
const HR_CLOSE_LABEL: Record<string, string> = {
  c: 'clôture hors du range',
  m: 'clôture hors du range d’au moins 20 % de sa hauteur',
  b: 'grande bougie (corps ≥ 60 %) qui clôture hors du range',
};
export const HR_MODES = ['x', 'f', 'r'] as const;
const HR_MODE_LABEL: Record<string, string> = { x: 'à chaque changement de côté', f: 'première cassure seulement', r: 'première cassure prise à l’envers (retour dans le range)' };

export function parseHourRange(id: string): { H: number; len: number; win: string; close: string; mode: string } | null {
  const m = /^hr_(\d+)_(\w+?)_(d|\d+)_([a-z])_([a-z])$/.exec(id);
  return m && HR_LENGTHS[m[2]] ? { H: Number(m[1]), len: HR_LENGTHS[m[2]], win: m[3], close: m[4], mode: m[5] } : null;
}

// the time (Paris local) a range ending at `end` stops being traded: 23:00 (the end of
// the gold / forex trading day), the next day's when the range ends less than an hour before
export function hrExpiry(end: number, win: string): number {
  if (win !== 'd') return end + Number(win) * 3600;
  let e = Math.floor((end - 82800) / 86400) * 86400 + 82800;
  if (e < end) e += 86400;
  return e - end < 3600 ? e + 86400 : e;
}

function hourBreak(f: Features, id: string): Int8Array {
  const { H, len, win, close, mode } = parseHourRange(id)!;
  const r = f.hourRange(H, len), p = f.local(), roll = f.rollover(), { o, h, l, c, n } = f.b;
  const out = new Int8Array(n);
  let bias = 0, lastEnd = NaN, exp = 0;
  for (let i = 1; i < n; i++) {
    const hi = r.hi[i], lo = r.lo[i];
    if (!(hi >= lo)) continue;
    if (r.end[i] !== lastEnd) { lastEnd = r.end[i]; bias = 0; exp = hrExpiry(lastEnd, win); }
    // nothing read during the forex rollover (spreads blow out, bid-only data dips)
    if (p[i] >= exp || roll[i]) continue;
    const m = close === 'm' ? 0.2 * (hi - lo) : 0;
    let up = c[i] > hi + m, dn = c[i] < lo - m;
    if (close === 'b') {
      const body = Math.abs(c[i] - o[i]) >= 0.6 * (h[i] - l[i]);
      up &&= body && c[i] > o[i];
      dn &&= body && c[i] < o[i];
    }
    if (mode !== 'x' && bias) continue;
    const s = mode === 'r' ? -1 : 1;
    if (up && bias !== 1) { out[i] = s; bias = 1; } else if (dn && bias !== -1) { out[i] = -s; bias = -1; }
  }
  return out;
}

const hrSignals: Signal[] = [];
for (let H = 0; H < 24; H++) {
  for (const len of Object.keys(HR_LENGTHS)) for (const win of HR_WINDOWS) for (const close of HR_CLOSES) for (const mode of HR_MODES) {
    const id = `hr_${H}_${len}_${win}_${close}_${mode}`;
    hrSignals.push({
      id, family: 'Range horaire',
      // the script's own settings stay in the indicator's list, the variants are for the lab
      hidden: !(len === '1h' && win === 'd' && close === 'c' && mode === 'x'),
      label: `Range de ${H} h (heure de Paris, ${HR_LEN_LABEL[len]}) · ${HR_CLOSE_LABEL[close]}, ${HR_MODE_LABEL[mode]}, ${HR_WINDOW_LABEL[win]}`,
      make: (f) => hourBreak(f, id),
    });
  }
}

export const SIGNALS: Signal[] = [...tshSignals, ...zlSignals, ...speSignals, ...srSignals, ...haSignals, ...fvgSignals, ...stairSignals, ...envSignals, ...hrSignals];

// ---------------------------------------------------------------- regime filters

type Allow = { long: Uint8Array; short: Uint8Array };
function allow(f: Features, fn: (i: number) => [boolean, boolean]): Allow {
  const n = f.b.n, long = new Uint8Array(n), short = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const [a, b] = fn(i); long[i] = a ? 1 : 0; short[i] = b ? 1 : 0; }
  return { long, short };
}
const both = (f: Features, fn: (i: number) => boolean) => allow(f, (i) => { const v = fn(i); return [v, v]; });
const and = (x: Allow, y: Allow): Allow => ({ long: x.long.map((v, i) => v & y.long[i]), short: x.short.map((v, i) => v & y.short[i]) });

const zlTrend = (f: Features, p: number) => {
  const z = f.zlema(p), c = f.b.c;
  return allow(f, (i) => [c[i] > z[i] && z[i] > z[i - 1], c[i] < z[i] && z[i] < z[i - 1]]);
};
const adxTrend = (f: Features, th: number) => { const a = f.adx(14); return allow(f, (i) => [a.adx[i] > th && a.pdi[i] > a.mdi[i], a.adx[i] > th && a.mdi[i] > a.pdi[i]]); };
const tshTrend = (f: Features) => { const s = f.tsh('WMA', 20); return allow(f, (i) => [s.trend[i] === 1, s.trend[i] === -1]); };
// the envelope's "staircase": new highs of the last k bars within w bars and no new low (or the reverse)
const stairs = (f: Features, k = 200, w = 20) => {
  const e = f.spe(k, k), n = f.b.n;
  const lastUp = new Int32Array(n).fill(-1e9), lastDn = new Int32Array(n).fill(-1e9);
  for (let i = 1; i < n; i++) {
    lastUp[i] = e.hh[i] > e.hh[i - 1] ? i : lastUp[i - 1];
    lastDn[i] = e.ll[i] < e.ll[i - 1] ? i : lastDn[i - 1];
  }
  return allow(f, (i) => [i - lastUp[i] <= w && lastUp[i] > lastDn[i], i - lastDn[i] <= w && lastDn[i] > lastUp[i]]);
};
// London + New York hours (UTC)
const session = (f: Features) => both(f, (i) => { const hr = new Date(f.b.t[i] * 1000).getUTCHours(); return hr >= 7 && hr < 20; });

// Stoch Price Envelope regimes, on this timeframe (b_) or a higher one (h<tf>_): a
// range on 4 hours is often a trend on 15 minutes going from one 4-hour line to the other
const HTF_SEC: Record<string, number> = { '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const HTF_LABEL: Record<string, string> = { '1h': '1 heure', '4h': '4 heures', '1d': 'journalier', '1w': 'hebdomadaire' };
// the higher timeframes looked at from each timeframe
const HTF_OF: Record<string, string[]> = { '15m': ['1h', '4h'], '30m': ['4h', '1d'], '1h': ['4h', '1d'], '4h': ['1d', '1w'], '1d': ['1w'] };
type Regime = 'trend' | 'range' | 'notrange' | 'room' | 'edge' | 'rangeroom' | 'stairs';
const REGIME_LABEL: Record<Regime, string> = {
  trend: 'tendance (ligne orange dans le haut du canal à l’achat, dans le bas à la vente)',
  range: 'range (bornes rouge et verte plates, ligne orange au milieu)',
  notrange: 'pas de range, dans le sens de la ligne orange',
  room: 'de la place jusqu’à la borne opposée (achat sous 70 % du canal, vente au-dessus de 30 %)',
  edge: 'range et prix au bord (achat dans les 25 % bas, vente dans les 25 % hauts)',
  rangeroom: 'range, achat dans la moitié basse (vers le rouge), vente dans la moitié haute (vers le vert)',
  stairs: 'escalier (dernier nouvel extrême récent et dans le sens du trade)',
};
// what envelope k of g says on its bar j for the price p: [long allowed, short allowed]
function regime(g: Features, k: number, j: number, p: number, r: Regime): [boolean, boolean] {
  const e = g.spe(k, k), age = g.speAge(k);
  const s = e.sigPct[j], width = e.hh[j] - e.ll[j];
  if (!(width > 0) || !Number.isFinite(s)) return [false, false];
  const pos = ((p - e.ll[j]) / width) * 100;
  // both lines flat for a fifth of the window, the orange line near the middle
  const ranging = Math.min(age.up[j], age.dn[j]) >= Math.round(k / 5) && s >= 35 && s <= 65;
  switch (r) {
    case 'trend': return [s > 60, s < 40];
    case 'range': return [ranging, ranging];
    case 'notrange': return [!ranging && s > 50, !ranging && s < 50];
    case 'room': return [pos < 70, pos > 30];
    case 'edge': return [ranging && pos < 25, ranging && pos > 75];
    case 'rangeroom': return [ranging && pos < 50, ranging && pos > 50];
    case 'stairs': return [age.up[j] < age.dn[j] && age.up[j] <= k / 4, age.dn[j] < age.up[j] && age.dn[j] <= k / 4];
  }
}
// bars of the robot's own timeframe its filter needs before it says anything: a
// higher-timeframe envelope k needs 2k higher bars (the window, then the orange line's average)
const TF_SEC: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1D': 86400, '1W': 604800 };
export function barsNeeded(filter: string, tf: string): number {
  const m = /^(?:s_)?h(\d[hdw])_[a-z]+_(\d+)$/.exec(filter);
  if (!m || !TF_SEC[tf]) return 1500;
  return Math.max(1500, Math.ceil((HTF_SEC[m[1]] / TF_SEC[tf]) * (2 * Number(m[2]) + 20)));
}
const envFilters: Filter[] = [];
for (const k of [50, 100, 200]) {
  for (const r of ['trend', 'range', 'notrange'] as Regime[]) {
    envFilters.push({ id: `b_${r}_${k}`, label: `Stoch Price Envelope ${k} de cette unité : ${REGIME_LABEL[r]}`, make: (f) => allow(f, (i) => regime(f, k, i, f.b.c[i], r)) });
  }
}
const htfRegime = (f: Features, sec: number, k: number, r: Regime) => {
  const { f: g, at } = f.htf(sec);
  return allow(f, (i) => (at[i] >= 0 ? regime(g, k, at[i], f.b.c[i], r) : [false, false]));
};
for (const [H, sec] of Object.entries(HTF_SEC)) {
  const tfs = Object.keys(HTF_OF).filter((tf) => HTF_OF[tf].includes(H));
  for (const k of [50, 100, 200]) {
    for (const r of Object.keys(REGIME_LABEL) as Regime[]) {
      envFilters.push({ id: `h${H}_${r}_${k}`, tfs, label: `Stoch Price Envelope ${k} en ${HTF_LABEL[H]} : ${REGIME_LABEL[r]}`, make: (f) => htfRegime(f, sec, k, r) });
    }
    // the same during the London and New York sessions only (intraday)
    for (const r of ['range', 'rangeroom', 'trend', 'notrange'] as Regime[]) {
      envFilters.push({
        id: `s_h${H}_${r}_${k}`, tfs: tfs.filter((tf) => tf !== '1d'), intraday: true,
        label: `Séances Londres + New York et Stoch Price Envelope ${k} en ${HTF_LABEL[H]} : ${REGIME_LABEL[r]}`,
        make: (f) => and(session(f), htfRegime(f, sec, k, r)),
      });
    }
  }
}

export const FILTERS: Filter[] = [
  { id: 'none', label: 'Aucun filtre', make: (f) => both(f, () => true) },
  { id: 'adx20', label: 'Tendance ADX 14 > 20 dans le sens du DI', make: (f) => adxTrend(f, 20) },
  { id: 'adx25', label: 'Tendance ADX 14 > 25 dans le sens du DI', make: (f) => adxTrend(f, 25) },
  { id: 'chop50', label: 'Hors range : Choppiness 14 < 50', make: (f) => { const x = f.chop(14); return both(f, (i) => x[i] < 50); } },
  { id: 'er30', label: 'Hors range : efficacité de Kaufman 20 > 0,3', make: (f) => { const x = f.er(20); return both(f, (i) => x[i] > 0.3); } },
  { id: 'zl200', label: 'Dans le sens de la ZLEMA 200 (prix et pente)', make: (f) => zlTrend(f, 200) },
  { id: 'zl100', label: 'Dans le sens de la ZLEMA 100 (prix et pente)', make: (f) => zlTrend(f, 100) },
  { id: 'tsh', label: 'Dans le sens de la SuperTrend Tsh_Arrow WMA 20', make: tshTrend },
  { id: 'stairs', label: 'Escalier du Stoch Price Envelope 200 (nouveaux extrêmes récents)', make: stairs },
  { id: 'adx20_zl200', label: 'ADX > 20 et sens de la ZLEMA 200', make: (f) => and(adxTrend(f, 20), zlTrend(f, 200)) },
  { id: 'er30_tsh', label: 'Efficacité > 0,3 et sens de la Tsh_Arrow', make: (f) => { const x = f.er(20); return and(both(f, (i) => x[i] > 0.3), tshTrend(f)); } },
  { id: 'chop50_stairs', label: 'Choppiness < 50 et escalier du Stoch Price Envelope', make: (f) => { const x = f.chop(14); return and(both(f, (i) => x[i] < 50), stairs(f)); } },
  { id: 'session', label: 'Séances Londres + New York (7 h – 20 h UTC)', intraday: true, make: session },
  { id: 'session_zl200', label: 'Séances Londres + New York et sens de la ZLEMA 200', intraday: true, make: (f) => and(session(f), zlTrend(f, 200)) },
  // round 2
  { id: 'zl50', label: 'Dans le sens de la ZLEMA 50 (prix et pente)', make: (f) => zlTrend(f, 50) },
  { id: 'zl400', label: 'Dans le sens de la ZLEMA 400 (prix et pente)', make: (f) => zlTrend(f, 400) },
  ...[[100, 10], [100, 40], [200, 40], [50, 20]].map(([k, w]): Filter => ({
    id: `stairs_${k}_${w}`, label: `Escalier du Stoch Price Envelope ${k} (nouvel extrême dans les ${w} dernières bougies)`, make: (f) => stairs(f, k, w),
  })),
  { id: 'stairs_zl200', label: 'Escalier du Stoch Price Envelope et sens de la ZLEMA 200', make: (f) => and(stairs(f), zlTrend(f, 200)) },
  { id: 'tsh_zl200', label: 'Sens de la Tsh_Arrow et de la ZLEMA 200', make: (f) => and(tshTrend(f), zlTrend(f, 200)) },
  // round 3: the higher timeframe's trend, volatility waking up
  ...[[4, 50], [4, 20], [6, 50]].map(([m, p]): Filter => ({
    id: `htf${m}_zl${p}`, label: `Tendance de l’unité ×${m} (ZLEMA ${p}, dernière bougie close)`,
    make: (f) => { const h = f.htfTrend(m, p); return allow(f, (i) => [h[i] === 1, h[i] === -1]); },
  })),
  { id: 'atrx', label: 'Volatilité qui se réveille (ATR 14 au-dessus de sa moyenne 50)', make: (f) => { const x = f.atrExpanding(); return both(f, (i) => x[i] === 1); } },
  { id: 'htf4_atrx', label: 'Tendance de l’unité ×4 et volatilité qui se réveille', make: (f) => { const h = f.htfTrend(4, 50), x = f.atrExpanding(); return allow(f, (i) => [h[i] === 1 && x[i] === 1, h[i] === -1 && x[i] === 1]); } },
  { id: 'htf4_zl200', label: 'Tendance de l’unité ×4 et sens de la ZLEMA 200', make: (f) => { const h = f.htfTrend(4, 50); return and(allow(f, (i) => [h[i] === 1, h[i] === -1]), zlTrend(f, 200)); } },
  ...envFilters,
];

// ---------------------------------------------------------------- stops (distance from the entry)

const atrStop = (k: number): Stop => ({
  id: `atr${k}`, label: `${String(k).replace('.', DEC)} × ATR 14`,
  make: (f) => { const a = f.atr(14), d = a.map((v) => v * k); return { long: d, short: d }; },
});
const swingStop = (p: number): Stop => ({
  id: `swing${p}`, label: `Sous le plus bas / au-dessus du plus haut des ${p} dernières bougies`,
  make: (f) => {
    const a = f.atr(14), lo = f.lowest(p), hi = f.highest(p), c = f.b.c, n = f.b.n;
    const long = new Float64Array(n), short = new Float64Array(n);
    // at least half an ATR, at most 5 ATR
    const clamp = (d: number, i: number) => Math.min(5 * a[i], Math.max(0.5 * a[i], d));
    for (let i = 0; i < n; i++) { long[i] = clamp(c[i] - lo[i], i); short[i] = clamp(hi[i] - c[i], i); }
    return { long, short };
  },
});

// from the hour range the signal broke (no stop, so no trade, for other signals): its
// opposite side, its middle, or just back inside the broken side. Against the break
// (mode r), the same share of the range's height: all of it, half, a quarter.
const rangeStop = (id: string, label: string, level: (hi: number, lo: number, side: 1 | -1) => number, min: number, share: number): Stop => ({
  id, label,
  make: (f, signal) => {
    const n = f.b.n, long = new Float64Array(n).fill(NaN), short = new Float64Array(n).fill(NaN);
    const hr = signal ? parseHourRange(signal) : null;
    if (!hr) return { long, short };
    const r = f.hourRange(hr.H, hr.len), a = f.atr(14), c = f.b.c;
    for (let i = 0; i < n; i++) {
      const hi = r.hi[i], lo = r.lo[i];
      if (!(hi >= lo)) continue;
      if (hr.mode === 'r') { long[i] = short[i] = Math.max(min * a[i], share * (hi - lo)); continue; }
      long[i] = Math.max(min * a[i], c[i] - level(hi, lo, 1));
      short[i] = Math.max(min * a[i], level(hi, lo, -1) - c[i]);
    }
    return { long, short };
  },
});

export const STOPS: Stop[] = [
  atrStop(1), atrStop(1.5), atrStop(2), atrStop(3), swingStop(5), swingStop(10), atrStop(0.75), atrStop(2.5), swingStop(20),
  rangeStop('rng_opp', 'De l’autre côté du range horaire (à l’envers : sa hauteur)', (hi, lo, s) => (s > 0 ? lo : hi), 0.25, 1),
  rangeStop('rng_mid', 'Au milieu du range horaire (à l’envers : la moitié de sa hauteur)', (hi, lo) => (hi + lo) / 2, 0.25, 0.5),
  rangeStop('rng_edge', 'Juste revenu dans le range horaire, au moins ½ ATR (à l’envers : un quart de sa hauteur)', (hi, lo, s) => (s > 0 ? hi : lo), 0.5, 0.25),
];
