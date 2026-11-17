import type { IndicatorDef, Plot, PlotBox, PlotLabel, PlotMarker, PlotPoint } from '../types';
import { boolInput, stringInput, withTransparency } from '../helpers';
import { tfSeconds } from '../../data/timeframes';
import { currentChartSeries } from '../companion';
import { NB_AUTO, NB_SESSIONS, NB_SESSION_LABELS, nbBand, nbCostOf, nbDayTrade, nbNoise, nbRuleOf, nbSessionOf, nbSessions } from '../../robots/noiseBand';
import { DEC, LOCALE } from '../../i18n/lang';

// The noise band (src/robots/noiseBand.ts, robots/pa/PRICE-ACTION.md): around the session's
// reference (its open or the previous close), the usual move at each time of day over the last
// sessions. Inside the band the price is noise; a 30-minute close out of it is the robot's
// signal, followed to the session's end. On 5, 15 or 30-minute charts; the robot's signals on
// 15 minutes, as the study measured them. NOT PROVEN.

const fr = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d).replace('.', DEC)} R`;

export const NOISE_BAND: IndicatorDef = {
  type: 'NOISE_BAND',
  label: 'Bande de bruit (momentum intraday)',
  short: 'Bruit',
  category: 'Personnalises',
  overlay: true,
  description: 'L’écart habituel entre le prix et l’ouverture à chaque heure de la séance (14 séances). Une clôture de 30 min hors de la bande donne le signal du robot, suivi jusqu’à la fin de séance. Non prouvé : +0,03 R par trade depuis 2022, seulement avec des frais serrés.',
  defaults: { period: 0, color: '#ff9800' },
  inputs: [
    { key: 'session', label: 'Séance', default: NB_AUTO, kind: 'string', options: NB_SESSION_LABELS, group: 'Bande' },
    { key: 'k', label: 'Largeur (× l’écart habituel)', default: 1.25, min: 0.25, max: 4, step: 0.25, group: 'Bande' },
    { key: 'look', label: 'Séances de référence', default: 14, min: 5, max: 60, step: 1, group: 'Bande' },
    { key: 'showRef', label: 'Référence (ouverture ou clôture de la veille)', default: true, kind: 'bool', group: 'Bande' },
    { key: 'robot', label: 'Signaux du robot (graphique 15 min)', default: true, kind: 'bool', group: 'Robot (non prouvé)', tooltip: 'Toutes les 30 min, la première clôture hors de la bande est suivie à la bougie suivante, une fois par séance. Deux entrées : A sort à +1 fois le mouvement habituel d’une séance, B à la fin de la séance. Non prouvé : walk-forward 2022 → 2026 à +0,03 R par trade (t 1,8), 2025 négatif, perdant dès que les frais doublent ou triplent.' },
    { key: 'stopU', label: 'Stop (× le mouvement habituel d’une séance)', default: 2, min: 0.5, max: 6, step: 0.25, group: 'Robot (non prouvé)' },
    { key: 'targetU', label: 'Objectif de l’entrée A (× le mouvement habituel)', default: 1, min: 0.25, max: 6, step: 0.25, group: 'Robot (non prouvé)' },
    { key: 'cost', label: 'Frais par côté (% du prix, résultats nets)', default: 0.005, min: 0, max: 0.2, step: 0.001, group: 'Robot (non prouvé)' },
    { key: 'showStats', label: 'Bilan des signaux', default: true, kind: 'bool', group: 'Robot (non prouvé)' },
    { key: 'bandColor', label: 'Bande', default: '#ff9800', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'buyColor', label: 'Achat', default: '#089981', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'sellColor', label: 'Vente', default: '#f23645', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params: (cfg) => `${String(nbRuleOf(cfg.inputs).k).replace('.', DEC)}`,
  compute(k, cfg) {
    const n = k.length;
    const str = (key: string) => stringInput(cfg, NOISE_BAND, key);
    const on = (key: string) => boolInput(cfg, NOISE_BAND, key);
    const col = str('bandColor'), buy = str('buyColor'), sell = str('sellColor');
    const hiV = new Array<number>(n).fill(NaN), loV = new Array<number>(n).fill(NaN);
    const boxes: PlotBox[] = [], labels: PlotLabel[] = [], markers: PlotMarker[] = [];
    // the band's points. The chart joins a line's points across the bars without one, so the
    // last point of each session is transparent: its segment is the one that would reach the next session
    const ends = new Set<number>();
    const pts = (v: number[]) => { const p: PlotPoint[] = []; for (let i = 0; i < n; i++) if (Number.isFinite(v[i])) p.push(ends.has(i) ? { time: k[i].time, value: v[i], color: 'rgba(0,0,0,0)' } : { time: k[i].time, value: v[i] }); return p; };
    const out = (): Plot[] => [
      { key: 'hi', name: 'Haut de la bande', color: col, kind: 'line', width: 1, data: pts(hiV) },
      { key: 'lo', name: 'Bas de la bande', color: col, kind: 'line', width: 1, data: pts(loV) },
      { key: 'boxes', name: 'Référence, stop et objectif', color: col, kind: 'boxes', data: [], boxes },
      { key: 'labels', name: 'Bilan', color: col, kind: 'labels', data: [], labels },
      { key: 'signals', name: 'Robot (non prouvé)', color: buy, kind: 'markers', data: [], markers },
    ];
    const st = currentChartSeries();
    if (!st || n < 20) return out();
    const step = tfSeconds(st.tf) ?? 0;
    const note = (text: string) => {
      let top = -Infinity;
      for (let i = Math.max(0, n - 60); i < n; i++) top = Math.max(top, k[i].high);
      labels.push({ time: k[Math.max(0, n - 12)].time, price: top, text, color: col, style: 'down', size: 10 });
      return out();
    };
    if (step !== 300 && step !== 900 && step !== 1800) return note('Bande de bruit : graphique en 5, 15 ou 30 minutes');

    const rule = nbRuleOf(cfg.inputs);
    const key = nbSessionOf(cfg.inputs?.session ?? NB_AUTO, st.sym.ticker, st.sym.category);
    const cost = nbCostOf(cfg.inputs, st.sym.ticker);
    const b = { t: k.map((c) => c.time), o: k.map((c) => c.open), h: k.map((c) => c.high), l: k.map((c) => c.low), c: k.map((c) => c.close), n };
    const se = nbSessions(b, key, step);
    const noise = nbNoise(b, se, rule.look);
    const robot = on('robot') && step === 900;
    const line = (from: number, to: number, price: number, color: string, style: PlotBox['borderStyle'], rightBars = 0): PlotBox =>
      ({ left: k[from].time, right: k[to].time, rightBars, top: price, bottom: price, fill: 'rgba(0,0,0,0)', border: color, borderWidth: 1, borderStyle: style });

    let sum = 0, count = 0, wins = 0, ready = 0;
    let today = '';
    for (let d = 0; d < se.days.length; d++) {
      const D = se.days[d];
      const lastDay = d === se.days.length - 1;
      const band = nbBand(b, se, D, noise[d], rule.k);
      if (!band) continue;
      ready++;
      let first = -1, last = -1;
      for (let j = 0; j < se.slots; j++) {
        const i = D.idx[j];
        if (i < 0) continue;
        if (first < 0) first = i;
        last = i;
        hiV[i] = band.hi[j]; loV[i] = band.lo[j];
      }
      if (last >= 0 && last < n - 1) ends.add(last);
      if (on('showRef') && first >= 0) {
        boxes.push(line(first, last, band.up, withTransparency(col, 55), 'dotted'));
        if (band.dn !== band.up) boxes.push(line(first, last, band.dn, withTransparency(col, 55), 'dotted'));
      }
      if (!robot || (!D.full && !lastDay)) continue;
      const closed = !lastDay || D.idx[se.slots - 1] >= 0;
      const t = nbDayTrade(b, se, D, band, closed, rule);
      if (lastDay) today = t ? '' : closed ? 'Séance terminée sans signal' : 'Pas encore de signal aujourd’hui';
      if (!t) continue;
      const c = t.side > 0 ? buy : sell;
      const end = Math.max(t.legs[0].exitBar, t.legs[1].exitBar);
      markers.push({ time: k[t.entryBar].time, position: t.side > 0 ? 'belowBar' : 'aboveBar', shape: t.side > 0 ? 'arrowUp' : 'arrowDown', color: c, text: t.side > 0 ? 'Achat' : 'Vente' });
      boxes.push(line(t.entryBar, end, t.stop, withTransparency('#f23645', 20), 'dashed', closed ? 0 : 3));
      boxes.push(line(t.entryBar, t.legs[0].exitBar, t.target, withTransparency('#089981', 20), 'dashed', t.legs[0].reason === 'en cours' ? 3 : 0));
      const costR = (2 * cost * t.entry) / t.risk;
      const open = t.legs.some((l) => l.reason === 'en cours');
      if (open) {
        const p = (v: number) => v.toLocaleString(LOCALE, { maximumFractionDigits: v > 500 ? 1 : v > 20 ? 2 : 4 });
        today = `${t.side > 0 ? 'Achat' : 'Vente'} à ${p(t.entry)} · stop ${p(t.stop)} · objectif A ${p(t.target)} · B sort en fin de séance`;
        continue;
      }
      const r = t.legs[0].r + t.legs[1].r - 2 * costR;
      sum += r; count++; if (r > 0) wins++;
      // the result at the last exit; the first target as a small dot
      if (t.legs[0].reason === 'objectif' && t.legs[0].exitBar !== end) markers.push({ time: k[t.legs[0].exitBar].time, position: t.side > 0 ? 'aboveBar' : 'belowBar', shape: 'circle', color: withTransparency(c, 30), text: 'A', size: 0.6 });
      markers.push({ time: k[end].time, position: t.side > 0 ? 'aboveBar' : 'belowBar', shape: 'circle', color: r > 0 ? '#089981' : '#f23645', text: fr(r), size: 0.7 });
    }
    if (!ready) return note(`Bande de bruit : il faut ${rule.look} séances complètes (défiler à gauche)`);

    if (on('showStats')) {
      const lines = [`Bande de bruit · ${NB_SESSIONS[key].label}`];
      if (robot) {
        lines.push(count ? `Robot (non prouvé) : ${fr(sum)} · ${count} signaux · ${Math.round((wins / count) * 100)} % gagnants` : 'Robot (non prouvé) : aucun signal terminé');
        if (today) lines.push(today);
        lines.push(`2 entrées par signal, frais ${String(+(cost * 100).toFixed(4)).replace('.', DEC)} % par côté, sur ce graphique`);
      } else if (on('robot')) lines.push('Signaux du robot : en 15 minutes');
      // one block just above the lowest point of the last bars (the band's lower edge, most often: clear of the candles)
      let bottom = Infinity;
      for (let i = Math.max(0, n - 60); i < n; i++) bottom = Math.min(bottom, k[i].low, Number.isFinite(loV[i]) ? loV[i] : Infinity);
      labels.push({ time: k[Math.max(0, n - 12)].time, price: bottom, text: lines.join('\n'), color: col, style: 'down', size: 10 });
    }
    markers.sort((a, z) => a.time - z.time);
    return out();
  },
};
