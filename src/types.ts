export type Candle = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // holds minutes estimated from real-time proxies (index futures while their prices are delayed)
  est?: boolean;
};

// <count><unit>: T = ticks (trades per bar), s = seconds, m = minutes, h = hours,
// D = days, W = weeks, M = months. Any count is allowed (custom intervals).
export type TfUnit = 'T' | 's' | 'm' | 'h' | 'D' | 'W' | 'M';
export type Timeframe = `${number}${TfUnit}`;

export const TIME_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'];

export type DrawTool =
  | 'cursor'
  | 'trendline'
  | 'extended_line'
  | 'ray'
  | 'horizontal_line'
  // horizontal lines from a point (ProRealTime's): to the right, both ways, to the left
  | 'hline_right'
  | 'hline_both'
  | 'hline_left'
  | 'rectangle'
  | 'brush'
  | 'text'
  | 'fib_retracement'
  | 'fib_extension'
  // volume profiles: over two clicked bars ("Gamme fixe"), from a bar to the last one ("Profil ancré")
  | 'fixed_range'
  | 'anchored_vp'
  | 'long_position'
  | 'short_position'
  // position from three clicks: entry, stop, target (long or short from where the stop is)
  | 'position_3pt'
  // position from two clicks, entry and stop, the target at a preset risk / reward
  | 'position_rr'
  | 'ruler'
  | 'alert';

export type Point = { time: number; price: number };

export type Drawing = {
  id: string;
  tool: DrawTool;
  points: Point[];
  text?: string;
  color: string;
  lineWidth: number;
  done: boolean;
  // fib_retracement / fib_extension
  fibLevels?: number[];
  showPrice?: boolean;
  showPercent?: boolean;
  // fib settings like TradingView's dialog (levels with their colours, background, labels...)
  fib?: FibSettings;
  // long_position / short_position / position_rr
  riskReward?: number;
  // text
  fontSize?: number;
  // drawings belong to one symbol, like TradingView (legacy drawings have none and show everywhere)
  ticker?: string;
  lineStyle?: LineStyleName;
  // horizontal lines: sides running to the chart's edge, label (see hlineSettings.ts)
  hline?: Partial<HLineSettings>;
  // volume profiles (see volumeProfile.ts)
  vp?: Partial<VpSettings>;
  // the timeframe it was drawn on, and on which timeframes it shows (all when absent)
  tf?: Timeframe;
  showOn?: DrawingShowOn;
};

export type DrawingShowOn = 'all' | 'this' | 'lower' | 'higher';

// a volume profile's settings, like TradingView's
export type VpSettings = {
  // price rows
  rows: number;
  // % of the volume in the value area
  valueArea: number;
  // histogram width, % of the range's width
  width: number;
  placement: 'left' | 'right';
  // buying and selling volume side by side (else one bar per row)
  split: boolean;
  upColor: string;
  downColor: string;
  showPoc: boolean;
  pocColor: string;
  // the POC line runs on to the chart's right edge
  extendPoc: boolean;
  // value area high / low lines
  showVaLines: boolean;
  background: boolean;
  bgColor: string;
};

// a horizontal line's settings, like ProRealTime's "Ligne horizontale" window
export type HLineSettings = {
  extendLeft: boolean;
  extendRight: boolean;
  text: string;
  showPrice: boolean;
  // the timeframe the line was drawn on
  showTf: boolean;
  // distance to the last price, in price and in %
  showDist: boolean;
  showPct: boolean;
  // the label in a box on the line (else just above it)
  boxed: boolean;
  // label text in the line's colour (else the chart's text colour)
  sameColor: boolean;
  // font size added to 11 px
  size: number;
  // where the label sits along the line
  align: 'left' | 'center' | 'right';
};

export type LineStyleName = 'solid' | 'dashed' | 'dotted';

// a saved drawing style ("un carré bleu"), usable like a tool and pinnable to the favorites bar
export type DrawingPreset = {
  id: string;
  name: string;
  tool: DrawTool;
  color: string;
  lineWidth: number;
  lineStyle?: LineStyleName;
  fibLevels?: number[];
  riskReward?: number;
  hline?: Partial<HLineSettings>;
  vp?: Partial<VpSettings>;
};

export type FibLevel = { value: number; color: string; on: boolean };
export type FibSettings = {
  levels: FibLevel[];
  // all levels in the drawing's colour
  oneColor: boolean;
  trendLine: boolean;
  background: boolean;
  // 0..100, like TradingView's "Transparence"
  bgTransparency: number;
  extendLeft: boolean;
  extendRight: boolean;
  reverse: boolean;
  showPrices: boolean;
  showLevels: boolean;
  levelsAs: 'values' | 'percent';
  labelsAt: 'left' | 'right';
  fontSize: number;
};

export const FIB_RETR_ALL = [0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.786, 1];
export const FIB_EXT_ALL = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618];

export type OverlayIndicatorType = 'SMA' | 'EMA' | 'ZLEMA' | 'WMA' | 'BOLLINGER' | 'VWAP' | 'DONCHIAN' | 'STOCH_ENV'
  | 'FVG_CUSTOM' | 'IMBALANCE' | 'HA_CANDLES' | 'SESSIONS' | 'TSH_ARROW' | 'ROBOT' | 'HOUR_RANGE' | 'DOW_STRUCTURE' | 'INDEX_REGIME' | 'PIVOT_POINTS' | 'BASIS' | 'GAP_OPEN' | 'EXPECTED_MOVE';
export type PaneIndicatorType = 'RSI' | 'STOCH' | 'VOLUME' | 'MACD' | 'ATR' | 'CCI' | 'MOMENTUM' | 'OBV' | 'WILLR' | 'ADX' | 'STO_RSI';
// PINE: a user script pasted in the Pine editor (cfg.scriptId)
// STRATEGY: a strategy of the tester shown on the chart (cfg.strategyId): its indicators and trades
export type IndicatorType = OverlayIndicatorType | PaneIndicatorType | 'PINE' | 'STRATEGY';
export type BuiltinIndicatorType = Exclude<IndicatorType, 'PINE' | 'STRATEGY'>;

// units of the "Visibilité" tab of the indicator settings
export type VisibilityUnit = 'T' | 's' | 'm' | 'h' | 'D' | 'W' | 'M';
export type TfVisibility = Partial<Record<VisibilityUnit, { on: boolean; min: number; max: number }>>;

export type IndicatorConfig = {
  id: string;
  type: IndicatorType;
  period: number;
  color: string;
  overlay: boolean;
  visible: boolean;
  // BOLLINGER only
  stdDev?: number;
  bandColors?: { upper: string; mid: string; lower: string };
  bandVisible?: { upper: boolean; mid: boolean; lower: boolean };
  // STOCH only (cfg.period is used as the %K length)
  dPeriod?: number;
  // MACD only (cfg.period is used as the fast length)
  slowPeriod?: number;
  signalPeriod?: number;
  // VOLUME only
  volUpColor?: string;
  volDownColor?: string;
  // pane indicators only: shrunk to its header line
  collapsed?: boolean;
  // pane indicators only: pane height relative to the main price pane (main = 1)
  paneStretch?: number;
  // generic numeric inputs and per-plot colors (indicators declaring `inputs` / `styles`)
  inputs?: Record<string, number | boolean | string>;
  scriptId?: string;
  strategyId?: string;
  plotColors?: Record<string, string>;
  // "Source" of the indicators that have one: a price field ('close', 'hl2'...) or another
  // indicator's plot on the same chart, 'ind:<indicator id>:<plot key>' (indicator on indicator)
  source?: string;
  // "Style" tab: line width and visibility of each plot
  plotWidths?: Record<string, number>;
  plotHidden?: Record<string, boolean>;
  // "Visibilité" tab: timeframes on which the indicator is drawn (all when absent)
  tfVisibility?: TfVisibility;
  // horizontal reference lines of a pane indicator (overrides the defaults, e.g. RSI 70/50/30)
  levels?: number[];
  levelColor?: string;
  // ROBOT only: the lab robot it was opened from (the strategy tester replays it on the
  // lab's own history, the very bars of its report)
  robot?: RobotOrigin;
  // an indicator a lab robot reads (its entry signal or filter), opened with it on its chart:
  // the robot's report id
  robotPart?: string;
};

export type RobotOrigin = {
  // the report's robot id, its title, the lab file (id) and the period it was measured on
  id: string; name: string; dataset: string; source: string; market: string;
  // the platform's symbol and timeframe
  ticker: string; tf: string;
  from: number; to: number; split: number;
};

export type PriceAlert = {
  id: string;
  ticker: string;
  price: number;
  triggered: boolean;
  // the symbol, so its price is followed even when it is on no chart and in no open list
  symbol?: Symbol;
};

// ---------- alerts on indicators, with several conditions, on a symbol or a whole watchlist
// (TradingView's "Créer une alerte"); they run in the main window while the platform is open

// one side of a condition: the bar's close, a plot of one of the alert's indicators, or a number
export type AlertOperand =
  | { kind: 'price' }
  | { kind: 'plot'; id: string; plot: string }
  | { kind: 'value'; value: number };
// cross*: from the previous bar to this one; above / below: on this bar; enter / exit / inside /
// outside: the channel between `right` and `right2`; up_pct / down_pct: `left` moved at least
// `right` % over the last `bars` bars
export type AlertOp = 'cross' | 'cross_up' | 'cross_down' | 'above' | 'below' | 'enter' | 'exit' | 'inside' | 'outside' | 'up_pct' | 'down_pct';
export type AlertCondition = { left: AlertOperand; op: AlertOp; right: AlertOperand; right2?: AlertOperand; bars?: number };
// once: the first time, then the alert stops; bar: at most once per bar, on live prices;
// close: when a bar closes, on that bar
export type AlertTrigger = 'once' | 'bar' | 'close';
export type TechAlert = {
  id: string;
  name: string;
  message?: string;
  // one symbol, or every symbol of a watchlist (its symbols when the alert runs)
  target: { kind: 'symbol'; symbol: Symbol } | { kind: 'watchlist'; watchlistId: string };
  tf: Timeframe;
  // the indicators the conditions read (with the ones they are computed on), copied with their
  // settings when the alert was made: changing the chart later does not change the alert
  indicators: IndicatorConfig[];
  conditions: AlertCondition[];
  // all: every condition on the same bar; any: one is enough
  match: 'all' | 'any';
  trigger: AlertTrigger;
  // ms; absent: no expiry
  expires?: number;
  // a Windows notification besides the sound and the message on screen
  desktop?: boolean;
  active: boolean;
  createdAt: number;
  fired: number;
  lastFired?: number;
};
// the alerts journal: every alert that went off, price alerts included
export type AlertLogEntry = { id: string; alertId: string; time: number; ticker: string; text: string };

export type AssetCategory = 'Crypto' | 'Forex' | 'Actions' | 'Indices' | 'Matieres premieres';

export type Symbol = {
  ticker: string;
  name: string;
  // only used by the offline simulator fallback
  basePrice: number;
  category: AssetCategory;
  exchange?: string;
  // explicit data-feed ids; when absent they are derived from ticker + category
  yahoo?: string;
  binance?: string;
  // Interactive Brokers contract, "secType:symbol:exchange:currency" (e.g. CFD:IBUS30:SMART:USD)
  ib?: string;
};

export type WatchlistItem = Symbol & {
  lastPrice: number;
  prevClose: number;
  volume: number;
};

export type WatchlistRow =
  | { kind: 'asset'; data: WatchlistItem }
  | { kind: 'section'; id: string; name: string };

export type WatchlistSortColumn = 'symbol' | 'last' | 'chg' | 'chgPct' | 'volume';

export type WatchlistTab = {
  id: string;
  name: string;
  items: WatchlistRow[];
  // shown sorted by a column (inside each section); the stored order stays the manual one
  sort?: { col: WatchlistSortColumn; dir: 'asc' | 'desc' };
};

export type ChartSettings = {
  background: string;
  gridColor: string;
  showGrid: boolean;
  upColor: string;
  downColor: string;
  wickUpColor: string;
  wickDownColor: string;
  // candle body outline; older saved settings lack it and fall back to the body color
  borderUpColor?: string;
  borderDownColor?: string;
  candleStyle: 'candles' | 'bars' | 'line' | 'area' | 'heikin_ashi';
  // time left before the bar closes, under the last price (on when absent)
  showCountdown?: boolean;
  // the asset's events at the bottom of the chart, like TradingView (on when absent):
  // earnings (E), dividends (D), news (⚡)
  showEarnings?: boolean;
  showDividends?: boolean;
  showNews?: boolean;
};

// dark theme: grey rising candles, red falling candles
export const DEFAULT_CHART_SETTINGS_DARK: ChartSettings = {
  background: '#131722',
  gridColor: '#1e222d',
  showGrid: true,
  upColor: '#a6a6a6',
  downColor: '#d10000',
  wickUpColor: '#9e9e9e',
  wickDownColor: '#ef5350',
  borderUpColor: '#9e9e9e',
  borderDownColor: '#e60400',
  candleStyle: 'candles',
};

// light theme: grey rising candles outlined in black, black falling candles
export const DEFAULT_CHART_SETTINGS_LIGHT: ChartSettings = {
  background: '#ffffff',
  gridColor: '#f0f3fa',
  showGrid: true,
  upColor: '#b2b3b3',
  downColor: '#171717',
  wickUpColor: '#141515',
  wickDownColor: '#141515',
  borderUpColor: '#0f0f0f',
  borderDownColor: '#121212',
  candleStyle: 'candles',
};

export const DEFAULT_CHART_SETTINGS = DEFAULT_CHART_SETTINGS_DARK;

export type UiTheme = 'dark' | 'light';

export type PriceScaleModeName = 'normal' | 'log' | 'percent';

export type Profile = {
  name: string;
  chartSettings: ChartSettings;
  uiTheme: UiTheme;
  // settings of both themes, so a template restores the light and the dark look
  themeChartSettings?: Partial<Record<UiTheme, ChartSettings>>;
  indicators: IndicatorConfig[];
  // small JPEG of the chart when the template was saved (hover preview)
  thumbnail?: string;
  ticker?: string;
  timeframe?: string;
  savedAt?: number;
};
