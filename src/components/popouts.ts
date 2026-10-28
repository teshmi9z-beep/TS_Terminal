import { useStore, POPOUT_ID, type Popout } from '../store/store';
import { useChartUi } from '../store/chartUi';
import type { Symbol, Timeframe, UiTheme } from '../types';

// Detached chart windows: real browser windows (window.open) that can be moved
// to any screen. They talk to the main window over a BroadcastChannel to report
// their position, their symbol, and that they closed.

const CHANNEL = 'tesh-popouts';

type Geometry = { left: number; top: number; width: number; height: number };

type Msg =
  | ({ type: 'geom'; id: string; ticker: string; tf: Timeframe; symbol: Symbol } & Geometry)
  | { type: 'closed'; id: string }
  | { type: 'ping' }
  | { type: 'close-all' };

export type ScreenInfo = { label: string; left: number; top: number; width: number; height: number; primary: boolean };

type ScreenWindow = Window & { getScreenDetails?: () => Promise<{ screens: any[] }> };

// Chrome keeps windows opened by script on the screen of the page that opens them,
// unless the page has the "window management" permission (asked once): then saved
// positions on other screens are honoured. `prompt` lets the request show.
export async function ensureScreenAccess(prompt: boolean): Promise<boolean> {
  const w = window as ScreenWindow;
  if (!w.getScreenDetails) return false;
  try {
    const perm = await navigator.permissions.query({ name: 'window-management' as PermissionName });
    if (perm.state === 'denied' || (perm.state === 'prompt' && !prompt)) return false;
  } catch {
    if (!prompt) return false;
  }
  try { await w.getScreenDetails(); return true; } catch { return false; }
}

// a window whose middle is outside the screen of this page (another monitor)
export function onOtherScreen(p: Partial<Geometry>): boolean {
  if (p.left == null || p.top == null) return false;
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const cx = p.left + (p.width ?? 0) / 2, cy = p.top + (p.height ?? 0) / 2;
  const l = s.availLeft ?? 0, t = s.availTop ?? 0;
  return cx < l || cx > l + s.availWidth || cy < t || cy > t + s.availHeight;
}

// with the "window management" permission (Chrome asks once) windows can be opened
// directly on another screen; without it the browser keeps them on the current one
export async function listScreens(): Promise<ScreenInfo[]> {
  const w = window as ScreenWindow;
  if (w.getScreenDetails) {
    try {
      const d = await w.getScreenDetails();
      return d.screens.map((s, i) => ({
        label: s.label || `Écran ${i + 1}`, left: s.availLeft, top: s.availTop,
        width: s.availWidth, height: s.availHeight, primary: !!s.isPrimary,
      }));
    } catch { /* permission refused */ }
  }
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  return [{ label: 'Écran actuel', left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight, primary: true }];
}

// false when the browser blocked the window (only one pop-up per click unless pop-ups are allowed)
export function openPopout(symbol: Symbol, tf: Timeframe, place?: Partial<Geometry>, reuseId?: string, silent = false, layoutId?: string | null): boolean {
  const id = reuseId ?? `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const width = Math.round(place?.width ?? 960);
  const height = Math.round(place?.height ?? 620);
  let url = `${location.origin}${location.pathname}?popout=${id}&sym=${encodeURIComponent(JSON.stringify(symbol))}&tf=${tf}`;
  // the window puts itself back at this outer size and place (the features below set
  // the inner size, and Chrome may move it)
  if (place?.left != null && place?.top != null && place.width && place.height) url += `&geom=${[place.left, place.top, place.width, place.height].map(Math.round).join(',')}`;
  let features = `popup=yes,width=${width},height=${height}`;
  if (place?.left != null && place?.top != null) features += `,left=${Math.round(place.left)},top=${Math.round(place.top)}`;
  // open (or get back) the named window without reloading it when it already exists
  const win = window.open('', `tesh_${id}`, features);
  if (!win) {
    if (!silent) useChartUi.getState().showToast('Fenêtre bloquée : autorisez les pop-ups pour localhost (icône dans la barre d’adresse)');
    return false;
  }
  let alreadyOpen = false;
  try { alreadyOpen = win.location.href !== 'about:blank'; } catch { /* cross-origin: treat as new */ }
  if (alreadyOpen) win.focus(); else win.location.href = url;
  useStore.getState().upsertPopout({ id, symbol, tf, open: true, width, height, left: place?.left, top: place?.top, ...(layoutId !== undefined ? { layoutId } : {}) });
  return true;
}

// opens the window centered on a given screen
export function openPopoutOnScreen(symbol: Symbol, tf: Timeframe, screen: ScreenInfo) {
  const width = Math.min(1200, screen.width - 40);
  const height = Math.min(800, screen.height - 40);
  openPopout(symbol, tf, {
    left: screen.left + (screen.width - width) / 2, top: screen.top + (screen.height - height) / 2, width, height,
  });
}

export function reopenPopout(p: Popout, silent = false): boolean {
  return openPopout(p.symbol, p.tf, { left: p.left, top: p.top, width: p.width, height: p.height }, p.id, silent, p.layoutId);
}

export function closeAllPopouts() {
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage({ type: 'close-all' } satisfies Msg);
  ch.close();
  const st = useStore.getState();
  for (const p of st.popouts) st.upsertPopout({ id: p.id, open: false });
}

// main window: keeps the list of detached windows up to date
export function startPopoutHub(): () => void {
  const ch = new BroadcastChannel(CHANNEL);
  const st = () => useStore.getState();
  // nothing is known to be open until the windows answer the ping
  for (const p of st().popouts) st().upsertPopout({ id: p.id, open: false });
  ch.onmessage = (ev: MessageEvent<Msg>) => {
    const m = ev.data;
    if (m.type === 'geom') {
      st().upsertPopout({ id: m.id, symbol: m.symbol, tf: m.tf, open: true, left: m.left, top: m.top, width: m.width, height: m.height });
    } else if (m.type === 'closed') {
      st().upsertPopout({ id: m.id, open: false });
    }
  };
  ch.postMessage({ type: 'ping' } satisfies Msg);
  return () => ch.close();
}

// detached window: reports its geometry / symbol and obeys "close all"
export function startPopoutReporter(): () => void {
  if (!POPOUT_ID) return () => {};
  const id = POPOUT_ID;
  placeFromUrl();
  const ch = new BroadcastChannel(CHANNEL);
  let last = '';
  const send = (force = false) => {
    const s = useStore.getState();
    const msg: Msg = {
      type: 'geom', id, ticker: s.symbol.ticker, tf: s.timeframe, symbol: s.symbol,
      left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight,
    };
    const key = JSON.stringify(msg);
    if (force || key !== last) { last = key; ch.postMessage(msg); }
  };
  const timer = setInterval(() => send(), 1500);
  ch.onmessage = (ev: MessageEvent<Msg>) => {
    if (ev.data.type === 'ping') send(true);
    else if (ev.data.type === 'close-all') window.close();
  };
  const onUnload = () => ch.postMessage({ type: 'closed', id } satisfies Msg);
  window.addEventListener('beforeunload', onUnload);
  send(true);
  return () => { clearInterval(timer); window.removeEventListener('beforeunload', onUnload); ch.close(); };
}

// Light / dark is one setting for all the windows: a switch in any of them (main or
// detached) is passed to the others, which keep their own chart colors per theme.
export function startThemeSync(): () => void {
  const ch = new BroadcastChannel('tesh-theme');
  // a switch received from another window is not sent back
  let remote = false;
  ch.onmessage = (ev: MessageEvent<UiTheme>) => {
    if (ev.data !== 'dark' && ev.data !== 'light') return;
    remote = true;
    try { useStore.getState().setUiTheme(ev.data); } finally { remote = false; }
  };
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.uiTheme !== prev.uiTheme && !remote) ch.postMessage(s.uiTheme);
  });
  return () => { unsubscribe(); ch.close(); };
}

// a window opened from a saved workspace goes back to its saved place and outer size;
// done again a moment later because Chrome can still move a window that is loading
function placeFromUrl() {
  const url = new URL(location.href);
  const geom = url.searchParams.get('geom');
  if (!geom) return;
  const [x, y, w, h] = geom.split(',').map(Number);
  const place = () => {
    try {
      if (Number.isFinite(x) && Number.isFinite(y)) window.moveTo(x, y);
      if (w > 0 && h > 0) window.resizeTo(w, h);
    } catch { /* not allowed for this window */ }
  };
  place();
  setTimeout(place, 300);
  setTimeout(place, 1200);
  // a reload keeps the window where the user moved it since
  url.searchParams.delete('geom');
  history.replaceState(history.state, '', url);
}

// dropping a watchlist row outside the browser window opens a detached chart there
export function droppedOutsideWindow(e: { screenX: number; screenY: number }): boolean {
  if (!e.screenX && !e.screenY) return false;
  return e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth
    || e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
}
