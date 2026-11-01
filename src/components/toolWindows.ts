import { useStore, MAIN_KEY, POPOUT_TOOL, type ToolId, type TabChartState } from '../store/store';
import type { IndicatorConfig, Symbol, Timeframe } from '../types';

// A tool page (screener, portfolios, robots...) dragged out of the tabs into a window of its own
// works on the main window's data. It reads the main window's saved state and follows it (each
// time the main window saves), sends its own changes there (the main window keeps them), and what
// would open a chart opens it in the main window.

const CHANNEL = 'tesh-tool-windows';

type Msg =
  | { type: 'patch'; patch: Record<string, unknown> }
  | { type: 'show'; symbol: Symbol }
  | { type: 'goToChart'; symbol?: Symbol }
  | { type: 'chartTab'; symbol: Symbol; tf: Timeframe; indicators: IndicatorConfig[]; extra: TabChartState }
  | { type: 'tool'; tool: ToolId };

// what each window keeps for itself: its tabs, its windows, its theme switch (sent on its own),
// and the symbol (a symbol picked in a tool window is shown on the main window's chart instead)
const OWN = new Set(['tabs', 'activeTabId', 'closedTabs', 'popouts', 'chartLink', 'uiTheme', 'symbol']);

export function sendToMain(msg: Msg) {
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage(msg);
  ch.close();
}

// in a tool window
export function startToolWindow(): () => void {
  if (!POPOUT_TOOL) return () => {};
  let following = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      following = true;
      try { await useStore.persist.rehydrate(); } finally { following = false; }
    }, 250);
  };
  const onStorage = (e: StorageEvent) => { if (e.key === MAIN_KEY) follow(); };
  window.addEventListener('storage', onStorage);
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (following) return;
    const now = s as unknown as Record<string, unknown>, before = prev as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(now)) {
      if (!OWN.has(k) && now[k] !== before[k] && typeof now[k] !== 'function') patch[k] = now[k];
    }
    if (Object.keys(patch).length) sendToMain({ type: 'patch', patch });
    if (s.symbol !== prev.symbol) sendToMain({ type: 'show', symbol: s.symbol });
  });
  return () => { clearTimeout(timer); window.removeEventListener('storage', onStorage); unsubscribe(); };
}

// in the main window: the tool windows' changes and the charts they open
export function startToolWindowHub(actions: {
  showOnChart: (sym: Symbol) => void;
  goToChart: (sym?: Symbol) => void;
  openChartTab: (sym: Symbol, tf: Timeframe, indicators: IndicatorConfig[], extra: TabChartState) => void;
  openTool: (tool: ToolId, inNewTab: boolean) => void;
}): () => void {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (ev: MessageEvent<Msg>) => {
    const m = ev.data;
    if (m.type === 'patch') useStore.setState(m.patch as never);
    else if (m.type === 'show') actions.showOnChart(m.symbol);
    else if (m.type === 'goToChart') actions.goToChart(m.symbol);
    else if (m.type === 'chartTab') actions.openChartTab(m.symbol, m.tf, m.indicators, m.extra);
    else if (m.type === 'tool') actions.openTool(m.tool, true);
  };
  return () => ch.close();
}
