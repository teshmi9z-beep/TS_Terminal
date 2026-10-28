import type { Candle, IndicatorConfig, IndicatorType } from '../types';
import type { LinePoint } from './math';

export type PlotPoint = LinePoint & { color?: string };

export type PlotMarker = {
  time: number;
  // at*: Pine's location.absolute, at `price`
  position: 'aboveBar' | 'belowBar' | 'inBar' | 'atPriceTop' | 'atPriceBottom' | 'atPriceMiddle';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text?: string;
  price?: number;
  // 1 = normal; Pine's size.tiny ≈ 0.6
  size?: number;
};

// Pine's box.new: from the bar at `left` to the bar at `right` (plus `rightBars`
// more bars, which may reach into the future), between two prices; `leftBars` moves the
// left edge by that many bars (fractions allowed: -0.4 and 0.4 make a candle-wide box)
export type PlotBox = {
  left: number;
  leftBars?: number;
  right: number;
  rightBars?: number;
  top: number;
  bottom: number;
  fill: string;
  border?: string;
  borderWidth?: number;
  borderStyle?: 'solid' | 'dotted' | 'dashed';
};

// Pine's label.new with a transparent background: the text sits above (label_down)
// or below (label_up) the price; `time` may fall between two bars
export type PlotLabel = { time: number; price: number; text: string; color: string; style: 'down' | 'up'; size?: number };

// Pine's fill() between two plots: one colored band per bar (na = gap)
export type PlotFillPoint = { time: number; a: number; b: number; color: string };

// Pine's bgcolor(): the pane's full height behind the bars from `from` to `to`, one color
export type PlotBackground = { from: number; to: number; color: string };

// Pine's plotcandle
export type PlotCandle = { time: number; open: number; high: number; low: number; close: number; color: string };

// line / histogram / candles become chart series; hline a horizontal price line; markers
// (Pine's plotshape) are drawn on the price series or the indicator's first series;
// boxes and labels (Pine drawings) are painted over the price pane
export type Plot = {
  key: string;
  name: string;
  color: string;
  kind: 'line' | 'histogram' | 'candles' | 'hline' | 'markers' | 'boxes' | 'labels' | 'fill' | 'bgcolor';
  width?: number;
  // Pine's plot.style_stepline
  step?: boolean;
  // for candles: the close of each candle, used by the legends; a NaN value
  // breaks a line (Pine's plot.style_linebr)
  data: PlotPoint[];
  price?: number;
  dashed?: boolean;
  markers?: PlotMarker[];
  candles?: PlotCandle[];
  boxes?: PlotBox[];
  labels?: PlotLabel[];
  fill?: PlotFillPoint[];
  bg?: PlotBackground[];
};

export const isSeriesPlot = (p: Plot) => p.kind === 'line' || p.kind === 'histogram' || p.kind === 'candles';
export const isShapePlot = (p: Plot) => p.kind === 'boxes' || p.kind === 'labels' || p.kind === 'fill' || p.kind === 'bgcolor';

export type IndicatorCategory = 'Tendance' | 'Oscillateurs' | 'Volatilite' | 'Volume' | 'Personnalises';

// a setting, the equivalent of Pine's input.int / float / bool / source / string / color
export type InputDef = {
  key: string;
  label: string;
  default: number | boolean | string;
  // 'session': "HHMM-HHMM" (Pine's input.session)
  kind?: 'number' | 'bool' | 'source' | 'string' | 'color' | 'session';
  // Pine's group= (section title) and inline= (inputs sharing one line)
  group?: string;
  inline?: string;
  tooltip?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
};

// a plot whose color the user can change in the settings (Pine's "Style" tab)
export type StyleDef = { key: string; name: string; color: string };

export type IndicatorDef = {
  type: IndicatorType;
  label: string;
  short: string;
  category: IndicatorCategory;
  overlay: boolean;
  // the indicator has a "Source" input (Pine's input.source): its default ('close', 'hlc3'...).
  // The source may also be another indicator's plot (cfg.source, see derived.ts)
  source?: string;
  description: string;
  defaults: Omit<IndicatorConfig, 'id' | 'type' | 'overlay' | 'visible'>;
  // generic numeric inputs, stored in cfg.inputs
  inputs?: InputDef[];
  // per-plot colors, stored in cfg.plotColors
  styles?: StyleDef[];
  // fixed value range for oscillators (keeps the scale stable while panning)
  range?: [number, number];
  // dashed reference levels (70/30 for RSI...)
  levels?: number[];
  // default pane height relative to the main pane (main = 1)
  stretch?: number;
  volumeFormat?: boolean;
  params: (cfg: IndicatorConfig) => string;
  compute: (candles: Candle[], cfg: IndicatorConfig) => Plot[];
};
