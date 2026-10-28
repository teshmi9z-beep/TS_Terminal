// Interface language. The screens are written in French; in English the texts are
// swapped on the fly from src/i18n/en.json (see translate.ts), so the components
// keep their French strings. The choice is kept in this browser and applies after
// a reload, in every window of the platform.

export type Lang = 'fr' | 'en';

const KEY = 'tesh-lang';

// first visit: the browser's language (French unless it is another one); someone
// who already used the platform before the switch existed stays in French
function readLang(): Lang {
  // the lab scripts (Node) import some of these modules: their reports stay in French
  if (typeof window === 'undefined') return 'fr';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'fr') return saved;
    if (localStorage.getItem('platform_state_v1')) return 'fr';
    const first = (navigator.languages?.[0] ?? navigator.language ?? 'fr').toLowerCase();
    return first.startsWith('fr') ? 'fr' : 'en';
  } catch { return 'fr'; }
}

export const LANG: Lang = readLang();
// numbers and dates: 24-hour clock and day-month order in both languages
export const LOCALE = LANG === 'en' ? 'en-GB' : 'fr-FR';
// decimal separator for numbers written by hand (String(x).replace('.', DEC))
export const DEC = LANG === 'en' ? '.' : ',';

export function setLang(lang: Lang) {
  if (lang === LANG) return;
  try { localStorage.setItem(KEY, lang); } catch { /* storage blocked: stays in French */ }
  location.reload();
}

// detached windows follow when the main one switches
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === KEY && (e.newValue === 'en' ? 'en' : 'fr') !== LANG) location.reload(); });
}

// a French text in English (texts drawn outside the page, e.g. on a canvas, go through it)
let translator: ((s: string) => string | null) | null = null;
export function setTranslator(fn: (s: string) => string | null) { translator = fn; }
export const tr = (s: string): string => (translator ? translator(s) ?? s : s);
