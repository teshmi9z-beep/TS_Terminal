import { useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { closeAllPopouts, listScreens, openPopout, openPopoutOnScreen, reopenPopout, type ScreenInfo } from './popouts';
import { tfShortLabel } from '../data/timeframes';

export default function LayoutMenu({ onClose }: { onClose: () => void }) {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const resetLayout = useStore((s) => s.resetLayout);
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const popouts = useStore((s) => s.popouts);
  const removePopout = useStore((s) => s.removePopout);
  const [screens, setScreens] = useState<ScreenInfo[] | null>(null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal layout-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Disposition dans cet onglet</div>
        <div className="layout-options">
          {([1, 2, 4] as const).map((n) => (
            <button key={n} className={`layout-opt ${layout === n ? 'active' : ''}`} onClick={() => { setLayout(n); onClose(); }}>
              <div className={`layout-preview grid-${n}`}>
                {Array.from({ length: n }).map((_, i) => <span key={i} />)}
              </div>
              {n === 1 ? '1 fenêtre' : `${n} fenêtres`}
            </button>
          ))}
          <button className={`layout-opt ${layout === 'free' ? 'active' : ''}`} onClick={() => { setLayout('free'); onClose(); }}>
            <div className="layout-preview grid-free">
              <span style={{ left: 4, top: 4, width: '55%', height: '55%' }} />
              <span style={{ left: '35%', top: '30%', width: '55%', height: '55%' }} />
            </div>
            Libre
          </button>
        </div>

        <div className="modal-title">Fenêtres détachées (hors de l’onglet, multi-écrans)</div>
        <div className="popout-help">
          Chaque fenêtre détachée est une vraie fenêtre du navigateur : déplacez-la sur n’importe quel écran,
          elle garde son symbole, ses indicateurs et sa position.
          Astuce : glissez un actif de la liste de droite <b>en dehors</b> du navigateur pour l’ouvrir à cet endroit.
          Pour rouvrir plusieurs fenêtres d’un coup, autorisez les pop-ups pour localhost dans Chrome.
        </div>
        {window.locationbar?.visible && (
          // a normal Chrome tab: popups get a read-only address bar; app mode removes it
          <div className="popout-help popout-warn">
            Ouverte dans un onglet Chrome, les fenêtres détachées affichent la barre d’adresse.
            Lancez la plateforme avec <b>lancer.bat</b> (mode application) pour des fenêtres sans barre d’adresse ni onglets.
          </div>
        )}
        <div className="popout-actions">
          <button className="pill-btn" onClick={() => openPopout(symbol, timeframe)}>↗ Détacher {symbol.ticker}</button>
          <button className="pill-btn" onClick={() => void listScreens().then(setScreens)}>🖥 Choisir l’écran…</button>
        </div>
        {screens && (
          <div className="popout-screens">
            {screens.map((s, i) => (
              <button key={i} className="screen-btn" onClick={() => openPopoutOnScreen(symbol, timeframe, s)} title={`${s.width}×${s.height} à (${s.left}, ${s.top})`}>
                <span className="screen-shape" style={{ aspectRatio: `${s.width} / ${s.height}` }}>{i + 1}</span>
                <span>{s.label}{s.primary ? ' (principal)' : ''}</span>
              </button>
            ))}
            {screens.length === 1 && (
              <div className="popout-help">
                Un seul écran visible : autorisez « Gestion des fenêtres » quand Chrome le demande
                (ou via l’icône du cadenas) pour ouvrir directement sur vos autres écrans.
              </div>
            )}
          </div>
        )}
        {popouts.length > 0 && (
          <>
            <div className="modal-list popout-list">
              {popouts.map((p) => (
                <div key={p.id} className="modal-item active-item">
                  <span className={`popout-state ${p.open ? 'open' : ''}`} title={p.open ? 'Ouverte' : 'Fermée'} />
                  <span className="popout-name">{p.symbol.ticker} · {tfShortLabel(p.tf)}</span>
                  <span className="popout-geo">{p.width && p.height ? `${p.width}×${p.height}` : ''}</span>
                  <button className="pill-btn" onClick={() => reopenPopout(p)}>{p.open ? 'Afficher' : 'Rouvrir'}</button>
                  <button className="remove-btn" title="Oublier cette fenêtre" onClick={() => removePopout(p.id)}>✕</button>
                </div>
              ))}
            </div>
            <div className="popout-actions">
              <button className="pill-btn" onClick={() => {
                const blocked = popouts.filter((p) => !p.open).filter((p) => !reopenPopout(p, true));
                useChartUi.getState().setPendingPopouts(blocked);
              }}>Tout rouvrir</button>
              <button className="pill-btn" onClick={closeAllPopouts}>Tout fermer</button>
            </div>
          </>
        )}

        <button className="pill-btn" style={{ width: '100%', marginTop: 12 }} onClick={() => { resetLayout(); }}>
          ↺ Redéfinir les tailles par défaut
        </button>
        <button className="pill-btn close-btn" onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
