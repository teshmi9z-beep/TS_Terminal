import {
  AreaSeries, BarSeries, CandlestickSeries, LineSeries,
  type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp,
} from 'lightweight-charts';
import { useStore } from '../store/store';
import { heikinAshi } from '../indicators/math';
import type { Candle, ChartSettings } from '../types';

// The price series in the chart style picked in "Style du graphique" (candles, Heikin Ashi, bars,
// line, area), shared by the main chart and the small charts of the 2 / 4 and free windows (which
// may have a style of their own: `style`, else the one of "Style du graphique").

export type CandleStyle = ChartSettings['candleStyle'];
export const STYLE_LABELS: Record<CandleStyle, string> = {
  candles: 'Bougies', bars: 'Barres', line: 'Ligne', area: 'Aire', heikin_ashi: 'Heikin Ashi',
};
export const STYLE_ORDER: CandleStyle[] = ['candles', 'heikin_ashi', 'bars', 'line', 'area'];
const shownStyle = () => useStore.getState().chartSettings.candleStyle;

const ts = (t: number) => t as UTCTimestamp;
// estimated bars (index futures estimated in real time) keep their rising / falling body and
// get the estimate's violet outline and wick. A faded body hid the direction: in the light
// theme a faded black falling candle turned grey, like a rising one.
const EST_COLOR = '#8e6cf0';
export const ohlcPoint = (c: Candle) => {
  const p = { time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
  if (!c.est) return p;
  const s = useStore.getState().chartSettings;
  return { ...p, color: c.close >= c.open ? s.upColor : s.downColor, borderColor: EST_COLOR, wickColor: EST_COLOR };
};

export function nextHeikinAshi(prev: Candle | undefined, c: Candle): Candle {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  return { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close, volume: c.volume };
}

export function makeMainSeries(chart: IChartApi, s: ChartSettings, style: CandleStyle = s.candleStyle): ISeriesApi<SeriesType> {
  if (style === 'bars') return chart.addSeries(BarSeries, { upColor: s.upColor, downColor: s.downColor }, 0);
  if (style === 'line') return chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2 }, 0);
  if (style === 'area') {
    return chart.addSeries(AreaSeries, { lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.28)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2 }, 0);
  }
  return chart.addSeries(CandlestickSeries, {
    upColor: s.upColor, downColor: s.downColor,
    borderUpColor: s.borderUpColor ?? s.upColor, borderDownColor: s.borderDownColor ?? s.downColor,
    wickUpColor: s.wickUpColor, wickDownColor: s.wickDownColor,
  }, 0);
}

// what recreates the price series when it changes
export const styleKeyOf = (s: ChartSettings, style: CandleStyle = s.candleStyle) =>
  `${style}|${s.upColor}|${s.downColor}|${s.wickUpColor}|${s.wickDownColor}|${s.borderUpColor}|${s.borderDownColor}`;

// all the bars in the chart style; `ha` receives the Heikin Ashi bars, which the next live bar continues
export function setSeriesBars(series: ISeriesApi<SeriesType>, candles: Candle[], ha: { current: Candle[] }, style: CandleStyle = shownStyle()) {
  if (style === 'line' || style === 'area') {
    series.setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
  } else if (style === 'heikin_ashi') {
    ha.current = heikinAshi(candles);
    series.setData(ha.current.map(ohlcPoint));
  } else {
    series.setData(candles.map(ohlcPoint));
  }
}

// the last bar (moved or new) in the chart style
export function updateSeriesLast(series: ISeriesApi<SeriesType>, c: Candle, ha: { current: Candle[] }, style: CandleStyle = shownStyle()) {
  if (style === 'line' || style === 'area') {
    series.update({ time: ts(c.time), value: c.close });
  } else if (style === 'heikin_ashi') {
    const list = ha.current;
    const replacing = list.length > 0 && list[list.length - 1].time === c.time;
    const bar = nextHeikinAshi(replacing ? list[list.length - 2] : list[list.length - 1], c);
    if (replacing) list[list.length - 1] = bar; else list.push(bar);
    series.update(ohlcPoint(bar));
  } else {
    series.update(ohlcPoint(c));
  }
}
