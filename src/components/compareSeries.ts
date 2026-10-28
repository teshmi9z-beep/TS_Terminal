import { CandlestickSeries, LineSeries, type IChartApi, type ISeriesApi, type LineWidth, type SeriesType, type UTCTimestamp } from 'lightweight-charts';
import { openFeed } from '../data/feeds';
import type { Candle, Timeframe } from '../types';
import type { CompareItem } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { pricePrecision } from './chartUtils';

// "Comparer": the other symbols drawn on the main chart, each a line or candles,
// on the chart's scale (in % or in price) or on a scale of its own.
//
// Like TradingView, a compared symbol is laid on the chart's own bars: each of its
// points takes the time of a chart bar (its bars since the previous chart bar merged
// into one). Its own times would otherwise add points to the time scale, and the
// drawings, which place themselves by the chart's bar index, would shift.

// candles of each compared symbol (by compare id), read by the chart's legend
export const compareCandles = new Map<string, Candle[]>();

// a compared point on a chart bar: its bar, or only the last close when it has no bar
// there (market closed: the line carries on, no candle)
type Aligned = { time: number; bar?: Candle; carry?: number };

type Entry = {
  dataKey: string;
  shapeKey: string;
  candles: Candle[];
  aligned: Aligned[];
  series: ISeriesApi<SeriesType> | null;
  off: (() => void) | null;
  loading: boolean;
};

const ts = (t: number) => t as UTCTimestamp;
export const compareScaleId = (c: CompareItem) => (c.scale === 'own' ? `cmp-${c.id}` : 'right');
const shapeOf = (c: CompareItem) => `${c.style}|${compareScaleId(c)}`;
function pointOf(c: CompareItem, a: Aligned) {
  if (c.style === 'line') {
    const v = a.bar?.close ?? a.carry;
    return v == null ? { time: ts(a.time) } : { time: ts(a.time), value: v };
  }
  return a.bar ? { time: ts(a.time), open: a.bar.open, high: a.bar.high, low: a.bar.low, close: a.bar.close } : { time: ts(a.time) };
}

// the compared bars laid on the chart's bars
function align(raw: Candle[], main: Candle[]): Aligned[] {
  if (!main.length) return raw.map((b) => ({ time: b.time, bar: b }));
  const out: Aligned[] = [];
  let j = 0;
  let last: number | undefined;
  // before the chart's first bar: only the latest compared bar counts
  while (j < raw.length && raw[j].time <= main[0].time) j++;
  let first: Candle | undefined = j > 0 ? raw[j - 1] : undefined;
  for (const m of main) {
    let bar: Candle | undefined = first;
    first = undefined;
    for (; j < raw.length && raw[j].time <= m.time; j++) {
      const b = raw[j];
      bar = bar ? { ...bar, high: Math.max(bar.high, b.high), low: Math.min(bar.low, b.low), close: b.close } : { ...b };
    }
    if (bar) { out.push({ time: m.time, bar: { ...bar, time: m.time } }); last = bar.close; }
    else out.push({ time: m.time, carry: last });
  }
  return out;
}

export class CompareOverlay {
  private entries = new Map<string, Entry>();
  private items: CompareItem[] = [];
  // during a replay: the last bar shown (s); null = everything
  private limit: number | null = null;
  private chart: IChartApi;
  // the chart's whole history (during a replay too)
  private getMain: () => Candle[];
  private mainKey = '';

  constructor(chart: IChartApi, getMain: () => Candle[]) {
    this.chart = chart;
    this.getMain = getMain;
  }

  sync(items: CompareItem[], tf: Timeframe) {
    this.items = items;
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.drop(id);
    for (const item of items) {
      const dataKey = `${item.symbol.ticker}|${tf}`;
      let e = this.entries.get(item.id);
      if (e && e.dataKey !== dataKey) { this.drop(item.id); e = undefined; }
      if (!e) {
        e = { dataKey, shapeKey: shapeOf(item), candles: [], aligned: [], series: null, off: null, loading: true };
        this.entries.set(item.id, e);
        this.load(item, e, tf);
        continue;
      }
      if (e.loading || !e.series) continue;
      if (e.shapeKey !== shapeOf(item)) {
        // line <-> candles, or another scale: a new series with the same data
        this.removeSeries(e);
        e.shapeKey = shapeOf(item);
        e.series = this.create(item, e.candles);
        this.show(item, e);
      } else {
        e.series.applyOptions(this.options(item, e.candles));
      }
    }
  }

  // the chart's bars changed (older history, a new bar, another symbol): lay the compared ones again
  realign() {
    const main = this.getMain();
    const key = `${main.length}|${main[0]?.time}|${main[main.length - 1]?.time}`;
    if (key === this.mainKey) return;
    this.mainKey = key;
    for (const [id, e] of this.entries) {
      const item = this.items.find((i) => i.id === id);
      if (!item || e.loading) continue;
      e.aligned = align(e.candles, main);
      this.show(item, e);
    }
  }

  // replay: the compared symbols stop at the replay bar too (no peeking at the future)
  setLimit(t: number | null) {
    const prev = this.limit;
    if (t === prev) return;
    this.limit = t;
    for (const [id, e] of this.entries) {
      const item = this.items.find((i) => i.id === id);
      if (!item || !e.series) continue;
      if (t != null && prev != null && t > prev) {
        // stepping forward: only the new points
        for (const a of e.aligned) {
          if (a.time <= prev) continue;
          if (a.time > t) break;
          try { e.series.update(pointOf(item, a) as never); } catch { /* older point */ }
        }
      } else this.show(item, e);
    }
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  private load(item: CompareItem, e: Entry, tf: Timeframe) {
    openFeed(item.symbol, tf).then(({ session, candles }) => {
      if (this.entries.get(item.id) !== e) return;
      e.loading = false;
      e.candles = candles;
      e.aligned = align(candles, this.getMain());
      compareCandles.set(item.id, candles);
      const cur = this.items.find((i) => i.id === item.id) ?? item;
      e.shapeKey = shapeOf(cur);
      e.series = this.create(cur, candles);
      this.show(cur, e);
      e.off = session.subscribe((c) => {
        const list = e.candles;
        if (list.length && list[list.length - 1].time === c.time) list[list.length - 1] = c;
        else if (!list.length || c.time > list[list.length - 1].time) list.push(c);
        else return;
        // the chart's last bar takes the compared symbol's latest price
        e.aligned = align(list, this.getMain());
        const now = this.items.find((i) => i.id === item.id);
        const tail = e.aligned[e.aligned.length - 1];
        if (now && tail && e.series && this.limit == null) { try { e.series.update(pointOf(now, tail) as never); } catch { /* older point */ } }
      });
      useChartUi.getState().bumpData();
    }).catch(() => {
      if (this.entries.get(item.id) !== e) return;
      e.loading = false;
      useChartUi.getState().showToast(`Comparer : pas de données pour ${item.symbol.ticker}`);
    });
  }

  private options(c: CompareItem, candles: Candle[]) {
    const last = candles[candles.length - 1]?.close ?? 1;
    const precision = pricePrecision(c.symbol, last);
    const common = {
      priceScaleId: compareScaleId(c), visible: c.visible, title: c.symbol.ticker,
      priceLineVisible: false, lastValueVisible: true,
      priceFormat: { type: 'price' as const, precision, minMove: 10 ** -precision },
    };
    return c.style === 'line'
      ? { ...common, color: c.color, lineWidth: c.lineWidth as LineWidth }
      // up candles filled, down candles hollow: one colour stays readable over the chart's own candles
      : { ...common, upColor: c.color, downColor: 'rgba(0, 0, 0, 0)', borderVisible: true, borderUpColor: c.color, borderDownColor: c.color, wickUpColor: c.color, wickDownColor: c.color };
  }

  private create(c: CompareItem, candles: Candle[]): ISeriesApi<SeriesType> {
    const series = (c.style === 'line'
      ? this.chart.addSeries(LineSeries, this.options(c, candles) as never, 0)
      : this.chart.addSeries(CandlestickSeries, this.options(c, candles) as never, 0)) as ISeriesApi<SeriesType>;
    if (c.scale === 'own') series.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    return series;
  }

  private show(c: CompareItem, e: Entry) {
    if (!e.series) return;
    const lim = this.limit;
    const pts = lim == null ? e.aligned : e.aligned.filter((a) => a.time <= lim);
    e.series.setData(pts.map((a) => pointOf(c, a)) as never);
  }

  private removeSeries(e: Entry) {
    if (e.series) { try { this.chart.removeSeries(e.series); } catch { /* chart gone */ } }
    e.series = null;
  }

  private drop(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.off?.();
    this.removeSeries(e);
    this.entries.delete(id);
    compareCandles.delete(id);
  }
}
