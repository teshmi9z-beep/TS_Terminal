import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import { LineStyle, type IPriceLine, type Logical } from 'lightweight-charts';
import { useStore, type PaperOrder, type PaperPosition, type PaperSide } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { useQuotes } from '../data/feeds/quotes';
import { formatPrice, indexAtOrBefore, type ChartEngine } from './chartUtils';
import { lastPriceOf } from './paperActions';
import { currencySign, eurPerUnit, quoteCurrency } from '../data/fx';
import { LevelEditor, QtyEditor, QtyStepper } from './OrderEditors';
import { isReplaying, useTradingAccount } from './tradingAccount';
import { tradePnlEur } from '../store/replayTrading';
import { currentPrice } from './symbolActions';
import { moveEntry, newDraft, orderType, sideFor, sideSign as sign, type OrderDraft as Draft } from './orderDraft';
import { LOCALE, DEC } from '../i18n/lang';

// Virtual account on the chart, like a broker's platform:
// - "ordre sur le graphique": press on the entry price, drag to the stop; the
//   target starts at 2 R, the three lines can be dragged, then "Placer l'ordre"
//   sends a limit or stop order (from where the entry is against the price);
// - with the order ticket (right panel) in limit or stop mode, a line follows
//   the mouse; its side comes from where it is against the price (a limit above
//   sells, below buys; a stop the other way round) and a click puts the order
//   there, stop and target included, to adjust before sending;
// - open positions and pending orders show their lines with handles: stop and
//   target are dragged, added (+SL / +TP) or removed, orders moved or cancelled,
//   positions closed;
// - several positions on one side fold into one line at their average entry
//   ("−" on a position's label, "+" to unfold, like ProRealTime); its stop and
//   target lines move, or are removed, for all of them;
// - a position's line starts at the bar it was opened on; with several on one
//   side, a thick line at their average entry starts at the first one, and a thin
//   staircase shows how that average moved with each entry (ProRealTime again).

const BLUE = '#2962ff';
const RED = '#f23645';
const GREEN = '#089981';

// the line being dragged
type Grab =
  | { kind: 'draft'; field: 'entry' | 'sl' | 'tp' }
  | { kind: 'pos'; id: string; field: 'sl' | 'tp' }
  | { kind: 'order'; id: string; field: 'price' | 'sl' | 'tp' }
  // the folded positions of one side: the stop / target of those at `from` (all of them when absent)
  | { kind: 'group'; side: PaperSide; field: 'sl' | 'tp'; from?: number };
// the dragged line's price until the mouse is released
type Live = { key: string; price: number };

// `axisOnly`: only its price on the axis, the line itself is drawn from its bar on (positions)
type Line = { key: string; price: number; color: string; style: LineStyle; title: string; axisOnly?: boolean };
// a stop or target of folded positions: those that have it at the same price
type Level = { tag: string; price: number; list: PaperPosition[] };

const money = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const typeLabel = (side: PaperSide, type: PaperOrder['type']) => `${side === 'long' ? 'Achat' : 'Vente'} ${type === 'limit' ? 'limite' : 'stop'}`;
// ProRealTime's short labels: A / V (achat / vente), LMT / STP
const sideLetter = (side: PaperSide) => (side === 'long' ? 'A' : 'V');
const orderTag = (side: PaperSide, type: PaperOrder['type']) => `${sideLetter(side)}:${type === 'limit' ? 'LMT' : 'STP'}`;
const sideColor = (side: PaperSide) => (side === 'long' ? BLUE : RED);
// summed quantities without the float noise (0.1 + 0.2)
const qtyText = (q: number) => String(Number(q.toFixed(8)));
const totalQty = (list: PaperPosition[]) => list.reduce((s, p) => s + p.qty, 0);
const avgEntry = (list: PaperPosition[]) => list.reduce((s, p) => s + p.entry * p.qty, 0) / (totalQty(list) || 1);
const grabKey = (g: Grab) => (g.kind === 'draft' ? `draft:${g.field}` : g.kind === 'pos' ? `pos:${g.id}:${g.field}`
  : g.kind === 'order' ? `ord:${g.id}:${g.field}` : `grp:${g.side}:${g.field}:${g.from ?? 'all'}`);

// a quantity that risks `pct` % of the account between entry and stop
function qtyForRisk(equity: number, pct: number, entry: number, sl: number): number {
  const q = (equity * pct) / 100 / Math.abs(entry - sl);
  if (!Number.isFinite(q) || q <= 0) return 0;
  if (q >= 100) return Math.floor(q);
  if (q >= 1) return Math.floor(q * 100) / 100;
  return Number(q.toPrecision(3));
}

export default function ChartTrading({ engine, seriesGen }: {
  engine: RefObject<ChartEngine>;
  seriesGen: number;
}) {
  const symbol = useStore((s) => s.symbol);
  // during a replay: the replay account, priced at the replay bar
  const { api: acct, paper } = useTradingAccount();
  const placing = useChartUi((s) => s.orderPlacing);
  const setPlacing = useChartUi((s) => s.setOrderPlacing);
  const paperQty = useChartUi((s) => s.paperQty);
  const replayMode = useChartUi((s) => s.replay.mode);
  const replayOn = replayMode === 'on';
  useChartUi((s) => s.replay.at);
  const quotes = useQuotes((s) => s.quotes);
  const draft = useChartUi((s) => s.orderDraft);
  const setDraft = useChartUi((s) => s.setOrderDraft);
  const ticket = useChartUi((s) => s.orderTicket);
  const panelOpen = useStore((s) => s.rightPanel === 'trading');
  const activeTool = useStore((s) => s.activeTool);
  const [qty, setQty] = useState(String(paperQty));
  const [live, setLive] = useState<Live | null>(null);
  // price and x under the mouse while the order ticket waits for a click on the chart
  const [aim, setAim] = useState<{ price: number; x: number } | null>(null);
  const [, setFrame] = useState(0);
  const linesRef = useRef<IPriceLine[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  // the line under the mouse (its label then shows "Ajouter stop" / "Ajouter limite"); kept a
  // moment after leaving so the mouse can go from the line to the label
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const hoverTimer = useRef(0);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  // the small panel a double-click opens: a pending order's quantity, or a stop / target by its amount
  const [editor, setEditor] = useState<
    | { kind: 'qty'; id: string }
    // folded positions ('grp'): id is the side, `from` the stop / target price of those edited
    | { kind: 'level'; target: 'pos' | 'ord' | 'draft' | 'grp'; id: string; field: 'sl' | 'tp'; from?: number }
    | null
  >(null);
  const e = engine.current;
  const series = e.mainSeries;
  const prec = e.precision;
  const tick = 10 ** -prec;
  const round = (v: number) => Number(v.toFixed(prec));
  const last = replayOn ? (e.candles[e.candles.length - 1]?.close ?? null) : (quotes[symbol.ticker]?.last ?? lastPriceOf(symbol.ticker));

  const positions = paper.positions.filter((p) => p.symbol.ticker === symbol.ticker);
  const orders = paper.orders.filter((o) => o.symbol.ticker === symbol.ticker);
  // positions of a side folded into one line (only when there are several)
  const grouped = useStore((s) => s.groupedPositions);
  const sideList = (side: PaperSide) => positions.filter((p) => p.side === side);
  const isFolded = (side: PaperSide) => grouped.includes(`${symbol.ticker}:${side}`) && sideList(side).length > 1;
  const toggleFold = (side: PaperSide) => useStore.getState().toggleGroupedPositions(`${symbol.ticker}:${side}`);
  const foldedSides = (['long', 'short'] as PaperSide[]).filter(isFolded);
  const singles = positions.filter((p) => !isFolded(p.side));

  // another symbol, or the replay started / left (another account): the order being drawn is dropped
  useEffect(() => { setDraft(null); setPlacing(false); }, [symbol.ticker, replayOn, setDraft, setPlacing]);
  // placing an order puts the drawing tools away
  useEffect(() => { if (placing) useStore.getState().setActiveTool('cursor'); }, [placing]);
  // and picking a drawing tool stops placing
  useEffect(() => { if (activeTool !== 'cursor') setPlacing(false); }, [activeTool, setPlacing]);

  // the quantity is the one of the order ticket and the quick buttons
  useEffect(() => { setQty((q) => (parseFloat(q.replace(',', '.')) === paperQty ? q : String(paperQty))); }, [paperQty]);
  const changeQty = (v: string) => {
    setQty(v);
    const q = parseFloat(v.replace(',', '.'));
    if (q > 0) useChartUi.getState().setPaperQty(q);
  };

  // order ticket in limit or stop mode: a line follows the mouse, a click (not a
  // drag, which pans the chart) puts the order there
  const aimRule = panelOpen && ticket.type !== 'market' ? ticket.type : null;
  const aimOff = useChartUi((s) => s.orderAimOff);
  const aimOn = aimRule != null && !aimOff && !draft && !placing && !live && !editor && replayMode !== 'select' && activeTool === 'cursor';
  // the drawing layer reads it: a right-click then drops the placing instead of opening a menu
  useEffect(() => {
    useChartUi.getState().setOrderAiming(aimOn);
    return () => useChartUi.getState().setOrderAiming(false);
  }, [aimOn]);
  useEffect(() => {
    if (!aimOn || !aimRule) { setAim(null); return; }
    const lastNow = () => {
      if (isReplaying()) return currentPrice()?.price ?? null;
      const t = useStore.getState().symbol.ticker;
      return useQuotes.getState().quotes[t]?.last ?? lastPriceOf(t);
    };
    // the price under the mouse, on the main pane and not over the chart's own buttons
    const pointUnder = (ev: MouseEvent): { price: number; x: number } | null => {
      const box = rootRef.current?.closest('.chart-container');
      const eng = engine.current;
      const t = ev.target as HTMLElement | null;
      if (!box || !t || !eng.mainSeries || !eng.chart || !box.contains(t)) return null;
      if (t.closest('.chart-ui, .draw-float-toolbar-wrap, .draw-context-menu, .draw-text-editor')) return null;
      const r = box.getBoundingClientRect();
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      if (x < 0 || y < 0 || x >= eng.chart.paneSize(0).width || y >= (eng.chart.panes()[0]?.getHeight() ?? 0)) return null;
      const p = eng.mainSeries.coordinateToPrice(y);
      return p == null ? null : { price: Number(p.toFixed(eng.precision)), x };
    };
    const priceUnder = (ev: MouseEvent) => pointUnder(ev)?.price ?? null;
    let down: { x: number; y: number } | null = null;
    const onMove = (ev: MouseEvent) => {
      const p = pointUnder(ev);
      setAim((a) => (a?.price === p?.price && a?.x === p?.x ? a : p));
    };
    // a press on a drawing is swallowed by the drawing layer and never gets here
    const onDown = (ev: MouseEvent) => {
      down = ev.button === 0 && !ev.ctrlKey && !ev.metaKey && priceUnder(ev) != null ? { x: ev.clientX, y: ev.clientY } : null;
    };
    const onUp = (ev: MouseEvent) => {
      const d0 = down;
      down = null;
      if (!d0 || ev.button !== 0 || Math.hypot(ev.clientX - d0.x, ev.clientY - d0.y) > 4) return;
      const p = priceUnder(ev);
      if (p == null) return;
      const prec2 = engine.current.precision;
      const side = sideFor(aimRule, p, lastNow(), useChartUi.getState().orderTicket.side);
      setDraft(newDraft(side, p, (v) => Number(v.toFixed(prec2)), aimRule));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      setAim(null);
    };
  }, [aimOn, aimRule, engine, setDraft]);

  // Échap (like a right-click on the chart) drops the order being placed
  useEffect(() => {
    if (!placing && !draft && !aimOn) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') useChartUi.getState().cancelOrderMode(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing, draft, aimOn]);

  // the handles follow the chart's scrolling and zooming
  useEffect(() => {
    let raf = 0;
    let prev = '';
    const loop = () => {
      const eng = engine.current;
      const s = eng.mainSeries;
      const chart = eng.chart;
      if (s && chart) {
        const r = chart.timeScale().getVisibleLogicalRange();
        const sig = `${s.coordinateToPrice(0)}|${s.coordinateToPrice(100)}|${chart.paneSize(0).width}|${chart.panes()[0]?.getHeight()}|${r?.from}|${r?.to}`;
        if (sig !== prev) { prev = sig; setFrame((n) => n + 1); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const at = (key: string, price: number | undefined) => (live && live.key === key ? live.price : price);

  // ---------- the lines (drawn by the chart, with their price on the axis; the labels are ours) ----------
  const lines: Line[] = [];
  const push = (key: string, price: number | undefined, color: string, style: LineStyle, axisOnly = false) => {
    if (price != null && Number.isFinite(price)) lines.push({ key, price, color, style, title: '', axisOnly });
  };
  for (const side of foldedSides) {
    const list = sideList(side);
    push(`grp:${side}:entry`, avgEntry(list), sideColor(side), LineStyle.Solid, true);
    for (const l of levelsOf(side, list, 'sl')) push(`grp:${side}:sl:${l.tag}`, l.price, RED, LineStyle.Dashed);
    for (const l of levelsOf(side, list, 'tp')) push(`grp:${side}:tp:${l.tag}`, l.price, GREEN, LineStyle.Dashed);
  }
  for (const p of singles) {
    push(`pos:${p.id}:entry`, p.entry, sideColor(p.side), LineStyle.Solid, true);
    push(`pos:${p.id}:sl`, at(`pos:${p.id}:sl`, p.sl), RED, LineStyle.Dashed);
    push(`pos:${p.id}:tp`, at(`pos:${p.id}:tp`, p.tp), GREEN, LineStyle.Dashed);
  }
  for (const o of orders) {
    const moved = orderMove(o);
    push(`ord:${o.id}:price`, moved.price, sideColor(o.side), LineStyle.Dotted);
    push(`ord:${o.id}:sl`, moved.sl, RED, LineStyle.Dotted);
    push(`ord:${o.id}:tp`, moved.tp, GREEN, LineStyle.Dotted);
  }
  const d = draft ? draftMove(draft) : null;
  if (d) {
    push('draft:entry', d.entry, sideColor(d.side), LineStyle.Solid);
    push('draft:sl', d.sl, RED, LineStyle.Solid);
    push('draft:tp', d.tp, GREEN, LineStyle.Solid);
  }
  const linesKey = lines.map((l) => `${l.key}=${l.price}:${l.color}:${l.axisOnly ? 1 : 0}`).join('|');

  useEffect(() => {
    const s = engine.current.mainSeries;
    if (!s) return;
    for (const l of linesRef.current) { try { s.removePriceLine(l); } catch { /* series replaced */ } }
    linesRef.current = lines.map((l) => s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style, lineVisible: !l.axisOnly, axisLabelVisible: true, title: l.title }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, seriesGen]);
  useEffect(() => () => {
    const s = engine.current.mainSeries;
    for (const l of linesRef.current) { try { s?.removePriceLine(l); } catch { /* chart gone */ } }
  }, [engine]);

  // the stops (or targets) of folded positions, one line per price; while one is
  // dragged it shows where it is, and "Ajouter stop" dragged sets all of them there
  function levelsOf(side: PaperSide, list: PaperPosition[], field: 'sl' | 'tp'): Level[] {
    const by = new Map<number, PaperPosition[]>();
    for (const p of list) { const v = p[field]; if (v != null) by.set(v, [...(by.get(v) ?? []), p]); }
    const levels: Level[] = [...by].map(([v, ps]) => ({ tag: String(v), price: v, list: ps }));
    const prefix = `grp:${side}:${field}:`;
    if (!live || !live.key.startsWith(prefix)) return levels;
    const tag = live.key.slice(prefix.length);
    return tag === 'all' ? [{ tag, price: live.price, list }] : levels.map((l) => (l.tag === tag ? { ...l, price: live.price } : l));
  }

  // an order dragged by its price line carries its stop and target along
  function orderMove(o: PaperOrder) {
    if (!live || !live.key.startsWith(`ord:${o.id}:`)) return { price: o.price, type: o.type, sl: o.sl, tp: o.tp };
    if (live.key.endsWith(':price')) {
      const dv = live.price - o.price;
      return { price: live.price, type: orderType(o.side, live.price, last), sl: o.sl != null ? round(o.sl + dv) : undefined, tp: o.tp != null ? round(o.tp + dv) : undefined };
    }
    return { price: o.price, type: o.type, sl: live.key.endsWith(':sl') ? live.price : o.sl, tp: live.key.endsWith(':tp') ? live.price : o.tp };
  }
  function draftMove(dr: Draft): Draft {
    if (!live || !live.key.startsWith('draft:')) return dr;
    if (live.key === 'draft:entry') return moveEntry(dr, live.price, last, round);
    return live.key === 'draft:sl' ? { ...dr, sl: live.price } : { ...dr, tp: live.price };
  }

  if (!series || !e.chart) return null;
  const chart = e.chart;
  const plotW = chart.paneSize(0).width;
  const paneH = chart.panes()[0]?.getHeight() ?? 0;
  const yOf = (price: number | undefined) => {
    if (price == null) return null;
    const y = series.priceToCoordinate(price);
    return y == null || y < 0 || y > paneH ? null : y;
  };
  // x of the bar a position was opened on (the left edge when older than the history loaded)
  const barX = (ms: number) => {
    const idx = indexAtOrBefore(e.candles, Math.floor(ms / 1000));
    if (idx < 0) return 0;
    const x = chart.timeScale().logicalToCoordinate(idx as Logical);
    return x == null ? 0 : Math.max(0, Math.min(plotW, x));
  };
  // Positions' lines, drawn here from their bar to the right edge (the chart only
  // shows their price on the axis). `lineFrom`: where a line starts, for its hover strip.
  type Seg = { key: string; x: number; y: number; w?: number; h?: number; color: string; cls: string };
  const segs: Seg[] = [];
  const lineFrom = new Map<string, number>();
  const rawY = (price: number) => series.priceToCoordinate(price);
  const hLine = (key: string, x0: number, x1: number, price: number, color: string, cls: string) => {
    const y = rawY(price);
    if (y == null || y < 0 || y > paneH || x1 <= x0) return;
    segs.push({ key, x: x0, y, w: x1 - x0, color, cls });
  };
  for (const side of ['long', 'short'] as PaperSide[]) {
    const list = [...sideList(side)].sort((a, b) => a.openedAt - b.openedAt);
    if (!list.length) continue;
    const color = sideColor(side);
    const folded = isFolded(side);
    if (list.length === 1) {
      const x0 = barX(list[0].openedAt);
      hLine(`seg:${list[0].id}`, x0, plotW, list[0].entry, color, 'main');
      lineFrom.set(`pos:${list[0].id}:entry`, x0);
      continue;
    }
    // the average after each entry: a thin step at each one, then the thick line at the current average
    let q = 0, sum = 0;
    const steps = list.map((p) => { q += p.qty; sum += p.entry * p.qty; return { x: barX(p.openedAt), avg: sum / q }; });
    for (let k = 0; k + 1 < steps.length; k++) {
      const a = steps[k], b = steps[k + 1];
      hLine(`stair:${side}:${k}`, a.x, b.x, a.avg, color, 'stair');
      const ya = rawY(a.avg), yb = rawY(b.avg);
      if (ya != null && yb != null && b.x > 0 && b.x < plotW) {
        const top = Math.max(0, Math.min(ya, yb)), bottom = Math.min(paneH, Math.max(ya, yb));
        if (bottom > top) segs.push({ key: `stairv:${side}:${k}`, x: b.x, y: top, h: bottom - top, color, cls: 'stair v' });
      }
    }
    const last = steps[steps.length - 1];
    hLine(`avg:${side}`, steps[0].x, plotW, last.avg, color, 'main');
    if (folded) lineFrom.set(`grp:${side}:entry`, steps[0].x);
    // detailed: each position's own thin line from its bar
    else list.forEach((p, i) => { hLine(`seg:${p.id}`, steps[i].x, plotW, p.entry, color, 'one'); lineFrom.set(`pos:${p.id}:entry`, steps[i].x); });
  }

  const priceAt = (clientY: number, el: HTMLElement) => {
    const top = el.closest('.chart-container')!.getBoundingClientRect().top;
    const p = series.coordinateToPrice(clientY - top);
    return p == null ? null : round(p);
  };
  // (replay: the balance, in euros)
  const equity = replayOn ? paper.balance : paper.balance + paper.positions.reduce((sum, p) => {
    const q = quotes[p.symbol.ticker]?.last;
    return q == null ? sum : sum + (q - p.entry) * p.qty * sign(p.side);
  }, 0);

  // ---------- dragging a line ----------
  // stops stay on the losing side and targets on the winning side (of the
  // current price for a position, of the entry for an order)
  function clampFor(g: Grab, price: number): number {
    if (g.kind === 'draft') {
      const dr = draft!;
      if (g.field === 'entry') return price;
      const s = sign(dr.side);
      return g.field === 'sl' ? (s > 0 ? Math.min(price, dr.entry - tick) : Math.max(price, dr.entry + tick))
        : (s > 0 ? Math.max(price, dr.entry + tick) : Math.min(price, dr.entry - tick));
    }
    if (g.kind === 'pos' || g.kind === 'group') {
      const p = g.kind === 'pos' ? positions.find((x) => x.id === g.id) : sideList(g.side)[0];
      if (!p) return price;
      const ref = last ?? p.entry;
      const s = sign(p.side);
      return g.field === 'sl' ? (s > 0 ? Math.min(price, ref - tick) : Math.max(price, ref + tick))
        : (s > 0 ? Math.max(price, ref + tick) : Math.min(price, ref - tick));
    }
    const o = orders.find((x) => x.id === g.id);
    if (!o || g.field === 'price') return price;
    const s = sign(o.side);
    return g.field === 'sl' ? (s > 0 ? Math.min(price, o.price - tick) : Math.max(price, o.price + tick))
      : (s > 0 ? Math.max(price, o.price + tick) : Math.min(price, o.price - tick));
  }

  // `onClick`: what a press without moving does (the +SL / +TP buttons put the line at its default)
  function startDrag(g: Grab, ev: React.MouseEvent, onClick?: () => void) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = ev.currentTarget as HTMLElement;
    const key = grabKey(g);
    const y0 = ev.clientY;
    let cur: number | null = null;
    const onMove = (m: MouseEvent) => {
      if (cur == null && Math.abs(m.clientY - y0) < 3) return;
      const p = priceAt(m.clientY, el);
      if (p == null) return;
      cur = round(clampFor(g, p));
      setLive({ key, price: cur });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setLive(null);
      if (cur == null) { onClick?.(); return; }
      if (g.kind === 'draft') { const dr = useChartUi.getState().orderDraft; if (dr) setDraft(applyDraft(dr, g.field, cur)); }
      else if (g.kind === 'pos') acct.modify(g.id, { [g.field]: cur });
      else if (g.kind === 'group') {
        for (const p of acct.paper().positions) {
          if (p.symbol.ticker === symbol.ticker && p.side === g.side && (g.from == null || p[g.field] === g.from)) acct.modify(p.id, { [g.field]: cur });
        }
      } else {
        const o = acct.paper().orders.find((x) => x.id === g.id);
        if (!o) return;
        if (g.field === 'price') {
          const dv = cur - o.price;
          // moved across the price, a limit order becomes a stop order (and back)
          acct.modifyOrder(o.id, { price: cur, type: orderType(o.side, cur, last), sl: o.sl != null ? round(o.sl + dv) : undefined, tp: o.tp != null ? round(o.tp + dv) : undefined });
        } else acct.modifyOrder(o.id, { [g.field]: cur });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function applyDraft(dr: Draft, field: 'entry' | 'sl' | 'tp', v: number): Draft {
    return field === 'entry' ? moveEntry(dr, v, last, round) : { ...dr, [field]: v };
  }

  // ---------- drawing a new order: press on the entry, drag to the stop ----------
  function startPlacing(ev: React.MouseEvent) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = ev.currentTarget as HTMLElement;
    const entry = priceAt(ev.clientY, el);
    if (entry == null) return;
    const y0 = ev.clientY;
    let moved = false;
    const make = (sl: number): Draft => {
      const side: PaperSide = sl < entry ? 'long' : 'short';
      return { side, entry, sl, tp: round(entry + 2 * (entry - sl)) };
    };
    const onMove = (m: MouseEvent) => {
      if (Math.abs(m.clientY - y0) < 4) return;
      moved = true;
      const sl = priceAt(m.clientY, el);
      if (sl != null && sl !== entry) setDraft(make(sl));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setPlacing(false);
      // a plain click: a limit order on that side of the price, stop 1 % away
      if (!moved) setDraft(newDraft(last == null || entry <= last ? 'long' : 'short', entry, round));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function place() {
    if (!d) return;
    const q = parseFloat(qty.replace(',', '.'));
    const ui = useChartUi.getState();
    if (!(q > 0)) { ui.showToast('Quantité invalide'); return; }
    const type = orderType(d.side, d.entry, last);
    acct.placeOrder({ symbol, side: d.side, qty: q, type, price: d.entry, sl: d.sl, tp: d.tp });
    ui.setPaperQty(q);
    ui.showToast(`${replayOn ? 'Replay : ' : ''}${typeLabel(d.side, type)} placé : ${q} ${symbol.ticker} à ${formatPrice(d.entry, prec)}`);
    setDraft(null);
    if (replayOn) useStore.getState().setBottomDock({ tab: 'replay' });
  }

  // stop / target added from a handle: 1 % away, the target at 2 R when there is a stop
  const defaultSl = (side: PaperSide, from: number) => round(from * (1 - sign(side) * 0.01));
  const defaultTp = (side: PaperSide, entry: number, sl?: number) => round(sl != null ? entry + 2 * (entry - sl) : entry * (1 + sign(side) * 0.02));

  // while the replay's start bar is being picked the chart shows the whole history
  if (replayMode === 'select') return null;

  // A line's label, laid out like ProRealTime: a ↕ handle when the line can be
  // moved, the text, ✖, and on hover "Ajouter stop" / "Ajouter limite" to drag
  // out of it. A line that can be moved is also grabbed anywhere along it.
  type Adds = { up?: React.ReactNode; down?: React.ReactNode };
  // labels of lines closer than a label's height sit side by side instead of on top of each other
  // (positions and orders first, so that theirs stay nearest the axis, with their "−", ✖ and add buttons)
  const laneOf = new Map<string, number>();
  const laneYs: number[][] = [];
  const placed: { key: string; y: number; main: boolean }[] = [];
  for (const l of lines) { const y = yOf(l.price); if (y != null) placed.push({ key: l.key, y, main: /:(entry|price)$/.test(l.key) }); }
  for (const l of placed.sort((a, b) => Number(b.main) - Number(a.main) || a.y - b.y)) {
    let lane = laneYs.findIndex((ys) => ys.every((y) => Math.abs(l.y - y) >= 22));
    if (lane < 0) lane = laneYs.push([]) - 1;
    laneYs[lane].push(l.y);
    laneOf.set(l.key, lane);
  }
  const hoverOn = (key: string) => { clearTimeout(hoverTimer.current); setHoverKey(key); };
  const hoverOff = () => { clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => setHoverKey(null), 300); };
  // `dbl`: what a double-click on the line or its label opens
  // `lead`: the "−" / "+" that folds / unfolds a side's positions
  const pill = (key: string, price: number | undefined, color: string, body: React.ReactNode, grab?: Grab, extra?: React.ReactNode, adds?: Adds, dbl?: () => void, lead?: React.ReactNode) => {
    const y = yOf(price);
    if (y == null) return null;
    const onDbl = dbl ? (ev: React.MouseEvent) => { ev.stopPropagation(); dbl(); } : undefined;
    return (
      <Fragment key={key}>
        {(grab || adds) && !placing && (
          <div
            className={`ct-hit chart-ui ${grab ? 'grab' : ''}`} style={{ top: y, left: lineFrom.get(key) ?? 0 }}
            onMouseEnter={() => hoverOn(key)} onMouseLeave={hoverOff}
            onMouseDown={grab ? (ev) => startDrag(grab, ev) : undefined} onDoubleClick={onDbl}
          />
        )}
        <div
          className={`ct-pill chart-ui ${grab ? 'grab' : ''} ${hoverKey === key ? 'hover' : ''}`}
          style={{ top: y, right: 8 + (laneOf.get(key) ?? 0) * 190, borderColor: color, '--c': color } as React.CSSProperties}
          title={dbl ? 'Double-clic pour modifier' : undefined}
          onMouseEnter={() => hoverOn(key)} onMouseLeave={hoverOff}
          onMouseDown={grab ? (ev) => startDrag(grab, ev) : undefined} onDoubleClick={onDbl}
        >
          {lead}
          {grab && <span className="ct-handle" aria-hidden="true">↕</span>}
          <span className="ct-text">{body}</span>
          {extra}
          {adds?.up && <div className="ct-add up">{adds.up}</div>}
          {adds?.down && <div className="ct-add down">{adds.down}</div>}
        </div>
      </Fragment>
    );
  };
  const btn = (label: string, title: string, onClick: () => void, cls = '') => (
    <button className={`ct-btn ${cls}`} title={title} onMouseDown={(ev) => ev.stopPropagation()} onClick={(ev) => { ev.stopPropagation(); onClick(); }}>{label}</button>
  );
  // dragged out of the line to where the stop or target goes (an existing one moves there);
  // a plain click puts a missing one at its default
  const addBtn = (label: string, title: string, g: Grab, onClick?: () => void) => (
    <button className="ct-addbtn" title={title} onMouseDown={(ev) => startDrag(g, ev, onClick)}>
      <span className="ct-handle" aria-hidden="true">↕</span>{label}
    </button>
  );
  // both always offered: "Ajouter stop" on the losing side of the line, "Ajouter limite" (the target) on the winning side
  const addsFor = (side: PaperSide, g: { stop: Grab; limit: Grab }, has: { stop: boolean; limit: boolean }, defaults: { stop: () => void; limit: () => void }): Adds => {
    const stop = addBtn('Ajouter stop', has.stop ? 'Glissez : le stop se déplace là où vous lâchez' : 'Glissez jusqu’au stop voulu (un clic le met à 1 %)', g.stop, has.stop ? undefined : defaults.stop);
    const limit = addBtn('Ajouter limite', has.limit ? 'Glissez : l’objectif se déplace là où vous lâchez' : 'Glissez jusqu’à l’objectif voulu (un clic le met à 2 R)', g.limit, has.limit ? undefined : defaults.limit);
    return side === 'long' ? { up: limit, down: stop } : { up: stop, down: limit };
  };
  // shaded risk (entry to stop) and gain (entry to target)
  const zones = (key: string, entry: number, sl: number | undefined, tp: number | undefined) => {
    const ye = yOf(entry), ys = yOf(sl), yt = yOf(tp);
    const box = (a: number | null, b: number | null) => (a == null || b == null ? null : { top: Math.min(a, b), height: Math.abs(a - b) });
    const risk = box(ye, ys), gain = box(ye, yt);
    return (
      <Fragment key={key}>
        {risk && <div className="ct-zone risk" style={risk} />}
        {gain && <div className="ct-zone gain" style={gain} />}
      </Fragment>
    );
  };

  const st = acct;
  const pnlAt = (side: PaperSide, entry: number, price: number, q: number) => (price - entry) * q * sign(side);
  // on the replay account in euros, costs included, as it books them
  const pnlNum = (side: PaperSide, entry: number, price: number, q: number) => (replayOn ? tradePnlEur({ symbol, side, qty: q, entry }, price) : pnlAt(side, entry, price, q));
  // gains and losses in euros (at the live EURxxx rate); in the symbol's currency until that rate is in
  const cur = quoteCurrency(symbol, quotes);
  const eurRate = eurPerUnit(cur, quotes);
  const cash = (v: number) => (eurRate != null ? `${money(v * eurRate)} €` : `${money(v)} ${currencySign(cur)}`);
  const pnlTag = (v: number) => <b className={v >= 0 ? 'up' : 'down'}>{cash(v)}</b>;
  // what a trade gains / loses at that price, in euros
  const pnlShow = (v: number) => (replayOn ? <b className={v >= 0 ? 'up' : 'down'}>{money(v)} €</b> : pnlTag(v));
  const pnlOut = (side: PaperSide, entry: number, price: number, q: number) => pnlShow(pnlNum(side, entry, price, q));
  const pnlSum = (list: PaperPosition[], price: number) => pnlShow(list.reduce((sum, p) => sum + pnlNum(p.side, p.entry, price, p.qty), 0));
  const foldBtn = (side: PaperSide, folded: boolean) => btn(folded ? '+' : '−',
    folded ? `Détailler les ${sideList(side).length} positions` : `Regrouper les ${sideList(side).length} positions ${side === 'long' ? 'acheteuses' : 'vendeuses'} en une ligne`,
    () => toggleFold(side), 'fold');
  const px = (v: number) => formatPrice(v, prec);
  const draftQty = parseFloat(qty.replace(',', '.')) || 0;

  return (
    <div ref={rootRef} className={`chart-trading ${replayOn ? 'replay' : ''}`} style={{ width: plotW, height: paneH }}>
      {placing && (
        <div className="ct-capture chart-ui" onMouseDown={startPlacing} />
      )}
      {aimOn && aimRule && aim != null && (() => {
        const y = yOf(aim.price);
        if (y == null) return null;
        const side = sideFor(aimRule, aim.price, last, ticket.side);
        const color = side === 'long' ? BLUE : RED;
        // the label sits above the line, next to the mouse (kept inside the chart)
        return (
          <div className="ct-aim" style={{ top: y, borderTopColor: color }}>
            <span className="ct-aim-tag" style={{ background: color, left: Math.min(aim.x + 14, Math.max(0, plotW - 340)) }}>
              {typeLabel(side, aimRule)} {formatPrice(aim.price, prec)} · clic : placer · clic droit / Échap : arrêter
            </span>
          </div>
        );
      })()}
      {placing && !draft && (
        <div className="ct-hint chart-ui">
          Cliquez sur le prix d’entrée puis glissez jusqu’au stop · Échap ou clic droit pour annuler
          {btn('Annuler', 'Annuler', () => setPlacing(false), 'ghost')}
        </div>
      )}

      {segs.map((sg) => (
        <div
          key={sg.key} className={`ct-seg ${sg.cls}`}
          style={sg.h != null ? { left: sg.x, top: sg.y, height: sg.h, background: sg.color } : { left: sg.x, top: sg.y, width: sg.w, background: sg.color }}
        />
      ))}
      {d && zones('draft:zones', d.entry, d.sl, d.tp)}
      {orders.map((o) => { const m = orderMove(o); return zones(`ord:${o.id}:zones`, m.price, m.sl, m.tp); })}

      {foldedSides.map((side) => {
        const list = sideList(side);
        const avg = avgEntry(list);
        const sls = levelsOf(side, list, 'sl');
        const tps = levelsOf(side, list, 'tp');
        const grab = (field: 'sl' | 'tp', from?: number): Grab => ({ kind: 'group', side, field, from });
        const setAll = (patch: { sl?: number; tp?: number }) => { for (const p of list) st.modify(p.id, patch); };
        const level = (field: 'sl' | 'tp', l: Level) => {
          const from = l.tag === 'all' ? undefined : Number(l.tag);
          return pill(`grp:${side}:${field}:${l.tag}`, l.price, field === 'sl' ? RED : GREEN,
            <>{field === 'sl' ? 'Stop' : 'Limite'}{l.list.length < list.length && <> ({qtyText(totalQty(l.list))})</>} {px(l.price)} {pnlSum(l.list, l.price)}</>, grab(field, from),
            btn('✖', field === 'sl' ? 'Retirer le stop' : 'Retirer l’objectif', () => { for (const p of l.list) st.modify(p.id, { [field]: undefined }); }, 'x'), undefined,
            from == null ? undefined : () => setEditor({ kind: 'level', target: 'grp', id: side, field, from }));
        };
        return [
          pill(`grp:${side}:entry`, avg, sideColor(side), <>{sideLetter(side)}: {qtyText(totalQty(list))} @ {px(avg)}{last != null && <> {pnlSum(list, last)}</>}</>, undefined,
            btn('✖', `Fermer les ${list.length} positions au marché`, () => { if (last != null) for (const p of list) st.close(p.id, last, 'manuel'); }, 'x'),
            addsFor(side, { stop: grab('sl'), limit: grab('tp') }, { stop: sls.length > 0, limit: tps.length > 0 }, {
              stop: () => { const ref = last ?? avg; setAll({ sl: defaultSl(side, side === 'long' ? Math.min(avg, ref) : Math.max(avg, ref)) }); },
              limit: () => setAll({ tp: defaultTp(side, avg, sls.length === 1 ? sls[0].price : undefined) }),
            }), undefined, foldBtn(side, true)),
          ...sls.map((l) => level('sl', l)),
          ...tps.map((l) => level('tp', l)),
        ];
      })}

      {singles.map((p) => {
        const sl = at(`pos:${p.id}:sl`, p.sl);
        const tp = at(`pos:${p.id}:tp`, p.tp);
        const stopGrab: Grab = { kind: 'pos', id: p.id, field: 'sl' };
        const limitGrab: Grab = { kind: 'pos', id: p.id, field: 'tp' };
        return [
          pill(`pos:${p.id}:entry`, p.entry, sideColor(p.side), <>{sideLetter(p.side)}: {p.qty} @ {px(p.entry)}{last != null && <> {pnlOut(p.side, p.entry, last, p.qty)}</>}</>, undefined,
            btn('✖', 'Fermer la position au marché', () => { if (last != null) st.close(p.id, last, 'manuel'); }, 'x'),
            addsFor(p.side, { stop: stopGrab, limit: limitGrab }, { stop: p.sl != null, limit: p.tp != null }, {
              stop: () => {
                const ref = last ?? p.entry;
                st.modify(p.id, { sl: defaultSl(p.side, p.side === 'long' ? Math.min(p.entry, ref) : Math.max(p.entry, ref)) });
              },
              limit: () => st.modify(p.id, { tp: defaultTp(p.side, p.entry, p.sl) }),
            }), undefined, sideList(p.side).length > 1 ? foldBtn(p.side, false) : undefined),
          pill(`pos:${p.id}:sl`, sl, RED, <>Stop {sl != null && <>{px(sl)} {pnlOut(p.side, p.entry, sl, p.qty)}</>}</>, stopGrab,
            btn('✖', 'Retirer le stop', () => st.modify(p.id, { sl: undefined }), 'x'), undefined,
            () => setEditor({ kind: 'level', target: 'pos', id: p.id, field: 'sl' })),
          pill(`pos:${p.id}:tp`, tp, GREEN, <>Limite {tp != null && <>{px(tp)} {pnlOut(p.side, p.entry, tp, p.qty)}</>}</>, limitGrab,
            btn('✖', 'Retirer l’objectif', () => st.modify(p.id, { tp: undefined }), 'x'), undefined,
            () => setEditor({ kind: 'level', target: 'pos', id: p.id, field: 'tp' })),
        ];
      })}

      {orders.map((o) => {
        const m = orderMove(o);
        const stopGrab: Grab = { kind: 'order', id: o.id, field: 'sl' };
        const limitGrab: Grab = { kind: 'order', id: o.id, field: 'tp' };
        return [
          pill(`ord:${o.id}:price`, m.price, sideColor(o.side), <>{orderTag(o.side, m.type)} {o.qty} @ {px(m.price)}</>, { kind: 'order', id: o.id, field: 'price' },
            btn('✖', 'Annuler l’ordre', () => st.cancelOrder(o.id), 'x'),
            addsFor(o.side, { stop: stopGrab, limit: limitGrab }, { stop: o.sl != null, limit: o.tp != null }, {
              stop: () => st.modifyOrder(o.id, { sl: defaultSl(o.side, o.price) }),
              limit: () => st.modifyOrder(o.id, { tp: defaultTp(o.side, o.price, o.sl) }),
            }),
            () => setEditor({ kind: 'qty', id: o.id })),
          pill(`ord:${o.id}:sl`, m.sl, RED, <>Stop {m.sl != null && <>{px(m.sl)} {pnlOut(o.side, m.price, m.sl, o.qty)}</>}</>, stopGrab,
            btn('✖', 'Retirer le stop', () => st.modifyOrder(o.id, { sl: undefined }), 'x'), undefined,
            () => setEditor({ kind: 'level', target: 'ord', id: o.id, field: 'sl' })),
          pill(`ord:${o.id}:tp`, m.tp, GREEN, <>Limite {m.tp != null && <>{px(m.tp)} {pnlOut(o.side, m.price, m.tp, o.qty)}</>}</>, limitGrab,
            btn('✖', 'Retirer l’objectif', () => st.modifyOrder(o.id, { tp: undefined }), 'x'), undefined,
            () => setEditor({ kind: 'level', target: 'ord', id: o.id, field: 'tp' })),
        ];
      })}

      {d && (
        <>
          {pill('draft:entry', d.entry, sideColor(d.side), <>{orderTag(d.side, orderType(d.side, d.entry, last))} {draftQty} @ {px(d.entry)}</>, { kind: 'draft', field: 'entry' }, undefined,
            addsFor(d.side, { stop: { kind: 'draft', field: 'sl' }, limit: { kind: 'draft', field: 'tp' } }, { stop: true, limit: true }, { stop: () => {}, limit: () => {} }))}
          {pill('draft:sl', d.sl, RED, <>Stop {px(d.sl)}{draftQty > 0 && <> {pnlOut(d.side, d.entry, d.sl, draftQty)}</>}</>, { kind: 'draft', field: 'sl' },
            undefined, undefined, () => setEditor({ kind: 'level', target: 'draft', id: 'draft', field: 'sl' }))}
          {pill('draft:tp', d.tp, GREEN, <>Limite {px(d.tp)} · {(Math.abs(d.tp - d.entry) / Math.abs(d.entry - d.sl)).toFixed(1).replace('.', DEC)} R</>, { kind: 'draft', field: 'tp' },
            undefined, undefined, () => setEditor({ kind: 'level', target: 'draft', id: 'draft', field: 'tp' }))}
          <div className="ct-ticket chart-ui" onMouseDown={(ev) => ev.stopPropagation()}>
            <b className={d.side === 'long' ? 'buy' : 'sell'}>{typeLabel(d.side, orderType(d.side, d.entry, last))}</b>
            <label>Qté <QtyStepper value={qty} onChange={changeQty} /></label>
            {btn('1 %', 'Quantité qui risque 1 % du compte jusqu’au stop', () => changeQty(String(qtyForRisk(equity, 1, d.entry, d.sl))), 'ghost')}
            {btn('0,5 %', 'Quantité qui risque 0,5 % du compte jusqu’au stop', () => changeQty(String(qtyForRisk(equity, 0.5, d.entry, d.sl))), 'ghost')}
            {draftQty > 0 && (
              <span className="ct-risk">
                risque <b className="down">{cash(-Math.abs(d.entry - d.sl) * draftQty)}</b> ({((Math.abs(d.entry - d.sl) * draftQty / equity) * 100).toFixed(2).replace('.', DEC)} %)
                · gain <b className="up">{cash(Math.abs(d.tp - d.entry) * draftQty)}</b>
              </span>
            )}
            {btn('Placer l’ordre', 'Envoyer l’ordre au compte virtuel', place, d.side === 'long' ? 'buy' : 'sell')}
            {btn('Annuler', 'Effacer cet ordre (Échap)', () => setDraft(null), 'ghost')}
          </div>
        </>
      )}

      {editor && (() => {
        const rate = eurRate ?? 1;
        const unit = eurRate != null ? '€' : currencySign(cur);
        const close = () => setEditor(null);
        // under the line's label, or above it near the bottom of the chart
        const placeAt = (price: number, key: string) => {
          const y = yOf(price);
          if (y == null) return null;
          const right = 8 + (laneOf.get(key) ?? 0) * 190;
          return y > paneH - 190 ? { bottom: paneH - y + 14, right } : { top: y + 14, right };
        };
        if (editor.kind === 'qty') {
          const o = orders.find((x) => x.id === editor.id);
          const at = o && placeAt(o.price, `ord:${o.id}:price`);
          if (!o || !at) return null;
          return (
            <QtyEditor
              key={`qty:${o.id}`} at={at} title={`${orderTag(o.side, o.type)} @ ${px(o.price)}`} qty={o.qty} unit={unit}
              riskPerUnit={o.sl != null ? Math.abs(o.price - o.sl) * rate : null}
              gainPerUnit={o.tp != null ? Math.abs(o.tp - o.price) * rate : null}
              onSave={(q) => st.modifyOrder(o.id, { qty: q })} onClose={close}
            />
          );
        }
        let src: { side: PaperSide; entry: number; qty: number; sl?: number; tp?: number } | null = null;
        let save: (patch: { sl?: number; tp?: number }) => void = () => {};
        let keyOf = 'draft';
        let laneKey = '';
        if (editor.target === 'grp') {
          const side = editor.id as PaperSide;
          const field = editor.field;
          const list = sideList(side).filter((p) => p[field] === editor.from);
          if (list.length) {
            // the other level, when those positions share it
            const others = new Set(list.map((p) => (field === 'sl' ? p.tp : p.sl)));
            const other = others.size === 1 ? [...others][0] : undefined;
            src = { side, entry: avgEntry(list), qty: Number(qtyText(totalQty(list))), sl: field === 'sl' ? editor.from : other, tp: field === 'tp' ? editor.from : other };
            save = (patch) => { for (const p of list) st.modify(p.id, patch); };
            keyOf = `grp:${side}`;
            laneKey = `grp:${side}:${field}:${String(editor.from)}`;
          }
        } else if (editor.target === 'pos') {
          const p = positions.find((x) => x.id === editor.id);
          if (p) { src = { side: p.side, entry: p.entry, qty: p.qty, sl: p.sl, tp: p.tp }; save = (patch) => st.modify(p.id, patch); keyOf = `pos:${p.id}`; }
        } else if (editor.target === 'ord') {
          const o = orders.find((x) => x.id === editor.id);
          if (o) { src = { side: o.side, entry: o.price, qty: o.qty, sl: o.sl, tp: o.tp }; save = (patch) => st.modifyOrder(o.id, patch); keyOf = `ord:${o.id}`; }
        } else if (draft) {
          const dr = draft;
          src = { side: dr.side, entry: dr.entry, qty: draftQty > 0 ? draftQty : paperQty, sl: dr.sl, tp: dr.tp };
          save = (patch) => setDraft({ ...dr, ...patch });
        }
        const level = src && (editor.field === 'sl' ? src.sl : src.tp);
        const at = src && level != null ? placeAt(level, laneKey || `${keyOf}:${editor.field}`) : null;
        if (!src || !at) return null;
        return (
          <LevelEditor
            key={`${keyOf}:${editor.field}`} at={at} field={editor.field} side={src.side} entry={src.entry} qty={src.qty}
            sl={src.sl} tp={src.tp} rate={rate} unit={unit} prec={prec}
            last={editor.target === 'pos' || editor.target === 'grp' ? last : null} onSave={save} onClose={close}
          />
        );
      })()}
    </div>
  );
}
