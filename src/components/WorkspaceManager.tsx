import { useEffect } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { applyWorkspace, captureWorkspace, claimPopouts, exportWorkspace } from './workspaces';
import { LOCALE } from '../i18n/lang';

const WORKSPACE_KEYS_F = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'];

// rename, shortcut key, update with the current layout, export, delete
export default function WorkspaceManager() {
  const workspaces = useStore((s) => s.workspaces);
  const currentId = useStore((s) => s.currentWorkspaceId);
  const patchWorkspace = useStore((s) => s.patchWorkspace);
  const upsertWorkspace = useStore((s) => s.upsertWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setOpen = useChartUi((s) => s.setWorkspaceManagerOpen);
  const showToast = useChartUi((s) => s.showToast);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="ws-manager" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ws-manager-head">
          <span className="si-title">Gérer les espaces de travail</span>
          <button className="remove-btn si-close" onClick={() => setOpen(false)}>✕</button>
        </div>
        {workspaces.length === 0 ? (
          <div className="si-loading">Aucun espace enregistré. Disposez vos fenêtres puis « Enregistrer l’espace actuel sous… ».</div>
        ) : (
          <table className="ws-table">
            <thead>
              <tr><th>Nom</th><th>Raccourci</th><th>Fenêtres</th><th>Enregistré</th><th /></tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id} className={w.id === currentId ? 'current' : ''}>
                  <td>
                    <input className="ws-rename" value={w.name} onChange={(e) => patchWorkspace(w.id, { name: e.target.value })} />
                  </td>
                  <td>
                    <select value={w.shortcut ?? ''} onChange={(e) => patchWorkspace(w.id, { shortcut: e.target.value || undefined })}>
                      <option value="">—</option>
                      {WORKSPACE_KEYS_F.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </td>
                  <td className="ws-num">1 + {w.popouts.length}</td>
                  <td className="ws-date">{new Date(w.savedAt).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td className="ws-actions">
                    <button className="pill-btn" onClick={() => { void applyWorkspace(w); setOpen(false); }}>Charger</button>
                    <button
                      className="pill-btn" title="Remplacer par la disposition actuelle"
                      onClick={() => { upsertWorkspace(captureWorkspace(w.name, w.id)); claimPopouts(w.id); showToast(`« ${w.name} » mis à jour`); }}
                    >
                      Mettre à jour
                    </button>
                    <button className="pill-btn" onClick={() => exportWorkspace(w)}>Exporter</button>
                    <button
                      className="remove-btn" title="Supprimer"
                      onClick={() => { if (window.confirm(`Supprimer l’espace « ${w.name} » ?`)) removeWorkspace(w.id); }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="popout-help ws-help">
          Un espace mémorise la fenêtre principale (symbole, unité, indicateurs, disposition) et chaque fenêtre détachée
          avec sa position sur vos écrans. Les dessins restent communs à tous les espaces.
          F5 remplace le rechargement de page quand il est attribué à un espace.
        </div>
      </div>
    </div>
  );
}
