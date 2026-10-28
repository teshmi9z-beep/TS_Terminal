import { useStore, nextId, comparesOf, TAB_KEYS, type AppTab, type TabChartState, type ToolId, type Workspace } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { INDICATORS } from '../../indicators/registry';
import { capturePopouts, captureWorkspace, openWorkspacePopouts } from '../workspaces';
import type { IndicatorConfig, Symbol, Timeframe } from '../../types';

// Top tabs like TradingView's desktop app: every chart tab is a layout with its own
// chart; the active chart lives in the store, the others wait in their tab.

export const TOOL_LABELS: Record<ToolId, string> = {
  screener: 'Screener d’actions',
  heatmap: 'Carte thermique',
  calendar: 'Calendriers',
  news: 'Flux d’actualités',
  portfolios: 'Portefeuilles',
  yields: 'Courbes de rendement',
  options: 'Options',
  fundamentals: 'Graphiques fondamentaux',
  markets: 'Marchés',
  community: 'Communauté · Indicateurs',
  macro: 'Macro Maps',
  robots: 'Robots de trading',
  data: 'Développeur · Data',
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function snapshotChart(): TabChartState {
  const st = useStore.getState() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of TAB_KEYS) if (st[k] !== undefined) out[k] = st[k];
  return clone(out) as TabChartState;
}

const active = () => {
  const st = useStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId);
};

// a brand-new chart: current symbol and timeframe, volume, like TradingView's new layout
export function freshChart(sym?: Symbol): TabChartState {
  const st = useStore.getState();
  const vol = INDICATORS.VOLUME;
  return {
    symbol: sym ?? st.symbol, timeframe: st.timeframe, layout: 1, freeWindows: [], gridCharts: [], priceScaleMode: 'normal', compares: [],
    chartSettings: st.chartSettings,
    indicators: [{ id: nextId(), type: 'VOLUME', overlay: false, visible: true, ...clone(vol.defaults) }],
    testerRobot: null,
  };
}

// the layout (workspace) of the active chart tab follows its chart, and its detached
// windows while they are open (closing them doesn't take them out of the layout)
export function autosaveLayout() {
  const tab = active();
  if (!tab || tab.kind !== 'chart' || !tab.layoutId) return;
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => w.id === tab.layoutId);
  if (!ws) return;
  const popouts = capturePopouts(ws.id);
  st.upsertWorkspace({ ...ws, main: captureWorkspace(ws.name, ws.id).main, popouts: popouts.length ? popouts : ws.popouts, savedAt: Date.now() });
}

// the layout's detached windows, unless some of them are already open
function openLayoutWindows(ws: Workspace) {
  const st = useStore.getState();
  if (!ws.popouts.length || st.popouts.some((p) => p.open && p.layoutId === ws.id)) return;
  void openWorkspacePopouts(ws.popouts, ws.id);
}

// the active chart tab keeps a copy of its chart, and of a replay under way,
// before another tab takes the store
function stashed(): AppTab[] {
  const st = useStore.getState();
  const r = useChartUi.getState().replay;
  const replay = r.mode !== 'off' && r.time != null ? { time: r.time, at: r.at, speed: r.speed } : undefined;
  return st.tabs.map((t) => (t.id === st.activeTabId && t.kind === 'chart' ? { ...t, state: snapshotChart(), replay } : t));
}

function loadChart(tab: AppTab) {
  // tabs saved before the tester followed a robot show their strategy
  // (a tab saved before the compare list carries a single compareSymbol)
  // a tab saved before the 2 / 4 window charts were kept has none of its own
  if (tab.state) useStore.setState({ testerRobot: null, gridCharts: [], ...clone(tab.state), compares: comparesOf(clone(tab.state)) });
  useStore.setState({ currentWorkspaceId: tab.layoutId ?? null });
  // the tab's replay comes back paused where it was left
  const ui = useChartUi.getState();
  ui.setReplay(tab.replay
    ? { mode: 'on', time: tab.replay.time, at: tab.replay.at, speed: tab.replay.speed, playing: false, jump: ui.replay.jump + 1 }
    : { mode: 'off', playing: false, time: null, at: null });
}

let lastChartTab: string | null = null;

export function activateTab(id: string) {
  const st = useStore.getState();
  if (id === st.activeTabId) return;
  autosaveLayout();
  const tabs = stashed();
  const target = tabs.find((t) => t.id === id);
  if (!target) return;
  if (active()?.kind === 'chart') lastChartTab = st.activeTabId;
  if (target.kind === 'chart') { loadChart(target); lastChartTab = id; }
  st.setTabs(tabs, id);
}

// replaces what the active tab shows (the "Nouvel onglet" page becomes a chart or a tool)
function turnActiveInto(next: Omit<AppTab, 'id'>) {
  const st = useStore.getState();
  autosaveLayout();
  const tabs = stashed().map((t) => (t.id === st.activeTabId ? { id: t.id, ...next } : t));
  const tab = tabs.find((t) => t.id === st.activeTabId)!;
  if (tab.kind === 'chart') { loadChart(tab); lastChartTab = tab.id; }
  st.setTabs(tabs);
}

export function newTab(tab: Omit<AppTab, 'id'> = { kind: 'home' }, at?: number) {
  const st = useStore.getState();
  autosaveLayout();
  const t: AppTab = { ...tab, id: `tab${nextId()}` };
  const tabs = stashed();
  tabs.splice(at ?? tabs.length, 0, t);
  if (active()?.kind === 'chart') lastChartTab = st.activeTabId;
  if (t.kind === 'chart') { loadChart(t); lastChartTab = t.id; }
  st.setTabs(tabs, t.id);
}

export function closeTab(id: string) {
  const st = useStore.getState();
  const isActive = id === st.activeTabId;
  if (isActive) autosaveLayout();
  let tabs = stashed();
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  st.setClosedTabs([tabs[idx], ...st.closedTabs].slice(0, 10));
  tabs = tabs.filter((t) => t.id !== id);
  if (!tabs.length) {
    const home: AppTab = { id: `tab${nextId()}`, kind: 'home' };
    st.setTabs([home], home.id);
    return;
  }
  if (!isActive) { st.setTabs(tabs); return; }
  const next = tabs[Math.min(idx, tabs.length - 1)];
  if (next.kind === 'chart') { loadChart(next); lastChartTab = next.id; }
  st.setTabs(tabs, next.id);
}

export function closeOtherTabs(id: string, onlyRight = false) {
  const st = useStore.getState();
  const tabs = stashed();
  const idx = tabs.findIndex((t) => t.id === id);
  const keep = tabs.filter((t, i) => t.id === id || (onlyRight && i < idx));
  st.setClosedTabs([...tabs.filter((t) => !keep.includes(t)), ...st.closedTabs].slice(0, 10));
  if (!keep.some((t) => t.id === st.activeTabId)) {
    const target = keep.find((t) => t.id === id)!;
    if (target.kind === 'chart') loadChart(target);
    st.setTabs(keep, id);
  } else st.setTabs(keep);
}

export function reopenClosedTab() {
  const st = useStore.getState();
  const [tab, ...rest] = st.closedTabs;
  if (!tab) return;
  st.setClosedTabs(rest);
  newTab({ ...tab });
}

export function duplicateTab(id: string) {
  const tabs = stashed();
  const idx = tabs.findIndex((t) => t.id === id);
  const src = tabs[idx];
  if (!src) return;
  // a copy of a chart is a new, unsaved layout
  newTab({ ...clone(src), layoutId: null }, idx + 1);
}

export function moveTab(from: number, to: number) {
  const st = useStore.getState();
  const tabs = [...st.tabs];
  const [t] = tabs.splice(from, 1);
  tabs.splice(to, 0, t);
  st.setTabs(tabs);
}

export function openTool(tool: ToolId, inNewTab = false) {
  const st = useStore.getState();
  if (tool === 'screener' || tool === 'heatmap') st.setScreener({ mode: 'stocks' });
  if (inNewTab || active()?.kind === 'chart') newTab({ kind: 'tool', tool });
  else turnActiveInto({ kind: 'tool', tool });
}

const layoutState = (ws: Workspace): TabChartState => {
  const out: Record<string, unknown> = {};
  const main = ws.main as Record<string, unknown>;
  for (const k of TAB_KEYS) if (main[k] !== undefined) out[k] = main[k];
  return { ...freshChart(), ...(clone(out) as TabChartState) };
};

// a saved layout: the tab already showing it, else this tab (or a new one)
export function openLayout(ws: Workspace, inNewTab = false) {
  const st = useStore.getState();
  const open = st.tabs.find((t) => t.kind === 'chart' && t.layoutId === ws.id);
  openLayoutWindows(ws);
  if (open) { activateTab(open.id); return; }
  const tab = { kind: 'chart' as const, layoutId: ws.id, state: layoutState(ws) };
  if (inNewTab || active()?.kind === 'chart') newTab(tab);
  else turnActiveInto(tab);
}

// "Créer une nouvelle mise en page": an unnamed layout, saved as it changes
export function createLayout() {
  const st = useStore.getState();
  const state = freshChart();
  const ws: Workspace = { id: nextId(), name: 'Anonyme', savedAt: Date.now(), main: clone(state), popouts: [] };
  st.upsertWorkspace(ws);
  const tab = { kind: 'chart' as const, layoutId: ws.id, state };
  if (active()?.kind === 'chart') newTab(tab);
  else turnActiveInto(tab);
}

// back to the last chart used (or a new chart tab)
export function goToChart(sym?: Symbol) {
  const st = useStore.getState();
  if (active()?.kind === 'chart') return;
  const target = st.tabs.find((t) => t.id === lastChartTab && t.kind === 'chart') ?? [...st.tabs].reverse().find((t) => t.kind === 'chart');
  if (target) activateTab(target.id);
  else newTab({ kind: 'chart', layoutId: null, state: freshChart(sym) });
}

// a chart of its own for what a tool page shows (a lab robot): a new tab on that symbol
// and timeframe with these indicators, whatever the other charts show
export function openChartTab(sym: Symbol, tf: Timeframe, indicators: IndicatorConfig[], extra: TabChartState = {}) {
  const base = freshChart(sym);
  newTab({ kind: 'chart', layoutId: null, state: { ...base, timeframe: tf, indicators: [...(base.indicators ?? []), ...indicators], ...extra } });
}

// a symbol picked in a tool page opens on the last chart used (or a new chart tab)
export function showOnChart(sym: Symbol) {
  goToChart(sym);
  useStore.getState().setSymbol(sym);
}
