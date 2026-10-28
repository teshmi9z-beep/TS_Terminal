import type {
  IChartApi, IPanePrimitive, IPanePrimitivePaneView, IPrimitivePaneRenderer, ISeriesApi, Logical,
  PaneAttachedParameter, SeriesType, Time,
} from 'lightweight-charts';
import type { Candle } from '../types';
import type { Plot, PlotBackground, PlotBox, PlotFillPoint, PlotLabel } from '../indicators/types';
import { logicalToTime, timeToLogical } from './chartUtils';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

const labelFont = (px: number) => `${px}px -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif`;

// Paints an indicator's Pine drawings (box.new / label.new) on the price pane.
// A pane primitive keeps working when the price series is hidden or swapped
// (chart style change); prices are converted through `priceHost()`.
export class IndicatorShapes implements IPanePrimitive<Time> {
  private boxes: PlotBox[] = [];
  private labels: PlotLabel[] = [];
  private fills: PlotFillPoint[][] = [];
  private bgs: PlotBackground[] = [];
  private visible = true;
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPanePrimitivePaneView[];
  private readonly getCandles: () => Candle[];
  private readonly priceHost: () => ISeriesApi<SeriesType> | null;

  constructor(getCandles: () => Candle[], priceHost: () => ISeriesApi<SeriesType> | null) {
    this.getCandles = getCandles;
    this.priceHost = priceHost;
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    // backgrounds behind the bars, the rest over them
    const behind: IPrimitivePaneRenderer = { draw: (target) => this.drawBackground(target) };
    this.views = [{ zOrder: () => 'bottom', renderer: () => behind }, { zOrder: () => 'normal', renderer: () => renderer }];
  }

  attached(param: PaneAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return this.views;
  }

  setPlots(plots: Plot[]) {
    this.boxes = plots.flatMap((p) => (p.kind === 'boxes' ? p.boxes ?? [] : []));
    this.labels = plots.flatMap((p) => (p.kind === 'labels' ? p.labels ?? [] : []));
    this.fills = plots.flatMap((p) => (p.kind === 'fill' && p.fill ? [p.fill] : []));
    this.bgs = plots.flatMap((p) => (p.kind === 'bgcolor' ? p.bg ?? [] : []));
    this.requestUpdate?.();
  }

  setVisible(v: boolean) {
    if (v === this.visible) return;
    this.visible = v;
    this.requestUpdate?.();
  }

  // Pine bgcolor(): full-height bands, each bar's half spacing on both sides
  private drawBackground(target: Target) {
    const chart = this.chart;
    const candles = this.getCandles();
    if (!this.visible || !chart || !candles.length || !this.bgs.length) return;
    const scale = chart.timeScale();
    const half = scale.options().barSpacing / 2;
    const x = (time: number) => {
      const logical = timeToLogical(candles, time);
      return logical == null ? null : scale.logicalToCoordinate(Math.round(logical) as Logical);
    };
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const b of this.bgs) {
        const x1 = x(b.from), x2 = x(b.to);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2) - half, right = Math.max(x1, x2) + half;
        if (right < 0 || left > mediaSize.width) continue;
        ctx.fillStyle = b.color;
        ctx.fillRect(left, 0, right - left, mediaSize.height);
      }
    });
  }

  private draw(target: Target) {
    const chart = this.chart;
    const series = this.priceHost();
    const candles = this.getCandles();
    if (!this.visible || !chart || !series || !candles.length) return;
    const scale = chart.timeScale();
    // logicalToCoordinate only handles whole bar indexes: interpolate between two bars
    const x = (time: number, bars = 0) => {
      const logical = timeToLogical(candles, time);
      if (logical == null) return null;
      const i = Math.floor(logical + bars), frac = logical + bars - i;
      const x0 = scale.logicalToCoordinate(i as Logical);
      if (x0 == null || frac === 0) return x0;
      const x1 = scale.logicalToCoordinate((i + 1) as Logical);
      return x1 == null ? x0 : x0 + (x1 - x0) * frac;
    };
    const y = (price: number) => series.priceToCoordinate(price);

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      // Pine fill(): a band between two plots, colored bar by bar, broken at na
      for (const band of this.fills) {
        let prev: { x: number; a: number; b: number } | null = null;
        for (const p of band) {
          const px = Number.isFinite(p.a) && Number.isFinite(p.b) ? x(p.time) : null;
          const ya = px != null ? y(p.a) : null, yb = px != null ? y(p.b) : null;
          if (px == null || ya == null || yb == null) { prev = null; continue; }
          if (prev && !(px < 0 && prev.x < 0) && !(prev.x > mediaSize.width && px > mediaSize.width)) {
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.a);
            ctx.lineTo(px, ya);
            ctx.lineTo(px, yb);
            ctx.lineTo(prev.x, prev.b);
            ctx.closePath();
            ctx.fill();
          }
          prev = { x: px, a: ya, b: yb };
        }
      }
      // the visible time span (a few bars wider): boxes entirely outside it are skipped
      // before any coordinate work, so a long history of boxes costs little per frame
      const vis = scale.getVisibleLogicalRange();
      const t0 = vis ? logicalToTime(candles, vis.from - 3) : null, t1 = vis ? logicalToTime(candles, vis.to + 3) : null;
      for (const b of this.boxes) {
        if (t0 != null && t1 != null && (Math.max(b.left, b.right) < t0 || Math.min(b.left, b.right) > t1)) continue;
        const x1 = x(b.left, b.leftBars ?? 0), x2 = x(b.right, b.rightBars ?? 0);
        const y1 = y(b.top), y2 = y(b.bottom);
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        if (right < 0 || left > mediaSize.width) continue;
        const top = Math.min(y1, y2), h = Math.abs(y2 - y1);
        ctx.fillStyle = b.fill;
        ctx.fillRect(left, top, right - left, h);
        const bw = b.borderWidth ?? 1;
        if (b.border && bw > 0) {
          ctx.strokeStyle = b.border;
          ctx.lineWidth = bw;
          ctx.setLineDash(b.borderStyle === 'dotted' ? [bw, bw * 2] : b.borderStyle === 'dashed' ? [bw * 4, bw * 3] : []);
          ctx.strokeRect(left, top, right - left, h);
        }
      }
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      // newest first: a text that would cover one already written is left out (zoomed out, a
      // gap or a pivot on every session would pile up), so the most recent ones always show
      const taken: { x0: number; x1: number; y0: number; y1: number }[] = [];
      for (let k = this.labels.length - 1; k >= 0; k--) {
        const l = this.labels[k];
        const lx = x(l.time), ly = y(l.price);
        if (lx == null || ly == null || lx < -100 || lx > mediaSize.width + 100) continue;
        const size = l.size ?? 10;
        ctx.font = labelFont(size);
        // several lines stack away from the price: upward above it, downward below it
        const lines = l.text.split('\n'), lh = Math.round(size * 1.3);
        const w = Math.max(...lines.map((line) => ctx.measureText(line).width));
        const h = lines.length * lh;
        const box = { x0: lx - w / 2, x1: lx + w / 2, y0: l.style === 'down' ? ly - 4 - h : ly + 4, y1: l.style === 'down' ? ly - 4 : ly + 4 + h };
        if (taken.some((t) => t.x0 < box.x1 && box.x0 < t.x1 && t.y0 < box.y1 && box.y0 < t.y1)) continue;
        taken.push(box);
        ctx.fillStyle = l.color;
        ctx.textBaseline = l.style === 'down' ? 'bottom' : 'top';
        lines.forEach((line, j) => {
          const off = l.style === 'down' ? -4 - (lines.length - 1 - j) * lh : 4 + j * lh;
          ctx.fillText(line, lx, ly + off);
        });
      }
    });
  }
}
