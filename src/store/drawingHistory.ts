import { useSyncExternalStore } from 'react';
import { useStore, POPOUT_ID, POPOUT_TOOL } from './store';
import type { Drawing } from '../types';

// Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) for the drawings, like TradingView. The history keeps settled
// states only: no drawing half placed and no mouse button held. So a drag, a line placed in two
// clicks, or several drawings deleted at once each make one step. Quick edits to the same drawings
// (a price typed in a dialog, "thicker" clicked three times) merge into one step.
// Each window keeps its own history, in memory only (a reload starts it again).

const MAX = 100;
const MERGE_MS = 700;

const undoStack: Drawing[][] = [];
const redoStack: Drawing[][] = [];
let settled: Drawing[] = [];
let lastStep = { at: 0, ids: '' };
let pressed = false;
let timer: ReturnType<typeof setTimeout> | undefined;
// drawings left half placed by an earlier session (a reload while placing one) never block the history
let stale = new Set<string>();

const busy = (list: Drawing[]) => pressed || list.some((d) => !d.done && !stale.has(d.id));

// the top bar's ↶ ↷ buttons follow the two stacks (greyed when there is nothing to undo / redo)
const listeners = new Set<() => void>();
let snapshot = { canUndo: false, canRedo: false };
function notify() {
  const next = { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
  if (next.canUndo === snapshot.canUndo && next.canRedo === snapshot.canRedo) return;
  snapshot = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useDrawingHistory = () => useSyncExternalStore(subscribe, () => snapshot);

// the drawings that differ between two states, and whether some were added or removed
function diff(a: Drawing[], b: Drawing[]) {
  const before = new Map(a.map((d) => [d.id, d]));
  const after = new Map(b.map((d) => [d.id, d]));
  const ids: string[] = [];
  let addRemove = false;
  for (const [id, d] of after) {
    const old = before.get(id);
    if (!old) { ids.push(id); addRemove = true; } else if (old !== d) ids.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) { ids.push(id); addRemove = true; }
  return { ids: ids.sort().join(','), addRemove };
}

function settle() {
  timer = undefined;
  const now = useStore.getState().drawings;
  if (now === settled || busy(now)) return;
  const { ids, addRemove } = diff(settled, now);
  if (ids) {
    const merge = !addRemove && undoStack.length > 0 && ids === lastStep.ids && Date.now() - lastStep.at < MERGE_MS;
    if (!merge) {
      undoStack.push(settled);
      if (undoStack.length > MAX) undoStack.shift();
    }
    redoStack.length = 0;
    lastStep = { at: Date.now(), ids: addRemove ? '' : ids };
  }
  settled = now;
  notify();
}
// changes made in one go (a loop of removeDrawing) are looked at together, once they are done
const later = () => { clearTimeout(timer); timer = setTimeout(settle, 0); };

function restore(list: Drawing[]) {
  settled = list;
  lastStep = { at: 0, ids: '' };
  useStore.setState((st) => ({
    drawings: list,
    selectedDrawingId: st.selectedDrawingId && list.some((d) => d.id === st.selectedDrawingId) ? st.selectedDrawingId : null,
  }));
}

// false when there was nothing to undo (or a drawing is being placed: Escape cancels that one)
export function undoDrawing(): boolean {
  if (timer) { clearTimeout(timer); settle(); }
  if (busy(useStore.getState().drawings) || !undoStack.length) return false;
  redoStack.push(settled);
  restore(undoStack.pop()!);
  notify();
  return true;
}

export function redoDrawing(): boolean {
  if (timer) { clearTimeout(timer); settle(); }
  if (busy(useStore.getState().drawings) || !redoStack.length) return false;
  undoStack.push(settled);
  restore(redoStack.pop()!);
  notify();
  return true;
}

export function startDrawingHistory(): () => void {
  if (POPOUT_TOOL) return () => {};
  settled = useStore.getState().drawings;
  stale = new Set(settled.filter((d) => !d.done).map((d) => d.id));
  const unsubscribe = useStore.subscribe((s, prev) => { if (s.drawings !== prev.drawings) later(); });
  const down = () => { pressed = true; };
  const up = () => { if (!pressed) return; pressed = false; later(); };
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    // e.key, not e.code: Z sits where QWERTY's W is on a French keyboard
    const k = e.key.toLowerCase();
    const isUndo = k === 'z' && !e.shiftKey;
    const isRedo = k === 'y' || (k === 'z' && e.shiftKey);
    if (!isUndo && !isRedo) return;
    // a text field keeps its own undo (the Pine editor, a price typed in a dialog...)
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    // in the main window, only on a chart tab: never undo a drawing out of sight from a tool page
    const st = useStore.getState();
    if (!POPOUT_ID && st.tabs.find((t) => t.id === st.activeTabId)?.kind !== 'chart') return;
    e.preventDefault();
    if (isUndo) undoDrawing(); else redoDrawing();
  };
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
  window.addEventListener('keydown', onKey);
  return () => {
    unsubscribe();
    clearTimeout(timer);
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('blur', up);
    window.removeEventListener('keydown', onKey);
  };
}
