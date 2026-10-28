import raw from './en.json?raw';
import { setTranslator } from './lang';

// English screens: every French text shown by the page is swapped for its English
// from en.json, as React writes it (text, tooltips, placeholders), plus the texts
// drawn on canvases and the browser's alert / confirm boxes.
// "texts" are whole texts; "patterns" are texts with values in them, like
// "Revenir aux {0} fenêtres" -> "Back to the {0} windows". A null English keeps the text.
// Missing ones: node scripts/i18n-extract.mjs

type Dict = { texts: Record<string, string | null>; patterns: Record<string, string | null> };
type Pattern = { re: RegExp; anchor: string; fixed: number; order: number[]; en: string };

const LETTERS = /[A-Za-zÀ-ÿ]/;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dict = JSON.parse(raw) as Dict;
const texts = new Map<string, string>();
for (const [fr, en] of Object.entries(dict.texts)) if (en != null) texts.set(norm(fr), en);

const patterns: Pattern[] = [];
for (const [fr, en] of Object.entries(dict.patterns)) {
  if (en == null) continue;
  // even parts are the French around the values, odd parts the value numbers
  const parts = norm(fr).split(/\{(\d+)\}/);
  const literals = parts.filter((_, i) => i % 2 === 0);
  // "{0} {1}" says nothing; "{0} · {1}" or "{0} ({1})" translate their parts
  if (!literals.some((l) => l.trim())) continue;
  const src = parts.map((p, i) => (i % 2 ? '(.*?)' : esc(p))).join('');
  patterns.push({
    re: new RegExp(`^${src}$`),
    anchor: literals.reduce((a, l) => (l.trim().length > a.length ? l.trim() : a), ''),
    fixed: literals.join('').length,
    order: parts.filter((_, i) => i % 2 === 1).map(Number),
    en,
  });
}
// the most specific first (the most French around the values)
patterns.sort((a, b) => b.fixed - a.fixed);

const cache = new Map<string, string | null>();

function lookup(key: string, depth = 0): string | null {
  const hit = texts.get(key);
  if (hit !== undefined) return hit;
  if (depth > 1) return null;
  for (const p of patterns) {
    if (p.anchor && !key.includes(p.anchor)) continue;
    const m = p.re.exec(key);
    if (!m) continue;
    const vals: string[] = [];
    p.order.forEach((n, i) => { vals[n] = m[i + 1]; });
    // a value may itself be French ("hausse", a status...)
    return p.en.replace(/\{(\d+)\}/g, (_, n: string) => {
      const v = vals[Number(n)] ?? '';
      return LETTERS.test(v) ? lookup(norm(v), depth + 1) ?? v : v;
    });
  }
  return null;
}

// the English of a text, its surrounding spaces kept; null when there is none
function translate(text: string): string | null {
  if (!LETTERS.test(text)) return null;
  // tooltips made of several lines: line by line, unless the whole is known
  if (text.includes('\n') && !texts.has(norm(text))) {
    let changed = false;
    const lines = text.split('\n').map((l) => { const en = translate(l); if (en != null) changed = true; return en ?? l; });
    return changed ? lines.join('\n') : null;
  }
  const key = norm(text);
  let en = cache.get(key);
  if (en === undefined) {
    en = lookup(key);
    if (cache.size > 50000) cache.clear();
    cache.set(key, en);
  }
  if (en == null || en === key) return null;
  const lead = /^\s*/.exec(text)![0], trail = /\s*$/.exec(text)![0];
  return lead + en + trail;
}

// code, editors and anything marked translate="no" stay as they are
const SKIP = 'script, style, textarea, pre, code, [contenteditable="true"], [translate="no"], .notranslate';
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
// what was last written, so the change it causes is not handled again
const wroteText = new WeakMap<Text, string>();
const wroteAttr = new WeakMap<Element, Record<string, string>>();

function doText(n: Text) {
  const v = n.nodeValue;
  if (!v || wroteText.get(n) === v) return;
  const en = translate(v);
  if (en == null) return;
  wroteText.set(n, en);
  n.nodeValue = en;
}

function doAttr(el: Element, name: string) {
  const v = el.getAttribute(name);
  if (!v) return;
  const mine = wroteAttr.get(el);
  if (mine?.[name] === v) return;
  const en = translate(v);
  if (en == null) return;
  if (mine) mine[name] = en; else wroteAttr.set(el, { [name]: en });
  el.setAttribute(name, en);
}

function doAttrs(el: Element) {
  for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
}

const skipFilter = { acceptNode: (n: Node) => (n.nodeType === 1 && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) };

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    const p = root.parentElement;
    if (p && !p.closest(SKIP)) doText(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || (root as Element).closest(SKIP)) return;
  doAttrs(root as Element);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, skipFilter);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text); else doAttrs(n as Element);
  }
}

function patchCanvas() {
  const p = CanvasRenderingContext2D.prototype;
  const tx = (s: unknown) => (typeof s === 'string' ? translate(s) ?? s : s) as string;
  const { fillText, strokeText, measureText } = p;
  // width and drawing must see the same text
  p.fillText = function (this: CanvasRenderingContext2D, s: string, ...rest: [number, number, number?]) { return fillText.call(this, tx(s), ...(rest as [number, number])); };
  p.strokeText = function (this: CanvasRenderingContext2D, s: string, ...rest: [number, number, number?]) { return strokeText.call(this, tx(s), ...(rest as [number, number])); };
  p.measureText = function (this: CanvasRenderingContext2D, s: string) { return measureText.call(this, tx(s)); };
}

function patchDialogs() {
  const { alert, confirm, prompt } = window;
  const tx = (m: unknown) => (m == null ? m : translate(String(m)) ?? String(m)) as string;
  window.alert = (m?: unknown) => alert.call(window, tx(m));
  window.confirm = (m?: string) => confirm.call(window, tx(m));
  window.prompt = (m?: string, def?: string) => prompt.call(window, tx(m), def);
}

export function startTranslation() {
  setTranslator(translate);
  document.documentElement.lang = 'en';
  patchCanvas();
  patchDialogs();
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') {
        const t = m.target as Text;
        if (t.nodeValue && LETTERS.test(t.nodeValue) && !t.parentElement?.closest(SKIP)) doText(t);
      } else if (m.type === 'attributes') {
        const el = m.target as Element;
        if (!el.closest(SKIP)) doAttr(el, m.attributeName!);
      } else {
        m.addedNodes.forEach(walk);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
