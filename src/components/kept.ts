import { useCallback, useEffect, useState, type RefObject, type SetStateAction } from 'react';

// A tool tab's choices (filters, view, search, selection) and its scroll position survive
// leaving the tab and coming back: the tab bar unmounts the page, so a plain useState
// started over each time. Durable choices also go to localStorage and survive a reload;
// `session` values (loaded data, a selected item, the week shown) stay in memory while
// the app runs.

const memory = new Map<string, unknown>();
const storageKey = (key: string) => `tesh.page.${key}`;

function recall<T>(key: string, init: () => T, session: boolean): T {
  if (memory.has(key)) return memory.get(key) as T;
  if (!session) {
    try {
      const v = localStorage.getItem(storageKey(key));
      if (v != null) return JSON.parse(v) as T;
    } catch { /* private mode or a bad value: the default */ }
  }
  return init();
}

// sets a kept value from outside its component (before it mounts)
export function remember(key: string, value: unknown, session = false) {
  memory.set(key, value);
  if (session) return;
  try { localStorage.setItem(storageKey(key), JSON.stringify(value)); } catch { /* full or private mode */ }
}

// what a kept value is right now (undefined: not set while the app runs)
export const peekKept = <T,>(key: string): T | undefined => memory.get(key) as T | undefined;

// useState that remembers its value under `key`
export function useKept<T>(key: string, init: T | (() => T), session = false): [T, (v: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() => recall(key, () => (typeof init === 'function' ? (init as () => T)() : init), session));
  const set = useCallback((v: SetStateAction<T>) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      remember(key, next, session);
      return next;
    });
  }, [key, session]);
  return [value, set];
}

// ---------------------------------------------------------------- scroll position

type Scroll = { path: number[]; top: number; left: number };
const scrolls = new Map<string, Map<string, Scroll>>();

// an element's place under the root: child indexes, from the root down
function pathOf(root: Element, el: Element): number[] | null {
  const path: number[] = [];
  for (let e: Element | null = el; e !== root; e = e.parentElement) {
    const parent: Element | null = e?.parentElement ?? null;
    if (!e || !parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, e));
  }
  return path;
}
const elementAt = (root: Element, path: number[]) =>
  path.reduce<Element | undefined>((e, i) => e?.children[i], root) as HTMLElement | undefined;

const USER_EVENTS = ['wheel', 'touchstart', 'mousedown', 'keydown'] as const;

// every scrolled area under `ref` (the page, a table, a list) comes back where it was.
// The content often arrives after the page shows: the restore retries as it grows,
// for a few seconds, and gives way as soon as the user scrolls or clicks.
export function useScrollMemory(ref: RefObject<HTMLElement | null>, key: string) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let saved = scrolls.get(key);
    if (!saved) { saved = new Map(); scrolls.set(key, saved); }
    const kept = saved;
    const pending = new Map(kept);
    let observer: MutationObserver | null = null;
    let timer = 0;
    const stop = () => {
      pending.clear();
      observer?.disconnect();
      observer = null;
      window.clearTimeout(timer);
    };
    const restore = () => {
      for (const [id, s] of pending) {
        const el = elementAt(root, s.path);
        if (!el) continue;
        if (el.scrollTop !== s.top) el.scrollTop = s.top;
        if (el.scrollLeft !== s.left) el.scrollLeft = s.left;
        if (Math.abs(el.scrollTop - s.top) < 2 && Math.abs(el.scrollLeft - s.left) < 2) pending.delete(id);
      }
      if (!pending.size) stop();
    };
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !root.contains(el)) return;
      const path = pathOf(root, el);
      if (!path) return;
      const id = path.join('.');
      // our own restore, clamped while the content is still short: not the user's place
      if (pending.has(id)) return;
      kept.set(id, { path, top: el.scrollTop, left: el.scrollLeft });
    };
    root.addEventListener('scroll', onScroll, true);
    for (const ev of USER_EVENTS) root.addEventListener(ev, stop, { capture: true, passive: true });
    if (pending.size) {
      restore();
      if (pending.size) {
        observer = new MutationObserver(restore);
        observer.observe(root, { childList: true, subtree: true });
        timer = window.setTimeout(stop, 8000);
      }
    }
    return () => {
      stop();
      root.removeEventListener('scroll', onScroll, true);
      for (const ev of USER_EVENTS) root.removeEventListener(ev, stop, { capture: true });
    };
  }, [ref, key]);
}
