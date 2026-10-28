import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QUICK_COLORS } from './colors';

// TradingView-like color picker: palette, custom color and opacity. Colors are
// #rrggbb, or #rrggbbaa when not fully opaque.

const HUES = ['#F23645', '#FF9800', '#FFEB3B', '#4CAF50', '#089981', '#00BCD4', '#2962FF', '#673AB7', '#9C27B0', '#E91E63'];
const GRAYS = ['#FFFFFF', '#D1D4DC', '#B2B5BE', '#9598A1', '#787B86', '#5D606B', '#434651', '#2A2E39', '#131722', '#000000'];

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
function mix(hex: string, other: [number, number, number], t: number) {
  const [r, g, b] = rgbOf(hex);
  return toHex(r + (other[0] - r) * t, g + (other[1] - g) * t, b + (other[2] - b) * t);
}
// lighter and darker shades of each hue, like TradingView's grid
const SHADES = [0.8, 0.6, 0.4, 0.2, 0, -0.25, -0.5].map((t) => HUES.map((h) => (t >= 0 ? mix(h, [255, 255, 255], t) : mix(h, [0, 0, 0], -t))));

// '#rgb', '#rrggbb', '#rrggbbaa' or 'rgba(...)' -> base color and opacity (0..1)
function splitColor(c: string): { hex: string; alpha: number } {
  const s = c.trim();
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { hex: toHex(p[0], p[1], p[2]), alpha: p[3] ?? 1 };
  }
  let h = s.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  const hex = `#${h.slice(0, 6).toUpperCase()}`;
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { hex: /^#[0-9A-F]{6}$/.test(hex) ? hex : '#2962FF', alpha };
}

function joinColor(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return a >= 255 ? hex : `${hex}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

function ColorPopover({ value, anchor, onChange, onClose }: { value: string; anchor: DOMRect; onChange: (c: string) => void; onClose: () => void }) {
  const { hex, alpha } = splitColor(value);
  const custom = useRef<HTMLInputElement>(null);
  const [opacity, setOpacity] = useState(Math.round(alpha * 100));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const host = document.querySelector('.app') ?? document.body;
  const W = 252, H = 380;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
  const top = anchor.bottom + 6 + H > window.innerHeight ? Math.max(8, anchor.top - H - 6) : anchor.bottom + 6;
  const pick = (h: string) => onChange(joinColor(h, opacity / 100));
  const cell = (c: string) => (
    <button
      key={c} className={`cp-cell ${c === hex ? 'on' : ''}`} style={{ background: c }} title={c}
      onClick={() => pick(c)}
    />
  );
  return createPortal(
    <>
      <div className="cp-backdrop" onMouseDown={onClose} />
      <div className="cp-pop" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-sub cp-sub-top">Palette</div>
        <div className="cp-grid cp-quick">{QUICK_COLORS.map(cell)}</div>
        <div className="cp-grid">{GRAYS.map(cell)}</div>
        <div className="cp-grid cp-hues">{SHADES.flat().map(cell)}</div>
        <div className="cp-custom">
          <button className="cp-add" title="Couleur personnalisée" onClick={() => custom.current?.click()}>＋</button>
          <input ref={custom} type="color" value={hex.toLowerCase()} onChange={(e) => pick(e.target.value.toUpperCase())} />
          <span className="cp-current" style={{ background: joinColor(hex, opacity / 100) }} />
          <span className="cp-hex">{hex}</span>
        </div>
        <div className="cp-sub">Opacité</div>
        <div className="cp-opacity">
          <div className="cp-slider" style={{ background: `linear-gradient(to right, transparent, ${hex}), repeating-conic-gradient(#808080 0% 25%, #c0c0c0 0% 50%) 50% / 8px 8px` }}>
            <input
              type="range" min={0} max={100} value={opacity}
              onChange={(e) => { const v = parseInt(e.target.value); setOpacity(v); onChange(joinColor(hex, v / 100)); }}
            />
          </div>
          <span>{opacity} %</span>
        </div>
      </div>
    </>,
    host,
  );
}

// a color swatch that opens the picker (the checkerboard shows through transparent colors)
export function ColorSwatch({ value, onChange, title }: { value: string; onChange: (c: string) => void; title?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button className="cp-swatch" title={title ?? 'Couleur et opacité'} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        <span style={{ background: value }} />
      </button>
      {anchor && <ColorPopover value={value} anchor={anchor} onChange={onChange} onClose={() => setAnchor(null)} />}
    </>
  );
}
