import { createElement, type ReactNode } from 'react';
import type { DrawTool, LineStyleName } from '../types';

// a horizontal line and its point, placed where the line starts (ProRealTime's icons)
function hlineIcon(at: 'left' | 'middle' | 'right'): ReactNode {
  const cx = at === 'left' ? 4 : at === 'middle' ? 9 : 14;
  const x1 = at === 'left' ? cx + 2 : 1, x2 = at === 'right' ? cx - 2 : 17;
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true },
    createElement('line', { x1, y1: 9, x2, y2: 9, stroke: 'currentColor', strokeWidth: 1.6 }),
    at === 'middle' && createElement('line', { x1: 1, y1: 9, x2: 7, y2: 9, stroke: 'currentColor', strokeWidth: 1.6 }),
    createElement('circle', { cx, cy: 9, r: 2.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }));
}

// a volume profile: rows of bars from the left, the widest (the point of control) in amber;
// anchored: from a point at the bottom
function vpIcon(anchored: boolean): ReactNode {
  const rows = [[4, 5], [7, 9], [10, 7], [13, 4]];
  return createElement('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true },
    createElement('line', { x1: 2.5, y1: 2, x2: 2.5, y2: anchored ? 14 : 16, stroke: 'currentColor', strokeWidth: 1.3 }),
    !anchored && createElement('line', { x1: 15.5, y1: 2, x2: 15.5, y2: 16, stroke: 'currentColor', strokeWidth: 1.3, strokeDasharray: '2 1.5' }),
    ...rows.map(([y, w], i) => createElement('rect', { key: i, x: 3.5, y: y - 1, width: w, height: 2, fill: i === 1 ? TONE_AMBER : 'currentColor' })),
    anchored && createElement('circle', { cx: 2.5, cy: 15.5, r: 1.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }));
}

// the fixed colours of the multi-coloured icons, readable on the dark and the light theme
const TONE_GREEN = '#089981', TONE_RED = '#f23645', TONE_BLUE = '#3d7bff', TONE_ORANGE = '#ff9800', TONE_AMBER = '#f0b90b';

const svg = (...children: ReactNode[]) => createElement('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true }, ...children);

// Fibonacci retracement: coloured levels across a dashed swing
function fibIcon(): ReactNode {
  const levels: [number, string][] = [[3, TONE_RED], [7, TONE_ORANGE], [11, TONE_GREEN], [15, TONE_BLUE]];
  return svg(
    ...levels.map(([y, c]) => createElement('line', { key: y, x1: 1, y1: y, x2: 17, y2: y, stroke: c, strokeWidth: 1.5 })),
    createElement('line', { key: 's', x1: 2, y1: 15, x2: 16, y2: 3, stroke: 'currentColor', strokeWidth: 1.2, strokeDasharray: '2 1.5' }));
}

// Fibonacci extension: a three-point swing, then coloured levels on its right
function fibExtIcon(): ReactNode {
  const levels: [number, string][] = [[3, TONE_RED], [7.5, TONE_ORANGE], [12, TONE_GREEN]];
  return svg(
    createElement('polyline', { key: 'z', points: '1.5,15 5,7 8,12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
    ...levels.map(([y, c]) => createElement('line', { key: y, x1: 9.5, y1: y, x2: 17, y2: y, stroke: c, strokeWidth: 1.5 })));
}

// a position: the target (green) and the stop (red) boxes around the entry
function positionIcon(side: 'long' | 'short' | '3pt'): ReactNode {
  const top = side === 'short' ? TONE_RED : TONE_GREEN, bottom = side === 'short' ? TONE_GREEN : TONE_RED;
  const w = side === '3pt' ? 10 : 14;
  return svg(
    createElement('rect', { key: 't', x: 2, y: 2.5, width: w, height: 6.5, rx: 1, fill: top, fillOpacity: 0.3, stroke: top, strokeWidth: 1.2 }),
    createElement('rect', { key: 'b', x: 2, y: 9, width: w, height: 5, rx: 1, fill: bottom, fillOpacity: 0.3, stroke: bottom, strokeWidth: 1.2 }),
    side === '3pt' && createElement('line', { key: 'l', x1: 15.5, y1: 3, x2: 15.5, y2: 14, stroke: 'currentColor', strokeWidth: 1, strokeDasharray: '1.5 1.5' }),
    side === '3pt' && createElement('circle', { key: 'c1', cx: 15.5, cy: 3, r: 1.8, fill: TONE_GREEN }),
    side === '3pt' && createElement('circle', { key: 'c2', cx: 15.5, cy: 9, r: 1.8, fill: TONE_BLUE }),
    side === '3pt' && createElement('circle', { key: 'c3', cx: 15.5, cy: 14, r: 1.8, fill: TONE_RED }));
}

// "R:R", the reward in green and the risk in red
function rrIcon(): ReactNode {
  return createElement('span', { className: 'rr-icon' },
    createElement('b', { key: 'r', style: { color: TONE_GREEN } }, 'R'), ':', createElement('b', { key: 'k', style: { color: TONE_RED } }, 'R'));
}

// a yellow ruler with its marks
function rulerIcon(): ReactNode {
  return svg(
    createElement('rect', { key: 'r', x: 1, y: 6, width: 16, height: 6.5, rx: 1, fill: TONE_AMBER, stroke: '#b8860b', strokeWidth: 1, transform: 'rotate(-35 9 9)' }),
    ...[4, 7, 10, 13].map((x, i) => createElement('line', { key: x, x1: x, y1: 6, x2: x, y2: i % 2 ? 8.5 : 9.5, stroke: '#6b4e00', strokeWidth: 1, transform: 'rotate(-35 9 9)' })));
}

// each tool's colour family (a "tone-…" class in App.css, with its own step for the light theme)
export type ToolTone = 'cursor' | 'line' | 'amber' | 'blue' | 'red' | 'green' | 'shape' | 'brush' | 'text' | 'fib' | 'volume' | 'position' | 'measure';

export const TOOL_INFO: Record<DrawTool, { label: string; icon: ReactNode; tone: ToolTone }> = {
  cursor: { label: 'Curseur', icon: '⭠', tone: 'cursor' },
  trendline: { label: 'Segment', icon: '╱', tone: 'line' },
  extended_line: { label: 'Segment prolongé', icon: '⟍', tone: 'line' },
  ray: { label: 'Rayon', icon: '↗', tone: 'line' },
  // the horizontal lines wear the colour they draw with (DEFAULT_TOOL_COLOR)
  horizontal_line: { label: 'Ligne horizontale', icon: '―', tone: 'amber' },
  hline_right: { label: 'Ligne horizontale depuis un point, vers la droite', icon: hlineIcon('left'), tone: 'blue' },
  hline_both: { label: 'Ligne horizontale depuis un point, des deux côtés', icon: hlineIcon('middle'), tone: 'red' },
  hline_left: { label: 'Ligne horizontale depuis un point, vers la gauche', icon: hlineIcon('right'), tone: 'green' },
  rectangle: { label: 'Rectangle', icon: '▭', tone: 'shape' },
  brush: { label: 'Pinceau', icon: '✎', tone: 'brush' },
  text: { label: 'Texte', icon: 'T', tone: 'text' },
  fib_retracement: { label: 'Niveau de Fibo', icon: fibIcon(), tone: 'fib' },
  fib_extension: { label: 'Extension de Fibo', icon: fibExtIcon(), tone: 'fib' },
  fixed_range: { label: 'Gamme fixe : profil de volume entre deux bougies', icon: vpIcon(false), tone: 'volume' },
  anchored_vp: { label: 'Profil ancré : profil de volume d’une bougie jusqu’à la dernière', icon: vpIcon(true), tone: 'volume' },
  long_position: { label: 'Position longue', icon: positionIcon('long'), tone: 'position' },
  short_position: { label: 'Position courte', icon: positionIcon('short'), tone: 'position' },
  position_3pt: { label: 'Position : entrée, stop puis objectif (3 clics)', icon: positionIcon('3pt'), tone: 'position' },
  position_rr: { label: 'Position à R:R prédéfini : entrée puis stop', icon: rrIcon(), tone: 'position' },
  ruler: { label: 'Règle', icon: rulerIcon(), tone: 'measure' },
  alert: { label: 'Alerte de prix', icon: '🔔', tone: 'amber' },
};

// the classes that colour a tool's button or menu icon
export const toneClass = (tool: DrawTool) => `tool-tone tone-${TOOL_INFO[tool]?.tone ?? 'cursor'}`;

// tools that draw something (and can therefore get a saved style)
export const DRAWABLE_TOOLS = (Object.keys(TOOL_INFO) as DrawTool[]).filter((t) => t !== 'cursor' && t !== 'alert');

export const LINE_STYLES: { id: LineStyleName; label: string; glyph: string }[] = [
  { id: 'solid', label: 'Continu', glyph: '━' },
  { id: 'dashed', label: 'Tirets', glyph: '╍' },
  { id: 'dotted', label: 'Pointillés', glyph: '┄' },
];

export const DEFAULT_TOOL_COLOR: Partial<Record<DrawTool, string>> = {
  horizontal_line: '#f0b90b',
  hline_right: '#2962ff',
  hline_both: '#f23645',
  hline_left: '#089981',
  text: '#e0e0e0',
  long_position: '#26a69a',
  short_position: '#ef5350',
  position_3pt: '#26a69a',
  position_rr: '#26a69a',
};
