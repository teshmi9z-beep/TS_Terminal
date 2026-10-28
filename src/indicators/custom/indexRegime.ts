import type { IndicatorDef, PlotBackground, PlotBox, PlotLabel, PlotPoint } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';

// What the study of the user's main-list indices found (scripts/robots/index-study.ts and
// index-inspect.ts, since 2020): no candle configuration tells the direction better than
// chance once checked on later years and on 39 other indices, but the regime tells the
// risk. Under the 200-day average an index moves 2 to 3 times more (46 to 47 indices out
// of 47), without falling more on average. So this indicator gives no buy / sell: it
// colors the regime (calm above the average, agitated below) and shows how far the price
// went, in 80 % of the cases, over the next bars in that regime on this chart: the
// distance a stop needs so as not to be taken by the ordinary noise.
export const INDEX_REGIME: IndicatorDef = {
  type: 'INDEX_REGIME',
  label: 'Régime calme / agité (indices)',
  short: 'Régime',
  category: 'Personnalises',
  overlay: true,
  description: 'Calme au-dessus de la moyenne 200, agité en dessous, et le mouvement probable des prochaines bougies (pour placer le stop)',
  defaults: { period: 0, color: '#089981' },
  inputs: [
    { key: 'maLen', label: 'Moyenne de tendance (bougies)', default: 200, min: 20, max: 500, step: 10 },
    { key: 'atrLen', label: 'ATR (bougies)', default: 14, min: 2, max: 100, step: 1 },
    { key: 'cover', label: 'Part des cas couverts (%)', default: 80, min: 50, max: 99, step: 5 },
    { key: 'horizon', label: 'Sur les prochaines bougies', default: 1, min: 1, max: 20, step: 1 },
    { key: 'showBand', label: 'Mouvement probable (bande)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showMa', label: 'Moyenne de tendance', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showBg', label: 'Fond du régime', default: true, kind: 'bool', group: 'Affichage', inline: 'bg' },
    { key: 'bgTransp', label: 'Transparence', default: 92, min: 0, max: 100, step: 1, group: 'Affichage', inline: 'bg' },
    { key: 'calmColor', label: 'Calme', default: '#089981', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'stormColor', label: 'Agité', default: '#ff9800', kind: 'color', group: 'Couleurs', inline: 'c' },
  ],
  styles: [],
  params: (cfg) => `${inputOf(cfg, INDEX_REGIME, 'maLen')}, ${inputOf(cfg, INDEX_REGIME, 'cover')} %`,
  compute(k, cfg) {
    const n = k.length;
    const maLen = Math.max(2, Math.round(inputOf(cfg, INDEX_REGIME, 'maLen')));
    const atrLen = Math.max(2, Math.round(inputOf(cfg, INDEX_REGIME, 'atrLen')));
    const cover = Math.min(0.99, Math.max(0.5, inputOf(cfg, INDEX_REGIME, 'cover') / 100));
    const H = Math.max(1, Math.round(inputOf(cfg, INDEX_REGIME, 'horizon')));
    const calm = stringInput(cfg, INDEX_REGIME, 'calmColor'), storm = stringInput(cfg, INDEX_REGIME, 'stormColor');
    const on = (key: string) => boolInput(cfg, INDEX_REGIME, key);
    if (n < maLen + 2) return [];

    // the average and Wilder's ATR
    const ma = new Array<number>(n).fill(NaN), atr = new Array<number>(n).fill(NaN);
    let sum = 0, a = 0;
    for (let i = 0; i < n; i++) {
      sum += k[i].close;
      if (i >= maLen) sum -= k[i - maLen].close;
      if (i >= maLen - 1) ma[i] = sum / maLen;
      const tr = i ? Math.max(k[i].high - k[i].low, Math.abs(k[i].high - k[i - 1].close), Math.abs(k[i].low - k[i - 1].close)) : k[i].high - k[i].low;
      a = i < atrLen ? (a * i + tr) / (i + 1) : (a * (atrLen - 1) + tr) / atrLen;
      if (i >= atrLen - 1) atr[i] = a;
    }
    const regime = (i: number) => (Number.isNaN(ma[i]) ? 0 : k[i].close > ma[i] ? 1 : -1);

    // how far the price went from the close over the next H bars, in ATR, by regime
    const moves: Record<number, number[]> = { 1: [], [-1]: [] };
    for (let i = 0; i + H < n; i++) {
      const r = regime(i);
      if (!r || !(atr[i] > 0)) continue;
      let far = 0;
      for (let j = i + 1; j <= i + H; j++) far = Math.max(far, k[j].high - k[i].close, k[i].close - k[j].low);
      moves[r].push(far / atr[i]);
    }
    const quantile = (x: number[]) => {
      const s = [...x].sort((p, q) => p - q);
      return s[Math.min(s.length - 1, Math.floor(cover * s.length))];
    };
    const all = [...moves[1], ...moves[-1]];
    if (!all.length) return [];
    // a regime seen too rarely on this chart takes the value of all the bars
    const kOf = (r: number) => (moves[r].length >= 30 ? quantile(moves[r]) : quantile(all));
    const kCalm = kOf(1), kStorm = kOf(-1);

    // the band: what the bar H bars before gave as the probable move, drawn H bars later
    const hi: PlotPoint[] = [], lo: PlotPoint[] = [], maLine: PlotPoint[] = [], bg: PlotBackground[] = [];
    const transp = inputOf(cfg, INDEX_REGIME, 'bgTransp');
    for (let i = 0; i < n; i++) {
      const t = k[i].time;
      maLine.push({ time: t, value: ma[i] });
      const p = i - H, r = p >= 0 ? regime(p) : 0;
      const d = r && atr[p] > 0 ? (r > 0 ? kCalm : kStorm) * atr[p] : NaN;
      hi.push({ time: t, value: r ? k[p].close + d : NaN, color: r > 0 ? calm : storm });
      lo.push({ time: t, value: r ? k[p].close - d : NaN, color: r > 0 ? calm : storm });
      const c = regime(i);
      if (!c) continue;
      const color = withTransparency(c > 0 ? calm : storm, transp);
      const prev = bg[bg.length - 1];
      if (prev && prev.color === color) prev.to = t;
      else bg.push({ from: t, to: t, color });
    }

    // the zone ahead of the last bar and its reading
    const L = n - 1, rL = regime(L);
    const boxes: PlotBox[] = [], labels: PlotLabel[] = [];
    if (rL && atr[L] > 0) {
      const d = (rL > 0 ? kCalm : kStorm) * atr[L];
      const col = rL > 0 ? calm : storm;
      const digits = k[L].close >= 1000 ? 0 : k[L].close >= 10 ? 2 : 4;
      if (on('showBand')) boxes.push({ left: k[L].time, right: k[L].time, rightBars: H, top: k[L].close + d, bottom: k[L].close - d, fill: withTransparency(col, 85), border: withTransparency(col, 40), borderWidth: 1, borderStyle: 'dashed' });
      labels.push({
        // under the zone: the chart's legend sits at the top
        time: k[Math.max(0, L - 15)].time, price: k[L].close - d, color: col, style: 'up', size: 11,
        text: `${rL > 0 ? 'Calme' : 'Agité'} · ${Math.round(cover * 100)} % des cas : ±${d.toFixed(digits)} (${(rL > 0 ? kCalm : kStorm).toFixed(1)} ATR) sur ${H} bougie${H > 1 ? 's' : ''} · stop au-delà`,
      });
    }

    return [
      { key: 'bg', name: 'Fond du régime', color: calm, kind: 'bgcolor', data: [], bg: on('showBg') ? bg : [] },
      { key: 'ma', name: 'Moyenne de tendance', color: withTransparency('#787b86', 20), kind: 'line', width: 1, data: on('showMa') ? maLine : [] },
      { key: 'hi', name: 'Mouvement probable (haut)', color: calm, kind: 'line', width: 1, step: true, dashed: true, data: on('showBand') ? hi : [] },
      { key: 'lo', name: 'Mouvement probable (bas)', color: calm, kind: 'line', width: 1, step: true, dashed: true, data: on('showBand') ? lo : [] },
      { key: 'zone', name: 'Zone probable', color: calm, kind: 'boxes', data: [], boxes },
      { key: 'labels', name: 'Lecture', color: calm, kind: 'labels', data: [], labels },
    ];
  },
};
