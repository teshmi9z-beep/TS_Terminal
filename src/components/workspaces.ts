import { useStore, nextId, comparesOf, WORKSPACE_KEYS, type Popout, type Workspace, type WorkspaceChartState } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { closeAllPopouts, ensureScreenAccess, onOtherScreen, reopenPopout } from './popouts';
import { endReplaySession } from './tradingAccount';

const POPOUT_KEY = (id: string) => `platform_popout_${id}`;
const FILE_FORMAT = 'teshterminal-workspace';

function pickChartState(state: Record<string, unknown>): WorkspaceChartState {
  const out: Record<string, unknown> = {};
  for (const k of WORKSPACE_KEYS) if (state[k] !== undefined) out[k] = state[k];
  return JSON.parse(JSON.stringify(out));
}

function readPopoutState(id: string): WorkspaceChartState {
  try {
    const raw = localStorage.getItem(POPOUT_KEY(id));
    return raw ? pickChartState(JSON.parse(raw).state ?? {}) : {};
  } catch {
    return {};
  }
}

// the open detached windows (all, or those of one layout), with their place and content
export function capturePopouts(layoutId?: string): Workspace['popouts'] {
  return useStore.getState().popouts
    .filter((p) => p.open && (layoutId === undefined || p.layoutId === layoutId))
    .map((p) => ({ symbol: p.symbol, tf: p.tf, left: p.left, top: p.top, width: p.width, height: p.height, state: readPopoutState(p.id) }));
}

// snapshot of the main window and of every open detached window (with its position)
export function captureWorkspace(name: string, id: string = nextId()): Workspace {
  const st = useStore.getState();
  const existing = st.workspaces.find((w) => w.id === id);
  return {
    id,
    name,
    shortcut: existing?.shortcut,
    savedAt: Date.now(),
    main: pickChartState(st as unknown as Record<string, unknown>),
    popouts: capturePopouts(),
  };
}

// after a save the open windows belong to that workspace; windows on another screen
// need the window management permission to be put back there (asked now, on the click)
export function claimPopouts(layoutId: string) {
  const st = useStore.getState();
  const open = st.popouts.filter((p) => p.open);
  for (const p of open) st.upsertPopout({ id: p.id, layoutId });
  if (open.some(onOtherScreen)) void ensureScreenAccess(true);
}

// Opens a workspace's detached windows at their saved place, all at once when pop-ups
// are allowed for the site. Chrome otherwise opens one window per click: the others
// wait in the bar at the bottom (PendingPopoutsBar).
export async function openWorkspacePopouts(list: Workspace['popouts'], layoutId: string | null) {
  if (!list.length) return;
  if (list.some(onOtherScreen)) await ensureScreenAccess(true);
  const blocked: Popout[] = [];
  for (const p of list) {
    const id = `p${nextId()}`;
    // seed the window's own saved state before it opens
    const seed = { ...pickChartState(useStore.getState() as unknown as Record<string, unknown>), ...p.state, layout: 1, popouts: [], workspaces: [] };
    localStorage.setItem(POPOUT_KEY(id), JSON.stringify({ state: { ...seed, drawings: useStore.getState().drawings }, version: 0 }));
    const popout: Popout = { id, symbol: p.symbol, tf: p.tf, open: false, left: p.left, top: p.top, width: p.width, height: p.height, layoutId };
    if (!reopenPopout(popout, true)) {
      useStore.getState().upsertPopout(popout);
      blocked.push(popout);
    }
  }
  useChartUi.getState().setPendingPopouts(blocked);
}

// Restores a workspace: main window content + detached windows at their saved place.
export async function applyWorkspace(ws: Workspace, { saveUndo = true } = {}) {
  const st = useStore.getState();
  if (saveUndo) st.setWorkspaceUndo(captureWorkspace('Avant le dernier chargement', 'undo'));

  const previous = st.popouts.map((p) => p.id);
  closeAllPopouts();
  for (const id of previous) localStorage.removeItem(POPOUT_KEY(id));

  useStore.setState({ gridCharts: [], ...ws.main, compares: comparesOf(ws.main), popouts: [], activeTool: 'cursor', selectedDrawingId: null });
  // a replay being played ends with the workspace it belonged to
  endReplaySession();
  useChartUi.getState().setReplay({ mode: 'off', playing: false, time: null, at: null });
  useStore.getState().setCurrentWorkspace(ws.id === 'undo' ? null : ws.id);
  useChartUi.getState().setPendingPopouts([]);

  await openWorkspacePopouts(ws.popouts, ws.id === 'undo' ? null : ws.id);
  useChartUi.getState().showToast(`Espace de travail « ${ws.name} » chargé`);
}

export function undoLastLoad() {
  const undo = useStore.getState().workspaceUndo;
  if (!undo) return;
  void applyWorkspace(undo, { saveUndo: false });
  useStore.getState().setWorkspaceUndo(null);
}

// ready-made layouts, like ProRealTime's predefined workspaces
export function predefinedWorkspaces(): Workspace[] {
  const st = useStore.getState();
  const base = { savedAt: 0, popouts: [] };
  return [
    { ...base, id: 'pre-1', name: 'Initial (1 graphique)', main: { symbol: st.symbol, timeframe: st.timeframe, layout: 1 } },
    { ...base, id: 'pre-4', name: 'Grille de 4 graphiques', main: { symbol: st.symbol, timeframe: st.timeframe, layout: 4 } },
    { ...base, id: 'pre-free', name: 'Fenêtres libres', main: { symbol: st.symbol, timeframe: st.timeframe, layout: 'free' } },
  ];
}

export function exportWorkspace(ws: Workspace) {
  const { shortcut: _shortcut, ...portable } = ws;
  const blob = new Blob([JSON.stringify({ format: FILE_FORMAT, version: 1, workspace: portable }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `espace-${ws.name.replace(/[^\w-]+/g, '_')}.teshws.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importWorkspaceFile(file: File): Promise<Workspace> {
  const json = JSON.parse(await file.text());
  const ws = json?.format === FILE_FORMAT ? json.workspace : null;
  if (!ws || typeof ws.name !== 'string' || typeof ws.main !== 'object' || !Array.isArray(ws.popouts)) {
    throw new Error('Ce fichier n’est pas un espace de travail TeshTerminal');
  }
  const names = new Set(useStore.getState().workspaces.map((w) => w.name));
  let name = ws.name;
  for (let i = 2; names.has(name); i++) name = `${ws.name} (${i})`;
  const imported: Workspace = {
    id: nextId(), name, savedAt: Date.now(),
    main: pickChartState(ws.main),
    popouts: ws.popouts
      .filter((p: { symbol?: { ticker?: string } }) => p?.symbol?.ticker)
      .map((p: Workspace['popouts'][number]) => ({ ...p, state: pickChartState(p.state as Record<string, unknown> ?? {}) })),
  };
  useStore.getState().upsertWorkspace(imported);
  return imported;
}
