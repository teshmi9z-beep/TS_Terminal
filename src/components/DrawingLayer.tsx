import { useEffect, useRef, useState, type RefObject } from 'react';
import { QUICK_COLORS, withAlpha } from './colors';
import { timeToLogical, logicalToTime, type ChartHandles } from './chartUtils';
import { mainChart } from './mainChart';
import { useStore, nextId } from '../store/store';
import { useChartUi } from '../store/chartUi';
import type { Candle, Drawing, DrawingPreset, DrawTool, LineStyleName, Point } from '../types';
import { DEFAULT_TOOL_COLOR, LINE_STYLES, TOOL_INFO } from './toolInfo';
import { defaultFib, fibOf, FIB_RETR_LINE, type FibTool } from './fibSettings';
import FibDialog from './FibDialog';
import HLineDialog from './HLineDialog';
import { hlineLabel, hlineOf, isHLine, shownOnTf } from './hlineSettings';
import VolumeProfileDialog from './VolumeProfileDialog';
import { computeProfile, isVolumeProfile, vpOf, vpRange } from './volumeProfile';
import AvwapDialog from './AvwapDialog';
import { avwapOf, avwapOperand, avwapSeries, bandOffset, sourcePrice } from './anchoredVwap';
import { LOCALE } from '../i18n/lang';
import DrawingDialog from './DrawingDialog';
import { defaultFill, hasDrawingDialog, NO_STYLE, styleCaps } from './drawingStyle';
import { ColorButton } from './ColorPicker';
import { AlertIcon, BucketIcon, LockIcon, MoreIcon, PencilIcon, SettingsIcon, TemplatesIcon, TextIcon, TrashIcon } from './drawIcons';

const HANDLE_R = 5;
const HIT_TOLERANCE = 6;
const TEXT_SIZE = 14;

const COLOR_PALETTE = QUICK_COLORS;
// keep clear of the pane separator's resize handle (it reaches 4px above the line)
const SEPARATOR_GUARD = 6;

type XY = { x: number; y: number };
type RenderCtx = {
  toXY: (p: Point) => XY | null;
  // plot area of the price pane: drawings are clipped to it
  width: number;
  height: number;
  precision: number;
  barsBetween: (t1: number, t2: number) => number;
  // the virtual account's risk per trade, to size the position tools
  riskAmount: number;
  riskPct: number;
  // the last price (horizontal lines' distance to it), and the label colours of the theme
  last: number | null;
  textColor: string;
  boxBg: string;
  // the chart's bars and plain time / price to pixel (volume profiles)
  candles: Candle[];
  xOf: (t: number) => number | null;
  yOf: (price: number) => number | null;
};
type Rect = { x0: number; y0: number; x1: number; y1: number };
// what a click grabbed: a point (by index; a position's derived target is the
// index after its points) or the whole drawing
type Hit = { kind: 'point'; index: number } | { kind: 'body' };

// drawings belong to one symbol; legacy ones without a ticker show everywhere
const onSymbol = (d: Drawing, ticker: string) => !d.ticker || d.ticker === ticker;
const isFib = (t: DrawTool): t is FibTool => t === 'fib_retracement' || t === 'fib_extension';
const isPosition = (t: DrawTool) => t === 'long_position' || t === 'short_position' || t === 'position_3pt' || t === 'position_rr';
const isText = (d: Drawing) => d.tool === 'text';

// a volume profile's box on screen (from the first to the last bar of its range,
// from its lowest to its highest price) and its rows
function vpGeometry(d: Drawing, candles: Candle[], xOf: (t: number) => number | null, yOf: (p: number) => number | null) {
  const r = vpRange(d, candles);
  const p = r ? computeProfile(candles, r.t0, r.t1, vpOf(d)) : null;
  if (!r || !p) return null;
  const xa = xOf(r.t0), xb = xOf(r.t1), yTop = yOf(p.hi), yBot = yOf(p.lo);
  if (xa == null || xb == null || yTop == null || yBot == null) return null;
  return { x0: Math.min(xa, xb), x1: Math.max(xa, xb), yTop: Math.min(yTop, yBot), yBot: Math.max(yTop, yBot), p };
}

// an anchored VWAP on screen: the x of each bar from the anchor, the y of the VWAP and of the
// bands shown (NaN off screen, where nothing is drawn), and the anchor's point on the VWAP
function avwapGeometry(d: Drawing, candles: Candle[], xOf: (t: number) => number | null, yOf: (p: number) => number | null, width: number) {
  const s = avwapOf(d);
  const ser = avwapSeries(candles, d.points[0]?.time, s.source);
  if (!ser) return null;
  const n = ser.vwap.length;
  const xs = new Array<number>(n);
  for (let k = 0; k < n; k++) xs[k] = xOf(candles[ser.start + k].time) ?? NaN;
  // the bars on screen, with one more on each side so the lines reach the edges
  const shown = (k: number) => [k - 1, k, k + 1].some((j) => j >= 0 && j < n && xs[j] >= 0 && xs[j] <= width);
  const line = (f: (k: number) => number) => {
    const ys = new Array<number>(n);
    for (let k = 0; k < n; k++) ys[k] = shown(k) ? yOf(f(k)) ?? NaN : NaN;
    return ys;
  };
  const mid = line((k) => ser.vwap[k]);
  const bands = s.bands.filter((b) => b.on).map((b) => ({
    b,
    up: line((k) => ser.vwap[k] + bandOffset(s, ser, k, b)),
    lo: line((k) => ser.vwap[k] - bandOffset(s, ser, k, b)),
  }));
  const ay = yOf(ser.vwap[0]);
  return { xs, mid, bands, anchor: Number.isFinite(xs[0]) && ay != null ? { x: xs[0], y: ay } : null };
}

// the x span of a horizontal line: from its point to the edge(s) it runs to
function hlineSpan(d: Drawing, ax: number, width: number): { x0: number; x1: number } {
  const h = hlineOf(d);
  if (!h.extendLeft && !h.extendRight) return { x0: ax, x1: width };
  return { x0: h.extendLeft ? 0 : ax, x1: h.extendRight ? width : ax };
}

// entry, stop and target of the position tools. long / short: entry and target
// clicked, stop from the R:R; 3 clicks: all three; preset R:R: entry and stop
// clicked, target from the R:R
function positionLevels(d: Drawing): { entry: number; stop: number; target: number; long: boolean; rr: number } | null {
  const [p0, p1, p2] = d.points;
  if (!p0 || !p1) return null;
  const entry = p0.price;
  if (d.tool === 'long_position' || d.tool === 'short_position') {
    const long = d.tool === 'long_position';
    const rr = d.riskReward ?? 1;
    const target = p1.price;
    return { entry, target, stop: long ? entry - Math.abs(target - entry) / rr : entry + Math.abs(target - entry) / rr, long, rr };
  }
  const stop = p1.price;
  const long = stop <= entry;
  if (d.tool === 'position_3pt') {
    const target = p2?.price ?? entry + 2 * (entry - stop);
    const risk = Math.abs(entry - stop);
    return { entry, stop, target, long, rr: risk ? Math.abs(target - entry) / risk : 0 };
  }
  const rr = d.riskReward ?? 2;
  return { entry, stop, target: entry + rr * (entry - stop), long, rr };
}

const measureCtx = document.createElement('canvas').getContext('2d');
function textBox(d: Drawing): { w: number; h: number; lines: string[]; size: number } {
  const size = d.fontSize ?? TEXT_SIZE;
  const lines = (d.text ?? '').split('\n');
  let w = 0;
  if (measureCtx) {
    measureCtx.font = `${size}px sans-serif`;
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  }
  return { w, h: lines.length * size * 1.3, lines, size };
}

// a rectangle's 8 handles, like TradingView's: its two points (0, 1), the other corners (2: the
// first point's time with the second's price, 3: the reverse), then the middles of its sides
// (4, 5: the sides at each point's time; 6, 7: at each point's price)
function rectHandles(a: XY, b: XY): XY[] {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }, { x: a.x, y: my }, { x: b.x, y: my }, { x: mx, y: a.y }, { x: mx, y: b.y }];
}
// the points once handle `i` is dragged to `pt`
function moveRectHandle(points: Point[], i: number, pt: Point): Point[] {
  const [p0, p1] = points;
  switch (i) {
    case 0: return [pt, p1];
    case 1: return [p0, pt];
    case 2: return [{ time: pt.time, price: p0.price }, { time: p1.time, price: pt.price }];
    case 3: return [{ time: p0.time, price: pt.price }, { time: pt.time, price: p1.price }];
    case 4: return [{ ...p0, time: pt.time }, p1];
    case 5: return [p0, { ...p1, time: pt.time }];
    case 6: return [{ ...p0, price: pt.price }, p1];
    case 7: return [p0, { ...p1, price: pt.price }];
    default: return points;
  }
}
// a rectangle's box on screen, its sides run to the edges when asked
function rectBox(d: Drawing, a: XY, b: XY, width: number) {
  return { x0: d.extendLeft ? 0 : Math.min(a.x, b.x), x1: d.extendRight ? width : Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
}

// the style fields a template carries (besides colour, width and line style)
const STYLE_KEYS = ['fib', 'fibLevels', 'riskReward', 'hline', 'vp', 'avwap', 'fontSize', 'fillColor', 'noFill', 'extendLeft', 'extendRight', 'textColor', 'bold', 'italic', 'textV', 'textH'] as const;
const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

// a quantity that risks `amount` between entry and stop
function riskQty(amount: number, entry: number, stop: number): number {
  const q = amount / Math.abs(entry - stop);
  if (!Number.isFinite(q) || q <= 0) return 0;
  if (q >= 100) return Math.floor(q);
  if (q >= 1) return Math.floor(q * 100) / 100;
  return Number(q.toPrecision(3));
}

// style of a new drawing: the active preset's, else the tool's defaults
function newDrawingStyle(tool: DrawTool): Pick<Drawing, 'color' | 'lineWidth'> & Partial<Drawing> {
  const st = useStore.getState();
  const preset = st.activePresetId ? st.drawingPresets.find((p) => p.id === st.activePresetId && p.tool === tool) : undefined;
  const fib = tool === 'fib_retracement' ? FIB_RETR_LINE : null;
  return {
    color: preset?.color ?? fib?.color ?? DEFAULT_TOOL_COLOR[tool] ?? '#2962ff',
    lineWidth: preset?.lineWidth ?? fib?.lineWidth ?? (isHLine(tool) || tool === 'text' || tool === 'anchored_vwap' ? 1 : 2),
    ...defined({ lineStyle: preset?.lineStyle ?? fib?.lineStyle }),
    // (only what the template sets: a text keeps its default size otherwise)
    ...(preset ? defined(Object.fromEntries(STYLE_KEYS.map((k) => [k, preset[k]]))) : {}),
  };
}

const DASH: Record<string, number[]> = { dashed: [6, 4], dotted: [1.5, 3] };
const fr = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });

type ContextMenuState = { x: number; y: number; drawingId: string } | null;

// how close (px) the mouse must be to an open, high, low or close for the weak magnet
const MAGNET_PX = 24;

export default function DrawingLayer({
  handles, containerRef,
}: { handles: RefObject<ChartHandles>; containerRef: RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const allDrawings = useStore((s) => s.drawings);
  const ticker = useStore((s) => s.symbol.ticker);
  const timeframe = useStore((s) => s.timeframe);
  const drawings = allDrawings.filter((d) => onSymbol(d, ticker) && shownOnTf(d, timeframe));
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const addDrawing = useStore((s) => s.addDrawing);
  const updateDrawing = useStore((s) => s.updateDrawing);
  const removeDrawing = useStore((s) => s.removeDrawing);
  const selectedDrawingId = useStore((s) => s.selectedDrawingId);
  const setSelectedDrawingId = useStore((s) => s.setSelectedDrawingId);
  const addAlert = useStore((s) => s.addAlert);
  const positionRR = useStore((s) => s.positionRR);
  const positionRiskPct = useStore((s) => s.positionRiskPct);
  const setPositionTool = useStore((s) => s.setPositionTool);
  const balance = useStore((s) => s.paper.balance);
  const editTextId = useChartUi((s) => s.editTextId);
  const setEditTextId = useChartUi((s) => s.setEditTextId);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  // several drawings picked with Ctrl (a box on the chart, or Ctrl + click)
  const [multi, setMulti] = useState<string[]>([]);
  const multiRef = useRef<string[]>([]);
  multiRef.current = multi;
  const [fibDialogId, setFibDialogId] = useState<string | null>(null);
  const [hlineDialogId, setHlineDialogId] = useState<string | null>(null);
  const [vpDialogId, setVpDialogId] = useState<string | null>(null);
  const [avwapDialogId, setAvwapDialogId] = useState<string | null>(null);
  // rectangles and lines: TradingView's settings window
  const [drawDialogId, setDrawDialogId] = useState<string | null>(null);
  // the floating toolbar's open menu, for the drawing it was opened on (another one selected: closed)
  const [menuOf, setMenuOf] = useState<{ id: string; kind: 'templates' | 'width' | 'style' | 'more' } | null>(null);
  const menu = menuOf && menuOf.id === selectedDrawingId ? menuOf.kind : null;
  const toggleMenu = (kind: 'templates' | 'width' | 'style' | 'more') => setMenuOf(menu === kind || !selectedDrawingId ? null : { id: selectedDrawingId, kind });
  const [, setFrame] = useState(0);

  // the drawing being placed and which of its points follows the mouse
  const pendingRef = useRef<{ d: Drawing; stage: number } | null>(null);
  const brushingRef = useRef(false);
  const selectingRef = useRef<Rect | null>(null);
  const dragRef = useRef<
    | { id: string; mode: 'point'; pointIndex: number }
    // (moved by whole bars from where the mouse grabbed it: `logicals` are the points' bar indexes)
    | { mode: 'move'; startMouse: Point; startLogical: number; start: { id: string; points: Point[]; logicals: (number | null)[] }[] }
    | null
  >(null);
  // text typed in place: its value before editing (to cancel) and the editor
  const editOrigRef = useRef<string>('');
  // the magnet's point under the mouse (drawn as a ring), null when nothing sticks
  const snapRef = useRef<Point | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // the drawing's handle under the mouse (highlighted), and the cursor shown for it
  const hoverRef = useRef<{ id: string; index: number } | null>(null);

  // times map through fractional bar indexes, so drawings keep their place on any
  // timeframe and can extend into the empty area right of the last bar
  function toXY(p: Point): XY | null {
    const h = handles.current;
    if (!h.chart || !h.mainSeries) return null;
    const logical = timeToLogical(h.candles, p.time);
    if (logical === null) return null;
    const x = h.chart.timeScale().logicalToCoordinate(logical as never);
    const y = h.mainSeries.priceToCoordinate(p.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  function xOfTime(t: number): number | null {
    const h = handles.current;
    const l = h.chart ? timeToLogical(h.candles, t) : null;
    return l == null || !h.chart ? null : h.chart.timeScale().logicalToCoordinate(l as never);
  }
  function yOfPrice(p: number): number | null {
    return handles.current.mainSeries?.priceToCoordinate(p) ?? null;
  }
  const vpGeo = (d: Drawing) => vpGeometry(d, handles.current.candles, xOfTime, yOfPrice);
  const avwapGeo = (d: Drawing) => avwapGeometry(d, handles.current.candles, xOfTime, yOfPrice, mainPaneSize().width);
  // an anchored VWAP's anchor: the bar under the mouse (the last one right of it), at its VWAP's start
  function anchorAt(clientX: number, d?: Drawing): Point | null {
    const candles = handles.current.candles;
    const l = mouseLogical(clientX);
    if (l == null || !candles.length) return null;
    const c = candles[Math.max(0, Math.min(candles.length - 1, Math.round(l)))];
    return { time: c.time, price: sourcePrice(c, d ? avwapOf(d).source : 'hlc3') };
  }

  // `snap`: placing or moving a point, where the magnet applies
  function toPoint(clientX: number, clientY: number, snap = false): Point | null {
    const h = handles.current;
    const canvas = canvasRef.current;
    if (!h.chart || !h.mainSeries || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const logical = h.chart.timeScale().coordinateToLogical(clientX - rect.left);
    const price = h.mainSeries.coordinateToPrice(clientY - rect.top);
    if (logical === null || price === null) return null;
    if (snap) {
      snapRef.current = magnetPoint(logical, clientY - rect.top);
      if (snapRef.current) return snapRef.current;
    }
    const time = logicalToTime(h.candles, logical);
    if (time === null) return null;
    return { time, price };
  }

  // the mouse's cursor over a drawing, like TradingView's: a rectangle's sides stretch up / down or
  // left / right, its corners on a diagonal; a position's derived line goes up / down; the rest of
  // a drawing moves. A locked one is only picked (a hand).
  function cursorOf(d: Drawing, hit: Hit): string {
    if (d.locked) return 'pointer';
    if (hit.kind === 'body') return 'move';
    if (d.tool === 'rectangle') {
      if (hit.index === 4 || hit.index === 5) return 'ew-resize';
      if (hit.index === 6 || hit.index === 7) return 'ns-resize';
      const a = toXY(d.points[0]), b = toXY(d.points[1]);
      if (!a || !b) return 'pointer';
      const p = rectHandles(a, b)[hit.index];
      // top-left / bottom-right on one diagonal, the other two on the other (y grows downwards)
      return (p.x - (a.x + b.x) / 2) * (p.y - (a.y + b.y) / 2) > 0 ? 'nwse-resize' : 'nesw-resize';
    }
    if (isPosition(d.tool) && hit.index >= d.points.length) return 'ns-resize';
    return 'pointer';
  }
  function hoverAt(e: MouseEvent) {
    const el = containerRef.current;
    if (!el) return;
    let cursor = '';
    let hover: { id: string; index: number } | null = null;
    const overUi = (e.target as HTMLElement | null)?.closest?.('.draw-float-toolbar-wrap, .chart-ui, .draw-text-editor');
    if (!overUi && inMainPlot(e.clientX, e.clientY)) {
      const { x, y } = pxDist(e.clientX, e.clientY);
      const found = findDrawingAt(x, y);
      if (found) {
        cursor = cursorOf(found.drawing, found.hit);
        if (found.hit.kind === 'point' && !found.drawing.locked) hover = { id: found.drawing.id, index: found.hit.index };
      }
    }
    hoverRef.current = hover;
    if (el.style.cursor !== cursor) el.style.cursor = cursor;
  }

  // the bar index (fractional) under the mouse
  function mouseLogical(clientX: number): number | null {
    const h = handles.current;
    const canvas = canvasRef.current;
    if (!h.chart || !canvas) return null;
    return h.chart.timeScale().coordinateToLogical(clientX - canvas.getBoundingClientRect().left) as number | null;
  }
  // a move of drawings grabbed at `pt`: their points as bar indexes, to shift them by whole bars
  function moveDrag(pt: Point, clientX: number, list: Drawing[]) {
    const candles = handles.current.candles;
    return {
      mode: 'move' as const, startMouse: pt, startLogical: mouseLogical(clientX) ?? NaN,
      start: list.map((d) => ({ id: d.id, points: d.points.map((p) => ({ ...p })), logicals: d.points.map((p) => timeToLogical(candles, p.time)) })),
    };
  }

  // TradingView's magnet: the open, high, low or close of the bar under the mouse nearest to it,
  // within MAGNET_PX (weak magnet) or whatever the distance (strong magnet)
  function magnetPoint(logical: number, y: number): Point | null {
    const mode = useStore.getState().magnet;
    const h = handles.current;
    if (mode === 'off' || !h.mainSeries) return null;
    const c = h.candles[Math.round(logical)];
    if (!c) return null;
    let best: number | null = null, dist = Infinity;
    for (const p of [c.open, c.high, c.low, c.close]) {
      const py = h.mainSeries.priceToCoordinate(p);
      if (py !== null && Math.abs(py - y) < dist) { dist = Math.abs(py - y); best = p; }
    }
    if (best === null || (mode === 'weak' && dist > MAGNET_PX)) return null;
    return { time: c.time, price: best };
  }

  function mainPaneSize(): { width: number; height: number } {
    const chart = handles.current.chart;
    if (!chart) return { width: 0, height: 0 };
    return { width: chart.paneSize(0).width, height: chart.panes()[0]?.getHeight() ?? 0 };
  }

  function pxDist(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  // the x span of a position box: from the entry to the furthest click, 120 px at least
  function positionSpan(d: Drawing): { x0: number; x1: number } | null {
    const pts = d.points.map(toXY).filter(Boolean) as XY[];
    if (!pts.length) return null;
    const x0 = pts[0].x;
    const x1 = Math.max(...pts.map((p) => p.x));
    return { x0, x1: x1 - x0 < 60 ? x0 + 120 : x1 };
  }

  // screen box of a drawing, for the Ctrl selection box
  function boundsOf(d: Drawing): Rect | null {
    const pts = d.points.map(toXY).filter(Boolean) as XY[];
    if (!pts.length) return null;
    const { width } = mainPaneSize();
    if (isHLine(d.tool)) { const sp = hlineSpan(d, pts[0].x, width); return { x0: sp.x0, x1: sp.x1, y0: pts[0].y - 2, y1: pts[0].y + 2 }; }
    if (isVolumeProfile(d.tool)) { const g = vpGeo(d); return g ? { x0: g.x0, x1: g.x1, y0: g.yTop, y1: g.yBot } : null; }
    if (d.tool === 'anchored_vwap') {
      const g = avwapGeo(d);
      if (!g?.anchor) return null;
      const ys = [g.mid, ...g.bands.flatMap((b) => [b.up, b.lo])].flat().filter(Number.isFinite);
      const xs = g.xs.filter(Number.isFinite);
      return { x0: g.anchor.x, x1: Math.max(...xs), y0: Math.min(g.anchor.y, ...ys), y1: Math.max(g.anchor.y, ...ys) };
    }
    if (isText(d)) {
      const b = textBox(d);
      return { x0: pts[0].x, x1: pts[0].x + b.w, y0: pts[0].y - b.size, y1: pts[0].y - b.size + b.h };
    }
    let xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    if (isPosition(d.tool)) {
      const lv = positionLevels(d);
      const span = positionSpan(d);
      if (lv && span) {
        xs = [span.x0, span.x1];
        ys = [lv.entry, lv.stop, lv.target].map((p) => handles.current.mainSeries?.priceToCoordinate(p) ?? pts[0].y);
      }
    }
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  function hitTestDrawing(d: Drawing, mx: number, my: number): Hit | null {
    const pts = d.points.map(toXY);
    if (isHLine(d.tool)) {
      const a = pts[0];
      if (!a) return null;
      if (Math.hypot(mx - a.x, my - a.y) < 10) return { kind: 'point', index: 0 };
      const sp = hlineSpan(d, a.x, mainPaneSize().width);
      return Math.abs(my - a.y) < HIT_TOLERANCE && mx >= sp.x0 - HIT_TOLERANCE && mx <= sp.x1 + HIT_TOLERANCE ? { kind: 'body' } : null;
    }
    if (isText(d)) {
      const a = pts[0];
      if (!a) return null;
      const b = textBox(d);
      return mx >= a.x - 4 && mx <= a.x + Math.max(b.w, 12) + 4 && my >= a.y - b.size - 4 && my <= a.y - b.size + b.h + 4 ? { kind: 'body' } : null;
    }
    if (isVolumeProfile(d.tool)) {
      const g = vpGeo(d);
      if (!g) return null;
      // its handles sit at the bottom of the box, under each clicked bar
      for (let i = 0; i < d.points.length; i++) {
        const x = xOfTime(d.points[i].time);
        if (x != null && Math.hypot(mx - x, my - g.yBot) < 9) return { kind: 'point', index: i };
      }
      return mx >= g.x0 - 4 && mx <= g.x1 + 4 && my >= g.yTop - 4 && my <= g.yBot + 4 ? { kind: 'body' } : null;
    }
    if (d.tool === 'anchored_vwap') {
      const g = avwapGeo(d);
      if (!g) return null;
      // its anchor, then the VWAP or a band near the mouse
      if (g.anchor && Math.hypot(mx - g.anchor.x, my - g.anchor.y) < 9) return { kind: 'point', index: 0 };
      for (const ys of [g.mid, ...g.bands.flatMap((b) => [b.up, b.lo])]) {
        for (let k = 0; k + 1 < g.xs.length; k++) {
          const x1 = g.xs[k], x2 = g.xs[k + 1];
          if (!(mx >= Math.min(x1, x2) - HIT_TOLERANCE && mx <= Math.max(x1, x2) + HIT_TOLERANCE)) continue;
          if (Number.isFinite(ys[k]) && Number.isFinite(ys[k + 1]) && distToSeg(mx, my, x1, ys[k], x2, ys[k + 1]) < HIT_TOLERANCE) return { kind: 'body' };
        }
      }
      return null;
    }
    if (d.tool === 'rectangle') {
      const a = pts[0], b = pts[1];
      if (!a || !b) return null;
      // its 8 handles, then its box (sides at the edge when prolonged)
      const hs = rectHandles(a, b);
      for (let i = 0; i < hs.length; i++) if (Math.hypot(mx - hs[i].x, my - hs[i].y) < 8) return { kind: 'point', index: i };
      const r = rectBox(d, a, b, mainPaneSize().width);
      return mx >= r.x0 - HIT_TOLERANCE && mx <= r.x1 + HIT_TOLERANCE && my >= r.y0 - HIT_TOLERANCE && my <= r.y1 + HIT_TOLERANCE ? { kind: 'body' } : null;
    }
    // the points first (a position's derived stop / target too)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p && Math.hypot(mx - p.x, my - p.y) < 9) return { kind: 'point', index: i };
    }
    if (isPosition(d.tool)) {
      const lv = positionLevels(d);
      const span = positionSpan(d);
      const s = handles.current.mainSeries;
      if (!lv || !span || !s) return null;
      // position_rr: its target line can be dragged (it sets the R:R); long / short: their stop line
      const derived = d.tool === 'position_rr' ? lv.target : d.tool === 'long_position' || d.tool === 'short_position' ? lv.stop : null;
      const yd = derived != null ? s.priceToCoordinate(derived) : null;
      if (yd != null && Math.abs(my - yd) < 7 && mx >= span.x0 - 4 && mx <= span.x1 + 4) return { kind: 'point', index: d.points.length };
      const ys = [lv.entry, lv.stop, lv.target].map((p) => s.priceToCoordinate(p) ?? 0);
      return mx >= span.x0 && mx <= span.x1 && my >= Math.min(...ys) && my <= Math.max(...ys) ? { kind: 'body' } : null;
    }
    const a = pts[0], b = pts[1];
    if (!a || !b) return null;
    if (d.tool === 'brush') {
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i], p2 = pts[i + 1];
        if (p1 && p2 && distToSeg(mx, my, p1.x, p1.y, p2.x, p2.y) < HIT_TOLERANCE) return { kind: 'body' };
      }
      return null;
    }
    if (d.tool === 'trendline' || d.tool === 'ruler') {
      return distToSeg(mx, my, a.x, a.y, b.x, b.y) < HIT_TOLERANCE ? { kind: 'body' } : null;
    }
    if (d.tool === 'ray' || d.tool === 'extended_line') {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const dist = Math.abs((mx - a.x) * nx + (my - a.y) * ny);
      return dist < HIT_TOLERANCE ? { kind: 'body' } : null;
    }
    // box-shaped tools: rectangle, fib_retracement, fib_extension, fixed_range
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (mx >= x0 - HIT_TOLERANCE && mx <= x1 + HIT_TOLERANCE && my >= y0 - HIT_TOLERANCE && my <= y1 + HIT_TOLERANCE) return { kind: 'body' };
    return null;
  }

  function findDrawingAt(mx: number, my: number): { drawing: Drawing; hit: Hit } | null {
    const st = useStore.getState();
    const list = st.drawings;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      if (!d.done || !onSymbol(d, st.symbol.ticker) || !shownOnTf(d, st.timeframe)) continue;
      const hit = hitTestDrawing(d, mx, my);
      if (hit) return { drawing: d, hit };
    }
    return null;
  }

  function inContainer(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // only the plot area of the price pane belongs to the drawing tools. Axes, the
  // indicator panes and the pane separators stay with the chart library so its
  // native pan / scale / pane-resize keep working.
  function inMainPlot(clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    const { width, height } = mainPaneSize();
    return x >= 0 && x < width && y >= 0 && y < height - SEPARATOR_GUARD;
  }

  const setMultiSel = (ids: string[]) => { multiRef.current = ids; setMulti(ids); };

  function removeSelected() {
    const ids = multiRef.current.length ? multiRef.current : useStore.getState().selectedDrawingId ? [useStore.getState().selectedDrawingId!] : [];
    for (const id of ids) removeDrawing(id);
    setMultiSel([]);
    setSelectedDrawingId(null);
  }

  // text typed in place: the editor opens on the drawing
  function startEditing(d: Drawing) {
    editOrigRef.current = d.text ?? '';
    setSelectedDrawingId(d.id);
    setEditTextId(d.id);
  }
  function finishEditing(cancel = false) {
    const id = useChartUi.getState().editTextId;
    if (!id) return;
    const d = useStore.getState().drawings.find((x) => x.id === id);
    setEditTextId(null);
    if (!d) return;
    const text = cancel ? editOrigRef.current : (editorRef.current?.value ?? d.text ?? '');
    if (!text.trim()) { removeDrawing(id); setSelectedDrawingId(null); return; }
    updateDrawing(id, { text });
  }

  // window capture phase: we see the click before the chart and swallow it only
  // when it's ours (grabbing a drawing, or placing a point with a drawing tool)
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.chart-ui, .draw-float-toolbar-wrap, .draw-context-menu, .modal-backdrop, .sm-backdrop, .symbol-menu, .tb-dropdown-backdrop, .fav-bar, .presets-panel, .idg-backdrop, .draw-text-editor, .cp-pop, .cp-backdrop')) return;
      // picking the replay start bar: the click belongs to the chart
      if (useChartUi.getState().replay.mode === 'select') return;
      if (!inContainer(e.clientX, e.clientY)) return;
      setContextMenu(null);
      // a click away from the text being typed validates it
      if (useChartUi.getState().editTextId) finishEditing();
      if (!inMainPlot(e.clientX, e.clientY)) return;

      if (activeTool === 'cursor') {
        const { x, y } = pxDist(e.clientX, e.clientY);
        const found = findDrawingAt(x, y);
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl) {
          e.stopPropagation();
          e.preventDefault();
          if (found) {
            // Ctrl + click adds or removes a drawing from the selection
            const cur = multiRef.current.length ? multiRef.current : selectedDrawingIdNow() ? [selectedDrawingIdNow()!] : [];
            const next = cur.includes(found.drawing.id) ? cur.filter((id) => id !== found.drawing.id) : [...cur, found.drawing.id];
            setMultiSel(next.length > 1 ? next : []);
            setSelectedDrawingId(next.length === 1 ? next[0] : null);
            return;
          }
          // Ctrl + drag on an empty spot: a selection box
          selectingRef.current = { x0: x, y0: y, x1: x, y1: y };
          return;
        }
        if (!found) {
          // empty spot: deselect and let the chart pan natively
          if (useStore.getState().selectedDrawingId) setSelectedDrawingId(null);
          if (multiRef.current.length) setMultiSel([]);
          return;
        }
        const pt = toPoint(e.clientX, e.clientY);
        if (!pt) return;
        e.stopPropagation();
        e.preventDefault();
        // dragging one of several selected drawings moves them all
        if (found.hit.kind === 'body' && multiRef.current.includes(found.drawing.id)) {
          // (the locked ones stay where they are)
          const list = useStore.getState().drawings.filter((d) => multiRef.current.includes(d.id) && !d.locked);
          dragRef.current = moveDrag(pt, e.clientX, list);
          return;
        }
        if (multiRef.current.length) setMultiSel([]);
        setSelectedDrawingId(found.drawing.id);
        // locked: selected (its toolbar opens), neither moved nor resized
        if (found.drawing.locked) return;
        if (found.hit.kind === 'point') dragRef.current = { id: found.drawing.id, mode: 'point', pointIndex: found.hit.index };
        else dragRef.current = moveDrag(pt, e.clientX, [found.drawing]);
        return;
      }

      // the magnet holds points, not freehand strokes or text
      const pt = toPoint(e.clientX, e.clientY, activeTool !== 'brush' && activeTool !== 'text');
      if (!pt) return;
      e.stopPropagation();
      e.preventDefault();
      const symTicker = useStore.getState().symbol.ticker;

      if (isHLine(activeTool)) {
        // at a price of the chart's precision, like the axis shows it
        const at = { ...pt, price: Number(pt.price.toFixed(handles.current.precision)) };
        const d: Drawing = { id: nextId(), tool: activeTool, points: [at], ...newDrawingStyle(activeTool), done: true, ticker: symTicker, tf: useStore.getState().timeframe };
        addDrawing(d);
        // the lines from a point stay selected: their settings are a click away
        // (back to the cursor first: picking a tool clears the selection)
        setActiveTool('cursor');
        if (activeTool !== 'horizontal_line') setSelectedDrawingId(d.id);
        return;
      }
      if (activeTool === 'anchored_vp') {
        // one click: from this bar to the last one
        const d: Drawing = { id: nextId(), tool: 'anchored_vp', points: [pt], ...newDrawingStyle('anchored_vp'), done: true, ticker: symTicker };
        addDrawing(d);
        setActiveTool('cursor');
        setSelectedDrawingId(d.id);
        return;
      }
      if (activeTool === 'anchored_vwap') {
        // one click: the anchor bar, the VWAP runs from it to the last one
        const at = anchorAt(e.clientX);
        if (!at) return;
        const style = newDrawingStyle('anchored_vwap');
        const d: Drawing = { id: nextId(), tool: 'anchored_vwap', points: [at], ...style, done: true, ticker: symTicker, tf: useStore.getState().timeframe };
        addDrawing(d);
        setActiveTool('cursor');
        setSelectedDrawingId(d.id);
        return;
      }
      if (activeTool === 'alert') {
        addAlert(symTicker, +pt.price.toFixed(handles.current.precision));
        setActiveTool('cursor');
        return;
      }
      if (activeTool === 'text') {
        // typed right there, like in a word processor
        const d: Drawing = { id: nextId(), tool: 'text', points: [pt], text: '', fontSize: TEXT_SIZE, ...newDrawingStyle('text'), done: true, ticker: symTicker };
        addDrawing(d);
        setActiveTool('cursor');
        startEditing(d);
        return;
      }
      if (activeTool === 'brush') {
        brushingRef.current = true;
        const d: Drawing = { id: nextId(), tool: 'brush', points: [pt], ...newDrawingStyle('brush'), done: false, ticker: symTicker };
        pendingRef.current = { d, stage: 0 };
        addDrawing(d);
        return;
      }

      const pending = pendingRef.current;
      if (!pending) {
        const style = newDrawingStyle(activeTool);
        const n = activeTool === 'position_3pt' ? 3 : 2;
        const d: Drawing = { id: nextId(), tool: activeTool, points: Array.from({ length: n }, () => ({ ...pt })), ...style, done: false, ticker: symTicker };
        // (a template's Fibo settings, else the defaults)
        if (isFib(activeTool)) d.fib = style.fib ? structuredClone(style.fib) : defaultFib(activeTool);
        if (activeTool === 'long_position' || activeTool === 'short_position') d.riskReward = style.riskReward ?? 1;
        if (activeTool === 'position_rr') d.riskReward = style.riskReward ?? useStore.getState().positionRR;
        pendingRef.current = { d, stage: 1 };
        addDrawing(d);
        return;
      }
      const d = useStore.getState().drawings.find((x) => x.id === pending.d.id) ?? pending.d;
      const pts = [...d.points];
      pts[pending.stage] = pt;
      if (pending.stage + 1 < pts.length) {
        // 3 clicks: the stop is set, the target follows the mouse
        pendingRef.current = { d: { ...d, points: pts }, stage: pending.stage + 1 };
        updateDrawing(d.id, { points: pts });
        return;
      }
      updateDrawing(d.id, { points: pts, done: true });
      pendingRef.current = null;
      // the drawing just placed stays selected, its toolbar open (like TradingView)
      setActiveTool('cursor');
      setSelectedDrawingId(d.id);
    }

    function selectedDrawingIdNow() { return useStore.getState().selectedDrawingId; }

    function onMove(e: MouseEvent) {
      if (selectingRef.current) {
        const { x, y } = pxDist(e.clientX, e.clientY);
        selectingRef.current = { ...selectingRef.current, x1: x, y1: y };
        setFrame((n) => n + 1);
        return;
      }
      // pointing at drawings: the cursor tells what a drag would do (it stays as it is while dragging)
      if (!dragRef.current && activeTool === 'cursor') hoverAt(e);
      if (dragRef.current) {
        const pt = toPoint(e.clientX, e.clientY, dragRef.current.mode === 'point');
        if (!pt) return;
        const drag = dragRef.current;
        const list = useStore.getState().drawings;
        if (drag.mode === 'point') {
          const d = list.find((x) => x.id === drag.id);
          if (!d) return;
          if (d.tool === 'rectangle') { updateDrawing(d.id, { points: moveRectHandle(d.points, drag.pointIndex, pt) }); return; }
          // the anchored VWAP's anchor goes bar by bar, the VWAP following it
          if (d.tool === 'anchored_vwap') {
            const at = anchorAt(e.clientX, d);
            if (at && at.time !== d.points[0]?.time) updateDrawing(d.id, { points: [at] });
            return;
          }
          if (drag.pointIndex >= d.points.length) {
            // a position's derived line: the R:R follows it
            const lv = positionLevels(d);
            if (!lv) return;
            if (d.tool === 'position_rr') {
              const rr = Math.abs(pt.price - lv.entry) / Math.abs(lv.entry - lv.stop);
              if (Number.isFinite(rr) && rr > 0) updateDrawing(d.id, { riskReward: Math.round(rr * 100) / 100 });
            } else {
              const rr = Math.abs(lv.target - lv.entry) / Math.abs(pt.price - lv.entry);
              if (Number.isFinite(rr) && rr > 0) updateDrawing(d.id, { riskReward: Math.round(rr * 100) / 100 });
            }
            return;
          }
          const newPoints = [...d.points];
          newPoints[drag.pointIndex] = pt;
          updateDrawing(d.id, { points: newPoints });
        } else {
          // by whole bars, like TradingView: a move in seconds stretched the drawings, as a bar spans
          // a night or a week-end on the chart but an hour in the empty area right of the last bar
          const candles = handles.current.candles;
          const ml = mouseLogical(e.clientX);
          const dl = ml == null || !Number.isFinite(drag.startLogical) ? 0 : Math.round(ml - drag.startLogical);
          const dp = pt.price - drag.startMouse.price;
          for (const s of drag.start) {
            updateDrawing(s.id, {
              points: s.points.map((p, k) => {
                const l = s.logicals[k];
                const t = l == null ? null : logicalToTime(candles, l + dl);
                return { time: t ?? p.time, price: p.price + dp };
              }),
            });
          }
        }
        return;
      }
      const pt = toPoint(e.clientX, e.clientY, !brushingRef.current && activeTool !== 'cursor' && activeTool !== 'text');
      if (!pt) return;
      const pending = pendingRef.current;
      if (brushingRef.current && pending) {
        pending.d.points = [...pending.d.points, pt];
        updateDrawing(pending.d.id, { points: pending.d.points });
        return;
      }
      if (pending) {
        const pts = [...pending.d.points];
        pts[pending.stage] = pt;
        // 3 clicks, while placing the stop: the target shows at 2 R until clicked
        if (pending.d.tool === 'position_3pt' && pending.stage === 1) pts[2] = { time: pt.time, price: pts[0].price + 2 * (pts[0].price - pt.price) };
        for (let i = pending.stage + 1; i < pts.length; i++) if (pending.d.tool !== 'position_3pt') pts[i] = pt;
        pending.d.points = pts;
        updateDrawing(pending.d.id, { points: pts });
      }
    }

    function onUp() {
      if (dragRef.current?.mode === 'point') snapRef.current = null;
      dragRef.current = null;
      const sel = selectingRef.current;
      if (sel) {
        selectingRef.current = null;
        const box = { x0: Math.min(sel.x0, sel.x1), x1: Math.max(sel.x0, sel.x1), y0: Math.min(sel.y0, sel.y1), y1: Math.max(sel.y0, sel.y1) };
        const st = useStore.getState();
        const ids = st.drawings.filter((d) => d.done && onSymbol(d, st.symbol.ticker) && shownOnTf(d, st.timeframe)).filter((d) => {
          const b = boundsOf(d);
          return b && b.x0 <= box.x1 && b.x1 >= box.x0 && b.y0 <= box.y1 && b.y1 >= box.y0;
        }).map((d) => d.id);
        setMultiSel(ids.length > 1 ? ids : []);
        setSelectedDrawingId(ids.length === 1 ? ids[0] : null);
        setFrame((n) => n + 1);
      }
      const pending = pendingRef.current;
      if (brushingRef.current && pending) {
        updateDrawing(pending.d.id, { done: true });
        brushingRef.current = false;
        pendingRef.current = null;
        setActiveTool('cursor');
      }
    }

    // double-click: a text is edited in place, a fib or a horizontal line opens its settings
    // a click on the chart itself, not on a window laid over it (a settings dialog, a menu)
    function onChart(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      return !!t && !!containerRef.current?.contains(t) && inMainPlot(e.clientX, e.clientY);
    }

    function onDblClick(e: MouseEvent) {
      if (activeTool !== 'cursor' || !onChart(e)) return;
      if ((e.target as HTMLElement).closest('.chart-ui, .draw-text-editor')) return;
      const { x, y } = pxDist(e.clientX, e.clientY);
      const found = findDrawingAt(x, y);
      if (!found) return;
      if (isText(found.drawing)) { e.stopPropagation(); e.preventDefault(); startEditing(found.drawing); }
      else if (isFib(found.drawing.tool)) { e.stopPropagation(); e.preventDefault(); setFibDialogId(found.drawing.id); }
      else if (isHLine(found.drawing.tool)) { e.stopPropagation(); e.preventDefault(); setHlineDialogId(found.drawing.id); }
      else if (isVolumeProfile(found.drawing.tool)) { e.stopPropagation(); e.preventDefault(); setVpDialogId(found.drawing.id); }
      else if (found.drawing.tool === 'anchored_vwap') { e.stopPropagation(); e.preventDefault(); setAvwapDialogId(found.drawing.id); }
      else if (hasDrawingDialog(found.drawing)) { e.stopPropagation(); e.preventDefault(); setDrawDialogId(found.drawing.id); }
    }

    function onContextMenu(e: MouseEvent) {
      if (!onChart(e)) return;
      e.preventDefault();
      // placing an order on the chart: a right-click drops it instead of opening a menu
      const ui = useChartUi.getState();
      if (ui.orderDraft || ui.orderPlacing || ui.orderAiming) { ui.cancelOrderMode(); return; }
      // a drawing tool picked: a right-click puts it away, and drops what it had started
      if (activeTool !== 'cursor') {
        const p = pendingRef.current;
        if (p && !p.d.done) removeDrawing(p.d.id);
        pendingRef.current = null;
        brushingRef.current = false;
        setActiveTool('cursor');
        return;
      }
      const { x, y } = pxDist(e.clientX, e.clientY);
      const found = findDrawingAt(x, y);
      if (found) {
        setSelectedDrawingId(found.drawing.id);
        setContextMenu({ x: e.clientX, y: e.clientY, drawingId: found.drawing.id });
      } else {
        // right-click on the chart itself: the symbol menu, like TradingView
        setContextMenu(null);
        useChartUi.getState().setSymbolMenu({ x: e.clientX, y: e.clientY });
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.closest('input, textarea, select, [contenteditable="true"]');
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && (useStore.getState().selectedDrawingId || multiRef.current.length)) {
        removeSelected();
      }
      if (e.key === 'Escape' && !typing) {
        if (pendingRef.current && !pendingRef.current.d.done) removeDrawing(pendingRef.current.d.id);
        pendingRef.current = null;
        brushingRef.current = false;
        selectingRef.current = null;
        setMultiSel([]);
        setActiveTool('cursor');
        setContextMenu(null);
      }
    }

    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('dblclick', onDblClick, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('dblclick', onDblClick, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // a tool left half-drawn (another tool picked) is dropped
  useEffect(() => {
    const p = pendingRef.current;
    if (p && activeTool !== p.d.tool && !p.d.done) { removeDrawing(p.d.id); pendingRef.current = null; brushingRef.current = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // another symbol: the selection goes
  useEffect(() => { setMultiSel([]); }, [ticker]);

  // the text editor gets the keyboard as soon as it opens
  useEffect(() => {
    if (!editTextId) return;
    const t = setTimeout(() => { editorRef.current?.focus(); editorRef.current?.select(); }, 0);
    return () => clearTimeout(t);
  }, [editTextId]);

  // custom cursor feedback over the plot area (the canvas itself no longer
  // captures pointer events, so we style the container instead)
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.style.cursor = activeTool === 'cursor' ? '' : activeTool === 'text' ? 'text' : 'crosshair';
  }, [activeTool, containerRef]);

  // an anchored VWAP whose anchor is before the bars loaded (drawn on a higher timeframe):
  // older history is paged in, once per anchor (it is not drawn until the bars reach it)
  const dataVersion = useChartUi((s) => s.dataVersion);
  const pagedRef = useRef(new Set<string>());
  useEffect(() => {
    const first = handles.current.candles[0]?.time;
    if (first == null || !mainChart.loadBefore || handles.current !== mainChart.engine) return;
    const anchors = drawings.filter((d) => d.tool === 'anchored_vwap' && d.points[0] && d.points[0].time < first).map((d) => d.points[0].time);
    if (!anchors.length) return;
    const oldest = Math.min(...anchors);
    const key = `${ticker}|${timeframe}|${oldest}`;
    if (pagedRef.current.has(key)) return;
    pagedRef.current.add(key);
    void mainChart.loadBefore(oldest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDrawings, ticker, timeframe, dataVersion]);

  // render loop
  useEffect(() => {
    let raf = 0;
    function draw() {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && container && ctx) {
        const w = container.clientWidth, hgt = container.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(hgt * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, hgt);
        const pane = mainPaneSize();
        const st = useStore.getState();
        const rc: RenderCtx = {
          toXY, width: pane.width, height: pane.height, precision: handles.current.precision,
          barsBetween: (t1, t2) => {
            const a = timeToLogical(handles.current.candles, t1), b = timeToLogical(handles.current.candles, t2);
            return a === null || b === null ? 0 : Math.round(Math.abs(b - a));
          },
          riskAmount: (st.paper.balance * st.positionRiskPct) / 100,
          riskPct: st.positionRiskPct,
          last: handles.current.candles[handles.current.candles.length - 1]?.close ?? null,
          textColor: st.uiTheme === 'dark' ? '#d1d4dc' : '#131722',
          boxBg: st.uiTheme === 'dark' ? '#1e222d' : '#ffffff',
          candles: handles.current.candles,
          xOf: xOfTime,
          yOf: yOfPrice,
        };
        const editing = useChartUi.getState().editTextId;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, pane.width, pane.height);
        ctx.clip();
        for (const d of drawings) {
          if (d.id === editing) continue;
          const hv = hoverRef.current;
          renderDrawing(ctx, d, rc, d.id === selectedDrawingId || multiRef.current.includes(d.id), hv && hv.id === d.id ? hv.index : null);
        }
        // the magnet's point: a ring where the next point will stick
        const snap = snapRef.current && st.magnet !== 'off' && (st.activeTool !== 'cursor' || dragRef.current) ? toXY(snapRef.current) : null;
        if (snap) {
          ctx.save();
          ctx.strokeStyle = '#2962ff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(snap.x, snap.y, 4.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        const sel = selectingRef.current;
        if (sel) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#2962ff';
          ctx.fillStyle = 'rgba(41, 98, 255, 0.08)';
          const x = Math.min(sel.x0, sel.x1), y = Math.min(sel.y0, sel.y1);
          ctx.fillRect(x, y, Math.abs(sel.x1 - sel.x0), Math.abs(sel.y1 - sel.y0));
          ctx.strokeRect(x, y, Math.abs(sel.x1 - sel.x0), Math.abs(sel.y1 - sel.y0));
          ctx.restore();
        }
        ctx.restore();

        const toolbar = toolbarRef.current;
        const selected = selectedDrawingId ? drawings.find((d) => d.id === selectedDrawingId) : null;
        if (toolbar) {
          const b = selected ? boundsOf(selected) : null;
          if (selected && b) {
            toolbar.style.display = 'flex';
            const toolbarH = toolbar.offsetHeight || 40;
            const fitsBelow = b.y1 + 10 + toolbarH <= pane.height;
            toolbar.style.left = `${Math.max(4, Math.min(b.x0, w - (toolbar.offsetWidth || 300) - 4))}px`;
            toolbar.style.top = fitsBelow ? `${b.y1 + 10}px` : `${Math.max(4, b.y0 - toolbarH - 10)}px`;
          } else {
            toolbar.style.display = 'none';
          }
        }
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDrawings, ticker, timeframe, selectedDrawingId, multi]);

  const activeDrawing = contextMenu ? drawings.find((d) => d.id === contextMenu.drawingId) : null;
  const selectedDrawing = selectedDrawingId && !editTextId ? drawings.find((d) => d.id === selectedDrawingId) : null;
  const editing = editTextId ? drawings.find((d) => d.id === editTextId) : null;
  const editXY = editing ? toXY(editing.points[0]) : null;
  const selectedLv = selectedDrawing && isPosition(selectedDrawing.tool) ? positionLevels(selectedDrawing) : null;
  const rectSel = selectedDrawing?.tool === 'rectangle';
  const vpSel = !!selectedDrawing && isVolumeProfile(selectedDrawing.tool);
  // only the colour, width and line style the drawing uses
  const caps = selectedDrawing ? styleCaps(selectedDrawing.tool) : NO_STYLE;
  const drawingPresets = useStore((s) => s.drawingPresets);
  const presetsOfTool = selectedDrawing ? drawingPresets.filter((p) => p.tool === selectedDrawing.tool) : [];

  // a template's style on this drawing (its points and text stay)
  function applyPreset(d: Drawing, p: DrawingPreset) {
    // (a template from before the Fibo settings were saved keeps the drawing's levels)
    const keys = STYLE_KEYS.filter((k) => k !== 'fib' || p.fib);
    updateDrawing(d.id, { color: p.color, lineWidth: p.lineWidth, lineStyle: p.lineStyle, ...Object.fromEntries(keys.map((k) => [k, k === 'fib' ? structuredClone(p.fib) : p[k]])) });
  }
  // the colour of a drawing; a Fibo's is all its levels'
  function setColor(d: Drawing, color: string) {
    updateDrawing(d.id, isFib(d.tool) ? { color, fib: { ...fibOf(d), oneColor: true } } : { color });
  }
  function savePreset(d: Drawing) {
    const name = window.prompt('Nom du modèle :', `${TOOL_INFO[d.tool].label} ${d.color}`);
    if (!name) return;
    useStore.getState().addDrawingPreset({
      id: nextId(), name, tool: d.tool, color: d.color, lineWidth: d.lineWidth, lineStyle: d.lineStyle,
      ...structuredClone(defined(Object.fromEntries(STYLE_KEYS.map((k) => [k, d[k]])))),
    });
    useChartUi.getState().showToast(`Modèle « ${name} » enregistré dans les favoris ★`);
  }
  // TradingView's "add alert" of a drawing: a rectangle, the price entering its zone; a line or an
  // anchored VWAP, crossing it (the VWAP's bands can be picked in the window)
  function alertOnDrawing(d: Drawing) {
    const round = (v: number) => Number(v.toFixed(handles.current.precision));
    const price = { kind: 'price' as const };
    if (d.tool === 'anchored_vwap') {
      useChartUi.getState().openAlert({ conditions: [{ left: price, op: 'cross', right: avwapOperand(d, 'vwap') }] });
    } else if (d.tool === 'rectangle') {
      const [a, b] = d.points;
      useChartUi.getState().openAlert({ conditions: [{ left: price, op: 'enter', right: { kind: 'value', value: round(Math.min(a.price, b.price)) }, right2: { kind: 'value', value: round(Math.max(a.price, b.price)) } }] });
    } else {
      useChartUi.getState().openAlert({ conditions: [{ left: price, op: 'cross', right: { kind: 'value', value: round(d.points[0].price) } }] });
    }
  }
  // a copy in the same place, selected (to be moved), never locked
  function cloneDrawing(d: Drawing) {
    const copy: Drawing = { ...structuredClone(d), id: nextId(), locked: false };
    addDrawing(copy);
    setSelectedDrawingId(copy.id);
  }
  // above or under the other drawings (they are drawn in the list's order)
  function reorderDrawing(id: string, front: boolean) {
    useStore.setState((st) => {
      const d = st.drawings.find((x) => x.id === id);
      if (!d) return st;
      const rest = st.drawings.filter((x) => x.id !== id);
      return { drawings: front ? [...rest, d] : [d, ...rest] };
    });
  }
  const toolHint = activeTool === 'position_3pt' ? 'Position : cliquez l’entrée, puis le stop, puis l’objectif'
    : activeTool === 'position_rr' ? 'Position à R:R fixe : cliquez l’entrée, puis le stop'
      : activeTool === 'text' ? 'Cliquez où écrire, puis tapez le texte (Entrée pour valider, Maj + Entrée pour aller à la ligne)'
        : null;

  return (
    <>
      <canvas
        ref={(el) => { canvasRef.current = el; mainChart.drawingCanvas = el; }}
        className="drawing-canvas" style={{ pointerEvents: 'none' }}
      />
      {editing && editXY && (() => {
        const size = editing.fontSize ?? TEXT_SIZE;
        return (
          <textarea
            ref={editorRef}
            className="draw-text-editor"
            defaultValue={editing.text ?? ''}
            rows={Math.max(1, (editing.text ?? '').split('\n').length)}
            style={{ left: editXY.x - 3, top: editXY.y - size - 2, font: `${size}px sans-serif`, color: editing.color, lineHeight: 1.3 }}
            onInput={(ev) => {
              const t = ev.currentTarget;
              t.rows = Math.max(1, t.value.split('\n').length);
              t.style.width = `${Math.max(60, Math.max(...t.value.split('\n').map((l) => l.length)) * size * 0.62 + 16)}px`;
            }}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finishEditing(); }
              if (ev.key === 'Escape') { ev.preventDefault(); finishEditing(true); }
            }}
            onBlur={() => finishEditing()}
            placeholder="Texte…"
          />
        );
      })()}
      {toolHint && <div className="draw-hint chart-ui">
        {toolHint}
        {activeTool === 'position_rr' && (
          <label>R:R <input type="number" min={0.25} step={0.25} value={positionRR} onChange={(e) => setPositionTool({ positionRR: Math.max(0.25, parseFloat(e.target.value) || 2) })} /></label>
        )}
        {(activeTool === 'position_rr' || activeTool === 'position_3pt') && (
          <label>risque <input type="number" min={0.1} step={0.1} value={positionRiskPct} onChange={(e) => setPositionTool({ positionRiskPct: Math.max(0.01, parseFloat(e.target.value) || 1) })} /> % du compte</label>
        )}
        <button className="pill-btn" onClick={() => setActiveTool('cursor')}>Annuler (Échap)</button>
      </div>}
      {multi.length > 1 && (
        <div className="draw-hint chart-ui draw-multi">
          {multi.length} objets sélectionnés
          <button className="pill-btn danger" onClick={removeSelected}>🗑 Supprimer</button>
          <button className="pill-btn" onClick={() => setMultiSel([])}>Désélectionner</button>
        </div>
      )}
      {selectedDrawing && (
        <div ref={toolbarRef} className="draw-float-toolbar-wrap" style={{ display: 'none' }}>
          <div className="draw-float-toolbar dtb">
            {/* templates: the tool's saved styles, and saving this one */}
            <div className="dtb-host">
              <button className={`dtb-btn ${menu === 'templates' ? 'on' : ''}`} title="Modèles" onClick={() => toggleMenu('templates')}><TemplatesIcon /></button>
              {menu === 'templates' && (
                <div className="dtb-menu">
                  {presetsOfTool.map((p) => <button key={p.id} className="dtb-item" onClick={() => { applyPreset(selectedDrawing, p); setMenuOf(null); }}>{p.name}</button>)}
                  {!presetsOfTool.length && <div className="dtb-empty">Aucun modèle pour cet outil</div>}
                  <div className="dtb-sep" />
                  <button className="dtb-item" onClick={() => { setMenuOf(null); savePreset(selectedDrawing); }}>Enregistrer le style comme modèle…</button>
                </div>
              )}
            </div>
            {caps.color && (
              <ColorButton
                value={selectedDrawing.color}
                title={isText(selectedDrawing) ? 'Couleur du texte' : rectSel ? 'Couleur de la bordure' : isFib(selectedDrawing.tool) ? 'Couleur de tous les niveaux' : 'Couleur de la ligne'}
                onChange={(color) => setColor(selectedDrawing, color)}
              >
                {isText(selectedDrawing) ? <TextIcon /> : <PencilIcon />}
              </ColorButton>
            )}
            {vpSel && (
              <ColorButton
                value={vpOf(selectedDrawing).bgColor} title="Couleur et opacité du fond (les autres couleurs : bouton Paramètres)"
                onChange={(bgColor) => updateDrawing(selectedDrawing.id, { vp: { ...selectedDrawing.vp, bgColor, background: true } })}
              >
                <BucketIcon />
              </ColorButton>
            )}
            {rectSel && (
              <ColorButton value={selectedDrawing.noFill ? 'transparent' : selectedDrawing.fillColor ?? defaultFill(selectedDrawing.color)} title="Couleur et opacité du fond" onChange={(fillColor) => updateDrawing(selectedDrawing.id, { fillColor, noFill: false })}>
                <BucketIcon />
              </ColorButton>
            )}
            {rectSel && (
              <ColorButton value={selectedDrawing.textColor ?? selectedDrawing.color} title="Couleur du texte (le texte s’écrit dans les paramètres, ou double-clic)" onChange={(textColor) => updateDrawing(selectedDrawing.id, { textColor })}>
                <TextIcon />
              </ColorButton>
            )}
            {isText(selectedDrawing) ? (
              <>
                <button className="float-btn" title="Texte plus petit" onClick={() => updateDrawing(selectedDrawing.id, { fontSize: Math.max(8, (selectedDrawing.fontSize ?? TEXT_SIZE) - 2) })}>−</button>
                <span className="float-width">{selectedDrawing.fontSize ?? TEXT_SIZE}px</span>
                <button className="float-btn" title="Texte plus grand" onClick={() => updateDrawing(selectedDrawing.id, { fontSize: Math.min(48, (selectedDrawing.fontSize ?? TEXT_SIZE) + 2) })}>+</button>
                <button className="float-btn" title="Modifier le texte (ou double-clic)" onClick={() => startEditing(selectedDrawing)}>✎</button>
              </>
            ) : (
              <>
                {caps.width && <div className="dtb-host">
                  <button className={`dtb-btn dtb-wide ${menu === 'width' ? 'on' : ''}`} title="Épaisseur" onClick={() => toggleMenu('width')}>
                    <span className="dtb-line" style={{ height: Math.min(4, selectedDrawing.lineWidth) }} />{selectedDrawing.lineWidth}px
                  </button>
                  {menu === 'width' && (
                    <div className="dtb-menu">
                      {[1, 2, 3, 4].map((w) => (
                        <button key={w} className={`dtb-item ${selectedDrawing.lineWidth === w ? 'on' : ''}`} onClick={() => { updateDrawing(selectedDrawing.id, { lineWidth: w }); setMenuOf(null); }}>
                          <span className="dtb-line" style={{ height: w }} />{w}px
                        </button>
                      ))}
                    </div>
                  )}
                </div>}
                {caps.style && <div className="dtb-host">
                  <button className={`dtb-btn ${menu === 'style' ? 'on' : ''}`} title="Style de trait" onClick={() => toggleMenu('style')}>
                    <LineGlyph style={selectedDrawing.lineStyle ?? 'solid'} />
                  </button>
                  {menu === 'style' && (
                    <div className="dtb-menu">
                      {LINE_STYLES.map((l) => (
                        <button key={l.id} className={`dtb-item ${(selectedDrawing.lineStyle ?? 'solid') === l.id ? 'on' : ''}`} onClick={() => { updateDrawing(selectedDrawing.id, { lineStyle: l.id }); setMenuOf(null); }}>
                          <LineGlyph style={l.id} />{l.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>}
              </>
            )}
            {isFib(selectedDrawing.tool) && (
              <button className="dtb-btn" title="Paramètres (ou double-clic sur le Fibo)" onClick={() => setFibDialogId(selectedDrawing.id)}><SettingsIcon /></button>
            )}
            {isVolumeProfile(selectedDrawing.tool) && (
              <button className="dtb-btn" title="Paramètres : lignes, zone de valeur, couleurs… (ou double-clic sur le profil)" onClick={() => setVpDialogId(selectedDrawing.id)}><SettingsIcon /></button>
            )}
            {selectedDrawing.tool === 'anchored_vwap' && (
              <button className="dtb-btn" title="Paramètres : bandes, source, couleurs… (ou double-clic sur le VWAP)" onClick={() => setAvwapDialogId(selectedDrawing.id)}><SettingsIcon /></button>
            )}
            {isHLine(selectedDrawing.tool) && (
              <button className="dtb-btn" title="Paramètres : extension, texte, prix, écart… (ou double-clic sur la ligne)" onClick={() => setHlineDialogId(selectedDrawing.id)}><SettingsIcon /></button>
            )}
            {hasDrawingDialog(selectedDrawing) && (
              <button className="dtb-btn" title="Paramètres : style, texte, coordonnées, visibilité (ou double-clic)" onClick={() => setDrawDialogId(selectedDrawing.id)}><SettingsIcon /></button>
            )}
            {(selectedDrawing.tool === 'position_rr' || selectedDrawing.tool === 'long_position' || selectedDrawing.tool === 'short_position') && (
              <label className="fib-check" title="Ratio gain / risque">R:R
                <input
                  type="number" min={0.25} max={20} step={0.25}
                  value={selectedDrawing.riskReward ?? (selectedDrawing.tool === 'position_rr' ? 2 : 1)}
                  onChange={(e) => {
                    const rr = Math.max(0.25, parseFloat(e.target.value) || 1);
                    updateDrawing(selectedDrawing.id, { riskReward: rr });
                    if (selectedDrawing.tool === 'position_rr') setPositionTool({ positionRR: rr });
                  }}
                  className="fib-rr-input"
                />
              </label>
            )}
            {selectedDrawing.tool === 'position_3pt' && selectedLv && (
              <span className="float-width" title="Ratio gain / risque">R:R {fr(selectedLv.rr)}</span>
            )}
            {isPosition(selectedDrawing.tool) && (
              <label className="fib-check" title={`Taille calculée pour risquer ce % du compte virtuel (${fr(balance)})`}>risque
                <input type="number" min={0.1} step={0.1} value={positionRiskPct} className="fib-rr-input" onChange={(e) => setPositionTool({ positionRiskPct: Math.max(0.01, parseFloat(e.target.value) || 1) })} />%
              </label>
            )}
            {(rectSel || isHLine(selectedDrawing.tool) || selectedDrawing.tool === 'anchored_vwap') && (
              <button
                className="dtb-btn"
                title={rectSel ? 'Créer une alerte : le prix entre dans la zone'
                  : selectedDrawing.tool === 'anchored_vwap' ? 'Créer une alerte : le prix croise le VWAP ou une de ses bandes'
                    : 'Créer une alerte : le prix croise la ligne'}
                onClick={() => alertOnDrawing(selectedDrawing)}
              ><AlertIcon /></button>
            )}
            <button
              className={`dtb-btn ${selectedDrawing.locked ? 'on' : ''}`} title={selectedDrawing.locked ? 'Déverrouiller' : 'Verrouiller (le dessin ne bouge plus)'}
              onClick={() => updateDrawing(selectedDrawing.id, { locked: !selectedDrawing.locked })}
            >
              <LockIcon locked={!!selectedDrawing.locked} />
            </button>
            <button className="dtb-btn danger" title="Supprimer (Suppr)" onClick={() => removeSelected()}><TrashIcon /></button>
            <div className="dtb-host">
              <button className={`dtb-btn ${menu === 'more' ? 'on' : ''}`} title="Plus" onClick={() => toggleMenu('more')}><MoreIcon /></button>
              {menu === 'more' && (
                <div className="dtb-menu dtb-menu-right">
                  <button className="dtb-item" onClick={() => { setMenuOf(null); cloneDrawing(selectedDrawing); }}>Cloner</button>
                  <button className="dtb-item" onClick={() => { setMenuOf(null); reorderDrawing(selectedDrawing.id, true); }}>Mettre au premier plan</button>
                  <button className="dtb-item" onClick={() => { setMenuOf(null); reorderDrawing(selectedDrawing.id, false); }}>Mettre en arrière-plan</button>
                  <div className="dtb-sep" />
                  <button className="dtb-item" onClick={() => { setMenuOf(null); savePreset(selectedDrawing); }}>Enregistrer le style comme modèle…</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {drawDialogId && <DrawingDialog id={drawDialogId} onClose={() => setDrawDialogId(null)} />}
      {fibDialogId && <FibDialog id={fibDialogId} onClose={() => setFibDialogId(null)} />}
      {hlineDialogId && <HLineDialog id={hlineDialogId} onClose={() => setHlineDialogId(null)} />}
      {vpDialogId && <VolumeProfileDialog id={vpDialogId} onClose={() => setVpDialogId(null)} />}
      {avwapDialogId && <AvwapDialog id={avwapDialogId} onClose={() => setAvwapDialogId(null)} />}
      {contextMenu && activeDrawing && (
        <div className="draw-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseLeave={() => setContextMenu(null)}>
          {styleCaps(activeDrawing.tool).color && (
            <>
              <div className="ctx-title">{isFib(activeDrawing.tool) ? 'Couleur des niveaux' : 'Couleur'}</div>
              <div className="ctx-colors">
                {COLOR_PALETTE.map((c) => (
                  <button key={c} className="ctx-color" style={{ background: c }} onClick={() => { setColor(activeDrawing, c); setContextMenu(null); }} />
                ))}
              </div>
              <div className="ctx-sep" />
            </>
          )}
          {isText(activeDrawing) && <button className="ctx-item" onClick={() => { startEditing(activeDrawing); setContextMenu(null); }}>Modifier le texte</button>}
          {isFib(activeDrawing.tool) && <button className="ctx-item" onClick={() => { setFibDialogId(activeDrawing.id); setContextMenu(null); }}>Paramètres…</button>}
          {isHLine(activeDrawing.tool) && <button className="ctx-item" onClick={() => { setHlineDialogId(activeDrawing.id); setContextMenu(null); }}>Paramètres…</button>}
          {isVolumeProfile(activeDrawing.tool) && <button className="ctx-item" onClick={() => { setVpDialogId(activeDrawing.id); setContextMenu(null); }}>Paramètres…</button>}
          {activeDrawing.tool === 'anchored_vwap' && <button className="ctx-item" onClick={() => { setAvwapDialogId(activeDrawing.id); setContextMenu(null); }}>Paramètres…</button>}
          {hasDrawingDialog(activeDrawing) && <button className="ctx-item" onClick={() => { setDrawDialogId(activeDrawing.id); setContextMenu(null); }}>Paramètres…</button>}
          <button className="ctx-item" onClick={() => { updateDrawing(activeDrawing.id, { locked: !activeDrawing.locked }); setContextMenu(null); }}>{activeDrawing.locked ? 'Déverrouiller' : 'Verrouiller'}</button>
          <button className="ctx-item" onClick={() => { cloneDrawing(activeDrawing); setContextMenu(null); }}>Cloner</button>
          {styleCaps(activeDrawing.tool).width && (
            <>
              <button className="ctx-item" onClick={() => { updateDrawing(activeDrawing.id, { lineWidth: Math.min(6, activeDrawing.lineWidth + 1) }); }}>Épaisseur +</button>
              <button className="ctx-item" onClick={() => { updateDrawing(activeDrawing.id, { lineWidth: Math.max(1, activeDrawing.lineWidth - 1) }); }}>Épaisseur −</button>
            </>
          )}
          <div className="ctx-sep" />
          <button className="ctx-item danger" onClick={() => { removeDrawing(activeDrawing.id); setContextMenu(null); }}>Supprimer</button>
        </div>
      )}
    </>
  );
}

// a rectangle's text, inside its box at the chosen place
function boxText(ctx: CanvasRenderingContext2D, d: Drawing, r: { x0: number; x1: number; y0: number; y1: number }) {
  const size = d.fontSize ?? TEXT_SIZE;
  const lines = (d.text ?? '').split('\n');
  const lh = size * 1.3, pad = 6, total = lines.length * lh;
  const h = d.textH ?? 'center', v = d.textV ?? 'middle';
  ctx.save();
  ctx.font = `${d.italic ? 'italic ' : ''}${d.bold ? 'bold ' : ''}${size}px sans-serif`;
  ctx.fillStyle = d.textColor ?? d.color;
  ctx.textAlign = h;
  ctx.textBaseline = 'middle';
  const x = h === 'left' ? r.x0 + pad : h === 'right' ? r.x1 - pad : (r.x0 + r.x1) / 2;
  let y = (v === 'top' ? r.y0 + pad : v === 'bottom' ? r.y1 - pad - total : (r.y0 + r.y1) / 2 - total / 2) + lh / 2;
  for (const l of lines) { ctx.fillText(l, x, y); y += lh; }
  ctx.restore();
}

// a line's style drawn small (the toolbar's style button and menu)
function LineGlyph({ style }: { style: LineStyleName }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 9h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeDasharray={style === 'dashed' ? '4 3' : style === 'dotted' ? '0.5 3' : undefined} /></svg>
  );
}

// `hover`: the index of its handle under the mouse (rectangles), null when none
function renderDrawing(ctx: CanvasRenderingContext2D, d: Drawing, rc: RenderCtx, selected: boolean, hover: number | null = null) {
  const { toXY, width, height, precision } = rc;
  const fmt = (v: number) => v.toFixed(precision);
  const baseDash = DASH[d.lineStyle ?? ''] ?? [];
  ctx.save();
  ctx.setLineDash(baseDash);
  ctx.strokeStyle = d.color;
  ctx.fillStyle = d.color;
  ctx.lineWidth = d.lineWidth || 1.5;
  ctx.font = '11px sans-serif';

  const drawHandles = (pts: ({ x: number; y: number } | null)[]) => {
    if (!selected) return;
    ctx.save();
    ctx.setLineDash([]);
    for (const p of pts) {
      if (!p) continue;
      ctx.fillStyle = '#0e1117';
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  };

  if (isHLine(d.tool)) {
    const a = toXY(d.points[0]);
    if (!a) return ctx.restore();
    const h = hlineOf(d);
    const sp = hlineSpan(d, a.x, width);
    const x0 = Math.max(0, sp.x0), x1 = Math.min(width, sp.x1);
    if (x1 > x0) { ctx.beginPath(); ctx.moveTo(x0, a.y); ctx.lineTo(x1, a.y); ctx.stroke(); }
    const label = x1 > x0 ? hlineLabel(d, h, fmt, rc.last) : '';
    if (label) {
      // at the left end, the middle or the right end of the line's visible part
      const size = 11 + h.size;
      ctx.setLineDash([]);
      ctx.font = `${size}px sans-serif`;
      const pad = h.boxed ? 4 : 0;
      const bw = ctx.measureText(label).width + pad * 2;
      const bh = size + 6;
      const at = h.align === 'left' ? x0 + 6 : h.align === 'right' ? x1 - 6 - bw : (x0 + x1) / 2 - bw / 2;
      const lx = Math.max(2, Math.min(width - bw - 2, at));
      if (h.boxed) {
        ctx.fillStyle = rc.boxBg;
        ctx.fillRect(lx, a.y - bh / 2, bw, bh);
        ctx.lineWidth = 1;
        ctx.strokeStyle = d.color;
        ctx.strokeRect(Math.round(lx) + 0.5, Math.round(a.y - bh / 2) + 0.5, Math.round(bw) - 1, bh - 1);
      }
      ctx.fillStyle = h.sameColor ? d.color : rc.textColor;
      ctx.textBaseline = h.boxed ? 'middle' : 'alphabetic';
      ctx.fillText(label, lx + pad, h.boxed ? a.y + 0.5 : a.y - 4);
      ctx.textBaseline = 'alphabetic';
    }
    drawHandles([a]);
  } else if (d.tool === 'text') {
    const a = toXY(d.points[0]);
    if (!a) return ctx.restore();
    const b = textBox(d);
    ctx.font = `${b.size}px sans-serif`;
    b.lines.forEach((l, i) => ctx.fillText(l, a.x, a.y + i * b.size * 1.3));
    if (selected) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x - 3, a.y - b.size - 1, b.w + 6, b.h + 4);
      ctx.restore();
    }
  } else if (d.tool === 'trendline') {
    const a = toXY(d.points[0]), b = toXY(d.points[1]);
    if (!a || !b) return ctx.restore();
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    drawHandles([a, b]);
  } else if (d.tool === 'ray' || d.tool === 'extended_line') {
    const a = toXY(d.points[0]), b = toXY(d.points[1]);
    if (!a || !b) return ctx.restore();
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.001) { ctx.beginPath(); ctx.moveTo(a.x, 0); ctx.lineTo(a.x, height); ctx.stroke(); drawHandles([a, b]); return ctx.restore(); }
    const slope = dy / dx;
    const extend = (fromX: number, toX: number) => {
      const y1 = a.y + slope * (fromX - a.x);
      const y2 = a.y + slope * (toX - a.x);
      ctx.beginPath(); ctx.moveTo(fromX, y1); ctx.lineTo(toX, y2); ctx.stroke();
    };
    if (d.tool === 'extended_line') extend(0, width);
    else extend(a.x, dx >= 0 ? width : 0);
    drawHandles([a, b]);
  } else if (d.tool === 'rectangle') {
    const a = toXY(d.points[0]), b = toXY(d.points[1]);
    if (!a || !b) return ctx.restore();
    const r = rectBox(d, a, b, width);
    // the background: its own colour (with its opacity), else the line's at 15 %
    if (!d.noFill) {
      if (d.fillColor) ctx.fillStyle = d.fillColor;
      else ctx.globalAlpha = 0.15;
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      ctx.globalAlpha = 1;
    }
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    if (d.text) boxText(ctx, d, r);
    const hs = rectHandles(a, b);
    drawHandles(hs.slice(0, 4));
    // the middles of the sides: small squares, like TradingView's
    if (selected) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = '#0e1117';
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1.5;
      for (const p of hs.slice(4)) { ctx.fillRect(p.x - 4, p.y - 4, 8, 8); ctx.strokeRect(p.x - 4, p.y - 4, 8, 8); }
      // the handle under the mouse: larger, with a halo (TradingView's)
      const p = hover != null ? hs[hover] : null;
      if (p) {
        ctx.fillStyle = 'rgba(41, 98, 255, 0.25)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0e1117';
        if (hover! < 4) { ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R + 1, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
        else { ctx.fillRect(p.x - 5, p.y - 5, 10, 10); ctx.strokeRect(p.x - 5, p.y - 5, 10, 10); }
      }
      ctx.restore();
    }
  } else if (d.tool === 'brush') {
    const pts = d.points.map(toXY).filter(Boolean) as { x: number; y: number }[];
    if (pts.length < 2) return ctx.restore();
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (selected) drawHandles([pts[0], pts[pts.length - 1]]);
  } else if (isVolumeProfile(d.tool)) {
    const g = vpGeometry(d, rc.candles, rc.xOf, rc.yOf);
    if (!g) return ctx.restore();
    const s = vpOf(d);
    const p = g.p;
    const w = Math.max(1, g.x1 - g.x0);
    ctx.setLineDash([]);
    // (its opacity is the colour's)
    if (s.background) { ctx.fillStyle = s.bgColor; ctx.fillRect(g.x0, g.yTop, w, g.yBot - g.yTop); }
    // rows from the left (or right) edge of the range, their length by their volume;
    // brighter inside the value area
    const hw = (w * s.width) / 100;
    const left = s.placement === 'left';
    const bar = (from: number, len: number, top: number, h: number, color: string) => {
      if (len <= 0) return;
      ctx.fillStyle = color;
      ctx.fillRect(left ? g.x0 + from : g.x1 - from - len, top, len, h);
    };
    for (let r = 0; r < p.up.length; r++) {
      const total = p.up[r] + p.down[r];
      const ya = rc.yOf(p.lo + (r + 1) * p.step), yb = rc.yOf(p.lo + r * p.step);
      if (!total || ya == null || yb == null) continue;
      const top = Math.min(ya, yb), h = Math.max(1, Math.abs(yb - ya) - 1);
      const alpha = r >= p.vaLo && r <= p.vaHi ? 0.8 : 0.35;
      if (s.split) {
        const wu = (p.up[r] / p.max) * hw;
        bar(0, wu, top, h, withAlpha(s.upColor, alpha));
        bar(wu, (p.down[r] / p.max) * hw, top, h, withAlpha(s.downColor, alpha));
      } else bar(0, (total / p.max) * hw, top, h, withAlpha(s.upColor, alpha));
    }
    const line = (price: number, x1: number, color: string, dash: number[], lw: number) => {
      const y = rc.yOf(price);
      if (y == null) return;
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(g.x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.restore();
    };
    if (s.showVaLines) {
      line(p.lo + (p.vaHi + 1) * p.step, g.x1, s.upColor, [4, 3], 1);
      line(p.lo + p.vaLo * p.step, g.x1, s.downColor, [4, 3], 1);
    }
    if (s.showPoc) line(p.lo + (p.poc + 0.5) * p.step, s.extendPoc ? width : g.x1, s.pocColor, [], 1.5);
    if (selected) {
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(g.x0, g.yTop, w, g.yBot - g.yTop);
    }
    drawHandles(d.points.map((pt) => { const x = rc.xOf(pt.time); return x == null ? null : { x, y: g.yBot }; }));
  } else if (d.tool === 'anchored_vwap') {
    const g = avwapGeometry(d, rc.candles, rc.xOf, rc.yOf, width);
    if (!g) return ctx.restore();
    const { xs } = g;
    // a line through the bars on screen (NaN breaks it)
    const poly = (ys: number[], color: string, lw: number, dash: number[]) => {
      ctx.save();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < xs.length; k++) {
        if (!Number.isFinite(ys[k]) || !Number.isFinite(xs[k])) { pen = false; continue; }
        if (pen) ctx.lineTo(xs[k], ys[k]); else { ctx.moveTo(xs[k], ys[k]); pen = true; }
      }
      ctx.stroke();
      ctx.restore();
    };
    // a band's background: along its upper line, back along its lower one
    const fill = (up: number[], lo: number[], color: string) => {
      ctx.save();
      ctx.fillStyle = color;
      let k = 0;
      while (k < xs.length) {
        while (k < xs.length && !(Number.isFinite(up[k]) && Number.isFinite(lo[k]))) k++;
        const a = k;
        while (k < xs.length && Number.isFinite(up[k]) && Number.isFinite(lo[k])) k++;
        if (k - a < 2) continue;
        ctx.beginPath();
        ctx.moveTo(xs[a], up[a]);
        for (let j = a + 1; j < k; j++) ctx.lineTo(xs[j], up[j]);
        for (let j = k - 1; j >= a; j--) ctx.lineTo(xs[j], lo[j]);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    };
    for (const b of g.bands) if (b.b.fill) fill(b.up, b.lo, b.b.fillColor);
    for (const b of g.bands) { poly(b.up, b.b.upColor, 1, []); poly(b.lo, b.b.loColor, 1, []); }
    poly(g.mid, d.color, d.lineWidth || 1, baseDash);
    drawHandles([g.anchor]);
  } else if (isFib(d.tool)) {
    const a = toXY(d.points[0]), b = toXY(d.points[1]);
    if (!a || !b) return ctx.restore();
    const f = fibOf(d);
    // "Inverser" swaps the ends the levels are measured from
    const [pa, pb] = f.reverse ? [d.points[1].price, d.points[0].price] : [d.points[0].price, d.points[1].price];
    const [ya, yb] = f.reverse ? [b.y, a.y] : [a.y, b.y];
    const xl = f.extendLeft ? 0 : Math.min(a.x, b.x);
    const xr = f.extendRight ? width : Math.max(a.x, b.x);
    const levels = f.levels.filter((l) => l.on).sort((l1, l2) => l1.value - l2.value);
    const colorOf = (c: string) => (f.oneColor ? d.color : c);
    if (f.background) {
      const alpha = Math.max(0, Math.min(1, 1 - f.bgTransparency / 100));
      for (let i = 1; i < levels.length; i++) {
        const y1 = ya + (yb - ya) * levels[i - 1].value, y2 = ya + (yb - ya) * levels[i].value;
        ctx.fillStyle = withAlpha(colorOf(levels[i].color), alpha);
        ctx.fillRect(xl, Math.min(y1, y2), xr - xl, Math.abs(y2 - y1));
      }
    }
    ctx.font = `${f.fontSize}px sans-serif`;
    for (const l of levels) {
      const price = pa + (pb - pa) * l.value;
      const y = ya + (yb - ya) * l.value;
      const c = colorOf(l.color);
      ctx.strokeStyle = c;
      ctx.beginPath(); ctx.moveTo(xl, y); ctx.lineTo(xr, y); ctx.stroke();
      const lvl = f.levelsAs === 'percent' ? `${(l.value * 100).toFixed(1)}%` : String(l.value);
      const label = f.showLevels && f.showPrices ? `${lvl} (${fmt(price)})` : f.showLevels ? lvl : f.showPrices ? fmt(price) : '';
      if (!label) continue;
      ctx.fillStyle = c;
      if (f.labelsAt === 'left') { ctx.textAlign = 'right'; ctx.fillText(label, Math.max(xl - 4, ctx.measureText(label).width + 2), y + 4); }
      else { ctx.textAlign = 'left'; ctx.fillText(label, Math.min(xr + 4, width - ctx.measureText(label).width - 2), y + 4); }
    }
    ctx.textAlign = 'left';
    if (f.trendLine) {
      ctx.strokeStyle = '#787b86';
      ctx.beginPath(); ctx.setLineDash([3, 3]); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash(baseDash);
    }
    drawHandles([a, b]);
  } else if (isPosition(d.tool)) {
    const lv = positionLevels(d);
    const a = toXY(d.points[0]);
    if (!lv || !a) return ctx.restore();
    const yOf = (price: number) => toXY({ time: d.points[0].time, price })?.y ?? null;
    const yE = a.y, yS = yOf(lv.stop), yT = yOf(lv.target);
    if (yS == null || yT == null) return ctx.restore();
    const pts = d.points.map(toXY).filter(Boolean) as XY[];
    const x0 = a.x;
    let x1 = Math.max(...pts.map((p) => p.x));
    if (x1 - x0 < 60) x1 = x0 + 120;
    const w = x1 - x0;
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#26a69a';
    ctx.fillRect(x0, Math.min(yE, yT), w, Math.abs(yT - yE));
    ctx.fillStyle = '#ef5350';
    ctx.fillRect(x0, Math.min(yE, yS), w, Math.abs(yS - yE));
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#9598a1';
    ctx.beginPath(); ctx.moveTo(x0, yE); ctx.lineTo(x1, yE); ctx.stroke();
    ctx.strokeStyle = '#26a69a';
    ctx.beginPath(); ctx.moveTo(x0, yT); ctx.lineTo(x1, yT); ctx.stroke();
    ctx.strokeStyle = '#ef5350';
    ctx.beginPath(); ctx.moveTo(x0, yS); ctx.lineTo(x1, yS); ctx.stroke();

    const s = lv.long ? 1 : -1;
    const gainPct = ((lv.target - lv.entry) / lv.entry) * 100 * s;
    const riskPct = ((lv.entry - lv.stop) / lv.entry) * 100 * s;
    const qty = riskQty(rc.riskAmount, lv.entry, lv.stop);
    const gain = qty * Math.abs(lv.target - lv.entry);
    const up = lv.long ? yT < yE : yT > yE;
    const tY = up ? Math.min(yT, yE) - 5 : Math.max(yT, yE) + 13;
    const sY = up ? Math.max(yS, yE) + 13 : Math.min(yS, yE) - 5;
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#26a69a';
    ctx.fillText(`Objectif ${fmt(lv.target)}  (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)} %)  +${fr(gain)}  ·  R:R ${fr(lv.rr)}`, x0 + 4, tY);
    ctx.fillStyle = '#ef5350';
    ctx.fillText(`Stop ${fmt(lv.stop)}  (${(-Math.abs(riskPct)).toFixed(2)} %)  −${fr(rc.riskAmount)}`, x0 + 4, sY);
    // the entry label on a dark tag, in the box
    const label = `${lv.long ? 'Achat' : 'Vente'} ${fmt(lv.entry)}  ·  Qté ${qty.toLocaleString(LOCALE)} (risque ${fr(rc.riskPct, rc.riskPct % 1 ? 1 : 0)} %)`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(19, 23, 34, 0.85)';
    ctx.fillRect(x0 + 2, yE - 8, tw + 8, 16);
    ctx.fillStyle = '#e0e0e0';
    ctx.fillText(label, x0 + 6, yE + 4);
    const handlesAt: (XY | null)[] = [a, ...d.points.slice(1).map(toXY)];
    if (d.tool === 'position_rr') handlesAt.push({ x: x1, y: yT });
    if (d.tool === 'long_position' || d.tool === 'short_position') handlesAt.push({ x: x1, y: yS });
    drawHandles(handlesAt);
  } else if (d.tool === 'ruler') {
    const a = toXY(d.points[0]), b = toXY(d.points[1]);
    if (!a || !b) return ctx.restore();
    const p1 = d.points[0].price, p2 = d.points[1].price;
    const pct = ((p2 - p1) / p1) * 100;
    const bars = rc.barsBetween(d.points[0].time, d.points[1].time);
    ctx.globalAlpha = 0.18;
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.globalAlpha = 1;
    // the line and the label in the ruler's colour (its width and style on the line)
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
    const label = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%   ${fmt(p2 - p1)}   ${bars} barres`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = '#1c2028';
    ctx.fillRect(midX - tw / 2 - 4, midY - 16, tw + 8, 18);
    ctx.fillStyle = d.color;
    ctx.fillText(label, midX - tw / 2, midY - 3);
    drawHandles([a, b]);
  }
  ctx.restore();
}
