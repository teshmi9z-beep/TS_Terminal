import type { Candle, IndicatorConfig } from '../../types';
import type { IndicatorDef, Plot, PlotBackground, PlotBox, PlotLabel, PlotMarker, PlotPoint } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';
import { dowAllow, dowHigherTrend, dowRun, type DowBox, type DowLiq, type DowParams } from '../../robots/dow';
import { parisOffset } from '../../robots/features';
import { LOCALE, DEC } from '../../i18n/lang';

// Price action after Dow, drawn from the shared engine (src/robots/dow.ts, which the
// study measures too): swing highs and lows (HH / HL / LH / LL), the last high and the
// last low to break, the trend (BOS / CHoCH on clean closes), the box of the leg that
// broke the level, entries back into it and exits (stop, target, reversal) with their
// result in R, equal highs / lows (liquidity) and ranges, and a light trend background.

export const ENTRY = ['Au contact de la boîte', 'Bougie de rejet dans la boîte'];
// what triggers the entries
export const MODES: [string, DowParams['mode']][] = [
  ['Retour dans la boîte après une cassure', 'box'],
  ['Prise de liquidité puis retour (tous les sommets / creux)', 'sweep'],
  ['Prise de liquidité puis retour (equal high / low seulement)', 'sweepeq'],
];
export const DIRS = ['Achat et vente', 'Achat seulement', 'Vente seulement'];
export const TARGETS = ['Prochaine liquidité', 'Multiple fixe du risque (R)', 'Aucun (sortie au retournement)', 'Stop suiveur sous chaque nouveau creux (Dow)'];
export const BOXES: [string, DowBox][] = [
  ['Dernière bougie opposée (bloc)', 'candle'],
  ['Moitié basse de la jambe (50 %)', 'fib'],
  ['Retour sous le niveau cassé (range)', 'range'],
];
export const LIQS: [string, DowLiq][] = [
  ['Aucun', 'none'],
  ['Pas de trade avec de la liquidité près du stop', 'guard'],
  ['Stop placé au-delà de la liquidité proche', 'beyond'],
  ['Seulement après une prise de liquidité', 'sweep'],
];
// the higher timeframe whose Dow trend the entries must follow (0 seconds: 20 bars, for tick charts)
export const HTF: [string, number][] = [['Aucune', -1], ['1 heure', 3600], ['4 heures', 14400], ['Journalier', 86400], ['20 bougies (graphiques en ticks)', 0], ['Hebdomadaire', 604800]];
const EXIT = '#f5b93a';

// "8-12, 14-18" -> the hours 8 to 11 and 14 to 17 (Paris time); empty: every hour
export function parseHours(s: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2})(?:h)?(?:-(\d{1,2})h?)?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), z = m[2] !== undefined ? Number(m[2]) : a + 1;
    for (let h = a; h !== z % 24 && out.size < 24; h = (h + 1) % 24) out.add(h % 24);
  }
  return out.size ? out : null;
}
const REASON: Record<string, string> = { stop: 'stop', objectif: 'objectif', retournement: 'retournement', fin: 'en cours' };

const fmtR = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} R`;

// same bars and settings -> same drawings (the chart recomputes on every tick)
const memo = new Map<string, { key: string; plots: Plot[] }>();

export const DOW_STRUCTURE: IndicatorDef = {
  type: 'DOW_STRUCTURE',
  label: 'Structure de marché (Dow) · price action',
  short: 'Structure Dow',
  category: 'Personnalises',
  overlay: true,
  description: 'Plus hauts / plus bas, cassures en clôture franche, retour dans la boîte d’origine, equal high / low (liquidité), ranges, flèches d’entrée et de sortie, fond de tendance',
  defaults: { period: 0, color: '#2962ff' },
  inputs: [
    { key: 'swing', label: 'Force des sommets / creux (bougies de chaque côté)', default: 3, min: 1, max: 30, step: 1, group: 'Structure' },
    { key: 'body', label: 'Clôture franche : corps ≥ (% de la bougie)', default: 50, min: 0, max: 100, step: 5, group: 'Structure' },
    { key: 'mode', label: 'Signal d’entrée', default: MODES[0][0], kind: 'string', options: MODES.map(([l]) => l), group: 'Trades' },
    { key: 'box', label: 'Boîte', default: BOXES[0][0], kind: 'string', options: BOXES.map(([l]) => l), group: 'Trades' },
    { key: 'entry', label: 'Entrée', default: ENTRY[0], kind: 'string', options: ENTRY, group: 'Trades' },
    { key: 'dir', label: 'Sens', default: DIRS[0], kind: 'string', options: DIRS, group: 'Trades' },
    { key: 'target', label: 'Objectif', default: TARGETS[0], kind: 'string', options: TARGETS, group: 'Trades' },
    { key: 'minR', label: 'Objectif à au moins (R) / multiple fixe', default: 1, min: 0.5, max: 10, step: 0.5, group: 'Trades' },
    { key: 'liq', label: 'Liquidité', default: LIQS[0][0], kind: 'string', options: LIQS.map(([l]) => l), group: 'Trades' },
    { key: 'maxAge', label: 'Boîte valable (bougies, 0 = jusqu’au retournement)', default: 0, min: 0, max: 1000, step: 5, group: 'Trades' },
    { key: 'be', label: 'Stop au prix d’entrée après +1 R', default: false, kind: 'bool', group: 'Trades' },
    { key: 'hours', label: 'Heures actives (Paris, ex. 8-12, 14-18 ; vide = toutes)', default: '', kind: 'string', group: 'Filtres' },
    { key: 'cost', label: 'Frais par côté (% du prix, résultats nets)', default: 0, min: 0, max: 1, step: 0.005, group: 'Filtres' },
    { key: 'maxCostR', label: 'Pas de trade si les frais dépassent (% du risque, 0 = pas de limite)', default: 0, min: 0, max: 100, step: 5, group: 'Filtres' },
    { key: 'noRange', label: 'Pas d’entrée quand le prix est dans un range', default: false, kind: 'bool', group: 'Filtres' },
    { key: 'htf', label: 'Dans le sens de la tendance de', default: HTF[0][0], kind: 'string', options: HTF.map(([l]) => l), group: 'Filtres' },
    { key: 'minLeg', label: 'Impulsion minimale (× ATR 14, 0 = toutes)', default: 0, min: 0, max: 20, step: 0.5, group: 'Trades' },
    { key: 'eqTol', label: 'Equal high / low : écart max (× ATR 14)', default: 0.15, min: 0.01, max: 2, step: 0.05, group: 'Liquidité et ranges' },
    { key: 'rangeTol', label: 'Range : écart max des bornes (× ATR 14)', default: 0.5, min: 0.05, max: 5, step: 0.05, group: 'Liquidité et ranges' },
    { key: 'showSwings', label: 'Étiquettes HH / HL / LH / LL', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showBreaks', label: 'Cassures (BOS / CHoCH)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showBoxes', label: 'Boîtes de retracement', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showLiq', label: 'Equal high / low (liquidité)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showRanges', label: 'Ranges', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showStats', label: 'Bilan des trades (nombre, R, gagnants)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showBg', label: 'Fond de tendance', default: true, kind: 'bool', group: 'Affichage', inline: 'bg' },
    { key: 'bgTransp', label: 'Transparence', default: 92, min: 0, max: 100, step: 1, group: 'Affichage', inline: 'bg' },
    { key: 'upColor', label: 'Haussier', default: '#089981', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'downColor', label: 'Baissier', default: '#f23645', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'liqColor', label: 'Liquidité', default: '#b388ff', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'rangeColor', label: 'Range', default: '#787b86', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params: (cfg) => `${inputOf(cfg, DOW_STRUCTURE, 'swing')}`,
  compute(k, cfg) {
    if (k.length < 30) return [];
    const last = k[k.length - 1];
    const key = JSON.stringify([cfg.inputs, k.length, k[0].time, last.time, last.close, last.high, last.low]);
    const hit = memo.get(cfg.id);
    if (hit?.key === key) return hit.plots;
    const plots = structure(k, cfg);
    memo.set(cfg.id, { key, plots });
    return plots;
  },
};

// the indicator's settings as the engine's
export function dowParams(cfg: IndicatorConfig): DowParams {
  const num = (key: string) => inputOf(cfg, DOW_STRUCTURE, key);
  const str = (key: string) => stringInput(cfg, DOW_STRUCTURE, key);
  const target = TARGETS.indexOf(str('target'));
  const dir = DIRS.indexOf(str('dir'));
  return {
    swing: num('swing'), body: num('body') / 100,
    box: BOXES.find(([l]) => l === str('box'))?.[1] ?? 'candle',
    entry: str('entry') === ENTRY[1] ? 'reject' : 'contact',
    target: target === 1 ? 'fixed' : target === 2 ? 'none' : target === 3 ? 'trail' : 'liq', targetR: num('minR'),
    liq: LIQS.find(([l]) => l === str('liq'))?.[1] ?? 'none',
    dir: dir === 1 ? 1 : dir === 2 ? -1 : 0,
    eqTol: num('eqTol'), rangeTol: num('rangeTol'), cost: num('cost') / 100, maxAge: num('maxAge'), pad: 0.1, maxCostR: num('maxCostR') / 100,
    be: boolInput(cfg, DOW_STRUCTURE, 'be'), minLeg: num('minLeg'),
    mode: MODES.find(([l]) => l === str('mode'))?.[1] ?? 'box', noRange: boolInput(cfg, DOW_STRUCTURE, 'noRange'),
  };
}

function structure(k: Candle[], cfg: IndicatorConfig): Plot[] {
  const str = (key: string) => stringInput(cfg, DOW_STRUCTURE, key);
  const on = (key: string) => boolInput(cfg, DOW_STRUCTURE, key);
  const n = k.length;
  const up = str('upColor'), down = str('downColor'), liqCol = str('liqColor'), rangeCol = str('rangeColor');
  const t = (i: number) => k[i].time;
  const b = {
    n, t: k.map((x) => x.time), o: k.map((x) => x.open), h: k.map((x) => x.high), l: k.map((x) => x.low), c: k.map((x) => x.close),
  };
  // the entries' filters: the active hours and the higher timeframe's trend
  const hours = parseHours(str('hours'));
  const inHours = hours ? k.map((x) => (hours.has(Math.floor((((x.time + parisOffset(x.time)) % 86400) + 86400) % 86400 / 3600)) ? 1 : 0)) : undefined;
  const htfSec = HTF.find(([l]) => l === str('htf'))?.[1] ?? -1;
  const res = dowRun(b, dowParams(cfg), dowAllow(n, inHours, htfSec >= 0 ? dowHigherTrend(b, htfSec) : undefined), true);

  const hiLine: PlotPoint[] = [], loLine: PlotPoint[] = [];
  const bg: PlotBackground[] = [];
  for (let i = 0; i < n; i++) {
    hiLine.push({ time: t(i), value: res.refHigh[i] });
    loLine.push({ time: t(i), value: res.refLow[i] });
    const tr = res.trend[i];
    const color = tr === 1 ? up : tr === -1 ? down : '';
    const prev = bg[bg.length - 1];
    if (prev && prev.color === color) prev.to = t(i);
    else bg.push({ from: t(i), to: t(i), color });
  }

  const markers: PlotMarker[] = [];
  for (const tr of res.trades) {
    markers.push({ time: t(tr.entryIdx), position: tr.up ? 'belowBar' : 'aboveBar', shape: tr.up ? 'arrowUp' : 'arrowDown', color: tr.up ? up : down, text: tr.up ? 'Achat' : 'Vente' });
    markers.push({ time: t(tr.exitIdx), position: tr.up ? 'aboveBar' : 'belowBar', shape: tr.up ? 'arrowDown' : 'arrowUp', color: EXIT, text: `Sortie · ${REASON[tr.reason]} ${fmtR(tr.r)}`, size: 0.8 });
  }
  if (res.open) {
    const P = res.open;
    markers.push({ time: t(P.idx), position: P.up ? 'belowBar' : 'aboveBar', shape: P.up ? 'arrowUp' : 'arrowDown', color: P.up ? up : down, text: P.up ? 'Achat' : 'Vente' });
  }
  markers.sort((a, z) => a.time - z.time);

  const level = (from: number, to: number, price: number, color: string, style: PlotBox['borderStyle'], width = 1, rightBars = 0): PlotBox =>
    ({ left: from, right: to, rightBars, top: price, bottom: price, fill: 'rgba(0,0,0,0)', border: color, borderWidth: width, borderStyle: style });

  const swingLabels: PlotLabel[] = on('showSwings')
    ? res.swings.filter((s) => s.label).slice(-300).map((s) => ({
      time: t(s.idx), price: s.price, text: s.label, color: withTransparency(s.label === 'HH' || s.label === 'HL' ? up : down, 20), style: s.up ? 'down' : 'up', size: 9,
    }))
    : [];
  const breakLines: PlotBox[] = [], breakLabels: PlotLabel[] = [];
  if (on('showBreaks')) {
    for (const x of res.breaks.slice(-150)) {
      const color = x.up ? up : down;
      breakLines.push(level(t(x.from), t(x.idx), x.price, withTransparency(color, 30), 'dotted'));
      breakLabels.push({ time: (t(x.from) + t(x.idx)) / 2, price: x.price, text: x.turn ? 'CHoCH' : 'BOS', color, style: x.up ? 'down' : 'up', size: 9 });
    }
  }
  const boxes: PlotBox[] = [];
  if (on('showBoxes')) {
    for (const z of res.zones.slice(-80)) {
      const color = z.up ? up : down;
      boxes.push({ left: t(z.ob), right: t(z.end), top: z.top, bottom: z.bottom, fill: withTransparency(color, z.dead && !z.used ? 92 : 80), border: withTransparency(color, 40), borderWidth: 1 });
    }
  }
  const liqBoxes: PlotBox[] = [], liqLabels: PlotLabel[] = [];
  if (on('showLiq')) {
    for (const x of res.liqs.slice(-120)) {
      liqBoxes.push(level(t(x.from), t(x.to), x.level, x.open ? liqCol : withTransparency(liqCol, 50), 'dashed', 1, x.open ? 6 : 0));
      liqLabels.push({ time: t(x.from), price: x.level, text: `${x.up ? 'EQH' : 'EQL'}${x.count > 2 ? ` ×${x.count}` : ''}`, color: liqCol, style: x.up ? 'down' : 'up', size: 9 });
      // taken by a wick that closed back: a sweep
      const s = x.sweptAt;
      if (s >= 0 && (x.up ? k[s].close < x.level : k[s].close > x.level)) {
        liqLabels.push({ time: t(s), price: x.up ? k[s].high : k[s].low, text: 'Liquidité prise', color: liqCol, style: x.up ? 'down' : 'up', size: 9 });
      }
    }
  }
  const rangeBoxes: PlotBox[] = [], rangeLabels: PlotLabel[] = [];
  if (on('showRanges')) {
    for (const r of res.ranges.slice(-60)) {
      rangeBoxes.push({ left: t(r.from), right: t(r.to), top: r.top, bottom: r.bottom, fill: withTransparency(rangeCol, 88), border: withTransparency(rangeCol, 30), borderWidth: 1, borderStyle: 'dashed' });
      rangeLabels.push({ time: t(r.from), price: r.top, text: 'Range', color: rangeCol, style: 'down', size: 9 });
    }
  }
  // the trade still open: entry, stop, target
  const openLevels: PlotBox[] = [];
  if (res.open) {
    const P = res.open;
    openLevels.push(level(t(P.idx), t(n - 1), P.entry, '#787b86', 'solid', 1, 8));
    openLevels.push(level(t(P.idx), t(n - 1), P.stop, down, 'solid', 1, 8));
    if (!Number.isNaN(P.target)) openLevels.push(level(t(P.idx), t(n - 1), P.target, up, 'solid', 1, 8));
  }

  // the trades' results on the bars shown, over the last bars
  const statLabels: PlotLabel[] = [];
  if (on('showStats') && res.trades.length) {
    const sum = res.trades.reduce((a, x) => a + x.r, 0), wins = res.trades.filter((x) => x.r > 0).length;
    let top = -Infinity;
    for (let i = Math.max(0, n - 40); i < n; i++) top = Math.max(top, k[i].high);
    const net = inputOf(cfg, DOW_STRUCTURE, 'cost') > 0;
    statLabels.push({
      // a little left of the last bar, so the text isn't cut by the price scale
      time: t(Math.max(0, n - 20)), price: top, color: sum >= 0 ? up : down, style: 'down', size: 11,
      text: `${res.trades.length} trades · ${fmtR(sum)} · ${Math.round((wins / res.trades.length) * 100)} % gagnants${net ? ' (frais compris)' : ' (sans frais)'}`,
    });
  }

  const transp = inputOf(cfg, DOW_STRUCTURE, 'bgTransp');
  return [
    { key: 'bg', name: 'Fond de tendance', color: up, kind: 'bgcolor', data: [], bg: on('showBg') ? bg.filter((x) => x.color).map((x) => ({ ...x, color: withTransparency(x.color, transp) })) : [] },
    { key: 'hi', name: 'Plus haut à casser', color: withTransparency(down, 30), kind: 'line', width: 1, step: true, data: hiLine },
    { key: 'lo', name: 'Plus bas à casser', color: withTransparency(up, 30), kind: 'line', width: 1, step: true, data: loLine },
    { key: 'ranges', name: 'Ranges', color: rangeCol, kind: 'boxes', data: [], boxes: rangeBoxes },
    { key: 'boxes', name: 'Boîtes de retracement', color: up, kind: 'boxes', data: [], boxes: [...boxes, ...breakLines, ...openLevels] },
    { key: 'liq', name: 'Liquidité (equal high / low)', color: liqCol, kind: 'boxes', data: [], boxes: liqBoxes },
    { key: 'labels', name: 'Étiquettes', color: '#787b86', kind: 'labels', data: [], labels: [...swingLabels, ...breakLabels, ...liqLabels.slice(-150), ...rangeLabels, ...statLabels] },
    { key: 'trades', name: 'Entrées et sorties', color: up, kind: 'markers', data: [], markers },
  ];
}

// A setting of the study (see scripts/robots/dow-lib.ts, key and variantOf) as the
// indicator's inputs, for a chart of the timeframe `tf`; `hours`: the market's active
// hours (Paris) when the setting keeps to them
export type DowSetting = {
  swing: number; body: number; box: DowBox; entry: 'contact' | 'reject'; target: DowParams['target']; targetR: number;
  liq: DowLiq; hours: 'all' | 'med' | 'top'; maxAge: number; be: boolean; minLeg: number; htf: 0 | 1; mode: DowParams['mode']; noRange?: boolean;
};
export function dowInputs(v: DowSetting & { maxCostR?: number }, tf: string, hours: number[] = [], cost = 0): Record<string, number | string | boolean> {
  const hoursText = v.hours === 'all' ? '' : hours.map((h) => `${h}`).join(', ');
  const htf = !v.htf ? HTF[0][0] : /T$/.test(tf) ? HTF[4][0] : tf === '1m' || tf === '5m' ? HTF[1][0] : tf === '15m' ? HTF[2][0] : tf === '4h' || tf === '1d' ? HTF[5][0] : HTF[3][0];
  return {
    swing: v.swing, body: Math.round(v.body * 100),
    box: BOXES.find(([, b]) => b === v.box)![0], entry: ENTRY[v.entry === 'reject' ? 1 : 0],
    target: TARGETS[v.target === 'fixed' ? 1 : v.target === 'none' ? 2 : v.target === 'trail' ? 3 : 0], minR: v.targetR,
    liq: LIQS.find(([, l]) => l === v.liq)![0], maxAge: v.maxAge, be: v.be, minLeg: v.minLeg, hours: hoursText, htf,
    cost: Math.round(cost * 100 * 10000) / 10000, maxCostR: Math.round((v.maxCostR ?? 0) * 100),
    mode: MODES.find(([, m]) => m === v.mode)![0], noRange: !!v.noRange,
  };
}

// the setting in words
export function dowLabel(v: DowSetting & { maxCostR?: number }): string {
  const sweep = v.mode === 'sweep' || v.mode === 'sweepeq';
  const parts = sweep ? [
    v.mode === 'sweep' ? 'prise de liquidité (sommet / creux) puis retour' : 'prise d’equal high / low puis retour',
    `sommets à ${v.swing} bougies`,
  ] : [
    `sommets à ${v.swing} bougies`,
    `clôture franche ${Math.round(v.body * 100)} %`,
    v.box === 'candle' ? 'boîte : dernière bougie opposée' : v.box === 'fib' ? 'boîte : moitié de la jambe' : 'boîte : retour sous le niveau cassé',
    v.entry === 'contact' ? 'entrée au contact' : 'entrée sur bougie de rejet',
  ];
  parts.push(
    v.target === 'liq' ? `objectif : liquidité à ${String(v.targetR).replace('.', DEC)} R au moins` : v.target === 'fixed' ? `objectif ${String(v.targetR).replace('.', DEC)} R`
      : v.target === 'trail' ? 'stop suiveur sous chaque creux' : 'sortie au retournement',
  );
  if (v.liq === 'guard') parts.push('pas de liquidité près du stop');
  if (v.liq === 'beyond') parts.push('stop au-delà de la liquidité proche');
  if (v.liq === 'sweep') parts.push('seulement après une prise de liquidité');
  if (v.hours === 'med') parts.push('heures actives');
  if (v.hours === 'top') parts.push('heures les plus actives');
  if (v.htf) parts.push('dans le sens de l’unité supérieure');
  if (v.be) parts.push('stop à l’entrée après +1 R');
  if (v.minLeg) parts.push(`impulsion d’au moins ${String(v.minLeg).replace('.', DEC)} ATR`);
  if (v.maxAge) parts.push(`boîte valable ${v.maxAge} bougies`);
  if (v.noRange) parts.push('pas d’entrée dans un range');
  if (v.maxCostR) parts.push(`frais sous ${Math.round(v.maxCostR * 100)} % du risque`);
  return parts.join(' · ');
}
