import type { Drawing, DrawTool } from '../types';

// the drawings with TradingView's settings window (DrawingDialog.tsx)
export const hasDrawingDialog = (d: Drawing) => d.tool === 'rectangle' || d.tool === 'trendline' || d.tool === 'ray' || d.tool === 'extended_line';

// what the common colour, width and line style change on each tool, so that only the
// controls that do something are offered (toolbar, right click, "Mes styles de dessin").
// The volume profiles take their colours from their own settings window, the positions
// are green and red, a text has a size instead of a width. A Fibo's colour is all its
// levels' (it turns "Utiliser une seule couleur" on).
export type StyleCaps = { color: boolean; width: boolean; style: boolean };
export const NO_STYLE: StyleCaps = { color: false, width: false, style: false };
export function styleCaps(tool: DrawTool): StyleCaps {
  switch (tool) {
    case 'fixed_range': case 'anchored_vp':
    case 'long_position': case 'short_position': case 'position_3pt': case 'position_rr':
    case 'cursor': case 'alert':
      return NO_STYLE;
    case 'text':
      return { color: true, width: false, style: false };
    // the VWAP line's colour and width, like TradingView's toolbar (its style and the bands:
    // the settings window)
    case 'anchored_vwap':
      return { color: true, width: true, style: false };
    default:
      return { color: true, width: true, style: true };
  }
}
export const hasStyle = (tool: DrawTool) => { const c = styleCaps(tool); return c.color || c.width || c.style; };

// the background a rectangle has when none was chosen: its line colour at 15 %
export const RECT_FILL_ALPHA = 0.15;
export function defaultFill(color: string): string {
  const hex = /^#([0-9a-f]{6})/i.exec(color)?.[1];
  return hex ? `#${hex}${Math.round(RECT_FILL_ALPHA * 255).toString(16).padStart(2, '0')}`.toUpperCase() : color;
}
