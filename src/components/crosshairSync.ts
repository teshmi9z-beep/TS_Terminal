import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts';
import { POPOUT_ID } from '../store/store';
import { indexAtOrBefore } from './chartUtils';
import type { Candle } from '../types';

// The time under the cursor, shared by every chart open: this window's, the charts of its 2 / 4
// windows and the detached windows' (over a BroadcastChannel). The chart the mouse is on sends
// it; the others draw their vertical line on their bar at that time (no horizontal line: their
// prices are another market's), to see at a glance where the others stand at that moment.

type Listener = (from: string, time: number | null) => void;
const listeners = new Set<Listener>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('tesh-crosshair') : null;
if (channel) channel.onmessage = (ev: MessageEvent<{ from: string; time: number | null }>) => { for (const l of listeners) l(ev.data.from, ev.data.time); };

function share(from: string, time: number | null) {
  for (const l of listeners) l(from, time);
  channel?.postMessage({ from, time });
}

let counter = 0;

// links one chart to the others; `candles` and `series` are read when a time comes in
export function syncCrosshair(chart: IChartApi, el: HTMLElement, candles: () => Candle[], series: () => ISeriesApi<SeriesType> | null | undefined): () => void {
  const id = `${POPOUT_ID ?? 'main'}:${++counter}`;
  // the mouse is on this chart: it sends, and takes nothing from the others
  let own = false;
  let shown = false;
  const horz = (visible: boolean) => chart.applyOptions({ crosshair: { horzLine: { visible, labelVisible: visible } } });

  const onEnter = () => { own = true; if (shown) { shown = false; horz(true); } };
  const onLeave = () => { own = false; share(id, null); };
  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mouseleave', onLeave);
  const onMove = (param: { time?: Time; point?: unknown }) => {
    if (own) share(id, param.time != null && param.point ? (param.time as number) : null);
  };
  chart.subscribeCrosshairMove(onMove);

  const onShared: Listener = (from, time) => {
    if (from === id || own) return;
    const bars = candles(), s = series();
    const i = time == null || !s ? -1 : indexAtOrBefore(bars, time);
    if (i < 0 || !s) { chart.clearCrosshairPosition(); return; }
    if (!shown) { shown = true; horz(false); }
    chart.setCrosshairPosition(bars[i].close, bars[i].time as Time, s);
  };
  listeners.add(onShared);

  return () => {
    listeners.delete(onShared);
    chart.unsubscribeCrosshairMove(onMove);
    el.removeEventListener('mouseenter', onEnter);
    el.removeEventListener('mouseleave', onLeave);
  };
}
