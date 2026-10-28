import { useState } from 'react';
import { useChartUi } from '../store/chartUi';
import { reopenPopout } from './popouts';

// Chrome opens one pop-up per click unless pop-ups are allowed for the site: the
// windows of a workspace it blocked wait here. One click opens all of them when
// pop-ups are allowed, else the next one, and says how to allow them once for all.
export default function PendingPopoutsBar() {
  const pending = useChartUi((s) => s.pendingPopouts);
  const setPending = useChartUi((s) => s.setPendingPopouts);
  const [blockedAgain, setBlockedAgain] = useState(false);
  if (!pending.length) return null;

  const openAll = () => {
    const left = pending.filter((p) => !reopenPopout(p, true));
    setBlockedAgain(left.length > 0);
    setPending(left);
  };
  const n = pending.length;

  return (
    <div className="pending-bar">
      <span>
        {n} fenêtre{n > 1 ? 's' : ''} de l’espace bloquée{n > 1 ? 's' : ''} par le navigateur
        <small>
          {blockedAgain
            ? ` — pour tout ouvrir d’un coup : dans Chrome, chrome://settings/content/popups › « Autorisés à envoyer des pop-ups » › Ajouter ${location.origin}, puis Ouvrir.`
            : ' — autorisez les pop-ups pour ce site une fois, et tout s’ouvrira d’un coup à sa place.'}
        </small>
      </span>
      <button className="pill-btn" onClick={openAll}>
        Ouvrir {n > 1 ? `les ${n} fenêtres` : pending[0].symbol.ticker}
      </button>
      <button className="remove-btn" title="Ignorer" onClick={() => { setPending([]); setBlockedAgain(false); }}>✕</button>
    </div>
  );
}
