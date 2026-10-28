import type { Candle } from '../../types';
import type { IndicatorDef, Plot, PlotBox, PlotLabel } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';
import { SYMBOLS } from '../../data/symbols';
import { tfSeconds } from '../../data/timeframes';
import { familyOf, inCashSession, localDay, type IndexFamily } from '../../data/indexFamilies';
import { companion, currentChartSeries } from '../companion';
import { GAP_BUCKETS, GAP_STATS } from './gapStats';
import { LOCALE } from '../../i18n/lang';

// The cash index's opening gap (open against the previous session's close) as a box from the
// open until the price comes back to that close ("comblé") or the session ends, with what the
// study of 2020 → now found for a gap of that size and direction on that index
// (scripts/robots/gap-study.ts): how often it filled within the hour and by the close.
// Before the open: on the cash chart, the gap its future announces (the future's move since the
// cash close); on the future or the CFD, the gap forming (their own move since the cash close).
// On a daily chart of the cash index, every day's gap runs until a later day fills it: the gaps
// still open show years back.

const pct = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d })} %`;
const price = (v: number) => v.toLocaleString(LOCALE, { maximumFractionDigits: 2 });

// what the study says for a gap: "comblé 58 % des fois dans l'heure, 71 % d'ici la clôture"
function odds(f: IndexFamily, gapPct: number): string {
  const a = Math.abs(gapPct);
  let b = -1;
  GAP_BUCKETS.forEach((x, i) => { if (a >= x) b = i; });
  if (b < 0) return 'gap trop petit pour compter (moins de 0,1 %)';
  const row = GAP_STATS[f.cash]?.[gapPct > 0 ? 'up' : 'down']?.[b];
  if (!row || row[0] < 10) return 'pas assez de cas dans l’étude';
  const [n, , , f60, , fClose, med] = row;
  const hour = med >= 0 ? `${Math.round(f60)} % dans l’heure, ` : '';
  return `comblé ${hour}${Math.round(fClose)} % d’ici la clôture\n(${n} cas depuis 2020${med >= 0 ? `, médiane ${med} min` : ''})`;
}

export const GAP_OPEN: IndicatorDef = {
  type: 'GAP_OPEN',
  label: 'Gap d’ouverture (comblé ou pas, ouverture attendue)',
  short: 'Gap',
  category: 'Personnalises',
  overlay: true,
  description: 'Le gap du cash à l’ouverture jusqu’à son comblement, avec les chances qu’il se comble (étude depuis 2020), et avant l’ouverture le gap qu’annonce le future',
  defaults: { period: 0, color: '#089981' },
  inputs: [
    { key: 'mode', label: 'Affichage', default: 'Nuit seulement', kind: 'string', options: ['Nuit seulement', 'Complet'], tooltip: 'Nuit seulement : rien pendant la séance cash, le gap en léger de la clôture cash à l’ouverture suivante. Complet : le gap pendant la séance jusqu’à son comblement, avec les chances de l’étude.' },
    { key: 'sessions', label: 'Séances affichées (0 = toutes)', default: 0, min: 0, max: 5000, step: 1, tooltip: 'Toutes les séances chargées sur le graphique : en reculant dans le temps, les plus anciennes apparaissent aussi' },
    { key: 'minGap', label: 'Gap minimum (%)', default: 0.1, min: 0, max: 5, step: 0.05 },
    { key: 'showOdds', label: 'Chances de comblement (étude)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showNext', label: 'Ouverture attendue / gap en formation', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showClose', label: 'Trait de la clôture cash', default: true, kind: 'bool', group: 'Affichage', tooltip: 'Un trait horizontal au niveau de la clôture du cash, depuis la clôture jusqu’au comblement du gap (ou la fin de la séance suivante)' },
    { key: 'closeColor', label: 'Couleur du trait (avant l’ouverture)', default: '#d1d4dc', kind: 'color', group: 'Couleurs' },
    { key: 'transp', label: 'Transparence des zones', default: 80, min: 0, max: 100, step: 1, group: 'Affichage' },
    { key: 'upColor', label: 'Gap haussier', default: '#089981', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'downColor', label: 'Gap baissier', default: '#f23645', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params: (cfg) => `${inputOf(cfg, GAP_OPEN, 'sessions') || 'toutes'}`,
  compute(k, cfg) {
    const boxes: PlotBox[] = [], labels: PlotLabel[] = [];
    const out = (): Plot[] => [
      { key: 'boxes', name: 'Gaps', color: '#089981', kind: 'boxes', data: [], boxes },
      { key: 'labels', name: 'Textes', color: '#089981', kind: 'labels', data: [], labels },
    ];
    // the symbol and timeframe of these bars (not the store's, which changes before the bars do)
    const st = currentChartSeries();
    if (!st) return out();
    const fam = familyOf(st.sym.ticker);
    const step = tfSeconds(st.tf) ?? 60;
    const { family, role } = fam ?? {};
    // daily: the cash index only (a future's or a CFD's day doesn't start at the cash open)
    const daily = step >= 86400;
    if (!family || k.length < 3 || step > 86400 || (daily && role !== 'cash')) return out();
    const up = stringInput(cfg, GAP_OPEN, 'upColor'), down = stringInput(cfg, GAP_OPEN, 'downColor');
    const transp = inputOf(cfg, GAP_OPEN, 'transp');
    const minGap = inputOf(cfg, GAP_OPEN, 'minGap');
    const showOdds = boolInput(cfg, GAP_OPEN, 'showOdds');
    const showClose = boolInput(cfg, GAP_OPEN, 'showClose');

    // the cash sessions on this chart: first and last bar of each (the future and the CFD trade
    // outside them: only their bars inside the cash hours count)
    type S = { first: number; last: number; day: string };
    const ss: S[] = [];
    if (daily) for (let i = 0; i < k.length; i++) ss.push({ first: i, last: i, day: '' });
    else {
      for (let i = 0; i < k.length; i++) {
        if (!inCashSession(family, k[i].time)) continue;
        const day = localDay(family, k[i].time);
        const s = ss[ss.length - 1];
        if (s && s.day === day) s.last = i; else ss.push({ first: i, last: i, day });
      }
    }
    // every session loaded, unless a number is set
    const want = Math.round(inputOf(cfg, GAP_OPEN, 'sessions'));
    const keep = want > 0 ? want : ss.length;

    // night only: nothing over the cash session, the gap drawn lightly from the cash close to
    // the next open (a band between that close and the open, the close as a thin line)
    if (stringInput(cfg, GAP_OPEN, 'mode') !== 'Complet') {
      if (daily) return out();
      for (let n = Math.max(1, ss.length - keep); n < ss.length; n++) {
        const close = k[ss[n - 1].last], open = k[ss[n].first].open;
        const g = ((open - close.close) / close.close) * 100;
        if (Math.abs(g) < minGap) continue;
        const color = g > 0 ? up : down;
        const seg = { left: close.time, leftBars: 0.5, right: k[ss[n].first].time, rightBars: -0.5 };
        boxes.push({ ...seg, top: Math.max(open, close.close), bottom: Math.min(open, close.close), fill: withTransparency(color, 92) });
        boxes.push({ ...seg, top: close.close, bottom: close.close, fill: 'rgba(0,0,0,0)', border: withTransparency(color, 40), borderWidth: 1 });
      }
      // tonight: the close and the gap forming so far (on the future or the CFD)
      const last = ss[ss.length - 1], lastBar = k[k.length - 1];
      if (last && !inCashSession(family, Math.floor(Date.now() / 1000))) {
        const close = k[last.last].close;
        const seg = { left: k[last.last].time, leftBars: 0.5, right: lastBar.time, rightBars: 6 };
        const forming = role !== 'cash' && lastBar.time > k[last.last].time;
        const g = forming ? ((lastBar.close - close) / close) * 100 : 0;
        const color = g >= 0 ? up : down;
        if (forming) boxes.push({ ...seg, top: Math.max(lastBar.close, close), bottom: Math.min(lastBar.close, close), fill: withTransparency(color, 92) });
        boxes.push({ ...seg, top: close, bottom: close, fill: 'rgba(0,0,0,0)', border: withTransparency(stringInput(cfg, GAP_OPEN, 'closeColor'), 30), borderWidth: 1, borderStyle: 'dashed' });
        labels.push({ time: lastBar.time + step * 4, price: close, color: withTransparency(stringInput(cfg, GAP_OPEN, 'closeColor'), 20), style: g >= 0 ? 'up' : 'down', size: 9,
          text: forming ? `Gap ${pct(g)}` : `Clôture cash ${price(close)}` });
      }
      return out();
    }

    for (let n = Math.max(1, ss.length - keep); n < ss.length; n++) {
      const s = ss[n], prevClose = k[ss[n - 1].last].close, open = k[s.first].open;
      const g = ((open - prevClose) / prevClose) * 100;
      if (Math.abs(g) < minGap) continue;
      // intraday: filled in the session or not (what the study measures); daily: on whichever
      // later day it happened, or still open
      let fill = -1;
      const end = daily ? k.length - 1 : s.last;
      for (let i = s.first; i <= end; i++) if (g > 0 ? k[i].low <= prevClose : k[i].high >= prevClose) { fill = i; break; }
      const color = g > 0 ? up : down;
      // the cash close as a line from that close, through the night, to the fill
      if (showClose && !daily) {
        boxes.push({
          left: k[ss[n - 1].last].time, leftBars: 0.4, right: k[fill >= 0 ? fill : end].time, rightBars: 0.4,
          top: prevClose, bottom: prevClose, fill: 'rgba(0,0,0,0)', border: color, borderWidth: 2, borderStyle: 'solid',
        });
      }
      boxes.push({
        left: k[s.first].time, leftBars: -0.4, right: k[fill >= 0 ? fill : end].time, rightBars: 0.4,
        top: Math.max(open, prevClose), bottom: Math.min(open, prevClose),
        fill: withTransparency(color, transp), border: color, borderWidth: 1, borderStyle: fill >= 0 ? 'solid' : 'dashed',
      });
      const latest = n === ss.length - 1;
      let status: string;
      if (daily) {
        const days = fill - s.first;
        status = fill < 0 ? (latest ? 'pas encore comblé' : 'toujours ouvert') : days === 0 ? 'comblé le jour même' : `comblé après ${days} j`;
      } else {
        const minutes = fill >= 0 ? Math.round((k[fill].time + step - k[s.first].time) / 60) : 0;
        status = fill >= 0 ? `comblé en ${minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`}` : s.last === k.length - 1 ? 'pas encore comblé' : 'non comblé';
      }
      // the older gaps keep a short text, the last one the study's odds
      const text = latest ? `Gap ${pct(g)} · ${status}${showOdds ? `\n${odds(family, g)}` : ''}` : `${pct(g, 1)} · ${status}`;
      // in the middle of the box
      const mid = k[Math.round((s.first + (fill >= 0 ? fill : s.last)) / 2)].time;
      labels.push({ time: mid, price: g > 0 ? Math.max(open, prevClose) : Math.min(open, prevClose), text, color, style: g > 0 ? 'down' : 'up', size: 10 });
    }

    // before the next open: the gap the future announces, or the one forming on this chart
    const lastBar = k[k.length - 1];
    const lastSession = ss[ss.length - 1];
    // after the close: the line of that close, running into the future until the next open
    if (!daily && showClose && lastSession && !inCashSession(family, Math.floor(Date.now() / 1000))) {
      const closeColor = stringInput(cfg, GAP_OPEN, 'closeColor');
      const cashClose = k[lastSession.last].close;
      boxes.push({
        left: k[lastSession.last].time, leftBars: 0.4, right: lastBar.time, rightBars: 12,
        top: cashClose, bottom: cashClose, fill: 'rgba(0,0,0,0)', border: closeColor, borderWidth: 2, borderStyle: 'solid',
      });
      // on the far side from the gap forming (whose text sits beyond the price)
      labels.push({ time: lastBar.time + step * 7, price: cashClose, text: `Clôture cash ${price(cashClose)}`, color: closeColor, style: lastBar.close >= cashClose ? 'up' : 'down', size: 10 });
    }
    if (!daily && boolInput(cfg, GAP_OPEN, 'showNext') && lastSession && !inCashSession(family, Math.floor(Date.now() / 1000))) {
      const cashClose = k[lastSession.last].close, closeTime = k[lastSession.last].time;
      let expected = NaN, source = '';
      if (role === 'cash') {
        // the future's move since the cash close, added to that close
        const sym = SYMBOLS.find((s) => s.ticker === family.future);
        const c = sym ? companion(sym, st.tf, closeTime) : null;
        const F = c?.state === 'ready' ? c.candles : [];
        const atClose = closeBefore(F, closeTime + step), now = F[F.length - 1];
        if (atClose > 0 && now && now.time > closeTime) { expected = cashClose + (now.close - atClose); source = `d’après le future ${family.future}`; }
      } else if (lastBar.time > closeTime) {
        expected = lastBar.close;
        source = 'gap en formation';
      }
      if (expected > 0) {
        const g = ((expected - cashClose) / cashClose) * 100;
        const color = g >= 0 ? up : down;
        boxes.push({
          left: lastBar.time, leftBars: 1, right: lastBar.time, rightBars: 12,
          top: Math.max(expected, cashClose), bottom: Math.min(expected, cashClose),
          fill: withTransparency(color, Math.min(95, transp + 8)), border: color, borderWidth: 1, borderStyle: 'dotted',
        });
        const head = role === 'cash'
          ? `Ouverture attendue ≈ ${price(expected)} (${pct(g)})\n${source}`
          : `Gap du cash en formation ${pct(g)}\n(depuis ${price(cashClose)}, ce graphique à la clôture du cash)`;
        labels.push({
          time: lastBar.time + step * 7, price: g >= 0 ? Math.max(expected, cashClose) : Math.min(expected, cashClose),
          text: `${head}${showOdds ? `\n${odds(family, g)}` : ''}`,
          color, style: g >= 0 ? 'down' : 'up', size: 10,
        });
      }
    }
    return out();
  },
};

// the close of the last bar of `list` starting before `time`
function closeBefore(list: Candle[], time: number): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].time < time) return list[i].close;
  return NaN;
}
