import { TickMarkType, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesType, type Time } from 'lightweight-charts';
import type { Candle, IndicatorConfig, Symbol, Timeframe, UiTheme } from '../types';
import { isDailyTf, parseTf, tfSeconds } from '../data/timeframes';
import { zoneOffsetSec } from '../data/timeZone';
import type { Plot } from '../indicators/registry';
import type { IndicatorShapes } from './indicatorShapes';
import { LANG } from '../i18n/lang';

export type IndicatorRuntime = {
  cfg: IndicatorConfig;
  // 0 = main price pane
  pane: number;
  // one series per line / histogram plot, in plot order
  series: ISeriesApi<SeriesType>[];
  plots: Plot[];
  // Pine plotshape markers
  markers: ISeriesMarkersPluginApi<Time> | null;
  // false while the indicator is hidden (eye, timeframe visibility, collapsed pane):
  // the markers sit on the price series, so they are emptied rather than hidden
  shown?: boolean;
  // Pine boxes / labels painted on the price pane
  shapes: IndicatorShapes | null;
};

// everything the overlays (legends, drawings, countdown) need to read from the live chart
export type ChartEngine = {
  chart: IChartApi | null;
  mainSeries: ISeriesApi<SeriesType> | null;
  candles: Candle[];
  indicators: IndicatorRuntime[];
  precision: number;
};

export type ChartHandles = ChartEngine;

// "Visibilité" tab of the indicator settings: is the indicator drawn on this timeframe
export function shownOnTimeframe(cfg: Pick<IndicatorConfig, 'tfVisibility'>, tf: Timeframe): boolean {
  const { n, unit } = parseTf(tf);
  const v = cfg.tfVisibility?.[unit];
  return !v || (v.on && n >= v.min && n <= v.max);
}

export const COLLAPSED_PANE_PX = 26;

export function chartColors(theme: UiTheme) {
  return theme === 'dark'
    ? { text: '#d1d4dc', border: '#2a2e39', separator: '#2a2e39', crossLine: '#9598a1', crossLabel: '#363a45' }
    : { text: '#131722', border: '#e0e3eb', separator: '#e0e3eb', crossLine: '#9598a1', crossLabel: '#131722' };
}

export function pricePrecision(sym: Symbol, price: number): number {
  // yen pairs are quoted to 3 decimals whatever their price (ZARJPY, NOKJPY)
  if (sym.category === 'Forex') return price >= 20 || sym.ticker.endsWith('JPY') ? 3 : 5;
  const p = Math.abs(price);
  if (p >= 1) return sym.category === 'Matieres premieres' && p < 10 ? 3 : 2;
  if (p >= 0.01) return 4;
  if (p >= 0.0001) return 6;
  return 8;
}

export function formatPrice(v: number, precision: number): string {
  return v.toFixed(precision);
}

export function formatVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(a < 10 ? 2 : 0);
}

const DAYS = LANG === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MONTHS = LANG === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] : ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];
const pad = (n: number) => String(n).padStart(2, '0');

export { isDailyTf };

// daily+ bars are keyed by calendar date (00:00 UTC) so they must not be shifted
// by the display timezone; intraday and tick bars are real instants, read in the zone's
// own time of that day (summer or winter time)
export function timeFormatters(zone: string, tf: Timeframe) {
  const daily = isDailyTf(tf);
  const toDate = (t: Time) => new Date(((t as number) + (daily ? 0 : zoneOffsetSec(zone, t as number))) * 1000);
  return {
    timeFormatter: (t: Time) => {
      const d = toDate(t);
      const date = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
      if (isDailyTf(tf)) return date;
      const secs = /[Ts]$/.test(tf) ? `:${pad(d.getUTCSeconds())}` : '';
      return `${date}  ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${secs}`;
    },
    tickMarkFormatter: (t: Time, type: TickMarkType) => {
      const d = toDate(t);
      switch (type) {
        case TickMarkType.Year: return String(d.getUTCFullYear());
        case TickMarkType.Month: return MONTHS[d.getUTCMonth()];
        case TickMarkType.DayOfMonth: return String(d.getUTCDate());
        case TickMarkType.Time: return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        default: return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      }
    },
  };
}

// epoch seconds at which the bar starting at lastTime closes (null for tick bars)
export function barCloseTime(tf: Timeframe, lastTime: number): number | null {
  const { n, unit } = parseTf(tf);
  if (unit === 'M') {
    const d = new Date(lastTime * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 1000;
  }
  const step = tfSeconds(tf);
  return step ? lastTime + step : null;
}

export function formatCountdown(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}j ${pad(h)}h`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

// index of the last candle with time <= t, or -1
export function indexAtOrBefore(candles: Candle[], t: number): number {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function typicalStep(candles: Candle[]): number {
  const n = candles.length;
  if (n < 2) return 60;
  const deltas: number[] = [];
  for (let i = Math.max(1, n - 50); i < n; i++) deltas.push(candles[i].time - candles[i - 1].time);
  deltas.sort((a, b) => a - b);
  // tick bars can be milliseconds apart
  return Math.max(0.001, deltas[deltas.length >> 1]);
}

// time <-> fractional bar index, extrapolating past both ends of the data.
// Lets drawings survive timeframe changes and live in the empty future area.
export function timeToLogical(candles: Candle[], t: number): number | null {
  const n = candles.length;
  if (!n) return null;
  const step = typicalStep(candles);
  if (t <= candles[0].time) return (t - candles[0].time) / step;
  if (t >= candles[n - 1].time) return n - 1 + (t - candles[n - 1].time) / step;
  const i = indexAtOrBefore(candles, t);
  const a = candles[i], b = candles[i + 1];
  return i + (t - a.time) / (b.time - a.time);
}

// millisecond precision: several tick bars can share the same second
const roundMs = (t: number) => Math.round(t * 1000) / 1000;

export function logicalToTime(candles: Candle[], logical: number): number | null {
  const n = candles.length;
  if (!n) return null;
  const step = typicalStep(candles);
  if (logical <= 0) return roundMs(candles[0].time + logical * step);
  if (logical >= n - 1) return roundMs(candles[n - 1].time + (logical - (n - 1)) * step);
  const i = Math.floor(logical);
  const a = candles[i], b = candles[i + 1];
  return roundMs(a.time + (logical - i) * (b.time - a.time));
}
