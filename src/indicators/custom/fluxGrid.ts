import type { IndicatorDef, Plot, PlotBox, PlotLabel, PlotMarker } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';
import { FLUX } from './flux';
import { GRID_DEFAULT, prepGrid, runGrid, type Basket, type GridSetting } from '../../robots/fluxGrid';
import { LOCALE } from '../../i18n/lang';

// "Robot grille sur le flux" on the chart (src/robots/fluxGrid.ts, the study of 3 November
// 2026): the flux of 1 hour, and on the 5 or 15 minute chart every basket the robot would
// have taken (its zone, its orders, the ones filled, its exit and result in R before costs),
// the orders waiting now, and the legs its guards kept out (a big level, a big wick).

const SIZES: [string, GridSetting['size']][] = [['Égales', 'flat'], ['1-2-3…', 'lin'], ['Doublées 1-2-4…', 'mart']];
const TPS: [string, GridSetting['tp']][] = [['Bout de la jambe', 'low'], ['Mi-chemin', 'mid']];
const STOPS: [string, GridSetting['stop']][] = [['Flux qui change de couleur', 'flip'], ['Stop au-delà du nuage', 'cloud']];
const GUARDS: [string, GridSetting['guard']][] = [['Aucun', 'none'], ['Gros niveaux jour / semaine', 'level'], ['Grandes mèches', 'wick'], ['Les deux', 'both']];
const label = <T,>(xs: [string, T][], v: T) => xs.find(([, k]) => k === v)![0];
const pick = <T,>(xs: [string, T][], l: string, d: T) => xs.find(([x]) => x === l)?.[1] ?? d;
const fmtR = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toLocaleString(LOCALE, { maximumFractionDigits: 2 })} R`;

export const FLUX_GRID: IndicatorDef = {
  type: 'FLUX_GRID',
  label: 'Robot grille sur le flux (5 / 15 min)',
  short: 'Grille flux',
  category: 'Personnalises',
  overlay: true,
  description: 'Flux MM20 / MM50 en 1 heure pour le sens, grille d’ordres de la fin de la jambe jusqu’à la MM20, garde-fous sur les gros niveaux et les grandes mèches',
  defaults: { period: 0, color: '#f23645' },
  inputs: [
    { key: 'levels', label: 'Entrées', default: GRID_DEFAULT.levels, min: 2, max: 10, step: 1 },
    { key: 'size', label: 'Tailles', default: label(SIZES, GRID_DEFAULT.size), kind: 'string', options: SIZES.map(([l]) => l) },
    { key: 'tp', label: 'Objectif', default: label(TPS, GRID_DEFAULT.tp), kind: 'string', options: TPS.map(([l]) => l) },
    { key: 'stop', label: 'Invalidation', default: label(STOPS, GRID_DEFAULT.stop), kind: 'string', options: STOPS.map(([l]) => l) },
    { key: 'guard', label: 'Garde-fous', default: label(GUARDS, GRID_DEFAULT.guard), kind: 'string', options: GUARDS.map(([l]) => l),
      tooltip: 'Pas de grille quand la jambe finit sur un gros niveau du jour ou de la semaine (support sous les ventes, résistance sur les achats), ni après une grande mèche ou un marteau au bout de la jambe (5 / 15 min, 1 h, 4 h)' },
    { key: 'zone', label: 'Jambe minimale (ATR 1 h)', default: 1, min: 0.5, max: 10, step: 0.5 },
    { key: 'flux', label: 'Afficher le flux', default: true, kind: 'bool' },
    { key: 'sell', label: 'Ventes', default: '#f23645', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'buy', label: 'Achats', default: '#089981', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params(cfg) {
    return `${inputOf(cfg, FLUX_GRID, 'levels')} ${stringInput(cfg, FLUX_GRID, 'size')}`;
  },
  compute(k, cfg) {
    const s: GridSetting = {
      levels: Math.max(2, Math.round(inputOf(cfg, FLUX_GRID, 'levels'))),
      size: pick(SIZES, stringInput(cfg, FLUX_GRID, 'size'), GRID_DEFAULT.size),
      tp: pick(TPS, stringInput(cfg, FLUX_GRID, 'tp'), GRID_DEFAULT.tp),
      stop: pick(STOPS, stringInput(cfg, FLUX_GRID, 'stop'), GRID_DEFAULT.stop),
      guard: pick(GUARDS, stringInput(cfg, FLUX_GRID, 'guard'), GRID_DEFAULT.guard),
      zone: inputOf(cfg, FLUX_GRID, 'zone'),
    };
    const sell = stringInput(cfg, FLUX_GRID, 'sell'), buy = stringInput(cfg, FLUX_GRID, 'buy');
    const plots: Plot[] = boolInput(cfg, FLUX_GRID, 'flux') ? FLUX.compute(k, { ...cfg, type: 'FLUX', inputs: { tf: '1 heure' } }) : [];
    if (k.length < 300) return plots;
    const t = k.map((c) => c.time);
    const p = prepGrid({ t, o: k.map((c) => c.open), h: k.map((c) => c.high), l: k.map((c) => c.low), c: k.map((c) => c.close) });
    const { baskets, live, blocks } = runGrid(p, s, 0);

    const boxes: PlotBox[] = [], labels: PlotLabel[] = [], markers: PlotMarker[] = [];
    const last = t[t.length - 1];
    // a basket: the zone its grid covered, its orders (bold when filled), the invalidation past
    // the cloud, its fills; the open one reaches past the last bar with its target
    const draw = (b: Basket, open: boolean) => {
      const col = b.dir < 0 ? sell : buy;
      const far = b.levels[b.levels.length - 1];
      const right = open ? last : t[b.i1], rightBars = open ? 8 : 0;
      boxes.push({ left: t[b.i0], right, rightBars, top: Math.max(b.ext, far), bottom: Math.min(b.ext, far), fill: withTransparency(col, 90), border: withTransparency(col, 60), borderWidth: 1, borderStyle: 'dashed' });
      b.levels.forEach((lv, j) => {
        if (!Number.isFinite(lv)) return;
        const hit = b.fills.some((f) => f.k === j);
        boxes.push({ left: t[b.i0], right, rightBars, top: lv, bottom: lv, fill: 'rgba(0,0,0,0)', border: withTransparency(col, hit ? 0 : 65), borderWidth: hit ? 2 : 1, borderStyle: hit ? 'solid' : 'dotted' });
      });
      if (s.stop === 'cloud') boxes.push({ left: t[b.i0], right, rightBars, top: b.ref, bottom: b.ref, fill: 'rgba(0,0,0,0)', border: '#787b86', borderWidth: 1, borderStyle: 'dashed' });
      for (const f of b.fills) markers.push({ time: t[f.i], position: 'atPriceMiddle', price: f.p, shape: b.dir < 0 ? 'arrowDown' : 'arrowUp', color: col, size: 0.6 });
      if (open) {
        boxes.push({ left: t[b.i0], right, rightBars, top: b.tp, bottom: b.tp, fill: 'rgba(0,0,0,0)', border: '#089981', borderWidth: 2, borderStyle: 'dashed' });
        labels.push({ time: last, price: b.tp, text: `objectif · ${b.fills.length} / ${b.levels.filter(Number.isFinite).length} entrées`, color: '#089981', style: b.dir < 0 ? 'up' : 'down', size: 11 });
      } else {
        labels.push({ time: t[b.i1], price: b.exit, text: `${fmtR(b.r)}${b.why === 'flip' ? ' · flux' : b.why === 'stop' ? ' · stop' : ''}${b.cut ? ' · mèche' : ''}`, color: b.r >= 0 ? '#089981' : '#f23645', style: b.dir < 0 ? 'up' : 'down', size: 11 });
      }
    };
    for (const b of baskets.slice(-400)) draw(b, false);
    if (live.basket) draw(live.basket, true);
    let wins = 0, total = 0;
    for (const b of baskets) { total += b.r; if (b.r > 0) wins++; }
    // the legs the guards kept out
    for (const x of blocks.slice(-300)) {
      labels.push({ time: t[x.i], price: x.price, text: x.why === 'wick' ? 'mèche' : 'gros niveau', color: '#ff9800', style: x.dir < 0 ? 'up' : 'down', size: 10 });
    }
    // the orders waiting now
    for (const lv of live.levels) {
      if (Number.isFinite(lv)) boxes.push({ left: last, right: last, rightBars: 12, top: lv, bottom: lv, fill: 'rgba(0,0,0,0)', border: live.dir < 0 ? sell : buy, borderWidth: 2, borderStyle: 'dashed' });
    }
    const status = live.basket ? 'panier ouvert' : live.levels.some(Number.isFinite) ? 'ordres posés' : live.blocked === 'wick' ? 'attente : grande mèche' : live.blocked === 'level' ? 'attente : gros niveau' : 'pas de grille';
    // the summary over the last bars (centred a little left of the last one, so it shows whole)
    let top = -Infinity;
    for (let i = Math.max(0, k.length - 80); i < k.length; i++) top = Math.max(top, k[i].high);
    labels.push({
      time: t[Math.max(0, t.length - 40)], price: top, style: 'down', size: 11, color: '#787b86',
      text: `Grille : ${baskets.length} paniers · ${baskets.length ? Math.round((wins / baskets.length) * 100) : 0} % gagnants · ${fmtR(total)} hors frais · ${status}`,
    });
    plots.push(
      { key: 'grid', name: 'Paniers', color: sell, kind: 'boxes', data: [], boxes },
      { key: 'fills', name: 'Entrées', color: sell, kind: 'markers', data: [], markers },
      { key: 'res', name: 'Résultats', color: sell, kind: 'labels', data: [], labels },
    );
    return plots;
  },
};
