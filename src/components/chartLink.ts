import { useStore, POPOUT_ID, type LinkGroup } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { mainChart } from './mainChart';
import { logicalToTime, timeToLogical } from './chartUtils';
import type { Symbol, Timeframe } from '../types';

// Charts linked across windows, like ProRealTime's "Lier": the main window's chart
// and the detached ones (↗) join a link group for the symbol, the timeframe (and
// the number of bars shown) and the scrolling of the time scale; the charts of a
// group follow each other. One chart is the "principal" one: the watchlist opens
// its symbols there. They talk over a BroadcastChannel.

export const LINK_COLORS: Record<LinkGroup, string> = { 0: '', 1: '#ff9800', 2: '#2962ff' };

const ME = POPOUT_ID ?? 'main';
const CHANNEL = 'tesh-link';

type Msg =
  | { type: 'symbol'; from: string; group: LinkGroup; symbol: Symbol }
  | { type: 'tf'; from: string; group: LinkGroup; tf: Timeframe }
  // the time at the left and right edges of the chart
  | { type: 'range'; from: string; group: LinkGroup; t0: number; t1: number }
  // the number of bars shown
  | { type: 'bars'; from: string; group: LinkGroup; count: number }
  // `from` is now the principal chart (the others stop being it)
  | { type: 'principal'; from: string }
  // a window that started asks which chart is the principal one
  | { type: 'who' }
  // a watchlist click for the principal chart, and its answer
  | { type: 'open'; to: string; symbol: Symbol; key: string }
  | { type: 'opened'; key: string }
  // a chart joined a group: the others of the group send it their symbol / timeframe / view
  | { type: 'ask'; from: string; what: 'symbol' | 'tf' | 'range'; group: LinkGroup };

let channel: BroadcastChannel | null = null;
// the principal chart as last heard (null: not known)
let principalId: string | null = null;
// list clicks sent to another window that answered
const answered = new Set<string>();

// a watchlist (or list) click: the symbol goes to the principal chart, which may be a detached window
export function openFromList(symbol: Symbol) {
  const st = useStore.getState();
  const target = principalId;
  const elsewhere = !st.chartLink.principal && target && target !== ME && st.popouts.some((p) => p.id === target && p.open);
  if (elsewhere && channel) {
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    channel.postMessage({ type: 'open', to: target, symbol, key } satisfies Msg);
    // no answer (the window closed without saying so): opened here after all
    window.setTimeout(() => { if (!answered.delete(key)) takeBack(symbol); }, 600);
    return;
  }
  takeBack(symbol);
}

// no principal chart open elsewhere: this one takes the role back
function takeBack(symbol: Symbol) {
  const st = useStore.getState();
  if (!st.chartLink.principal) st.setChartLink({ principal: true });
  st.setSymbol(symbol);
}

export function startChartLink(): () => void {
  const ch = new BroadcastChannel(CHANNEL);
  channel = ch;
  const post = (m: Msg) => ch.postMessage(m);
  // a change received from another chart is not sent back
  let remote = false;
  const applyRemote = (fn: () => void) => { remote = true; try { fn(); } finally { remote = false; } };

  if (useStore.getState().chartLink.principal) { principalId = ME; post({ type: 'principal', from: ME }); }
  else post({ type: 'who' });

  const unsubscribe = useStore.subscribe((s, prev) => {
    const l = s.chartLink;
    if (l.principal && !prev.chartLink.principal) { principalId = ME; post({ type: 'principal', from: ME }); }
    if (remote) return;
    if (l.symbol && s.symbol.ticker !== prev.symbol.ticker) post({ type: 'symbol', from: ME, group: l.symbol, symbol: s.symbol });
    if (l.tf && s.timeframe !== prev.timeframe) post({ type: 'tf', from: ME, group: l.tf, tf: s.timeframe });
    // joining a group: this chart takes the group's symbol / timeframe / view
    if (l.symbol && l.symbol !== prev.chartLink.symbol) post({ type: 'ask', from: ME, what: 'symbol', group: l.symbol });
    if (l.tf && l.tf !== prev.chartLink.tf) post({ type: 'ask', from: ME, what: 'tf', group: l.tf });
    if (l.scroll && l.scroll !== prev.chartLink.scroll) post({ type: 'ask', from: ME, what: 'range', group: l.scroll });
  });

  // ---------- the time scale: sent when it moves, applied when another chart of the group moves ----------
  let prevKey = '';
  let prevWidth = 0;
  // after a range received, the chart's own move is not sent back
  let quietUntil = 0;
  let loading = false;
  let pending: Extract<Msg, { type: 'range' }> | null = null;
  const engineReady = () => {
    const e = mainChart.engine;
    // the replay drives its own view
    return e?.chart && e.candles.length && useChartUi.getState().replay.mode === 'off' ? e : null;
  };
  const applyRange = (m: Extract<Msg, { type: 'range' }>) => {
    const e = engineReady();
    if (!e) return;
    // older than the history loaded: load it first (the chart pages it in)
    if (m.t0 < e.candles[0].time && mainChart.loadBefore) {
      pending = m;
      if (loading) return;
      loading = true;
      void mainChart.loadBefore(m.t0).finally(() => {
        loading = false;
        const next = pending;
        pending = null;
        const e2 = engineReady();
        if (next && e2) setRange(e2, next);
      });
      return;
    }
    setRange(e, m);
  };
  const setRange = (e: NonNullable<ReturnType<typeof engineReady>>, m: { t0: number; t1: number }) => {
    const a = timeToLogical(e.candles, m.t0), b = timeToLogical(e.candles, m.t1);
    if (a == null || b == null || b - a < 2) return;
    quietUntil = performance.now() + 300;
    e.chart!.timeScale().setVisibleLogicalRange({ from: a, to: b });
  };

  const sendRange = (group: LinkGroup) => {
    const e = engineReady();
    const r = e?.chart!.timeScale().getVisibleLogicalRange();
    if (!e || !r) return;
    const t0 = logicalToTime(e.candles, r.from), t1 = logicalToTime(e.candles, r.to);
    if (t0 != null && t1 != null) post({ type: 'range', from: ME, group, t0, t1 });
  };

  const timer = window.setInterval(() => {
    const l = useStore.getState().chartLink;
    if (!l.scroll && !(l.tf && l.bars)) return;
    const e = engineReady();
    const r = e?.chart!.timeScale().getVisibleLogicalRange();
    if (!e || !r) return;
    const key = `${r.from.toFixed(2)}|${r.to.toFixed(2)}`;
    if (key === prevKey) return;
    prevKey = key;
    const width = r.to - r.from;
    if (performance.now() < quietUntil) { prevWidth = width; return; }
    if (l.scroll) sendRange(l.scroll);
    if (l.tf && l.bars && Math.abs(width - prevWidth) > 0.5) post({ type: 'bars', from: ME, group: l.tf, count: width });
    prevWidth = width;
  }, 60);

  ch.onmessage = (ev: MessageEvent<Msg>) => {
    const m = ev.data;
    const st = useStore.getState();
    const l = st.chartLink;
    switch (m.type) {
      case 'symbol':
        if (m.from !== ME && m.group === l.symbol && m.symbol.ticker !== st.symbol.ticker) applyRemote(() => st.setSymbol(m.symbol));
        break;
      case 'tf':
        if (m.from !== ME && m.group === l.tf && m.tf !== st.timeframe) applyRemote(() => st.setTimeframe(m.tf));
        break;
      case 'range':
        if (m.from !== ME && m.group === l.scroll) applyRange(m);
        break;
      case 'bars': {
        if (m.from === ME || m.group !== l.tf || !l.bars || l.scroll) break;
        const e = engineReady();
        const r = e?.chart!.timeScale().getVisibleLogicalRange();
        if (!e || !r) break;
        // the same number of bars, the right edge kept
        quietUntil = performance.now() + 300;
        e.chart!.timeScale().setVisibleLogicalRange({ from: r.to - m.count, to: r.to });
        break;
      }
      case 'principal':
        principalId = m.from;
        if (m.from !== ME && l.principal) applyRemote(() => st.setChartLink({ principal: false }));
        break;
      case 'who':
        if (l.principal) post({ type: 'principal', from: ME });
        break;
      case 'ask':
        if (m.from === ME) break;
        if (m.what === 'symbol' && m.group === l.symbol) post({ type: 'symbol', from: ME, group: m.group, symbol: st.symbol });
        if (m.what === 'tf' && m.group === l.tf) post({ type: 'tf', from: ME, group: m.group, tf: st.timeframe });
        if (m.what === 'range' && m.group === l.scroll) sendRange(m.group);
        break;
      case 'open':
        // a list click in another window: opened here, and passed on to this chart's group
        if (m.to !== ME) break;
        post({ type: 'opened', key: m.key });
        st.setSymbol(m.symbol);
        break;
      case 'opened':
        answered.add(m.key);
        break;
    }
  };

  return () => {
    unsubscribe();
    clearInterval(timer);
    ch.close();
    if (channel === ch) channel = null;
  };
}
