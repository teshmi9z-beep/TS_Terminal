import type { IndicatorType } from '../types';
import mathSource from './math.ts?raw';
import stochEnvPine from './custom/stochPriceEnvelope.pine?raw';
import stochEnvTs from './custom/stochPriceEnvelope.ts?raw';
import fvgCustomPine from './custom/fvgCustom.pine?raw';
import fvgCustomTs from './custom/fvgCustom.ts?raw';
import imbalancePine from './custom/imbalance.pine?raw';
import imbalanceTs from './custom/imbalance.ts?raw';
import haCandlesPine from './custom/haCandles.pine?raw';
import haCandlesTs from './custom/haCandles.ts?raw';
import sessionsPine from './custom/sessions.pine?raw';
import sessionsTs from './custom/sessions.ts?raw';
import hourRangePine from './custom/hourRange.pine?raw';
import hourRangeTs from './custom/hourRange.ts?raw';
import stoRsiPine from './custom/stoRsi.pine?raw';
import stoRsiTs from './custom/stoRsi.ts?raw';
import tshArrowPine from './custom/tshArrow.pine?raw';
import tshArrowTs from './custom/tshArrow.ts?raw';

// Source shown by the "{}" button of each indicator: the Pine Script equivalent
// (TradingView reference) and the TypeScript that actually runs on this platform.

const pine = (title: string, short: string, overlay: boolean, body: string) =>
  `//@version=5\nindicator("${title}", shorttitle="${short}", overlay=${overlay})\n\n${body.trim()}\n`;

const PINE: Partial<Record<IndicatorType, string>> = {
  SMA: pine('Moyenne mobile simple', 'SMA', true, `
len = input.int(20, "Période", minval=1)
plot(ta.sma(close, len), "SMA", color=#f0b90b, linewidth=2)`),
  EMA: pine('Moyenne mobile exponentielle', 'EMA', true, `
len = input.int(20, "Période", minval=1)
plot(ta.ema(close, len), "EMA", color=#2962ff, linewidth=2)`),
  WMA: pine('Moyenne mobile pondérée', 'WMA', true, `
len = input.int(20, "Période", minval=1)
plot(ta.wma(close, len), "WMA", color=#66bb6a, linewidth=2)`),
  ZLEMA: pine('Zero-lag EMA', 'ZLEMA', true, `
len = input.int(20, "Période", minval=1)
lag = math.floor((len - 1) / 2)
src = 2 * close - close[lag]
plot(ta.ema(src, len), "ZLEMA", color=#00bcd4, linewidth=2)`),
  VWAP: pine('VWAP (session)', 'VWAP', true, `
// remis à zéro à chaque nouvelle journée (UTC)
plot(ta.vwap(hlc3), "VWAP", color=#2962ff, linewidth=2)`),
  BOLLINGER: pine('Bandes de Bollinger', 'BB', true, `
len = input.int(20, "Période", minval=1)
mult = input.float(2.0, "Écart-type", minval=0.5, step=0.1)
basis = ta.sma(close, len)
dev = mult * ta.stdev(close, len)
plot(basis, "Base", color=#ff6d00)
plot(basis + dev, "Haut", color=#2962ff)
plot(basis - dev, "Bas", color=#2962ff)`),
  DONCHIAN: pine('Canaux de Donchian', 'DC', true, `
len = input.int(20, "Période", minval=1)
upper = ta.highest(high, len)
lower = ta.lowest(low, len)
plot(upper, "Haut", color=#2962ff)
plot(math.avg(upper, lower), "Base", color=#ff6d00)
plot(lower, "Bas", color=#2962ff)`),
  VOLUME: pine('Volume', 'Vol', false, `
upColor = input.color(#26a69a, "Hausse")
downColor = input.color(#ef5350, "Baisse")
plot(volume, "Volume", style=plot.style_columns, color=close >= open ? color.new(upColor, 40) : color.new(downColor, 40))`),
  RSI: pine('Relative Strength Index', 'RSI', false, `
len = input.int(14, "Période", minval=1)
plot(ta.rsi(close, len), "RSI", color=#7e57c2, linewidth=2)
hline(70, "Haut")
hline(50, "Milieu")
hline(30, "Bas")`),
  STOCH: pine('Stochastique', 'Stoch', false, `
kLen = input.int(14, "%K longueur", minval=1)
dLen = input.int(3, "%D lissage", minval=1)
k = ta.stoch(close, high, low, kLen)
plot(k, "%K", color=#2962ff, linewidth=2)
plot(ta.sma(k, dLen), "%D", color=#ff6d00)
hline(80)
hline(50)
hline(20)`),
  MACD: pine('MACD', 'MACD', false, `
fast = input.int(12, "EMA rapide")
slow = input.int(26, "EMA lente")
sig = input.int(9, "Signal")
[macdLine, signalLine, hist] = ta.macd(close, fast, slow, sig)
plot(hist, "Histo", style=plot.style_columns, color=hist >= 0 ? (hist >= hist[1] ? #26a69a : #b2dfdb) : (hist <= hist[1] ? #ef5350 : #ffcdd2))
plot(macdLine, "MACD", color=#2962ff, linewidth=2)
plot(signalLine, "Signal", color=#ff6d00)
hline(0)`),
  ATR: pine('Average True Range', 'ATR', false, `
len = input.int(14, "Période", minval=1)
plot(ta.atr(len), "ATR", color=#ff6d00, linewidth=2)`),
  CCI: pine('Commodity Channel Index', 'CCI', false, `
len = input.int(20, "Période", minval=1)
plot(ta.cci(hlc3, len), "CCI", color=#26c6da, linewidth=2)
hline(100)
hline(0)
hline(-100)`),
  MOMENTUM: pine('Momentum', 'Mom', false, `
len = input.int(10, "Période", minval=1)
plot(ta.mom(close, len), "Mom", color=#ec407a, linewidth=2)
hline(0)`),
  WILLR: pine('Williams %R', '%R', false, `
len = input.int(14, "Période", minval=1)
plot(ta.wpr(len), "%R", color=#7e57c2, linewidth=2)
hline(-20)
hline(-50)
hline(-80)`),
  ADX: pine('ADX / DMI', 'ADX', false, `
len = input.int(14, "Période", minval=1)
[diPlus, diMinus, adx] = ta.dmi(len, len)
plot(adx, "ADX", color=#ff6d00, linewidth=2)
plot(diPlus, "+DI", color=#26a69a)
plot(diMinus, "-DI", color=#ef5350)
hline(25)`),
  OBV: pine('On Balance Volume', 'OBV', false, `
plot(ta.obv, "OBV", color=#2962ff, linewidth=2)`),
};

// built-in indicators run the functions of math.ts
const MATH_FUNCTIONS: Partial<Record<IndicatorType, string[]>> = {
  SMA: ['sma'], EMA: ['ema'], WMA: ['wma'], ZLEMA: ['zlema'], VWAP: ['vwap'], BOLLINGER: ['sma', 'bollinger'],
  DONCHIAN: ['donchian'], RSI: ['rsi'], STOCH: ['stochastic'], MACD: ['ema', 'macd'], ATR: ['atr'], CCI: ['cci'],
  MOMENTUM: ['momentum'], WILLR: ['williamsR'], ADX: ['adx'], OBV: ['obv'],
};

function extractFunction(source: string, name: string): string | null {
  const start = source.search(new RegExp(`(^|\\n)(//[^\\n]*\\n)*export function ${name}\\(`));
  if (start < 0) return null;
  const rest = source.slice(start).replace(/^\n/, '');
  const next = rest.slice(1).search(/\n(\/\/[^\n]*\n)*export function /);
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
}

// user indicators ported from Pine Script: the original script and its port
const CUSTOM: Partial<Record<IndicatorType, { pine: string; ts: string }>> = {
  STOCH_ENV: { pine: stochEnvPine, ts: stochEnvTs },
  FVG_CUSTOM: { pine: fvgCustomPine, ts: fvgCustomTs },
  IMBALANCE: { pine: imbalancePine, ts: imbalanceTs },
  HA_CANDLES: { pine: haCandlesPine, ts: haCandlesTs },
  SESSIONS: { pine: sessionsPine, ts: sessionsTs },
  HOUR_RANGE: { pine: hourRangePine, ts: hourRangeTs },
  STO_RSI: { pine: stoRsiPine, ts: stoRsiTs },
  TSH_ARROW: { pine: tshArrowPine, ts: tshArrowTs },
};

export function indicatorSources(type: Exclude<IndicatorType, 'PINE'>): { pine?: string; ts?: string } {
  const custom = CUSTOM[type];
  if (custom) return custom;
  const fns = MATH_FUNCTIONS[type];
  const ts = fns?.map((f) => extractFunction(mathSource, f)).filter(Boolean).join('\n\n');
  return { pine: PINE[type], ts: ts || undefined };
}
