import { useRef } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import {
  applyWorkspace, captureWorkspace, claimPopouts, exportWorkspace, importWorkspaceFile, predefinedWorkspaces, undoLastLoad,
} from './workspaces';

// ProRealTime-like workspace menu: saved workspaces (with F-key), predefined ones,
// save / manage / import / export / undo
export default function WorkspaceMenu({ at, onClose }: { at: { left: number; top: number }; onClose: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const currentId = useStore((s) => s.currentWorkspaceId);
  const undo = useStore((s) => s.workspaceUndo);
  const upsertWorkspace = useStore((s) => s.upsertWorkspace);
  const setCurrentWorkspace = useStore((s) => s.setCurrentWorkspace);
  const setManagerOpen = useChartUi((s) => s.setWorkspaceManagerOpen);
  const showToast = useChartUi((s) => s.showToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = workspaces.find((w) => w.id === currentId);

  const run = (fn: () => void) => () => { onClose(); fn(); };

  function saveAs() {
    const name = window.prompt('Nom du nouvel espace de travail :', current ? `${current.name} (copie)` : 'Mon espace');
    if (!name?.trim()) return;
    const ws = captureWorkspace(name.trim());
    upsertWorkspace(ws);
    setCurrentWorkspace(ws.id);
    claimPopouts(ws.id);
    showToast(`Espace « ${ws.name} » enregistré (${ws.popouts.length} fenêtre${ws.popouts.length > 1 ? 's' : ''} détachée${ws.popouts.length > 1 ? 's' : ''})`);
  }

  function saveCurrent() {
    if (!current) return;
    upsertWorkspace(captureWorkspace(current.name, current.id));
    claimPopouts(current.id);
    showToast(`Espace « ${current.name} » mis à jour`);
  }

  return (
    <>
      <div className="tb-dropdown-backdrop" onClick={onClose} />
      <div className="ws-menu" style={{ left: at.left, top: at.top }}>
        <div className="ws-title">Mes espaces de travail</div>
        {workspaces.length === 0 && <div className="ws-empty">Aucun espace enregistré</div>}
        {workspaces.map((w) => (
          <button key={w.id} className="ws-item" onClick={run(() => void applyWorkspace(w))}>
            <span className="ws-check">{w.id === currentId ? '✓' : ''}</span>
            <span className="ws-name">{w.name}</span>
            {w.popouts.length > 0 && <span className="ws-count" title="Fenêtres détachées">{w.popouts.length}↗</span>}
            <span className="ws-key">{w.shortcut ?? ''}</span>
          </button>
        ))}
        <div className="ws-title">Espaces de travail prédéfinis</div>
        {predefinedWorkspaces().map((w) => (
          <button key={w.id} className="ws-item" onClick={run(() => void applyWorkspace(w))}>
            <span className="ws-check" />
            <span className="ws-name">{w.name}</span>
          </button>
        ))}
        <div className="sm-sep" />
        {current && (
          <button className="ws-item" onClick={run(saveCurrent)}>
            <span className="ws-check">💾</span><span className="ws-name">Enregistrer « {current.name} »</span>
          </button>
        )}
        <button className="ws-item" onClick={run(saveAs)}>
          <span className="ws-check">＋</span><span className="ws-name">Enregistrer l’espace actuel sous…</span>
        </button>
        <button className="ws-item" onClick={run(() => setManagerOpen(true))}>
          <span className="ws-check">⚙</span><span className="ws-name">Gérer les espaces de travail…</span>
        </button>
        <button className="ws-item" onClick={() => fileRef.current?.click()}>
          <span className="ws-check">⤓</span><span className="ws-name">Importer un espace de travail</span>
        </button>
        <button className="ws-item" disabled={!current} onClick={run(() => current && exportWorkspace(current))}>
          <span className="ws-check">⤒</span><span className="ws-name">Exporter {current ? `« ${current.name} »` : '(aucun espace chargé)'}</span>
        </button>
        <button className="ws-item" disabled={!undo} onClick={run(undoLastLoad)}>
          <span className="ws-check">↶</span><span className="ws-name">Annuler le dernier chargement</span>
        </button>
        <input
          ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            importWorkspaceFile(file)
              .then((ws) => showToast(`Espace « ${ws.name} » importé : choisissez-le dans la liste pour le charger`))
              .catch((err) => showToast(String(err instanceof Error ? err.message : err)))
              .finally(onClose);
          }}
        />
      </div>
    </>
  );
}
