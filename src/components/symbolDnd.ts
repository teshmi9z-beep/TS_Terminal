import { useStore } from '../store/store';
import { SYMBOLS } from '../data/symbols';
import type { Symbol } from '../types';

// drag & drop of a symbol from the watchlist onto a chart / the free-window canvas
export const SYMBOL_MIME = 'application/x-tesh-symbol';

export function setDragSymbol(e: React.DragEvent, sym: Symbol) {
  e.dataTransfer.setData(SYMBOL_MIME, JSON.stringify(sym));
  e.dataTransfer.setData('text/plain', sym.ticker);
  e.dataTransfer.effectAllowed = 'copyMove';
}

export const isSymbolDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(SYMBOL_MIME);

export function getDragSymbol(e: React.DragEvent): Symbol | null {
  try { return JSON.parse(e.dataTransfer.getData(SYMBOL_MIME)) as Symbol; } catch { return null; }
}

// built-in symbols plus anything added to a watchlist from the search
export function findSymbol(ticker: string): Symbol | null {
  const st = useStore.getState();
  if (st.symbol.ticker === ticker) return st.symbol;
  const builtIn = SYMBOLS.find((s) => s.ticker === ticker);
  if (builtIn) return builtIn;
  for (const t of st.watchlists) for (const r of t.items) if (r.kind === 'asset' && r.data.ticker === ticker) return r.data;
  return null;
}
