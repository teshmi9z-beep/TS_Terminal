import { useState } from 'react';
import { useStore } from '../store/store';
import { DRAWABLE_TOOLS, TOOL_INFO, toneClass } from './toolInfo';
import { PresetIcon } from './DrawingPresetsPanel';
import type { DrawTool } from '../types';

// TradingView's floating "favorite drawing tools" bar: drag it by its grip anywhere
export default function FavoritesToolbar() {
  const bar = useStore((s) => s.favoritesBar);
  const setFavoritesBar = useStore((s) => s.setFavoritesBar);
  const favorites = useStore((s) => s.favoriteTools);
  const presets = useStore((s) => s.drawingPresets);
  const activeTool = useStore((s) => s.activeTool);
  const activePresetId = useStore((s) => s.activePresetId);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const selectPreset = useStore((s) => s.selectPreset);
  const toggleFavoriteTool = useStore((s) => s.toggleFavoriteTool);
  const [editing, setEditing] = useState(false);

  if (!bar.visible) return null;

  function onGripDown(e: React.MouseEvent) {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, bx: bar.x, by: bar.y };
    const onMove = (ev: MouseEvent) => setFavoritesBar({
      x: Math.max(0, Math.min(window.innerWidth - 60, start.bx + ev.clientX - start.x)),
      y: Math.max(0, Math.min(window.innerHeight - 40, start.by + ev.clientY - start.y)),
    });
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className="fav-bar" style={{ left: bar.x, top: bar.y }}>
      <span className="fav-grip" onMouseDown={onGripDown} title="Déplacer">⋮⋮</span>
      {favorites.length === 0 && <span className="fav-empty">Clic droit sur un outil › Ajouter aux favoris</span>}
      {favorites.map((key) => {
        if (key.startsWith('preset:')) {
          const p = presets.find((x) => `preset:${x.id}` === key);
          if (!p) return null;
          return (
            <button
              key={key} className={`fav-btn ${activePresetId === p.id ? 'active' : ''}`} title={p.name}
              onClick={() => selectPreset(p.id)} onContextMenu={(e) => { e.preventDefault(); toggleFavoriteTool(key); }}
            >
              <PresetIcon preset={p} />
            </button>
          );
        }
        const tool = key as DrawTool;
        const info = TOOL_INFO[tool];
        if (!info) return null;
        return (
          <button
            key={key} className={`fav-btn ${toneClass(tool)} ${activeTool === tool && !activePresetId ? 'active' : ''}`}
            title={`${info.label} (clic droit : retirer)`}
            onClick={() => setActiveTool(tool)} onContextMenu={(e) => { e.preventDefault(); toggleFavoriteTool(key); }}
          >
            {info.icon}
          </button>
        );
      })}
      <button className={`fav-btn fav-edit ${editing ? 'active' : ''}`} title="Ajouter / retirer des outils" onClick={() => setEditing((v) => !v)}>＋</button>
      <button className="fav-close" title="Masquer la barre" onClick={() => setFavoritesBar({ visible: false })}>✕</button>
      {editing && (
        <div className="fav-menu">
          <div className="pp-title">Outils de la barre</div>
          {([...DRAWABLE_TOOLS, 'alert'] as DrawTool[]).map((t) => (
            <label key={t} className="fav-menu-item">
              <input type="checkbox" checked={favorites.includes(t)} onChange={() => toggleFavoriteTool(t)} />
              <span className={`fav-menu-icon ${toneClass(t)}`}>{TOOL_INFO[t].icon}</span>{TOOL_INFO[t].label}
            </label>
          ))}
          {presets.length > 0 && <div className="pp-title">Modèles</div>}
          {presets.map((p) => (
            <label key={p.id} className="fav-menu-item">
              <input type="checkbox" checked={favorites.includes(`preset:${p.id}`)} onChange={() => toggleFavoriteTool(`preset:${p.id}`)} />
              <span className="fav-menu-icon"><PresetIcon preset={p} /></span>{p.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
