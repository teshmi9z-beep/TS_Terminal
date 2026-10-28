import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { PineScript } from '../pine/compile';
import type { YieldPeriod } from '../data/yields';
import { defaultStrategies, type StrategyDoc } from '../strategy/doc';
import type { AlertLogEntry, ChartSettings, Drawing, DrawingPreset, DrawTool, FibSettings, IndicatorConfig, PriceAlert, PriceScaleModeName, Profile, Symbol, TechAlert, Timeframe, UiTheme, WatchlistItem, WatchlistRow, WatchlistTab } from '../types';
import { dependentsOf } from '../indicators/derived';

export const DEFAULT_TOOL_ORDER: DrawTool[] = [
  'cursor', 'trendline', 'extended_line', 'ray', 'horizontal_line', 'hline_right', 'hline_both', 'hline_left', 'rectangle', 'brush', 'text',
  'fib_retracement', 'fib_extension', 'fixed_range', 'anchored_vp', 'position_3pt', 'position_rr', 'ruler', 'alert',
];
import { DEFAULT_CHART_SETTINGS_DARK, DEFAULT_CHART_SETTINGS_LIGHT } from '../types';

const defaultChartSettings = (t: UiTheme) => (t === 'dark' ? DEFAULT_CHART_SETTINGS_DARK : DEFAULT_CHART_SETTINGS_LIGHT);

type ThemedState = { uiTheme: UiTheme; chartSettings: ChartSettings; themeChartSettings: Partial<Record<UiTheme, ChartSettings>> };
// light / dark switch: each theme keeps its own chart colors
function switchTheme(st: ThemedState, t: UiTheme): ThemedState {
  const saved = { ...st.themeChartSettings, [st.uiTheme]: st.chartSettings };
  return { uiTheme: t, themeChartSettings: saved, chartSettings: saved[t] ?? defaultChartSettings(t) };
}
import { SYMBOLS } from '../data/symbols';
import { getDailyChange } from '../data/generateData';
import { DEFAULT_TIME_ZONE, zoneOfOffset } from '../data/timeZone';

// key of the saved default settings of an indicator
export const indicatorKey = (i: Pick<IndicatorConfig, 'type' | 'scriptId'>) => (i.type === 'PINE' ? `PINE:${i.scriptId}` : i.type);

// collision-safe across sessions since state is persisted to localStorage and
// module-level counters would otherwise restart at 1 on every page load
let idCounter = 1;
export const nextId = () => `d${Date.now().toString(36)}${(idCounter++).toString(36)}`;

const PROFILES_KEY = 'platform_profiles_v1';
function loadProfilesFromStorage(): Profile[] {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]'); } catch { return []; }
}
function saveProfilesToStorage(profiles: Profile[]) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch { /* ignore quota/denied */ }
}

function tickerSeed(ticker: string): number {
  let h = 0;
  for (let i = 0; i < ticker.length; i++) h = (Math.imul(h, 31) + ticker.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function toWatchlistItem(s: Symbol): WatchlistItem {
  const { last, prevClose } = getDailyChange(s.ticker, s.basePrice);
  const volume = 10000 + (tickerSeed(s.ticker) % 5_000_000);
  return { ...s, lastPrice: last, prevClose, volume };
}

function makeTab(id: string, name: string, symbols: Symbol[]): WatchlistTab {
  return { id, name, items: symbols.map((s): WatchlistRow => ({ kind: 'asset', data: toWatchlistItem(s) })) };
}

export function rowKey(row: WatchlistRow): string {
  return row.kind === 'asset' ? row.data.ticker : row.id;
}

let tabIdCounter = 1;
const nextTabId = () => `wl${Date.now().toString(36)}${(tabIdCounter++).toString(36)}`;

export type TopBarButtonId = 'workspaces' | 'windows' | 'detach' | 'compare' | 'settings' | 'theme' | 'language' | 'alerts' | 'profiles' | 'screenshot' | 'fullscreen';
export const DEFAULT_TOPBAR_ORDER: TopBarButtonId[] = ['workspaces', 'compare', 'alerts', 'windows', 'detach', 'profiles', 'settings', 'screenshot', 'fullscreen', 'theme', 'language'];

export type MagnetMode = 'off' | 'weak' | 'strong';

export type PanePatch = { id: string; paneStretch?: number; collapsed?: boolean };

// tf: the window's own timeframe (kept when the layout changes and comes back)
export type FreeWindow = { id: string; x: number; y: number; w: number; h: number; ticker: string; z: number; tf?: Timeframe };
// a chart of the 2 / 4 window layouts, kept the same way
export type GridChart = { ticker?: string; tf?: Timeframe };

// a chart opened in its own browser window (movable to any screen)
export type Popout = {
  id: string;
  symbol: Symbol;
  tf: Timeframe;
  open: boolean;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  // saved layout (workspace) the window belongs to
  layoutId?: string | null;
};

// ---------- charts linked across windows (ProRealTime's "Lier") ----------
// 0: not linked; 1, 2: link groups. Charts of one group follow each other.
export type LinkGroup = 0 | 1 | 2;
export type ChartLink = {
  symbol: LinkGroup;
  tf: LinkGroup;
  // with the timeframe: the same number of bars shown
  bars: boolean;
  // the time scale scrolled and zoomed together
  scroll: LinkGroup;
  // the chart the watchlist's clicks open symbols in
  principal: boolean;
};

// ---------- paper trading (virtual account) ----------
export type PaperSide = 'long' | 'short';
export type PaperPosition = {
  id: string; symbol: Symbol; side: PaperSide; qty: number; entry: number;
  sl?: number; tp?: number; openedAt: number;
  // opened by a robot in automatic mode: which entry of which signal
  robot?: RobotLegTag;
};
// A fixe, B suiveur, C1..C3 the thirds of the "paliers" entry
export type RobotLegTag = { robotId: string; group: string; leg: 'A' | 'B' | 'C1' | 'C2' | 'C3'; R: number; entry: number; step: number };

// a robot of the lab trading the virtual account on live data; kind 'em': the Expected Move
// robot (src/robots/emRule.ts, run by src/robots/emRunner.ts), 'dow': a Dow structure robot
// (its indicator settings in `inputs`, run by src/robots/dowRunner.ts); their spec is unused
export type AutoRobot = {
  id: string; name: string; symbol: Symbol; tf: Timeframe; kind?: 'em' | 'dow';
  inputs?: Record<string, number | string | boolean>;
  spec: { signal: string; filter: string; stop: string; dir: number; tpR: number; trailK: number; cost: number };
  // % of the account risked by each of the 3 entries
  riskPct: number;
  enabled: boolean;
  createdAt: number;
};
export type PaperOrder = {
  id: string; symbol: Symbol; side: PaperSide; qty: number; type: 'limit' | 'stop'; price: number;
  sl?: number; tp?: number; createdAt: number;
  // placed by a robot in automatic mode: the position it fills carries the tag
  robot?: RobotLegTag;
};
export type PaperTrade = {
  id: string; ticker: string; side: PaperSide; qty: number; entry: number; exit: number; pnl: number;
  // 'fin': still open when a replay session ended, closed at its last replay price
  openedAt: number; closedAt: number; reason: 'manuel' | 'stop' | 'objectif' | 'robot' | 'fin';
  robot?: RobotLegTag;
};
export type PaperAccount = {
  initial: number; balance: number;
  positions: PaperPosition[]; orders: PaperOrder[]; history: PaperTrade[];
};
const NEW_ACCOUNT = (initial = 100000): PaperAccount => ({ initial, balance: initial, positions: [], orders: [], history: [] });

export type RightPanelId = 'watchlist' | 'alerts' | 'data' | 'screener' | 'pine' | 'trading' | 'yields' | 'macro';

// panel under the chart (TradingView's bottom panel): null tab = folded to its tab bar
export type BottomTab = 'editor' | 'tester' | 'trading' | 'replay' | 'options';
export type BottomDockState = { tab: BottomTab | null; height: number; maximized: boolean };

// ---------- "Comparer": other symbols drawn on the chart ----------
// percent: from the first visible bar, on the chart's scale (TradingView's default);
// same: in price on the chart's scale; own: its own scale, no axis. (No left scale: the
// chart's overlays — drawings, orders, legends — take the plot as starting at the left edge.)
export type CompareScale = 'percent' | 'same' | 'own';
export type CompareItem = {
  id: string; symbol: Symbol; style: 'line' | 'candles'; color: string; lineWidth: number; scale: CompareScale; visible: boolean;
};
export const MAX_COMPARES = 5;
export const COMPARE_COLORS = ['#ff6d00', '#2962ff', '#e91e63', '#00bcd4', '#ab47bc'];
const newCompare = (symbol: Symbol, list: CompareItem[]): CompareItem => ({
  id: nextId(), symbol, style: 'line', lineWidth: 2, scale: 'percent', visible: true,
  color: COMPARE_COLORS.find((c) => !list.some((x) => x.color === c)) ?? COMPARE_COLORS[list.length % COMPARE_COLORS.length],
});
// a saved chart (tab, workspace) from before the list: its single compared symbol
export function comparesOf(state: { compares?: CompareItem[]; compareSymbol?: Symbol | null }): CompareItem[] {
  return state.compares ?? (state.compareSymbol ? [newCompare(state.compareSymbol, [])] : []);
}

// ---------- top tabs (TradingView desktop): charts, the "Nouvel onglet" page, tools
export type ToolId = 'screener' | 'heatmap' | 'calendar' | 'news' | 'portfolios' | 'yields' | 'options' | 'fundamentals' | 'markets' | 'community' | 'macro' | 'robots' | 'data';
export const ALL_TOOLS: ToolId[] = ['screener', 'heatmap', 'calendar', 'news', 'portfolios', 'yields', 'options', 'fundamentals', 'markets', 'community', 'macro', 'robots', 'data'];
// chart settings each chart tab keeps for itself (the rest is shared by all tabs)
export const TAB_KEYS = ['symbol', 'timeframe', 'indicators', 'layout', 'freeWindows', 'gridCharts', 'chartSettings', 'priceScaleMode', 'compares', 'testerRobot'] as const;
export type TabChartState = Partial<Pick<Store, (typeof TAB_KEYS)[number]>>;
export type AppTab = {
  id: string;
  kind: 'chart' | 'home' | 'tool';
  tool?: ToolId;
  // chart of an inactive chart tab (the active one lives in the store itself)
  state?: TabChartState;
  // the saved layout ("mise en page" = workspace) this chart tab belongs to
  layoutId?: string | null;
  // a bar replay under way when the tab was left: shown again when it comes back
  replay?: { time: number; at: number | null; speed: number };
};

// ---------- portfolios (TradingView's "Portefeuilles"): holdings from transactions
export type PortfolioTx = { id: string; symbol: Symbol; side: 'buy' | 'sell'; qty: number; price: number; date: number; fee: number };
export type Portfolio = { id: string; name: string; createdAt: number; transactions: PortfolioTx[] };

// the stock screener's settings (TradingView-like), and saved screens
export type ScreenerFilters = {
  sector?: string;
  capMin?: number;
  priceMin?: number;
  priceMax?: number;
  chgMin?: number;
  chgMax?: number;
  rsiMin?: number;
  rsiMax?: number;
  relVolMin?: number;
};
export type ScreenerState = {
  mode: 'stocks' | 'lists';
  market: string;
  view: 'overview' | 'performance' | 'valuation' | 'technical';
  display: 'table' | 'heatmap';
  filters: ScreenerFilters;
  sort: { key: string; dir: 1 | -1 };
  screenName: string | null;
};
const DEFAULT_SCREENER: ScreenerState = {
  mode: 'stocks', market: 'france', view: 'overview', display: 'table', filters: {}, sort: { key: 'marketCap', dir: -1 }, screenName: null,
};

// one curve of the "Courbes de rendement" panel: a country's government yields, now or in the past
export type YieldCurveCfg = { id: string; country: string; period: YieldPeriod; color: string; visible: boolean };
export type YieldSettings = {
  // maturities spaced by duration (TradingView) or evenly
  scale: 'years' | 'even';
  showPoints: boolean;
  tableOpen: boolean;
};
export const YIELD_COLORS = ['#2962ff', '#22b35e', '#ff9800', '#f23645', '#ab47bc', '#00bcd4', '#e91e63', '#8bc34a', '#ffeb3b', '#8d6e63'];
const DEFAULT_YIELD_CURVES: YieldCurveCfg[] = [
  { id: 'yc1', country: 'FR', period: 'current', color: YIELD_COLORS[0], visible: true },
  { id: 'yc2', country: 'FR', period: '1M', color: YIELD_COLORS[1], visible: true },
  { id: 'yc3', country: 'FR', period: '1Y', color: YIELD_COLORS[2], visible: true },
];

// what a workspace remembers of a chart window (drawings stay global, per symbol)
export const WORKSPACE_KEYS = [
  'symbol', 'timeframe', 'indicators', 'layout', 'freeWindows', 'gridCharts', 'chartSettings', 'themeChartSettings', 'uiTheme',
  'watchlistWidth', 'priceScaleMode', 'compares', 'timeZone', 'favoritesBar',
] as const;
export type WorkspaceChartState = Partial<Pick<Store, (typeof WORKSPACE_KEYS)[number]>>;

// ProRealTime-style workspace: the main window plus every detached window and its place on screen
export type Workspace = {
  id: string;
  name: string;
  // F1..F10
  shortcut?: string;
  savedAt: number;
  main: WorkspaceChartState;
  popouts: { symbol: Symbol; tf: Timeframe; left?: number; top?: number; width?: number; height?: number; state: WorkspaceChartState }[];
};

// set when this page is a detached chart window (?popout=<id>)
const urlParams = new URLSearchParams(window.location.search);
export const POPOUT_ID = urlParams.get('popout');
const MAIN_KEY = 'platform_state_v1';

// A detached window keeps its own saved state (symbol, indicators, drawings...),
// seeded from the main window's state the first time it opens.
const stateStorage = createJSONStorage(() => ({
  getItem: (name: string) => {
    const own = localStorage.getItem(name);
    if (own || !POPOUT_ID) return own;
    const main = localStorage.getItem(MAIN_KEY);
    if (!main) return null;
    try {
      const parsed = JSON.parse(main);
      const sym = urlParams.get('sym');
      const tf = urlParams.get('tf');
      if (sym) parsed.state.symbol = JSON.parse(sym);
      if (tf) parsed.state.timeframe = tf;
      parsed.state.layout = 1;
      parsed.state.popouts = [];
      // a new window starts unlinked, and is not the principal chart
      parsed.state.chartLink = { symbol: 0, tf: 0, bars: false, scroll: 0, principal: false };
      return JSON.stringify(parsed);
    } catch {
      return main;
    }
  },
  setItem: (name: string, value: string) => localStorage.setItem(name, value),
  removeItem: (name: string) => localStorage.removeItem(name),
}));

// the main window's light / dark theme, which every detached window follows
function mainTheme(): UiTheme | null {
  try {
    const t = JSON.parse(localStorage.getItem(MAIN_KEY) ?? 'null')?.state?.uiTheme;
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}

export type WatchlistSettings = {
  tableView: boolean;
  showLast: boolean;
  showChg: boolean;
  showChgPct: boolean;
  showVolume: boolean;
  showExtendedHours: boolean;
  showLogo: boolean;
  labelMode: 'symbol' | 'name';
};

const DEFAULT_WATCHLIST_SETTINGS: WatchlistSettings = {
  tableView: true, showLast: true, showChg: true, showChgPct: true,
  showVolume: false, showExtendedHours: false, showLogo: true, labelMode: 'symbol',
};

let winIdCounter = 1;
let winZCounter = 1;

type Store = {
  symbol: Symbol;
  setSymbol: (s: Symbol) => void;

  // symbols compared on the chart ("Comparer"), 5 at most
  compares: CompareItem[];
  // false when 5 are already there
  addCompare: (s: Symbol) => boolean;
  updateCompare: (id: string, patch: Partial<Omit<CompareItem, 'id'>>) => void;
  removeCompare: (id: string) => void;

  watchlists: WatchlistTab[];
  // 2: the main list with its Forex / Indice / Crypto / Como sections (see mainTab)
  mainListVersion: number;
  activeWatchlistId: string;
  setActiveWatchlistId: (id: string) => void;
  addWatchlistTab: (name: string, symbols?: Symbol[]) => void;
  renameWatchlistTab: (id: string, name: string) => void;
  removeWatchlistTab: (id: string) => void;
  // drag a list tab onto another: it takes that tab's place
  moveWatchlistTab: (fromId: string, toId: string) => void;
  setWatchlistSort: (sort: WatchlistTab['sort']) => void;
  // a new manual order for the active list (a row dragged while sorted); clears the sort
  setWatchlistItems: (items: WatchlistRow[]) => void;
  addToWatchlist: (s: Symbol) => void;
  addToWatchlistTab: (tabId: string, s: Symbol) => void;
  removeFromWatchlist: (ticker: string) => void;
  reorderWatchlist: (fromIndex: number, toIndex: number) => void;
  addSection: (name: string) => void;
  renameSection: (id: string, name: string) => void;
  removeSection: (id: string) => void;
  watchlistWidth: number;
  setWatchlistWidth: (w: number) => void;

  watchlistSettings: WatchlistSettings;
  updateWatchlistSettings: (patch: Partial<WatchlistSettings>) => void;

  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  // starred intervals shown as buttons in the top bar
  favoriteTimeframes: Timeframe[];
  toggleFavoriteTf: (tf: Timeframe) => void;
  // user-defined intervals added to the interval menu
  customTimeframes: Timeframe[];
  addCustomTf: (tf: Timeframe) => void;
  removeCustomTf: (tf: Timeframe) => void;

  activeTool: DrawTool;
  setActiveTool: (t: DrawTool) => void;

  drawings: Drawing[];
  addDrawing: (d: Drawing) => void;
  updateDrawing: (id: string, patch: Partial<Drawing>) => void;
  removeDrawing: (id: string) => void;
  // clears the drawings of one symbol (plus legacy symbol-less drawings)
  clearDrawings: (ticker: string) => void;

  selectedDrawingId: string | null;
  setSelectedDrawingId: (id: string | null) => void;

  indicators: IndicatorConfig[];
  addIndicator: (i: Omit<IndicatorConfig, 'visible'>) => void;
  // replaces a whole configuration ("Annuler" of the settings dialog)
  replaceIndicator: (cfg: IndicatorConfig) => void;
  // settings saved with "Enregistrer comme défaut", by indicator key (type, or PINE:<script id>)
  indicatorDefaults: Record<string, Partial<IndicatorConfig>>;
  setIndicatorDefault: (key: string, cfg: Partial<IndicatorConfig> | null) => void;
  removeIndicator: (id: string) => void;
  updateIndicator: (id: string, patch: Partial<IndicatorConfig>) => void;
  // swaps a pane indicator with its previous/next pane indicator (pane order)
  moveIndicator: (id: string, dir: -1 | 1) => void;
  setPaneLayout: (patches: PanePatch[]) => void;

  priceScaleMode: PriceScaleModeName;
  setPriceScaleMode: (m: PriceScaleModeName) => void;

  alerts: PriceAlert[];
  addAlert: (ticker: string, price: number, symbol?: Symbol) => void;
  removeAlert: (id: string) => void;
  triggerAlert: (id: string) => void;
  rearmAlert: (id: string) => void;
  // alerts on indicators / several conditions / a watchlist (src/alerts)
  techAlerts: TechAlert[];
  saveTechAlert: (a: TechAlert) => void;
  updateTechAlert: (id: string, patch: Partial<TechAlert>) => void;
  removeTechAlert: (id: string) => void;
  // newest first, 300 at most
  alertLog: AlertLogEntry[];
  logAlert: (e: Omit<AlertLogEntry, 'id'>) => void;
  clearAlertLog: () => void;

  uiTheme: UiTheme;
  setUiTheme: (t: UiTheme) => void;

  chartSettings: ChartSettings;
  // chart settings last used with each theme, restored when switching back to it
  themeChartSettings: Partial<Record<UiTheme, ChartSettings>>;
  resetChartSettings: () => void;
  updateChartSettings: (patch: Partial<ChartSettings>) => void;

  topBarOrder: TopBarButtonId[];
  reorderTopBar: (from: number, to: number) => void;

  toolOrder: DrawTool[];
  reorderToolbar: (from: number, to: number) => void;

  // display time zone of the charts (IANA name, follows summer time), see data/timeZone.ts
  timeZone: string;
  setTimeZone: (zone: string) => void;

  layout: 1 | 2 | 4 | 'free';
  setLayout: (n: 1 | 2 | 4 | 'free') => void;

  freeWindows: FreeWindow[];
  // the charts of the 2 / 4 window layouts, by position
  gridCharts: GridChart[];
  setGridChart: (i: number, patch: GridChart) => void;
  addFreeWindow: (ticker: string, at?: { x: number; y: number }) => void;
  updateFreeWindow: (id: string, patch: Partial<FreeWindow>) => void;
  removeFreeWindow: (id: string) => void;
  bringWindowToFront: (id: string) => void;

  drawingPresets: DrawingPreset[];
  addDrawingPreset: (p: DrawingPreset) => void;
  // position tools: the preset risk / reward of "position_rr" and the % of the
  // virtual account risked to size the position they show
  positionRR: number;
  positionRiskPct: number;
  setPositionTool: (patch: Partial<{ positionRR: number; positionRiskPct: number }>) => void;
  // fib settings saved with "Enregistrer par défaut" in the fib dialog
  fibDefaults: Partial<Record<'fib_retracement' | 'fib_extension', FibSettings>>;
  setFibDefault: (tool: 'fib_retracement' | 'fib_extension', v: FibSettings | null) => void;
  removeDrawingPreset: (id: string) => void;
  // preset whose style the active drawing tool uses
  activePresetId: string | null;
  selectPreset: (id: string) => void;
  // DrawTool names and 'preset:<id>' entries shown in the floating favorites bar
  favoriteTools: string[];
  toggleFavoriteTool: (key: string) => void;
  favoritesBar: { visible: boolean; x: number; y: number };
  setFavoritesBar: (patch: Partial<{ visible: boolean; x: number; y: number }>) => void;
  // height (px) of the symbol's details under the watchlist, set by dragging their top edge
  watchlistDetailsHeight: number;
  setWatchlistDetailsHeight: (h: number) => void;
  // the drawing tools' magnet, like TradingView's: points stick to the nearest bar's open, high,
  // low or close, when close to it (weak) or always (strong); `magnetMode` is the one the
  // toolbar button turns back on
  magnet: MagnetMode;
  magnetMode: Exclude<MagnetMode, 'off'>;
  setMagnet: (m: MagnetMode) => void;

  popouts: Popout[];
  upsertPopout: (p: Partial<Popout> & { id: string }) => void;
  removePopout: (id: string) => void;

  // right side panel shown next to the thin icon strip (null = collapsed)
  rightPanel: RightPanelId | null;
  setRightPanel: (p: RightPanelId | null) => void;
  chartLink: ChartLink;
  setChartLink: (patch: Partial<ChartLink>) => void;
  // the order ticket ("Trader") opens on its own, or next to the panel already open;
  // closing it leaves that panel as it was
  toggleTradingPanel: () => void;
  // the panel shown next to the order ticket (null: the ticket alone)
  rightPanelBeside: RightPanelId | null;
  setRightPanelBeside: (p: RightPanelId | null) => void;
  // the account's trades (arrows and crosses) drawn on the chart
  showTradeMarks: boolean;
  setShowTradeMarks: (v: boolean) => void;

  yieldCurves: YieldCurveCfg[];
  setYieldCurves: (c: YieldCurveCfg[]) => void;

  // watchlist docked right (in the widget bar) or left of the chart
  watchlistSide: 'right' | 'left';
  leftWatchlistOpen: boolean;
  setWatchlistSide: (side: 'right' | 'left') => void;
  setLeftWatchlistOpen: (v: boolean) => void;

  bottomDock: BottomDockState;
  setBottomDock: (patch: Partial<BottomDockState>) => void;

  strategies: StrategyDoc[];
  activeStrategyId: string;
  upsertStrategy: (d: StrategyDoc) => void;
  removeStrategy: (id: string) => void;
  setActiveStrategy: (id: string) => void;
  // bars loaded by the strategy tester
  backtestBars: number;
  setBacktestBars: (n: number) => void;
  // the tester's strategy drawn on the chart (its indicators and trades), or removed from it
  setStrategyOnChart: (id: string | null) => void;
  // the chart's ROBOT indicator the tester shows in place of a strategy (its id), per chart tab
  testerRobot: string | null;
  setTesterRobot: (id: string | null) => void;

  tabs: AppTab[];
  activeTabId: string;
  closedTabs: AppTab[];
  setTabs: (tabs: AppTab[], activeTabId?: string) => void;
  setClosedTabs: (tabs: AppTab[]) => void;
  // "Nouvel onglet" page: tools shown, starred layouts, sort, first-time hint
  homeTools: ToolId[];
  // tools that existed when homeTools was last saved: newer ones are shown by default
  knownTools: ToolId[];
  setHomeTools: (t: ToolId[]) => void;
  favoriteLayouts: string[];
  toggleFavoriteLayout: (id: string) => void;
  layoutSort: 'recent' | 'name' | 'created';
  setLayoutSort: (s: 'recent' | 'name' | 'created') => void;
  homeHintSeen: boolean;
  setHomeHintSeen: (v: boolean) => void;

  portfolios: Portfolio[];
  activePortfolioId: string | null;
  upsertPortfolio: (p: Portfolio) => void;
  removePortfolio: (id: string) => void;
  setActivePortfolio: (id: string | null) => void;

  screener: ScreenerState;
  setScreener: (patch: Partial<ScreenerState>) => void;
  screenerScreens: { name: string; state: ScreenerState }[];
  setScreenerScreens: (s: { name: string; state: ScreenerState }[]) => void;

  macroMap: { indicator: string; group: string };
  setMacroMap: (patch: Partial<{ indicator: string; group: string }>) => void;
  yieldSettings: YieldSettings;
  setYieldSettings: (patch: Partial<YieldSettings>) => void;

  paper: PaperAccount;
  paperOpen: (p: Omit<PaperPosition, 'id' | 'openedAt'>) => void;
  paperPlaceOrder: (o: Omit<PaperOrder, 'id' | 'createdAt'>) => void;
  paperCancelOrder: (id: string) => void;
  paperClose: (id: string, price: number, reason?: PaperTrade['reason']) => void;
  paperModify: (id: string, patch: Partial<Pick<PaperPosition, 'sl' | 'tp'>>) => void;
  // a pending order moved on the chart (price, stop, target) or resized
  paperModifyOrder: (id: string, patch: Partial<Pick<PaperOrder, 'price' | 'sl' | 'tp' | 'qty' | 'type'>>) => void;
  paperReset: (initial?: number) => void;
  // symbol:side of the positions shown as one line on the chart (ProRealTime's "−" / "+")
  groupedPositions: string[];
  toggleGroupedPositions: (key: string) => void;

  // robots trading the virtual account ("Robots de trading" tab)
  autoRobots: AutoRobot[];
  upsertAutoRobot: (r: AutoRobot) => void;
  removeAutoRobot: (id: string) => void;

  // Pine scripts pasted in the editor (used by 'PINE' indicators)
  pineScripts: PineScript[];
  upsertPineScript: (s: PineScript) => void;
  removePineScript: (id: string) => void;

  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  // state right before the last workspace load ("Annuler le dernier chargement")
  workspaceUndo: Workspace | null;
  upsertWorkspace: (w: Workspace) => void;
  removeWorkspace: (id: string) => void;
  patchWorkspace: (id: string, patch: Partial<Workspace>) => void;
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaceUndo: (w: Workspace | null) => void;

  profiles: Profile[];
  saveProfile: (name: string, thumbnail?: string) => void;
  loadProfile: (name: string) => void;
  deleteProfile: (name: string) => void;

  resetLayout: () => void;
};

// the futures of the main list's indices, in the same order (version 3)
const FUTURES = ['HK50', 'J225', 'FR40', 'DE40', 'US500', 'US30', 'US100', 'US2000'];
// version 5: the Hang Seng, CAC and DAX futures (Interactive Brokers) join them
const FUTURES_5 = ['HK50', 'FR40', 'DE40'];
// Interactive Brokers' index CFDs, in the same order again (version 4)
const CFDS = ['IBHK50', 'IBJP225', 'IBFR40', 'IBDE40', 'IBUS500', 'IBUS30', 'IBUST100'];
// CoinShares' crypto ETPs on Euronext Paris (version 6)
const ETPS = ['CETH', 'BITC', 'SLNC', 'XRPL'];
// the main list, by section, in the platform's tickers (the user's broker names: JP225USD = NIKKEI,
// DE30EUR = DAX40, US30 = DJI, NAS100 = NDX100, US2000 = RUT2000, GOLD = XAUUSD, USOIL = WTI, NGAS = NATGAS).
// Since version 3 the cash indices have their round-the-clock futures below them (US30, US500...),
// to compare the gaps; the DAX, the CAC and the Hang Seng have no free futures feed. Version 4
// adds Interactive Brokers' index CFDs (23 h a day at the cash level, like Capital.com's).
const MAIN_LIST: [string, string[]][] = [
  ['Forex', ['AUDUSD', 'EURCHF', 'USDJPY', 'EURGBP', 'EURUSD']],
  ['Indice', ['HSI', 'NIKKEI', 'CAC40', 'DAX40', 'SPX500', 'DJI', 'NDX100', 'RUT2000']],
  ['Future', FUTURES],
  ['CFD', CFDS],
  ['Crypto', ['ETHUSD', 'BTCUSD']],
  ['ETP crypto', ETPS],
  ['Como', ['XAUUSD', 'WTI', 'NATGAS', 'XAGUSD']],
];
// the main list before version 2
const OLD_MAIN = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

// adds a section of the main list once, after the section `afterId` (at the end without it)
function addMainSection(tabs: WatchlistTab[], name: string, tickers: string[], afterId: string): WatchlistTab[] {
  const id = `wl0_${name.toLowerCase()}`;
  return tabs.map((t) => {
    if (t.id !== 'wl0' || t.items.some((r) => r.kind === 'section' && r.id === id)) return t;
    const add: WatchlistRow[] = [{ kind: 'section', id, name }];
    for (const tk of tickers) {
      const sym = SYMBOLS.find((x) => x.ticker === tk);
      if (sym && !t.items.some((r) => r.kind === 'asset' && r.data.ticker === tk)) add.push({ kind: 'asset', data: toWatchlistItem(sym) });
    }
    const idx = t.items.findIndex((r) => r.kind === 'section' && r.id === afterId);
    const next = idx < 0 ? -1 : t.items.findIndex((r, i) => i > idx && r.kind === 'section');
    const at = idx < 0 || next < 0 ? t.items.length : next;
    return { ...t, items: [...t.items.slice(0, at), ...add, ...t.items.slice(at)] };
  });
}

// adds tickers to a section of the main list (those it doesn't already have), then puts the
// section's rows in the order of `order` (rows it doesn't list stay at the end)
function addToMainSection(tabs: WatchlistTab[], sectionId: string, tickers: string[], order: string[]): WatchlistTab[] {
  return tabs.map((t) => {
    const idx = t.items.findIndex((r) => r.kind === 'section' && r.id === sectionId);
    if (t.id !== 'wl0' || idx < 0) return t;
    const next = t.items.findIndex((r, i) => i > idx && r.kind === 'section');
    const end = next < 0 ? t.items.length : next;
    const rows = t.items.slice(idx + 1, end);
    for (const tk of tickers) {
      const sym = SYMBOLS.find((x) => x.ticker === tk);
      if (sym && !t.items.some((r) => r.kind === 'asset' && r.data.ticker === tk)) rows.push({ kind: 'asset', data: toWatchlistItem(sym) });
    }
    const rank = (r: WatchlistRow) => { const k = r.kind === 'asset' ? order.indexOf(r.data.ticker) : -1; return k < 0 ? order.length : k; };
    rows.sort((a, b) => rank(a) - rank(b));
    return { ...t, items: [...t.items.slice(0, idx + 1), ...rows, ...t.items.slice(end)] };
  });
}

function mainTab(): WatchlistTab {
  const items: WatchlistRow[] = [];
  for (const [name, tickers] of MAIN_LIST) {
    items.push({ kind: 'section', id: `wl0_${name.toLowerCase()}`, name });
    for (const t of tickers) {
      const sym = SYMBOLS.find((x) => x.ticker === t);
      if (sym) items.push({ kind: 'asset', data: toWatchlistItem(sym) });
    }
  }
  return { id: 'wl0', name: 'Principale', items };
}

const initialWatchlists: WatchlistTab[] = [
  mainTab(),
  makeTab('wl_crypto', 'Crypto', SYMBOLS.filter((s) => s.category === 'Crypto').slice(0, 10)),
  makeTab('wl_forex', 'Forex', SYMBOLS.filter((s) => s.category === 'Forex').slice(0, 6)),
];
tabIdCounter = 1;

export const useStore = create<Store>()(persist((set) => ({
  symbol: SYMBOLS[0],
  setSymbol: (s) => set({ symbol: s }),

  compares: [],
  addCompare: (sym) => {
    const list = useStore.getState().compares;
    if (list.length >= MAX_COMPARES) return false;
    set({ compares: [...list, newCompare(sym, list)] });
    return true;
  },
  updateCompare: (id, patch) => set((st) => ({ compares: st.compares.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),
  removeCompare: (id) => set((st) => ({ compares: st.compares.filter((c) => c.id !== id) })),

  watchlists: initialWatchlists,
  mainListVersion: 6,
  activeWatchlistId: 'wl0',
  setActiveWatchlistId: (id) => set({ activeWatchlistId: id }),
  addWatchlistTab: (name, symbols) => {
    const id = nextTabId();
    set((st) => ({
      watchlists: [...st.watchlists, { id, name, items: (symbols ?? []).map((s): WatchlistRow => ({ kind: 'asset', data: toWatchlistItem(s) })) }],
      activeWatchlistId: id,
    }));
  },
  renameWatchlistTab: (id, name) => set((st) => ({ watchlists: st.watchlists.map((t) => (t.id === id ? { ...t, name } : t)) })),
  removeWatchlistTab: (id) => set((st) => {
    if (st.watchlists.length <= 1) return st;
    const watchlists = st.watchlists.filter((t) => t.id !== id);
    const activeWatchlistId = st.activeWatchlistId === id ? watchlists[0].id : st.activeWatchlistId;
    return { watchlists, activeWatchlistId };
  }),
  moveWatchlistTab: (fromId, toId) => set((st) => {
    const from = st.watchlists.findIndex((t) => t.id === fromId);
    const to = st.watchlists.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0 || from === to) return st;
    const watchlists = [...st.watchlists];
    const [moved] = watchlists.splice(from, 1);
    watchlists.splice(to, 0, moved);
    return { watchlists };
  }),
  setWatchlistSort: (sort) => set((st) => ({
    watchlists: st.watchlists.map((t) => (t.id === st.activeWatchlistId ? { ...t, sort } : t)),
  })),
  setWatchlistItems: (items) => set((st) => ({
    watchlists: st.watchlists.map((t) => (t.id === st.activeWatchlistId ? { ...t, items, sort: undefined } : t)),
  })),
  addToWatchlist: (s) => set((st) => ({
    watchlists: st.watchlists.map((t) => {
      if (t.id !== st.activeWatchlistId) return t;
      if (t.items.find((r) => r.kind === 'asset' && r.data.ticker === s.ticker)) return t;
      return { ...t, items: [...t.items, { kind: 'asset', data: toWatchlistItem(s) }] };
    }),
  })),
  addToWatchlistTab: (tabId, s) => set((st) => ({
    watchlists: st.watchlists.map((t) => {
      if (t.id !== tabId || t.items.some((r) => r.kind === 'asset' && r.data.ticker === s.ticker)) return t;
      return { ...t, items: [...t.items, { kind: 'asset', data: toWatchlistItem(s) }] };
    }),
  })),
  removeFromWatchlist: (ticker) => set((st) => ({
    watchlists: st.watchlists.map((t) => (t.id === st.activeWatchlistId
      ? { ...t, items: t.items.filter((r) => !(r.kind === 'asset' && r.data.ticker === ticker)) }
      : t)),
  })),
  reorderWatchlist: (fromIndex, toIndex) => set((st) => ({
    watchlists: st.watchlists.map((t) => {
      if (t.id !== st.activeWatchlistId) return t;
      const items = [...t.items];
      const [moved] = items.splice(fromIndex, 1);
      items.splice(toIndex, 0, moved);
      return { ...t, items };
    }),
  })),
  addSection: (name) => set((st) => ({
    watchlists: st.watchlists.map((t) => (t.id === st.activeWatchlistId
      ? { ...t, items: [...t.items, { kind: 'section', id: nextId(), name }] }
      : t)),
  })),
  renameSection: (id, name) => set((st) => ({
    watchlists: st.watchlists.map((t) => ({
      ...t,
      items: t.items.map((r) => (r.kind === 'section' && r.id === id ? { ...r, name } : r)),
    })),
  })),
  removeSection: (id) => set((st) => ({
    watchlists: st.watchlists.map((t) => ({
      ...t,
      items: t.items.filter((r) => !(r.kind === 'section' && r.id === id)),
    })),
  })),
  watchlistWidth: 300,
  setWatchlistWidth: (w) => set({ watchlistWidth: Math.max(220, Math.min(900, w)) }),

  watchlistSettings: DEFAULT_WATCHLIST_SETTINGS,
  updateWatchlistSettings: (patch) => set((st) => ({ watchlistSettings: { ...st.watchlistSettings, ...patch } })),

  timeframe: '15m',
  setTimeframe: (tf) => set({ timeframe: tf }),
  favoriteTimeframes: ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M', '150T', '500T', '1000T'],
  toggleFavoriteTf: (tf) => set((st) => ({
    favoriteTimeframes: st.favoriteTimeframes.includes(tf) ? st.favoriteTimeframes.filter((x) => x !== tf) : [...st.favoriteTimeframes, tf],
  })),
  customTimeframes: ['150T', '500T'],
  addCustomTf: (tf) => set((st) => ({ customTimeframes: st.customTimeframes.includes(tf) ? st.customTimeframes : [...st.customTimeframes, tf] })),
  removeCustomTf: (tf) => set((st) => ({
    customTimeframes: st.customTimeframes.filter((x) => x !== tf),
    favoriteTimeframes: st.favoriteTimeframes.filter((x) => x !== tf),
  })),

  activeTool: 'cursor',
  setActiveTool: (t) => set({ activeTool: t, activePresetId: null, selectedDrawingId: null }),

  drawings: [],
  addDrawing: (d) => set((st) => ({ drawings: [...st.drawings, d] })),
  updateDrawing: (id, patch) => set((st) => ({ drawings: st.drawings.map((d) => (d.id === id ? { ...d, ...patch } : d)) })),
  removeDrawing: (id) => set((st) => ({ drawings: st.drawings.filter((d) => d.id !== id), selectedDrawingId: st.selectedDrawingId === id ? null : st.selectedDrawingId })),
  clearDrawings: (ticker) => set((st) => ({ drawings: st.drawings.filter((d) => d.ticker && d.ticker !== ticker), selectedDrawingId: null })),

  selectedDrawingId: null,
  setSelectedDrawingId: (id) => set({ selectedDrawingId: id }),

  indicators: [],
  addIndicator: (i) => set((st) => {
    const saved = st.indicatorDefaults[indicatorKey(i)];
    // an indicator added on another one keeps that source over the saved defaults
    return { indicators: [...st.indicators, { ...i, ...(saved ? structuredClone(saved) : {}), ...(i.source ? { source: i.source } : {}), visible: true }] };
  }),
  replaceIndicator: (cfg) => set((st) => ({ indicators: st.indicators.map((i) => (i.id === cfg.id ? cfg : i)) })),
  indicatorDefaults: {},
  setIndicatorDefault: (key, cfg) => set((st) => {
    const next = { ...st.indicatorDefaults };
    if (cfg) next[key] = cfg; else delete next[key];
    return { indicatorDefaults: next };
  }),
  // the indicators computed on it go with it (an SMA of a removed RSI)
  removeIndicator: (id) => set((st) => {
    const gone = new Set([id, ...dependentsOf(st.indicators, id)]);
    return { indicators: st.indicators.filter((i) => !gone.has(i.id)) };
  }),
  updateIndicator: (id, patch) => set((st) => ({ indicators: st.indicators.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  moveIndicator: (id, dir) => set((st) => {
    const list = [...st.indicators];
    const paneIdx = list.map((ind, i) => (ind.overlay ? -1 : i)).filter((i) => i >= 0);
    const pos = paneIdx.findIndex((i) => list[i].id === id);
    const target = paneIdx[pos + dir];
    if (pos < 0 || target === undefined) return st;
    const from = paneIdx[pos];
    [list[from], list[target]] = [list[target], list[from]];
    return { indicators: list };
  }),
  setPaneLayout: (patches) => set((st) => ({
    indicators: st.indicators.map((i) => {
      const p = patches.find((x) => x.id === i.id);
      return p ? { ...i, ...p } : i;
    }),
  })),

  priceScaleMode: 'normal',
  setPriceScaleMode: (m) => set({ priceScaleMode: m }),

  alerts: [],
  addAlert: (ticker, price, symbol) => set((st) => ({
    alerts: [...st.alerts, { id: nextId(), ticker, price, triggered: false, symbol: symbol ?? (st.symbol.ticker === ticker ? st.symbol : undefined) }],
  })),
  removeAlert: (id) => set((st) => ({ alerts: st.alerts.filter((a) => a.id !== id) })),
  triggerAlert: (id) => set((st) => ({ alerts: st.alerts.map((a) => (a.id === id ? { ...a, triggered: true } : a)) })),
  rearmAlert: (id) => set((st) => ({ alerts: st.alerts.map((a) => (a.id === id ? { ...a, triggered: false } : a)) })),
  techAlerts: [],
  saveTechAlert: (a) => set((st) => ({
    techAlerts: st.techAlerts.some((x) => x.id === a.id) ? st.techAlerts.map((x) => (x.id === a.id ? a : x)) : [...st.techAlerts, a],
  })),
  updateTechAlert: (id, patch) => set((st) => ({ techAlerts: st.techAlerts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  removeTechAlert: (id) => set((st) => ({ techAlerts: st.techAlerts.filter((a) => a.id !== id) })),
  alertLog: [],
  logAlert: (e) => set((st) => ({ alertLog: [{ ...e, id: nextId() }, ...st.alertLog].slice(0, 300) })),
  clearAlertLog: () => set({ alertLog: [] }),

  uiTheme: 'dark',
  setUiTheme: (t) => set((st) => (t === st.uiTheme ? st : switchTheme(st, t))),

  chartSettings: DEFAULT_CHART_SETTINGS_DARK,
  themeChartSettings: {},
  updateChartSettings: (patch) => set((st) => ({ chartSettings: { ...st.chartSettings, ...patch } })),
  resetChartSettings: () => set((st) => ({ chartSettings: defaultChartSettings(st.uiTheme) })),

  topBarOrder: [...DEFAULT_TOPBAR_ORDER],
  reorderTopBar: (from, to) => set((st) => {
    const order = [...st.topBarOrder];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    return { topBarOrder: order };
  }),

  toolOrder: [...DEFAULT_TOOL_ORDER],
  reorderToolbar: (from, to) => set((st) => {
    const order = [...st.toolOrder];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    return { toolOrder: order };
  }),

  timeZone: DEFAULT_TIME_ZONE,
  setTimeZone: (zone) => set({ timeZone: zone }),

  layout: 1,
  setLayout: (n) => set((st) => ({
    layout: n,
    freeWindows: n === 'free' && st.freeWindows.length === 0
      ? [{ id: `fw${Date.now().toString(36)}${(winIdCounter++).toString(36)}`, x: 20, y: 20, w: 420, h: 320, ticker: st.symbol.ticker, z: winZCounter++ }]
      : st.freeWindows,
  })),

  freeWindows: [],
  gridCharts: [],
  setGridChart: (i, patch) => set((st) => {
    const next = [...st.gridCharts];
    for (let j = next.length; j < i; j++) next[j] = {};
    next[i] = { ...next[i], ...patch };
    return { gridCharts: next };
  }),
  addFreeWindow: (ticker, at) => set((st) => ({
    freeWindows: [...st.freeWindows, {
      id: `fw${Date.now().toString(36)}${(winIdCounter++).toString(36)}`,
      x: at ? Math.max(0, at.x) : 30 + (st.freeWindows.length % 5) * 30,
      y: at ? Math.max(0, at.y) : 30 + (st.freeWindows.length % 5) * 30,
      w: 420, h: 320, ticker, z: winZCounter++,
    }],
  })),
  updateFreeWindow: (id, patch) => set((st) => ({ freeWindows: st.freeWindows.map((w) => (w.id === id ? { ...w, ...patch } : w)) })),
  removeFreeWindow: (id) => set((st) => ({ freeWindows: st.freeWindows.filter((w) => w.id !== id) })),
  bringWindowToFront: (id) => set((st) => ({ freeWindows: st.freeWindows.map((w) => (w.id === id ? { ...w, z: winZCounter++ } : w)) })),

  drawingPresets: [],
  positionRR: 2,
  positionRiskPct: 1,
  setPositionTool: (patch) => set(patch),
  fibDefaults: {},
  setFibDefault: (tool, v) => set((st) => {
    const next = { ...st.fibDefaults };
    if (v) next[tool] = v; else delete next[tool];
    return { fibDefaults: next };
  }),
  addDrawingPreset: (p) => set((st) => ({ drawingPresets: [...st.drawingPresets, p], favoriteTools: [...st.favoriteTools, `preset:${p.id}`] })),
  removeDrawingPreset: (id) => set((st) => ({
    drawingPresets: st.drawingPresets.filter((p) => p.id !== id),
    favoriteTools: st.favoriteTools.filter((k) => k !== `preset:${id}`),
    activePresetId: st.activePresetId === id ? null : st.activePresetId,
  })),
  activePresetId: null,
  selectPreset: (id) => set((st) => {
    const p = st.drawingPresets.find((x) => x.id === id);
    return p ? { activeTool: p.tool, activePresetId: id, selectedDrawingId: null } : st;
  }),
  favoriteTools: ['trendline', 'horizontal_line', 'rectangle', 'fib_retracement', 'long_position', 'short_position'],
  toggleFavoriteTool: (key) => set((st) => ({
    favoriteTools: st.favoriteTools.includes(key) ? st.favoriteTools.filter((k) => k !== key) : [...st.favoriteTools, key],
  })),
  favoritesBar: { visible: false, x: 70, y: 60 },
  setFavoritesBar: (patch) => set((st) => ({ favoritesBar: { ...st.favoritesBar, ...patch } })),
  watchlistDetailsHeight: 300,
  setWatchlistDetailsHeight: (h) => set({ watchlistDetailsHeight: h }),
  magnet: 'off',
  magnetMode: 'weak',
  setMagnet: (m) => set((st) => ({ magnet: m, magnetMode: m === 'off' ? st.magnetMode : m })),

  popouts: [],
  upsertPopout: (p) => set((st) => {
    const exists = st.popouts.some((x) => x.id === p.id);
    if (!exists && !p.symbol) return st;
    return {
      popouts: exists
        ? st.popouts.map((x) => (x.id === p.id ? { ...x, ...p } : x))
        : [...st.popouts, { open: true, tf: st.timeframe, ...p } as Popout],
    };
  }),
  removePopout: (id) => set((st) => ({ popouts: st.popouts.filter((p) => p.id !== id) })),

  rightPanel: 'watchlist',
  setRightPanel: (p) => set({ rightPanel: p }),
  // the main window's chart is the principal one until a detached window takes it
  chartLink: { symbol: 0, tf: 0, bars: false, scroll: 0, principal: !POPOUT_ID },
  setChartLink: (patch) => set((st) => ({ chartLink: { ...st.chartLink, ...patch } })),
  toggleTradingPanel: () => set((st) => (st.rightPanel === 'trading'
    ? { rightPanel: st.rightPanelBeside, rightPanelBeside: null }
    : { rightPanel: 'trading', rightPanelBeside: st.rightPanel })),
  rightPanelBeside: null,
  setRightPanelBeside: (p) => set({ rightPanelBeside: p }),
  showTradeMarks: true,
  setShowTradeMarks: (v) => set({ showTradeMarks: v }),

  yieldCurves: DEFAULT_YIELD_CURVES,
  setYieldCurves: (c) => set({ yieldCurves: c }),

  watchlistSide: 'right',
  leftWatchlistOpen: true,
  setWatchlistSide: (side) => set((st) => ({
    watchlistSide: side,
    leftWatchlistOpen: true,
    rightPanel: side === 'left' ? (st.rightPanel === 'watchlist' ? null : st.rightPanel) : 'watchlist',
  })),
  setLeftWatchlistOpen: (v) => set({ leftWatchlistOpen: v }),

  bottomDock: { tab: null, height: 340, maximized: false },
  setBottomDock: (patch) => set((st) => ({ bottomDock: { ...st.bottomDock, ...patch } })),

  strategies: defaultStrategies(),
  activeStrategyId: 'st_ma_assisted',
  upsertStrategy: (d) => set((st) => ({
    strategies: st.strategies.some((x) => x.id === d.id) ? st.strategies.map((x) => (x.id === d.id ? d : x)) : [...st.strategies, d],
  })),
  removeStrategy: (id) => set((st) => {
    const strategies = st.strategies.filter((x) => x.id !== id);
    return {
      strategies,
      activeStrategyId: st.activeStrategyId === id ? strategies[0]?.id ?? '' : st.activeStrategyId,
      indicators: st.indicators.filter((i) => !(i.type === 'STRATEGY' && i.strategyId === id)),
    };
  }),
  // the chart shows the tester's strategy: switching strategy switches the one on the chart
  setActiveStrategy: (id) => set((st) => ({
    activeStrategyId: id,
    indicators: st.indicators.map((i) => (i.type === 'STRATEGY' ? { ...i, strategyId: id } : i)),
  })),
  backtestBars: 5000,
  setBacktestBars: (n) => set({ backtestBars: n }),
  setStrategyOnChart: (id) => set((st) => {
    const others = st.indicators.filter((i) => i.type !== 'STRATEGY');
    if (!id) return { indicators: others };
    const existing = st.indicators.find((i) => i.type === 'STRATEGY');
    const cfg: IndicatorConfig = existing
      ? { ...existing, strategyId: id, visible: true }
      : { id: nextId(), type: 'STRATEGY', strategyId: id, overlay: true, visible: true, period: 0, color: '#2962ff' };
    return { indicators: [...others, cfg], activeStrategyId: id };
  }),
  testerRobot: null,
  setTesterRobot: (id) => set({ testerRobot: id }),

  tabs: [{ id: 'tab-main', kind: 'chart', layoutId: null }],
  activeTabId: 'tab-main',
  closedTabs: [],
  setTabs: (tabs, activeTabId) => set((st) => ({ tabs, activeTabId: activeTabId ?? st.activeTabId })),
  setClosedTabs: (t) => set({ closedTabs: t }),
  homeTools: ALL_TOOLS,
  knownTools: ALL_TOOLS,
  setHomeTools: (t) => set({ homeTools: t }),
  favoriteLayouts: [],
  toggleFavoriteLayout: (id) => set((st) => ({
    favoriteLayouts: st.favoriteLayouts.includes(id) ? st.favoriteLayouts.filter((x) => x !== id) : [...st.favoriteLayouts, id],
  })),
  layoutSort: 'recent',
  setLayoutSort: (s) => set({ layoutSort: s }),
  homeHintSeen: false,
  setHomeHintSeen: (v) => set({ homeHintSeen: v }),

  portfolios: [],
  activePortfolioId: null,
  upsertPortfolio: (p) => set((st) => ({
    portfolios: st.portfolios.some((x) => x.id === p.id) ? st.portfolios.map((x) => (x.id === p.id ? p : x)) : [...st.portfolios, p],
  })),
  removePortfolio: (id) => set((st) => ({
    portfolios: st.portfolios.filter((p) => p.id !== id),
    activePortfolioId: st.activePortfolioId === id ? null : st.activePortfolioId,
  })),
  setActivePortfolio: (id) => set({ activePortfolioId: id }),

  screener: DEFAULT_SCREENER,
  setScreener: (patch) => set((st) => ({ screener: { ...st.screener, ...patch } })),
  screenerScreens: [],
  setScreenerScreens: (s) => set({ screenerScreens: s }),

  macroMap: { indicator: 'IRYY', group: 'G20' },
  setMacroMap: (patch) => set((st) => ({ macroMap: { ...st.macroMap, ...patch } })),
  yieldSettings: { scale: 'years', showPoints: true, tableOpen: true },
  setYieldSettings: (patch) => set((st) => ({ yieldSettings: { ...st.yieldSettings, ...patch } })),

  paper: NEW_ACCOUNT(),
  paperOpen: (p) => set((st) => ({
    paper: { ...st.paper, positions: [...st.paper.positions, { ...p, id: nextId(), openedAt: Date.now() }] },
  })),
  paperPlaceOrder: (o) => set((st) => ({
    paper: { ...st.paper, orders: [...st.paper.orders, { ...o, id: nextId(), createdAt: Date.now() }] },
  })),
  paperCancelOrder: (id) => set((st) => ({ paper: { ...st.paper, orders: st.paper.orders.filter((o) => o.id !== id) } })),
  paperClose: (id, price, reason = 'manuel') => set((st) => {
    const pos = st.paper.positions.find((p) => p.id === id);
    if (!pos) return st;
    const pnl = (price - pos.entry) * pos.qty * (pos.side === 'long' ? 1 : -1);
    const trade: PaperTrade = {
      id: pos.id, ticker: pos.symbol.ticker, side: pos.side, qty: pos.qty, entry: pos.entry, exit: price, pnl,
      openedAt: pos.openedAt, closedAt: Date.now(), reason, ...(pos.robot ? { robot: pos.robot } : {}),
    };
    return {
      paper: {
        ...st.paper, balance: st.paper.balance + pnl,
        positions: st.paper.positions.filter((p) => p.id !== id),
        history: [trade, ...st.paper.history].slice(0, 500),
      },
    };
  }),
  paperModify: (id, patch) => set((st) => ({
    paper: { ...st.paper, positions: st.paper.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
  })),
  paperModifyOrder: (id, patch) => set((st) => ({
    paper: { ...st.paper, orders: st.paper.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)) },
  })),
  paperReset: (initial) => set((st) => ({ paper: NEW_ACCOUNT(initial ?? st.paper.initial) })),
  groupedPositions: [],
  toggleGroupedPositions: (key) => set((st) => ({
    groupedPositions: st.groupedPositions.includes(key) ? st.groupedPositions.filter((k) => k !== key) : [...st.groupedPositions, key],
  })),

  autoRobots: [],
  upsertAutoRobot: (r) => set((st) => ({ autoRobots: st.autoRobots.some((x) => x.id === r.id) ? st.autoRobots.map((x) => (x.id === r.id ? r : x)) : [...st.autoRobots, r] })),
  removeAutoRobot: (id) => set((st) => ({ autoRobots: st.autoRobots.filter((x) => x.id !== id) })),

  pineScripts: [],
  upsertPineScript: (s) => set((st) => ({
    pineScripts: st.pineScripts.some((x) => x.id === s.id) ? st.pineScripts.map((x) => (x.id === s.id ? s : x)) : [...st.pineScripts, s],
  })),
  removePineScript: (id) => set((st) => ({
    pineScripts: st.pineScripts.filter((s) => s.id !== id),
    indicators: st.indicators.filter((i) => !(i.type === 'PINE' && i.scriptId === id)),
  })),

  workspaces: [],
  currentWorkspaceId: null,
  workspaceUndo: null,
  upsertWorkspace: (w) => set((st) => ({
    workspaces: st.workspaces.some((x) => x.id === w.id) ? st.workspaces.map((x) => (x.id === w.id ? w : x)) : [...st.workspaces, w],
  })),
  removeWorkspace: (id) => set((st) => ({
    workspaces: st.workspaces.filter((w) => w.id !== id),
    currentWorkspaceId: st.currentWorkspaceId === id ? null : st.currentWorkspaceId,
  })),
  // a shortcut key belongs to one workspace only
  patchWorkspace: (id, patch) => set((st) => ({
    workspaces: st.workspaces.map((w) => {
      if (w.id === id) return { ...w, ...patch };
      if (patch.shortcut && w.shortcut === patch.shortcut) return { ...w, shortcut: undefined };
      return w;
    }),
  })),
  setCurrentWorkspace: (id) => set((st) => ({
    currentWorkspaceId: id,
    tabs: st.tabs.map((t) => (t.id === st.activeTabId && t.kind === 'chart' ? { ...t, layoutId: id } : t)),
  })),
  setWorkspaceUndo: (w) => set({ workspaceUndo: w }),

  profiles: loadProfilesFromStorage(),
  saveProfile: (name, thumbnail) => set((st) => {
    const profile: Profile = {
      name, chartSettings: st.chartSettings, uiTheme: st.uiTheme, indicators: st.indicators,
      themeChartSettings: { ...st.themeChartSettings, [st.uiTheme]: st.chartSettings },
      thumbnail, ticker: st.symbol.ticker, timeframe: st.timeframe, savedAt: Date.now(),
    };
    const profiles = [...st.profiles.filter((p) => p.name !== name), profile];
    saveProfilesToStorage(profiles);
    return { profiles };
  }),
  loadProfile: (name) => set((st) => {
    const profile = st.profiles.find((p) => p.name === name);
    if (!profile) return st;
    // the theme being left keeps its settings unless the template has its own
    const themeChartSettings = { ...st.themeChartSettings, [st.uiTheme]: st.chartSettings, ...profile.themeChartSettings, [profile.uiTheme]: profile.chartSettings };
    return { chartSettings: profile.chartSettings, uiTheme: profile.uiTheme, indicators: profile.indicators, themeChartSettings };
  }),
  deleteProfile: (name) => set((st) => {
    const profiles = st.profiles.filter((p) => p.name !== name);
    saveProfilesToStorage(profiles);
    return { profiles };
  }),

  resetLayout: () => set((st) => ({
    watchlistWidth: 300,
    layout: 1,
    freeWindows: [],
    indicators: st.indicators.map((i) => ({ ...i, paneStretch: undefined, collapsed: false })),
  })),
}), {
  name: POPOUT_ID ? `platform_popout_${POPOUT_ID}` : MAIN_KEY,
  storage: stateStorage,
  partialize: (state) => {
    const { profiles: _profiles, saveProfile: _save, loadProfile: _load, deleteProfile: _delete, ...rest } = state;
    return rest;
  },
  // older saves may lack newer top-bar buttons or carry removed ones
  merge: (persisted, current) => {
    const p = (persisted ?? {}) as Partial<Store>;
    const order = (p.topBarOrder ?? []).filter((id) => DEFAULT_TOPBAR_ORDER.includes(id));
    for (const id of DEFAULT_TOPBAR_ORDER) if (!order.includes(id)) order.push(id);
    // saves from before knownTools knew every tool but the robots and the data tab
    const known = p.knownTools ?? ALL_TOOLS.filter((t) => t !== 'robots' && t !== 'data');
    const home = p.homeTools ?? ALL_TOOLS;
    const homeTools = [...home, ...ALL_TOOLS.filter((t) => !known.includes(t) && !home.includes(t))];
    // the long / short position tools gave way to the 3-click and preset R:R ones
    const tools: DrawTool[] = (p.toolOrder ?? DEFAULT_TOOL_ORDER).map((t): DrawTool => (t === 'long_position' ? 'position_3pt' : t === 'short_position' ? 'position_rr' : t));
    // a new tool goes after the one before it in the default order (else before the ruler)
    DEFAULT_TOOL_ORDER.forEach((t, i) => {
      if (tools.includes(t)) return;
      const prev = i > 0 ? tools.indexOf(DEFAULT_TOOL_ORDER[i - 1]) : -1;
      tools.splice(prev >= 0 ? prev + 1 : Math.max(0, tools.indexOf('ruler')), 0, t);
    });
    // saves from before the sectioned main list get it, and keep their own main list aside
    // as "Ancienne principale" unless it was still the old default
    let watchlists = p.watchlists ?? current.watchlists;
    let activeWatchlistId = p.activeWatchlistId ?? current.activeWatchlistId;
    if ((p.mainListVersion ?? 1) < 2 && p.watchlists) {
      const old = p.watchlists.find((t) => t.id === 'wl0');
      const oldTickers = old?.items.map((r) => (r.kind === 'asset' ? r.data.ticker : '#')).join(',');
      const keep = old && old.items.length && oldTickers !== OLD_MAIN.join(',') ? [{ ...old, id: 'wl0_old', name: 'Ancienne principale' }] : [];
      watchlists = [mainTab(), ...keep, ...p.watchlists.filter((t) => t.id !== 'wl0')];
      activeWatchlistId = 'wl0';
    } else if (p.watchlists) {
      // newer sections go into the main list after the one before them, its own rows untouched
      const v = p.mainListVersion ?? 1;
      if (v < 3) watchlists = addMainSection(watchlists, 'Future', FUTURES, 'wl0_indice');
      if (v < 4) watchlists = addMainSection(watchlists, 'CFD', CFDS, 'wl0_future');
      if (v < 5 && v >= 3) watchlists = addToMainSection(watchlists, 'wl0_future', FUTURES_5, FUTURES);
      if (v < 6) watchlists = addMainSection(watchlists, 'ETP crypto', ETPS, 'wl0_crypto');
    }
    // the retracement's settings the user chose on 2026-09-29 replace one saved before
    const fibDefaults = (p as { fibV?: number }).fibV === 2 ? p.fibDefaults ?? {} : { ...(p.fibDefaults ?? {}), fib_retracement: undefined };
    // saves from before the real time zones kept a fixed offset (2 = Paris in summer, wrong in winter)
    const timeZone = p.timeZone ?? zoneOfOffset((p as { utcOffsetHours?: number }).utcOffsetHours);
    const merged = { ...current, ...p, timeZone, fibDefaults, fibV: 2, watchlists, activeWatchlistId, mainListVersion: 6, topBarOrder: order, homeTools, knownTools: ALL_TOOLS, toolOrder: [...new Set(tools)], compares: comparesOf(p as { compareSymbol?: Symbol | null }) };
    // a detached window opens in the main window's theme (a saved workspace may hold the other one)
    const theme = POPOUT_ID ? mainTheme() : null;
    return theme && theme !== merged.uiTheme ? { ...merged, ...switchTheme(merged, theme) } : merged;
  },
}));

export function getActiveWatchlist(state: Store): WatchlistTab {
  return state.watchlists.find((t) => t.id === state.activeWatchlistId) ?? state.watchlists[0];
}
