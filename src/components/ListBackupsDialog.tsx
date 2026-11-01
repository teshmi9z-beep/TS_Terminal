import { useEffect, useRef, useState } from 'react';
import { useChartUi } from '../store/chartUi';
import { backupClient, exportLists, importLists, listBackups, restoreBackup, type ListBackup } from './listBackup';
import { LOCALE } from '../i18n/lang';

const when = (t: number) => new Date(t).toLocaleString(LOCALE, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// "Sauvegardes des listes et modèles": the watchlists and indicator templates saved on disk day by
// day, one put back in a click (the current lists kept apart first, the missing templates added),
// and a file to export / import
export default function ListBackupsDialog({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<ListBackup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useChartUi((s) => s.showToast);

  useEffect(() => { listBackups().then(setFiles).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, []);

  // the lists replaced, the templates it has and you don't added (none replaced or removed)
  const done = (what: string, n: number) => { toast(n ? `${what} · ${n} modèle(s) d’indicateurs retrouvé(s)` : what); onClose(); };

  async function put(b: ListBackup) {
    if (!window.confirm(`Remplacer toutes vos listes par celles du ${when(b.savedAt)} (${b.lists} listes, ${b.symbols} symboles) et rajouter ses modèles d’indicateurs qui vous manquent ? Les listes actuelles sont gardées dans une sauvegarde à part.`)) return;
    try { done('Listes restaurées', await restoreBackup(b.name)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Sauvegardes des listes et modèles</div>
        <div className="popout-help">
          Vos listes et vos modèles d’indicateurs sont enregistrés tout seuls sur le disque, quelques secondes après chaque changement,
          dans le dossier <b>sauvegardes/listes</b> de la plateforme : la dernière version de chaque jour, gardée 60 jours
          (chaque navigateur a ses propres fichiers).
        </div>
        {error && <div className="yc-error">{error}</div>}
        {!files && !error && <div className="side-empty"><span className="spinner" /> Chargement…</div>}
        {files && files.length === 0 && <div className="side-empty">Aucune sauvegarde pour l’instant : la première arrive quelques secondes après l’ouverture.</div>}
        {files && files.length > 0 && (
          <div className="modal-list lb-list">
            {files.map((b) => (
              <div key={b.name} className="modal-item active-item lb-row" title={b.names.join(' · ')}>
                <span className="lb-date">
                  {when(b.savedAt)}{b.beforeRestore && <small> · avant une restauration</small>}
                  {b.client && b.client !== backupClient() && <small> · autre navigateur</small>}
                </span>
                <span className="lb-count">{b.lists} listes · {b.symbols} symboles{b.templates ? ` · ${b.templates} modèles` : ''}</span>
                <button className="pill-btn" onClick={() => void put(b)}>Restaurer</button>
              </div>
            ))}
          </div>
        )}
        <div className="popout-actions">
          <button className="pill-btn" onClick={exportLists}>⤒ Exporter dans un fichier</button>
          <button className="pill-btn" onClick={() => fileRef.current?.click()}>⤓ Importer un fichier</button>
        </div>
        <input
          ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file || !window.confirm('Remplacer toutes vos listes par celles de ce fichier ? Les listes actuelles sont gardées dans une sauvegarde à part.')) return;
            importLists(file).then((n) => done('Listes importées', n)).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        />
        <button className="pill-btn close-btn" onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
