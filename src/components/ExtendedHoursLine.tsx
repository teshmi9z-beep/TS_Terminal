import { useEffect, useState, type RefObject } from 'react';
import { LineStyle, type AutoscaleInfo } from 'lightweight-charts';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { usShareId } from '../data/feeds/resolve';
import { yahooExtended, type ExtendedPrice } from '../data/feeds/yahoo';
import { isDailyTf, type ChartEngine } from './chartUtils';

const ORANGE = '#ff9800';
const POLL = 30_000;

// A US share's pre-market / after-hours price on its daily (and longer) chart, like TradingView's
// orange "Pré" / "Post" label: a dotted line on the price, kept in view by the price scale. The
// intraday charts show those hours as bars instead (YahooSession's prePost).
export default function ExtendedHoursLine({ engine, seriesGen }: { engine: RefObject<ChartEngine>; seriesGen: number }) {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const replay = useChartUi((s) => s.replay.mode);
  const id = isDailyTf(timeframe) && replay === 'off' ? usShareId(symbol) : null;
  // the last price read, for the share it was read for
  const [read, setRead] = useState<{ id: string; ext: ExtendedPrice | null } | null>(null);
  const ext = read && read.id === id ? read.ext : null;

  // the price every 30 s (none during the session)
  useEffect(() => {
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      yahooExtended(id).then((e) => { if (!stop) setRead({ id, ext: e }); }).catch(() => undefined)
        .finally(() => { if (!stop) timer = setTimeout(tick, POLL); });
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);

  useEffect(() => {
    const series = engine.current?.mainSeries;
    if (!series || !ext) return;
    const line = series.createPriceLine({
      price: ext.price, color: ORANGE, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true,
      axisLabelColor: ORANGE, axisLabelTextColor: '#fff', title: ext.session === 'pre' ? 'Pré' : 'Post',
    });
    // the scale reaches the price, however far from the bars (a gap after earnings)
    series.applyOptions({
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const r = base();
        return r?.priceRange
          ? { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ext.price), maxValue: Math.max(r.priceRange.maxValue, ext.price) } }
          : r;
      },
    });
    return () => {
      try {
        series.removePriceLine(line);
        series.applyOptions({ autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => base() });
      } catch { /* the series was replaced */ }
    };
  }, [ext, engine, seriesGen]);

  return null;
}
