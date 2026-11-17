import { useState } from 'react';
import { ColorSwatch } from './ColorPicker';
import { useStore, nextId } from '../store/store';
import { DRAWABLE_TOOLS, LINE_STYLES, TOOL_INFO } from './toolInfo';
import { hasStyle, styleCaps } from './drawingStyle';
import { defaultFib } from './fibSettings';
import type { DrawingPreset, DrawTool, LineStyleName } from '../types';

// the tools a colour or a stroke changes (the volume profiles and the positions have
// their own settings: their templates are saved from the drawing's toolbar)
const STYLED_TOOLS = DRAWABLE_TOOLS.filter(hasStyle);

export function PresetIcon({ preset }: { preset: DrawingPreset }) {
  return (
    <span className="preset-icon" style={{ color: preset.color }}>
      {TOOL_INFO[preset.tool].icon}
      <i style={{ background: preset.color }} />
    </span>
  );
}

// the colours offered with one click (any other through the swatch at the end)
const COLORS: [string, string][] = [
  ['#2962ff', 'bleu'], ['#f23645', 'rouge'], ['#089981', 'vert'], ['#ff9800', 'orange'],
  ['#f0b90b', 'jaune'], ['#9c27b0', 'violet'], ['#00bcd4', 'cyan'], ['#787b86', 'gris'],
];
const WIDTHS = [1, 2, 3, 4];
const DASH: Record<LineStyleName, string | undefined> = { solid: undefined, dashed: '6 4', dotted: '0.1 4' };

// a stroke as it will be drawn: its colour, thickness and style
function LineSample({ color, width, style, length = 28 }: { color: string; width: number; style: LineStyleName; length?: number }) {
  return (
    <svg width={length} height="12" viewBox={`0 0 ${length} 12`} aria-hidden="true">
      <line x1="2" y1="6" x2={length - 2} y2="6" stroke={color} strokeWidth={width} strokeDasharray={DASH[style]} strokeLinecap={style === 'dotted' ? 'round' : 'butt'} />
    </svg>
  );
}

// ProRealTime-style saved drawings: a tool with its colour and stroke, drawn in one click
export default function DrawingPresetsPanel({ at, onClose }: { at: { x: number; y: number }; onClose: () => void }) {
  const presets = useStore((s) => s.drawingPresets);
  const addDrawingPreset = useStore((s) => s.addDrawingPreset);
  const removeDrawingPreset = useStore((s) => s.removeDrawingPreset);
  const selectPreset = useStore((s) => s.selectPreset);
  const favoriteTools = useStore((s) => s.favoriteTools);
  const toggleFavoriteTool = useStore((s) => s.toggleFavoriteTool);
  const setFavoritesBar = useStore((s) => s.setFavoritesBar);
  const [tool, setTool] = useState<DrawTool>('rectangle');
  const [color, setColor] = useState('#2962ff');
  const [width, setWidth] = useState(2);
  const [lineStyle, setLineStyle] = useState<LineStyleName>('solid');
  const [name, setName] = useState('');
  const caps = styleCaps(tool);

  function create() {
    const colorName = COLORS.find(([c]) => c.toLowerCase() === color.toLowerCase())?.[1];
    addDrawingPreset({
      id: nextId(), name: name.trim() || (colorName ? `${TOOL_INFO[tool].label} · ${colorName}` : TOOL_INFO[tool].label), tool, color, lineWidth: width,
      lineStyle: lineStyle === 'solid' || !caps.style ? undefined : lineStyle,
      // a Fibo in one colour: all its levels take the chosen one
      ...(tool === 'fib_retracement' || tool === 'fib_extension' ? { fib: { ...defaultFib(tool), oneColor: true } } : {}),
    });
    setFavoritesBar({ visible: true });
    setName('');
  }

  const top = Math.min(at.y, window.innerHeight - 600);

  return (
    <>
      <div className="sm-backdrop" onMouseDown={onClose} />
      <div className="presets-panel" style={{ left: at.x, top: Math.max(8, top) }}>
        <div className="pp-title">Mes styles de dessin</div>
        <div className="pp-hint">Un outil, une couleur, un trait : un clic dessus et vous dessinez avec.</div>

        {presets.length === 0
          ? <div className="pp-empty">Aucun style pour l’instant : composez-en un ci-dessous.</div>
          : (
            <div className="pp-chips">
              {presets.map((p) => {
                const fav = favoriteTools.includes(`preset:${p.id}`);
                return (
                  <div key={p.id} className="pp-chip" title={`${p.name} : cliquer pour dessiner avec`} onClick={() => { selectPreset(p.id); onClose(); }}>
                    <span className="pp-chip-icon" style={{ color: p.color }}>{TOOL_INFO[p.tool].icon}</span>
                    <LineSample color={p.color} width={p.lineWidth} style={p.lineStyle ?? 'solid'} length={34} />
                    <span className="pp-chip-name">{p.name}</span>
                    <button
                      className={`pp-chip-star ${fav ? 'on' : ''}`} title={fav ? 'Retirer de la barre des favoris' : 'Mettre dans la barre des favoris'}
                      onClick={(e) => { e.stopPropagation(); toggleFavoriteTool(`preset:${p.id}`); }}
                    >{fav ? '★' : '☆'}</button>
                    <button className="pp-chip-del" title="Supprimer ce style" onClick={(e) => { e.stopPropagation(); removeDrawingPreset(p.id); }}>✕</button>
                  </div>
                );
              })}
            </div>
          )}

        <div className="pp-sep" />
        <div className="pp-title">Nouveau style</div>

        <div className="pp-label">Outil</div>
        <div className="pp-tools">
          {STYLED_TOOLS.map((t) => (
            <button key={t} className={`pp-pick ${tool === t ? 'on' : ''}`} style={{ color }} title={TOOL_INFO[t].label} onClick={() => setTool(t)}>
              {TOOL_INFO[t].icon}
            </button>
          ))}
        </div>

        <div className="pp-label">Couleur</div>
        <div className="pp-colors">
          {COLORS.map(([c, n]) => (
            <button key={c} className={`pp-dot ${color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} title={n} onClick={() => setColor(c)} />
          ))}
          <ColorSwatch value={color} onChange={setColor} title="Autre couleur" />
        </div>

        {/* (a text has no stroke: its colour only) */}
        {(caps.width || caps.style) && (
          <>
            <div className="pp-label">Trait</div>
            <div className="pp-strokes">
              {caps.width && WIDTHS.map((w) => (
                <button key={w} className={`pp-pick wide ${width === w ? 'on' : ''}`} title={`${w} px`} onClick={() => setWidth(w)}>
                  <LineSample color="currentColor" width={w} style="solid" />
                </button>
              ))}
              <span className="pp-gap" />
              {caps.style && LINE_STYLES.map((l) => (
                <button key={l.id} className={`pp-pick wide ${lineStyle === l.id ? 'on' : ''}`} title={l.label} onClick={() => setLineStyle(l.id)}>
                  <LineSample color="currentColor" width={2} style={l.id} />
                </button>
              ))}
            </div>
          </>
        )}

        <div className="pp-preview">
          <span className="pp-chip-icon big" style={{ color }}>{TOOL_INFO[tool].icon}</span>
          {(caps.width || caps.style) && <LineSample color={color} width={width} style={lineStyle} length={60} />}
          <input className="pp-name-input" placeholder="Nom (facultatif)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        </div>
        <button className="pill-btn pp-add" onClick={create} title="Le style rejoint la liste et la barre des favoris">＋ Ajouter</button>
      </div>
    </>
  );
}
