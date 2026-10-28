import type { Candle } from '../../types';
import type { IndicatorDef, PlotBox, PlotLabel, PlotMarker } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';
import { nyOffset } from '../../robots/features';
import { DEC } from '../../i18n/lang';

// Pivot points of the previous day and week (classic, Camarilla or Fibonacci), and the three
// buy breakouts that held on Bitcoin and Ether in the night study of 2026-09-27 / 28
// (scripts/robots/night-*.ts, robots/night/NUIT.md), since 2020 at real costs:
// - day: the close above the classic R2 when the previous day closed above the average of
//   the last 50 daily closes; stop at R1, out at the day's end (tested on 15 minutes);
// - week: the close above the weekly Camarilla H4; stop at H3, out at the week's end
//   (tested on 1 hour);
// - volatility (Larry Williams): the close above the day's open + 0.5 × the previous day's
//   range, the same trend filter; stop at the open, out at the day's end (15 minutes).
// Days are cut at midnight UTC (crypto's daily candle) or at 17:00 New York; the pivots of
// New York days did not work on crypto.

const KINDS = ['Classiques', 'Camarilla', 'Fibonacci'];
const CUTS = ['Minuit UTC (crypto)', '17 h New York (forex, indices, matières premières)'];

type Period = { first: number; last: number; h: number; l: number; c: number };
type Lvl = { name: string; price: number };

function levels(kind: string, p: Period): Lvl[] {
  const P = (p.h + p.l + p.c) / 3, rg = p.h - p.l;
  if (kind === 'Camarilla') {
    return [['H4', p.c + (1.1 * rg) / 2], ['H3', p.c + (1.1 * rg) / 4], ['L3', p.c - (1.1 * rg) / 4], ['L4', p.c - (1.1 * rg) / 2]].map(([name, price]) => ({ name: name as string, price: price as number }));
  }
  if (kind === 'Fibonacci') {
    return [['R3', P + rg], ['R2', P + 0.618 * rg], ['R1', P + 0.382 * rg], ['P', P], ['S1', P - 0.382 * rg], ['S2', P - 0.618 * rg], ['S3', P - rg]].map(([name, price]) => ({ name: name as string, price: price as number }));
  }
  return [['R3', p.h + 2 * (P - p.l)], ['R2', P + rg], ['R1', 2 * P - p.l], ['P', P], ['S1', 2 * P - p.h], ['S2', P - rg], ['S3', p.l - 2 * (p.h - P)]].map(([name, price]) => ({ name: name as string, price: price as number }));
}

function barSeconds(k: Candle[]): number {
  const d: number[] = [];
  for (let i = Math.max(1, k.length - 50); i < k.length; i++) d.push(k[i].time - k[i - 1].time);
  d.sort((a, b) => a - b);
  return d[d.length >> 1] ?? 0;
}

// the periods (days or weeks) of the bars: each bar's period index, and each period's bars and high / low / close
function periods(k: Candle[], key: (t: number) => number): { of: Int32Array; list: Period[] } {
  const of = new Int32Array(k.length), list: Period[] = [];
  let cur = NaN;
  for (let i = 0; i < k.length; i++) {
    const id = key(k[i].time);
    if (id !== cur) { cur = id; list.push({ first: i, last: i, h: k[i].high, l: k[i].low, c: k[i].close }); }
    const p = list[list.length - 1];
    p.last = i; p.h = Math.max(p.h, k[i].high); p.l = Math.min(p.l, k[i].low); p.c = k[i].close;
    of[i] = list.length - 1;
  }
  return { of, list };
}

export const PIVOT_POINTS: IndicatorDef = {
  type: 'PIVOT_POINTS',
  label: 'Points pivots + cassures (jour / semaine)',
  short: 'Pivots',
  category: 'Personnalises',
  overlay: true,
  description: 'Pivots de la veille et de la semaine d’avant, et les trois cassures à l’achat qui ont tenu sur BTC / ETH (R2 du jour dans la tendance, H4 Camarilla de la semaine, cassure de volatilité)',
  defaults: { period: 0, color: '#2962ff' },
  inputs: [
    { key: 'kind', label: 'Type de pivots', default: KINDS[0], kind: 'string', options: KINDS, group: 'Niveaux' },
    { key: 'cut', label: 'Journée coupée à', default: CUTS[0], kind: 'string', options: CUTS, group: 'Niveaux' },
    { key: 'showDay', label: 'Pivots du jour (d’après la veille)', default: true, kind: 'bool', group: 'Niveaux' },
    { key: 'showWeek', label: 'Pivots de la semaine (d’après la semaine d’avant)', default: true, kind: 'bool', group: 'Niveaux' },
    { key: 'days', label: 'Jours affichés', default: 10, min: 1, max: 365, step: 1, group: 'Niveaux' },
    { key: 'sigDay', label: 'Signal jour : cassure de R2, veille au-dessus de la moyenne (stop R1, sortie en fin de journée)', default: true, kind: 'bool', group: 'Signaux (testés sur BTC et ETH)' },
    { key: 'trendLen', label: 'Moyenne des clôtures journalières (jours)', default: 50, min: 5, max: 200, step: 1, group: 'Signaux (testés sur BTC et ETH)' },
    { key: 'sigWeek', label: 'Signal semaine : cassure de H4 Camarilla (stop H3, sortie en fin de semaine)', default: true, kind: 'bool', group: 'Signaux (testés sur BTC et ETH)' },
    { key: 'sigVol', label: 'Signal volatilité : ouverture du jour + 0,5 × range de la veille, dans la tendance (stop à l’ouverture, sortie en fin de journée)', default: true, kind: 'bool', group: 'Signaux (testés sur BTC et ETH)' },
    { key: 'cost', label: 'Frais par côté (% du prix, résultats nets)', default: 0.06, min: 0, max: 1, step: 0.01, group: 'Signaux (testés sur BTC et ETH)' },
    { key: 'showStats', label: 'Bilan des signaux', default: true, kind: 'bool', group: 'Signaux (testés sur BTC et ETH)' },
    { key: 'dayColor', label: 'Jour', default: '#2962ff', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'weekColor', label: 'Semaine', default: '#9c27b0', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'buyColor', label: 'Achat', default: '#089981', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params: (cfg) => `${stringInput(cfg, PIVOT_POINTS, 'kind')}`,
  compute(k, cfg) {
    const n = k.length;
    if (n < 10) return [];
    const str = (key: string) => stringInput(cfg, PIVOT_POINTS, key);
    const on = (key: string) => boolInput(cfg, PIVOT_POINTS, key);
    const kind = str('kind');
    const utc = str('cut') === CUTS[0];
    const dayCol = str('dayColor'), weekCol = str('weekColor'), buy = str('buyColor');
    const cost = inputOf(cfg, PIVOT_POINTS, 'cost') / 100;
    const step = barSeconds(k);
    const intraday = step > 0 && step < 86400;

    const dayOf = (t: number) => (utc ? Math.floor(t / 86400) : Math.floor((t + nyOffset(t) + 7 * 3600) / 86400));
    const D = periods(k, dayOf);
    const W = periods(k, (t) => Math.floor((dayOf(t) + 3) / 7));

    const boxes: PlotBox[] = [], labels: PlotLabel[] = [], markers: PlotMarker[] = [];
    const t = (i: number) => k[i].time;
    const line = (from: number, to: number, price: number, color: string, style: PlotBox['borderStyle'], rightBars = 0): PlotBox =>
      ({ left: t(from), right: t(to), rightBars, top: price, bottom: price, fill: 'rgba(0,0,0,0)', border: color, borderWidth: 1, borderStyle: style });

    // the levels: each period's, from the previous one's high / low / close
    const draw = (P: typeof D, color: string, style: PlotBox['borderStyle'], count: number, suffix: string) => {
      for (let p = Math.max(1, P.list.length - count); p < P.list.length; p++) {
        const cur = P.list[p], prev = P.list[p - 1];
        const live = p === P.list.length - 1;
        for (const lv of levels(kind, prev)) {
          boxes.push(line(cur.first, cur.last, lv.price, withTransparency(color, lv.name === 'P' ? 0 : 25), style, live ? 5 : 0));
          labels.push({ time: t(cur.first), price: lv.price, text: `${lv.name}${suffix}`, color: withTransparency(color, 10), style: 'down', size: 9 });
        }
      }
    };
    const days = Math.max(1, Math.round(inputOf(cfg, PIVOT_POINTS, 'days')));
    if (on('showDay') && intraday) draw(D, dayCol, 'solid', days, '');
    const weeks = Math.max(2, Math.ceil(days / 5) + 1);
    if (on('showWeek')) draw(W, weekCol, 'dashed', weeks, ' sem.');
    // the weekly signal's own levels, when the pivots shown are not Camarilla
    if (on('sigWeek') && kind !== 'Camarilla') {
      for (let p = Math.max(1, W.list.length - weeks); p < W.list.length; p++) {
        const cur = W.list[p], prev = W.list[p - 1], rg = prev.h - prev.l, live = p === W.list.length - 1;
        for (const [name, price] of [['H4', prev.c + (1.1 * rg) / 2], ['H3', prev.c + (1.1 * rg) / 4]] as [string, number][]) {
          boxes.push(line(cur.first, cur.last, price, withTransparency(weekCol, 45), 'dotted', live ? 5 : 0));
          labels.push({ time: t(cur.first), price, text: `${name} sem.`, color: withTransparency(weekCol, 20), style: 'down', size: 9 });
        }
      }
    }

    // the signals, traded as in the study: entry at the next bar's open, stop first, out at the period's last close
    type Res = { n: number; wins: number; sum: number };
    const fmt = (name: string, r: Res) => `${name} ${r.sum >= 0 ? '+' : ''}${r.sum.toFixed(1).replace('.', DEC)} R · ${r.n} trades · ${Math.round((r.wins / r.n) * 100)} %`;
    // sameDay: the cross must happen inside the period (the volatility breakout: not on its first bar)
    const trade = (label: string, P: typeof D, want: (p: number) => { level: number; stop: number } | null, res: Res, sameDay = false) => {
      let done = -1;
      for (let i = 1; i + 1 < n; i++) {
        const p = P.of[i];
        if (p === 0 || p === done || (sameDay && P.of[i - 1] !== p)) continue;
        const w = want(p);
        if (!w || !(k[i - 1].close <= w.level && k[i].close > w.level)) continue;
        done = p;
        const e = i + 1;
        if (P.of[e] !== p) continue;
        const entry = k[e].open, risk = entry - w.stop;
        if (!(risk > 0) || (2 * cost * entry) / risk > 0.25) continue;
        const end = P.list[p].last;
        let x = -1, px = NaN;
        for (let j = e; j <= end; j++) {
          if (k[j].low <= w.stop) { x = j; px = j === e ? w.stop : Math.min(k[j].open, w.stop); break; }
        }
        const closed = x >= 0 || end < n - 1;
        if (x < 0) { x = end; px = k[end].close; }
        markers.push({ time: t(e), position: 'belowBar', shape: 'arrowUp', color: buy, text: `Achat ${label}` });
        boxes.push(line(e, closed ? x : n - 1, w.stop, withTransparency('#f23645', 20), 'dashed', closed ? 0 : 3));
        if (!closed) { labels.push({ time: t(e), price: w.stop, text: `stop ${label}`, color: '#f23645', style: 'up', size: 9 }); continue; }
        const r = (px - entry) / risk - (2 * cost * entry) / risk;
        res.n++; if (r > 0) res.wins++; res.sum += r;
        markers.push({ time: t(x), position: 'aboveBar', shape: 'circle', color: r > 0 ? buy : '#f23645', text: `${r > 0 ? '+' : ''}${r.toFixed(1).replace('.', DEC)} R`, size: 0.7 });
      }
    };
    const stats: string[] = [];
    if (on('sigDay') && intraday) {
      const len = Math.max(2, Math.round(inputOf(cfg, PIVOT_POINTS, 'trendLen')));
      const res: Res = { n: 0, wins: 0, sum: 0 };
      trade('R2', D, (p) => {
        if (p < len) return null;
        let s = 0;
        for (let q = p - len; q < p; q++) s += D.list[q].c;
        const prev = D.list[p - 1];
        if (!(prev.c > s / len)) return null;
        const P = (prev.h + prev.l + prev.c) / 3;
        return { level: P + (prev.h - prev.l), stop: 2 * P - prev.l };
      }, res);
      stats.push(res.n ? fmt('R2 jour', res) : D.list.length <= len ? `R2 jour : il faut ${len} jours (défiler à gauche)` : 'R2 jour : aucun trade');
    }
    if (on('sigVol') && intraday) {
      const len = Math.max(2, Math.round(inputOf(cfg, PIVOT_POINTS, 'trendLen')));
      const res: Res = { n: 0, wins: 0, sum: 0 };
      trade('volat.', D, (p) => {
        if (p < len) return null;
        let s = 0;
        for (let q = p - len; q < p; q++) s += D.list[q].c;
        const prev = D.list[p - 1];
        if (!(prev.c > s / len)) return null;
        const open = k[D.list[p].first].open;
        return { level: open + 0.5 * (prev.h - prev.l), stop: open };
      }, res, true);
      stats.push(res.n ? fmt('Volatilité', res) : D.list.length <= len ? `Volatilité : il faut ${len} jours (défiler à gauche)` : 'Volatilité : aucun trade');
    }
    if (on('sigWeek')) {
      const res: Res = { n: 0, wins: 0, sum: 0 };
      trade('H4 sem.', W, (p) => {
        const prev = W.list[p - 1], rg = prev.h - prev.l;
        return { level: prev.c + (1.1 * rg) / 2, stop: prev.c + (1.1 * rg) / 4 };
      }, res);
      stats.push(res.n ? fmt('H4 semaine', res) : 'H4 semaine : aucun trade');
    }
    if (on('showStats') && stats.length) {
      // one line per signal over the last bars, toward the right (the chart's legend sits top left)
      let top = -Infinity, bottom = Infinity;
      for (let i = Math.max(0, n - 60); i < n; i++) { top = Math.max(top, k[i].high); bottom = Math.min(bottom, k[i].low); }
      const gap = (top - bottom) * 0.07;
      [...stats, 'résultats nets de frais, sur ce graphique'].forEach((text, j, all) => {
        labels.push({ time: t(Math.max(0, n - 12)), price: top + (all.length - 1 - j) * gap, text, color: j < stats.length ? buy : withTransparency(buy, 40), style: 'down', size: 10 });
      });
    }
    markers.sort((a, b) => a.time - b.time);
    return [
      { key: 'levels', name: 'Niveaux', color: dayCol, kind: 'boxes', data: [], boxes },
      { key: 'labels', name: 'Étiquettes', color: dayCol, kind: 'labels', data: [], labels },
      { key: 'signals', name: 'Signaux', color: buy, kind: 'markers', data: [], markers },
    ];
  },
};
