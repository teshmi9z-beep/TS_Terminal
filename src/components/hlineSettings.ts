import type { Drawing, DrawTool, HLineSettings, Timeframe } from '../types';
import { parseTf, tfSeconds } from '../data/timeframes';
import { LOCALE } from '../i18n/lang';

// The horizontal lines: the plain one (all across) and ProRealTime's three from a
// point (to the right, both ways, to the left). They share one settings window.

export const isHLine = (t: DrawTool) => t === 'horizontal_line' || t === 'hline_right' || t === 'hline_both' || t === 'hline_left';

export function defaultHLine(tool: DrawTool): HLineSettings {
  return {
    extendLeft: tool !== 'hline_right',
    extendRight: tool !== 'hline_left',
    text: '',
    showPrice: true,
    showTf: false,
    showDist: false,
    showPct: false,
    // the plain line keeps its price written above it on the left
    boxed: tool !== 'horizontal_line',
    sameColor: true,
    size: 0,
    // the label next to the point
    align: tool === 'hline_left' ? 'right' : 'left',
  };
}

export const hlineOf = (d: Drawing): HLineSettings => ({ ...defaultHLine(d.tool), ...d.hline });

// ticks come before any time unit, fewer ticks first
function tfRank(tf: Timeframe): number {
  const s = tfSeconds(tf);
  return s == null ? parseTf(tf).n / 1e6 : s;
}

// "Afficher dans": on every timeframe, only the one it was drawn on, or that one and the smaller / larger ones
export function shownOnTf(d: Drawing, tf: Timeframe): boolean {
  if (!d.showOn || d.showOn === 'all' || !d.tf) return true;
  if (d.showOn === 'this') return d.tf === tf;
  const a = tfRank(tf), b = tfRank(d.tf);
  return d.showOn === 'lower' ? a <= b : a >= b;
}

// the label of a line: its text, then the price and what else is ticked
export function hlineLabel(d: Drawing, h: HLineSettings, fmt: (v: number) => string, last: number | null): string {
  const price = d.points[0]?.price;
  if (price == null) return '';
  const parts: string[] = [];
  if (h.text.trim()) parts.push(h.text.trim());
  if (h.showPrice) parts.push(fmt(price));
  if (h.showTf && d.tf) parts.push(d.tf);
  if (last != null && (h.showDist || h.showPct)) {
    const dv = price - last;
    if (h.showDist) parts.push(`${dv >= 0 ? '+' : '−'}${fmt(Math.abs(dv))}`);
    if (h.showPct && last) {
      const pct = (dv / last) * 100;
      parts.push(`${pct >= 0 ? '+' : '−'}${Math.abs(pct).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`);
    }
  }
  return parts.join('  ');
}
