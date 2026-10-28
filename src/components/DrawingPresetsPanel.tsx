import { useState } from 'react';
import { ColorSwatch } from './ColorPicker';
import { useStore, nextId } from '../store/store';
import { DRAWABLE_TOOLS, LINE_STYLES, TOOL_INFO } from './toolInfo';
import type { DrawingPreset, DrawTool, LineStyleName } from '../types';

export function PresetIcon({ preset }: { preset: DrawingPreset }) {
  return (
    <span className="preset-icon" style={{ color: preset.color }}>
      {TOOL_INFO[preset.tool].icon}
      <i style={{ background: preset.color }} />
    </span>
  );
}

// ProRealTime-style saved drawings: "rectangle bleu", "ligne rouge pointillée"...
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

  function create() {
    addDrawingPreset({
      id: nextId(), name: name.trim() || `${TOOL_INFO[tool].label} ${color}`, tool, color, lineWidth: width,
      lineStyle: lineStyle === 'solid' ? undefined : lineStyle,
    });
    setFavoritesBar({ visible: true });
    setName('');
  }

  const top = Math.min(at.y, window.innerHeight - 460);

  return (
    <>
      <div className="sm-backdrop" onMouseDown={onClose} />
      <div className="presets-panel" style={{ left: at.x, top: Math.max(8, top) }}>
        <div className="pp-title">Modèles de dessin</div>
        {presets.length === 0 && <div className="pp-empty">Aucun modèle. Créez-en un ci-dessous, ou sélectionnez un dessin et cliquez sur ☆.</div>}
        <div className="pp-list">
          {presets.map((p) => {
            const fav = favoriteTools.includes(`preset:${p.id}`);
            return (
              <div key={p.id} className="pp-row" onClick={() => { selectPreset(p.id); onClose(); }} title="Dessiner avec ce modèle">
                <PresetIcon preset={p} />
                <span className="pp-name">{p.name}</span>
                <span className="pp-meta">{LINE_STYLES.find((l) => l.id === (p.lineStyle ?? 'solid'))?.glyph} {p.lineWidth}px</span>
                <button
                  className={`tf-menu-icon star ${fav ? 'on' : ''}`} title={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                  onClick={(e) => { e.stopPropagation(); toggleFavoriteTool(`preset:${p.id}`); }}
                >
                  {fav ? '★' : '☆'}
                </button>
                <button className="tf-menu-icon" title="Supprimer" onClick={(e) => { e.stopPropagation(); removeDrawingPreset(p.id); }}>✕</button>
              </div>
            );
          })}
        </div>
        <div className="pp-title">Nouveau modèle</div>
        <div className="pp-form">
          <select value={tool} onChange={(e) => setTool(e.target.value as DrawTool)}>
            {DRAWABLE_TOOLS.map((t) => <option key={t} value={t}>{TOOL_INFO[t].label}</option>)}
          </select>
          <ColorSwatch value={color} onChange={setColor} title="Couleur" />
          <select value={width} onChange={(e) => setWidth(parseInt(e.target.value))} title="Épaisseur">
            {[1, 2, 3, 4, 5, 6].map((w) => <option key={w} value={w}>{w}px</option>)}
          </select>
          <select value={lineStyle} onChange={(e) => setLineStyle(e.target.value as LineStyleName)} title="Style de trait">
            {LINE_STYLES.map((l) => <option key={l.id} value={l.id}>{l.glyph} {l.label}</option>)}
          </select>
          <input className="pp-name-input" placeholder="Nom (ex : Carré bleu)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <button className="pill-btn" onClick={create}>Créer et ajouter aux favoris</button>
        </div>
      </div>
    </>
  );
}
