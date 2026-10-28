import { useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { TOOL_INFO, toneClass } from './toolInfo';
import DrawingPresetsPanel from './DrawingPresetsPanel';
import type { DrawTool } from '../types';

// an order ticket with its stop (red) and target (green) lines
function OrderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <line x1="2" y1="4" x2="16" y2="4" stroke="#089981" strokeWidth="1.6" strokeDasharray="2.5 1.5" />
      <line x1="2" y1="9" x2="16" y2="9" stroke="#2962ff" strokeWidth="1.8" />
      <line x1="2" y1="14" x2="16" y2="14" stroke="#f23645" strokeWidth="1.6" strokeDasharray="2.5 1.5" />
    </svg>
  );
}

// a horseshoe magnet, red with grey poles when on; the strong magnet has its poles filled
function MagnetIcon({ strong, on = true }: { strong: boolean; on?: boolean }) {
  const body = on ? '#f23645' : 'currentColor', pole = on ? '#9598a1' : 'currentColor';
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" strokeWidth="1.6">
      <path d="M4 5.9v3.6a5 5 0 0 0 10 0v-3.6" stroke={body} />
      <rect x="2.9" y="2.5" width="3.2" height="3.4" rx="0.6" stroke={pole} fill={strong ? pole : 'none'} />
      <rect x="11.9" y="2.5" width="3.2" height="3.4" rx="0.6" stroke={pole} fill={strong ? pole : 'none'} />
    </svg>
  );
}

// a bin, in the button's (red) colour whatever the emoji font
function BinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3 4.5h12M7 4.5V3h4v1.5M4.5 4.5l.8 10.5h7.4l.8-10.5M7.5 7.5v5M10.5 7.5v5" />
    </svg>
  );
}

const MAGNET_LABEL = { weak: 'Aimant faible', strong: 'Aimant fort' } as const;

export default function LeftToolbar() {
  const activeTool = useStore((s) => s.activeTool);
  const setActiveTool = useStore((s) => s.setActiveTool);
  const activePresetId = useStore((s) => s.activePresetId);
  const clearDrawings = useStore((s) => s.clearDrawings);
  const ticker = useStore((s) => s.symbol.ticker);
  const toolOrder = useStore((s) => s.toolOrder);
  const reorderToolbar = useStore((s) => s.reorderToolbar);
  const favoriteTools = useStore((s) => s.favoriteTools);
  const toggleFavoriteTool = useStore((s) => s.toggleFavoriteTool);
  const favoritesBar = useStore((s) => s.favoritesBar);
  const setFavoritesBar = useStore((s) => s.setFavoritesBar);
  const dragIndex = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ tool: DrawTool; x: number; y: number } | null>(null);
  const [presetsAt, setPresetsAt] = useState<{ x: number; y: number } | null>(null);
  const magnet = useStore((s) => s.magnet);
  const magnetMode = useStore((s) => s.magnetMode);
  const setMagnet = useStore((s) => s.setMagnet);
  const [magnetMenu, setMagnetMenu] = useState<{ x: number; y: number } | null>(null);
  const orderPlacing = useChartUi((s) => s.orderPlacing);
  const setOrderPlacing = useChartUi((s) => s.setOrderPlacing);
  // picking the replay's start bar: no order then (during the replay they go to the replay account)
  const replaySelect = useChartUi((s) => s.replay.mode === 'select');

  return (
    <div className="left-toolbar">
      {/* first, so it stays in sight on short screens */}
      <button
        title={replaySelect
          ? 'Ordre sur le graphique : choisissez d’abord la barre de départ du replay'
          : 'Ordre sur le graphique (compte virtuel) : cliquez le prix d’entrée puis glissez jusqu’au stop. Limite ou stop selon le prix, TP et SL déplaçables.'}
        className={`tool-btn order-btn ${orderPlacing ? 'active' : ''}`}
        disabled={replaySelect}
        onClick={() => setOrderPlacing(!orderPlacing)}
      >
        <OrderIcon />
      </button>
      <div className="toolbar-sep" />
      {toolOrder.map((tool, i) => {
        const info = TOOL_INFO[tool];
        return (
          <button
            key={tool}
            title={`${info.label} — clic droit : favoris`}
            className={`tool-btn ${toneClass(tool)} ${activeTool === tool ? 'active' : ''} ${activeTool === tool && activePresetId ? 'preset' : ''}`}
            draggable
            onDragStart={() => { dragIndex.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (dragIndex.current !== null) reorderToolbar(dragIndex.current, i); dragIndex.current = null; }}
            onClick={() => setActiveTool(tool)}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ tool, x: e.clientX, y: e.clientY }); }}
          >
            {info.icon}
            {favoriteTools.includes(tool) && <span className="tool-fav-dot">★</span>}
          </button>
        );
      })}
      <div className="toolbar-sep" />
      <button
        title={`${magnet === 'off' ? `Aimant désactivé — clic : ${MAGNET_LABEL[magnetMode].toLowerCase()}` : `${MAGNET_LABEL[magnet]} — clic : désactiver`} · clic droit : aimant faible ou fort`}
        className={`tool-btn ${magnet !== 'off' ? 'tool-tone tone-red active' : ''}`}
        onClick={() => setMagnet(magnet === 'off' ? magnetMode : 'off')}
        onContextMenu={(e) => { e.preventDefault(); setMagnetMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <MagnetIcon strong={(magnet === 'off' ? magnetMode : magnet) === 'strong'} on={magnet !== 'off'} />
      </button>
      <button
        title="Modèles de dessin (styles enregistrés)" className={`tool-btn tool-tone tone-shape ${presetsAt ? 'active' : ''}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPresetsAt(presetsAt ? null : { x: r.right + 6, y: r.top });
        }}
      >
        ◧
      </button>
      <button
        title={favoritesBar.visible ? 'Masquer la barre des favoris' : 'Afficher la barre mobile des favoris'}
        className={`tool-btn tool-tone tone-amber ${favoritesBar.visible ? 'active' : ''}`}
        onClick={() => setFavoritesBar({ visible: !favoritesBar.visible })}
      >
        ★
      </button>
      <button title={`Effacer les dessins de ${ticker}`} className="tool-btn tool-tone tone-red" onClick={() => clearDrawings(ticker)}><BinIcon /></button>

      {menu && (
        <>
          <div className="sm-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="symbol-menu tool-menu" style={{ left: menu.x + 4, top: menu.y }}>
            <div className="sm-item" onClick={() => { setActiveTool(menu.tool); setMenu(null); }}>
              <span className={`sm-icon ${toneClass(menu.tool)}`}>{TOOL_INFO[menu.tool].icon}</span><span className="sm-label">{TOOL_INFO[menu.tool].label}</span>
            </div>
            <div className="sm-sep" />
            <div className="sm-item" onClick={() => { toggleFavoriteTool(menu.tool); setFavoritesBar({ visible: true }); setMenu(null); }}>
              <span className="sm-icon tool-tone tone-amber">{favoriteTools.includes(menu.tool) ? '★' : '☆'}</span>
              <span className="sm-label">{favoriteTools.includes(menu.tool) ? 'Retirer des favoris' : 'Ajouter aux favoris'}</span>
            </div>
          </div>
        </>
      )}
      {magnetMenu && (
        <>
          <div className="sm-backdrop" onMouseDown={() => setMagnetMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMagnetMenu(null); }} />
          <div className="symbol-menu tool-menu" style={{ left: magnetMenu.x + 4, top: magnetMenu.y }}>
            {(['weak', 'strong'] as const).map((m) => (
              <div key={m} className="sm-item" onClick={() => { setMagnet(m); setMagnetMenu(null); }}>
                <span className="sm-icon"><MagnetIcon strong={m === 'strong'} /></span>
                <span className="sm-label">{MAGNET_LABEL[m]}{m === 'weak' ? ' (près d’un prix)' : ' (toujours)'}</span>
                {magnet === m && <span className="sm-check">✓</span>}
              </div>
            ))}
            <div className="sm-sep" />
            <div className="sm-item" onClick={() => { setMagnet('off'); setMagnetMenu(null); }}>
              <span className="sm-icon" /><span className="sm-label">Désactiver l’aimant</span>
              {magnet === 'off' && <span className="sm-check">✓</span>}
            </div>
          </div>
        </>
      )}
      {presetsAt && <DrawingPresetsPanel at={presetsAt} onClose={() => setPresetsAt(null)} />}
    </div>
  );
}
