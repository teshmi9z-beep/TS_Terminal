import type { Candle } from '../../types';
import type { IndicatorDef, Plot } from '../types';
import { closes, highest, highs, inputOf, lowest, lows, plotColor, smaNa, stringInput, toPoints } from '../helpers';

// Port of the Pine Script v5 indicator "Stoch Price Envelope [1-99] - No BB".
// The stochastic %K / %D levels are projected back onto the price scale over
// the [lowest low, highest high] range of the last `k` bars.
// "Unité de temps" reads the envelope of a higher timeframe (built from the chart's own
// bars), as the lab's robots do: each bar shows the envelope of the last closed higher bar.

const TFS: [string, number][] = [['Celle du graphique', 0], ['1 heure', 3600], ['4 heures', 14400], ['Journalier', 86400], ['Hebdomadaire', 604800]];
export const SPE_TF_LABEL: Record<string, string> = { '1h': '1 heure', '4h': '4 heures', '1d': 'Journalier', '1w': 'Hebdomadaire' };

// the four lines of the envelope on these bars
function envelope(candles: Candle[], kPeriod: number, smoothK: number, dPeriod: number, levelHigh: number, levelLow: number) {
  // --- bounds (HH / LL)
  const hh = highest(highs(candles), kPeriod);
  const ll = lowest(lows(candles), kPeriod);
  const range = hh.map((h, i) => h - ll[i]);

  // --- classic stochastic (internal); x / 0 is na in Pine
  const close = closes(candles);
  const rawK = close.map((c, i) => (range[i] === 0 ? NaN : (100 * (c - ll[i])) / range[i]));
  const smoothedK = smaNa(rawK, smoothK);
  const dSignal = smaNa(smoothedK, dPeriod);

  // --- projection back onto price
  const at = (pct: (i: number) => number) => range.map((r, i) => (pct(i) / 100) * r + ll[i]);
  // is_breaking_up / is_breaking_down are computed by the original script but
  // never plotted, so they are not reproduced here.
  return { p99: at(() => levelHigh), p01: at(() => levelLow), mid: at(() => 50), sig: at((i) => dSignal[i]) };
}

// the chart's bars grouped by higher bar (weeks from Monday, like the lab), and for each
// chart bar the last higher bar already closed (-1 before the first one closes)
function higher(candles: Candle[], seconds: number) {
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 200); i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  const step = gaps[gaps.length >> 1] || 60;
  if (seconds <= step) return null;
  const anchor = seconds >= 7 * 86400 ? 4 * 86400 : 0;
  const rows: Candle[] = [], idx: number[] = [], bucket: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], bk = Math.floor((c.time - anchor) / seconds);
    const last = rows[rows.length - 1];
    if (last && bucket[i - 1] === bk) {
      last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close; last.volume += c.volume;
    } else rows.push({ time: bk * seconds + anchor, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    bucket.push(bk); idx.push(rows.length - 1);
  }
  const closed = candles.map((c, i) => (c.time + step >= (bucket[i] + 1) * seconds + anchor ? idx[i] : idx[i] - 1));
  return { rows, closed };
}
export const STOCH_PRICE_ENVELOPE: IndicatorDef = {
  type: 'STOCH_ENV',
  label: 'Stoch Price Envelope [1-99] - No BB',
  short: 'Stoch Price Envelope',
  category: 'Personnalises',
  overlay: true,
  description: 'Niveaux stochastiques 1 / 50 / 99 % et signal D projetés sur le prix',
  defaults: { period: 0, color: '#FF9800' },
  inputs: [
    { key: 'k', label: 'Période (Mémoire 200)', default: 200, min: 1, max: 5000 },
    { key: 'smoothK', label: 'Lissage K', default: 3, min: 1, max: 500 },
    { key: 'd', label: 'Période D (Signal)', default: 200, min: 1, max: 5000 },
    { key: 'high', label: 'Niveau Haut (%)', default: 99, min: 0, max: 100, step: 0.5 },
    { key: 'low', label: 'Niveau Bas (%)', default: 1, min: 0, max: 100, step: 0.5 },
    { key: 'tf', label: 'Unité de temps', default: TFS[0][0], kind: 'string', options: TFS.map(([l]) => l) },
  ],
  // Pine: color.red, color.lime, color.new(color.orange, 50), color.orange
  styles: [
    { key: 'p99', name: 'Plafond (99%)', color: '#FF5252' },
    { key: 'p01', name: 'Plancher (1%)', color: '#00E676' },
    { key: 'mid', name: 'Milieu (50%)', color: '#FF980080' },
    { key: 'sig', name: 'Signal Stoch', color: '#FF9800' },
  ],
  params(cfg) {
    const v = (key: string) => inputOf(cfg, STOCH_PRICE_ENVELOPE, key);
    const tf = stringInput(cfg, STOCH_PRICE_ENVELOPE, 'tf');
    return `${v('k')} ${v('smoothK')} ${v('d')} ${v('high')} ${v('low')}${tf !== TFS[0][0] ? ` · ${tf}` : ''}`;
  },
  compute(candles, cfg) {
    const input = (key: string) => inputOf(cfg, STOCH_PRICE_ENVELOPE, key);
    const kPeriod = Math.max(1, Math.round(input('k')));
    const smoothK = Math.max(1, Math.round(input('smoothK')));
    const dPeriod = Math.max(1, Math.round(input('d')));
    const levelHigh = input('high');
    const levelLow = input('low');

    const seconds = TFS.find(([l]) => l === stringInput(cfg, STOCH_PRICE_ENVELOPE, 'tf'))?.[1] ?? 0;
    const htf = seconds ? higher(candles, seconds) : null;
    let env = envelope(htf ? htf.rows : candles, kPeriod, smoothK, dPeriod, levelHigh, levelLow);
    // a higher timeframe's lines, held on each chart bar until its next higher bar closes
    if (htf) {
      const hold = (xs: number[]) => htf.closed.map((j) => (j >= 0 ? xs[j] : NaN));
      env = { p99: hold(env.p99), p01: hold(env.p01), mid: hold(env.mid), sig: hold(env.sig) };
    }
    const { p99: price99, p01: price01, mid: priceMid, sig: priceSignal } = env;

    const col = (key: string) => plotColor(cfg, STOCH_PRICE_ENVELOPE, key);
    const plots: Plot[] = [
      { key: 'p99', name: 'Plafond (99%)', color: col('p99'), kind: 'line', width: 2, step: !!htf, data: toPoints(candles, price99) },
      { key: 'p01', name: 'Plancher (1%)', color: col('p01'), kind: 'line', width: 2, step: !!htf, data: toPoints(candles, price01) },
      { key: 'mid', name: 'Milieu (50%)', color: col('mid'), kind: 'line', width: 1, step: true, data: toPoints(candles, priceMid) },
      { key: 'sig', name: 'Signal Stoch', color: col('sig'), kind: 'line', width: 2, step: !!htf, data: toPoints(candles, priceSignal) },
    ];
    return plots;
  },
};
