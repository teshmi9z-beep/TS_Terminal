import type { Candle, Timeframe } from '../../types';
import type { IndicatorDef, Plot, PlotPoint } from '../types';
import { boolInput, inputOf, plotColor, stringInput } from '../helpers';
import { SYMBOLS } from '../../data/symbols';
import { tfSeconds } from '../../data/timeframes';
import { familyOf, inCashSession, nextExpiry } from '../../data/indexFamilies';
import { closeAt, companion, currentChartSeries } from '../companion';
import { LOCALE } from '../../i18n/lang';

// The basis of an index: its future minus the cash index (or minus a CFD quoted at the cash
// level). Above zero the future is in contango ("report": rates above dividends), below in
// backwardation ("déport"). The theoretical basis is the cost of carry to the front contract's
// last trading day, cash × (rate − dividends) × days / 365; what is left, the premium, is what
// arbitrage closes. Works on the cash, the future or the CFD of a main-list index: the other
// series load in the background (src/indicators/companion.ts).

// the legend's summary, per indicator
const info = new Map<string, string>();

const pts = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const dayMonth = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export const BASIS: IndicatorDef = {
  type: 'BASIS',
  label: 'Base future / cash (contango, déport)',
  short: 'Base',
  category: 'Personnalises',
  overlay: false,
  description: 'Écart du future sur l’indice cash (ou le CFD) : contango au-dessus de zéro, déport en dessous, avec l’écart théorique du portage jusqu’à l’échéance et la prime restante',
  defaults: { period: 0, color: '#2962ff' },
  inputs: [
    { key: 'ref', label: 'Comparer le future à', default: 'Cash', kind: 'string', options: ['Cash', 'CFD'], tooltip: 'Le cash n’existe que pendant sa séance ; le CFD cote presque 24 h sur 24 au niveau du cash' },
    { key: 'unit', label: 'Unité', default: 'Points', kind: 'string', options: ['Points', '%'] },
    { key: 'showTheo', label: 'Écart théorique (portage)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showPrem', label: 'Prime (écart − théorique)', default: false, kind: 'bool', group: 'Affichage' },
    { key: 'rate', label: 'Taux (%/an, −1 = défaut de l’indice)', default: -1, min: -1, max: 20, step: 0.05, group: 'Portage', tooltip: 'Défauts : dollar 3,9 %, euro 2,3 %, yen 0,75 %, dollar de Hong Kong 3,5 %' },
    { key: 'div', label: 'Dividendes (%/an, −1 = défaut de l’indice)', default: -1, min: -1, max: 20, step: 0.05, group: 'Portage', tooltip: 'Défauts : S&P 1,2 %, Nasdaq 0,7 %, Dow 1,6 %, Russell 1,3 %, DAX 0 (indice de performance), CAC 3 %, Nikkei 1,8 %, Hang Seng 3,5 %' },
  ],
  styles: [
    { key: 'basis', name: 'Écart (contango)', color: '#2962ff' },
    { key: 'back', name: 'Écart (déport)', color: '#ff9800' },
    { key: 'theo', name: 'Écart théorique', color: '#9598a1' },
    { key: 'prem', name: 'Prime', color: '#26a69a' },
  ],
  params: (cfg) => info.get(cfg.id) ?? '',
  compute(k, cfg) {
    const up = plotColor(cfg, BASIS, 'basis'), down = plotColor(cfg, BASIS, 'back');
    const basis: PlotPoint[] = [], theo: PlotPoint[] = [], prem: PlotPoint[] = [];
    const out = (): Plot[] => [
      { key: 'basis', name: 'Écart', color: up, kind: 'line', width: 2, data: basis },
      { key: 'theo', name: 'Théorique', color: plotColor(cfg, BASIS, 'theo'), kind: 'line', width: 1, data: theo },
      { key: 'prem', name: 'Prime', color: plotColor(cfg, BASIS, 'prem'), kind: 'histogram', data: prem },
      { key: 'zero', name: 'Zéro', color: '#787b86', kind: 'hline', price: 0, dashed: true, data: [] },
    ];
    // the symbol and timeframe of these bars (not the store's, which changes before the bars do)
    const st = currentChartSeries();
    if (!st) return out();
    const fam = familyOf(st.sym.ticker);
    if (!fam) { info.set(cfg.id, '· à ouvrir sur un indice de la liste (cash, future ou CFD)'); return out(); }
    const { family } = fam;
    const ref = stringInput(cfg, BASIS, 'ref') === 'CFD' && family.cfd ? family.cfd : family.cash;
    const pct = stringInput(cfg, BASIS, 'unit') === '%';
    const rateIn = inputOf(cfg, BASIS, 'rate'), divIn = inputOf(cfg, BASIS, 'div');
    const carry = ((rateIn >= 0 ? rateIn : family.rate) - (divIn >= 0 ? divIn : family.div)) / 100;
    const step = tfSeconds(st.tf) ?? 60;
    if (!k.length) return out();
    // both prices at the same moment: above 15 minutes, a cash bar and a future bar of the chart's
    // size don't end together (US cash hours start at :30, the last cash bar of a day is short),
    // so the basis is measured on 15-minute bars and each chart bar shows its last value
    const fine: Timeframe = step > 900 ? '15m' : st.tf;
    const fineStep = Math.min(step, 900);

    // the chart's own bars, or the other instrument's (loading in the background)
    const series = (ticker: string): Candle[] | string => {
      if (ticker === st.sym.ticker && fine === st.tf) return k;
      const sym = SYMBOLS.find((s) => s.ticker === ticker);
      if (!sym) return `${ticker} inconnu`;
      const c = companion(sym, fine, k[0].time);
      if (c.state === 'error') return `${ticker} indisponible (${c.error})`;
      if (c.state === 'loading') return `chargement de ${ticker}…`;
      return c.candles;
    };
    const F = series(family.future), R = series(ref);
    if (typeof F === 'string' || typeof R === 'string') {
      info.set(cfg.id, `${family.name} · ${typeof F === 'string' ? F : R}`);
      return out();
    }

    // the pairs (reference bar, future at the same time), then the last pair of each chart bar
    const pairs: { time: number; b: number; r: number }[] = [];
    const cashRef = ref === family.cash;
    for (const c of R) {
      if (cashRef && !inCashSession(family, c.time)) continue;
      const f = closeAt(F, c.time, fineStep);
      if (f > 0 && c.close > 0) pairs.push({ time: c.time, b: f - c.close, r: c.close });
    }
    const showTheo = boolInput(cfg, BASIS, 'showTheo'), showPrem = boolInput(cfg, BASIS, 'showPrem');
    let last = -1, lastB = NaN, lastR = NaN, lastT = NaN, lastExp = 0, lastTime = 0, p = 0;
    for (let i = 0; i < k.length; i++) {
      const time = k[i].time, end = i + 1 < k.length ? Math.min(k[i + 1].time, time + step) : time + step;
      while (p < pairs.length && pairs[p].time < time) p++;
      let q = -1;
      while (p < pairs.length && pairs[p].time < end) q = p++;
      if (q < 0) {
        // a break in the lines (the cash is closed)
        basis.push({ time, value: NaN });
        if (showTheo) theo.push({ time, value: NaN });
        if (showPrem) prem.push({ time, value: NaN });
        continue;
      }
      const { b, r } = pairs[q];
      const exp = nextExpiry(family.expiry, pairs[q].time);
      const t = r * carry * Math.max(0, exp - pairs[q].time) / 86400 / 365;
      const scale = pct ? 100 / r : 1;
      basis.push({ time, value: b * scale, color: b >= 0 ? up : down });
      if (showTheo) theo.push({ time, value: t * scale });
      if (showPrem) prem.push({ time, value: (b - t) * scale });
      last = i; lastB = b; lastR = r; lastT = t; lastExp = exp; lastTime = pairs[q].time;
    }

    if (last < 0) {
      info.set(cfg.id, `${family.name} · pas encore de bougies communes au future et à ${ref}`);
      return out();
    }
    const days = Math.max(0, (lastExp - lastTime) / 86400);
    const annual = days > 0.5 ? (lastB / lastR) * (365 / days) * 100 : NaN;
    const parts = [
      `${family.name} · future − ${ref === family.cash ? 'cash' : 'CFD'}`,
      `${lastB >= 0 ? 'contango' : 'déport'} ${pts(lastB)} pts (${pts((lastB / lastR) * 100, 2)} %)`,
      Number.isNaN(annual) ? '' : `portage ${pts(annual)} %/an`,
      showTheo || showPrem ? `théorique ${pts(lastT)}, prime ${pts(lastB - lastT)}` : '',
      `échéance ${dayMonth(lastExp)} (${Math.round(days)} j)`,
      last < k.length - 1 ? 'à la dernière bougie commune' : '',
    ];
    info.set(cfg.id, `· ${parts.filter(Boolean).join(' · ')}`);
    return out();
  },
};
