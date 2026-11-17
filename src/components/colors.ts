// the ten ready-made colors offered first in every color choice (candles, drawings, indicators)
export const QUICK_COLORS = [
  '#000000', '#FFFFFF', '#B2B3B3', '#787B86', '#D10000',
  '#F23645', '#089981', '#2962FF', '#FF9800', '#AB47BC',
];

// a colour as the colour picker gives it ('#rrggbb', or '#rrggbbaa' with its opacity) at
// `alpha` times its own opacity; anything else comes back as it is
export function withAlpha(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!m) return color;
  const v = parseInt(m[1], 16);
  const a = (m[2] ? parseInt(m[2], 16) / 255 : 1) * alpha;
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`;
}
