import { useStore } from '../store/store';
import type { IndicatorTemplate, WatchlistTab } from '../types';

// The watchlists and the indicator templates saved on disk by the local server
// (scripts/list-backup.ts): a few seconds after each change, the main window sends them;
// sauvegardes/listes keeps the day's last state for 60 days. The "Sauvegardes des listes et modèles"
// window lists them, puts one back, and exports / imports a file.

const API = '/api/backup/lists';
const DELAY = 4000;

export type ListBackup = { name: string; savedAt: number; client: string | null; beforeRestore: boolean; lists: number; symbols: number; names: string[]; templates: number };

// this browser's id: each browser opened on the platform writes its own files, never another's
let clientId: string | null = null;
export function backupClient(): string {
  if (clientId) return clientId;
  try { clientId = localStorage.getItem('tesh.backup.client'); } catch { /* private mode */ }
  if (!clientId || !/^[a-z0-9]{1,12}$/.test(clientId)) {
    clientId = Math.random().toString(36).slice(2, 10) || 'web';
    try { localStorage.setItem('tesh.backup.client', clientId); } catch { /* private mode */ }
  }
  return clientId;
}

async function send(label?: string) {
  const { watchlists, indicatorTemplates } = useStore.getState();
  await fetch(`${API}/?client=${backupClient()}${label ? `&label=${label}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchlists, indicatorTemplates }),
  });
}

// in the main window: the lists and templates go to disk after each change (and once on start)
export function startListBackup(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void send().catch(() => undefined); }, DELAY);
  };
  later();
  const off = useStore.subscribe((s, prev) => { if (s.watchlists !== prev.watchlists || s.indicatorTemplates !== prev.indicatorTemplates) later(); });
  return () => { clearTimeout(timer); off(); };
}

export async function listBackups(): Promise<ListBackup[]> {
  const res = await fetch(`${API}/`);
  if (!res.ok) throw new Error(`sauvegardes indisponibles (${res.status})`);
  return ((await res.json()) as { files: ListBackup[] }).files;
}

const isTabs = (v: unknown): v is WatchlistTab[] =>
  Array.isArray(v) && v.length > 0 && v.every((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.items));
const templatesOf = (v: unknown): IndicatorTemplate[] =>
  Array.isArray(v) ? v.filter((t) => t && typeof t.name === 'string' && Array.isArray(t.indicators)) : [];

// the lists replaced by a backup's (or an imported file's), the current ones saved first, apart;
// its indicator templates that are missing here added (none replaced). How many templates came back
async function restore(watchlists: WatchlistTab[], templates: IndicatorTemplate[]): Promise<number> {
  await send('avant-restauration').catch(() => undefined);
  const st = useStore.getState();
  useStore.setState({ watchlists, activeWatchlistId: watchlists.some((t) => t.id === st.activeWatchlistId) ? st.activeWatchlistId : watchlists[0].id });
  return st.mergeIndicatorTemplates(templates);
}

export async function restoreBackup(name: string): Promise<number> {
  const res = await fetch(`${API}/file?name=${encodeURIComponent(name)}`);
  const data = (await res.json()) as { watchlists?: unknown; indicatorTemplates?: unknown };
  if (!res.ok || !isTabs(data.watchlists)) throw new Error('sauvegarde illisible');
  return restore(data.watchlists, templatesOf(data.indicatorTemplates));
}

// a file to keep anywhere (a USB key, another PC)
export function exportLists() {
  const { watchlists, indicatorTemplates } = useStore.getState();
  const blob = new Blob([JSON.stringify({ format: 'teshterminal-listes', savedAt: Date.now(), watchlists, indicatorTemplates }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `listes-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importLists(file: File): Promise<number> {
  const data = JSON.parse(await file.text()) as { watchlists?: unknown; indicatorTemplates?: unknown };
  if (!isTabs(data.watchlists)) throw new Error('ce fichier ne contient pas de listes');
  return restore(data.watchlists, templatesOf(data.indicatorTemplates));
}
