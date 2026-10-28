import { useState } from 'react';
import { useStore } from '../store/store';
import FloatingChartWindow from './FloatingChartWindow';
import { getDragSymbol, isSymbolDrag } from './symbolDnd';

export default function FreeWindowsCanvas() {
  const freeWindows = useStore((s) => s.freeWindows);
  const addFreeWindow = useStore((s) => s.addFreeWindow);
  const symbol = useStore((s) => s.symbol);
  const [dropHint, setDropHint] = useState(false);

  return (
    <div
      className={`free-windows-canvas ${dropHint ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        if (!isSymbolDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropHint(true);
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDropHint(false); }}
      onDrop={(e) => {
        setDropHint(false);
        const sym = getDragSymbol(e);
        if (!sym) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        // the window's title bar lands under the cursor
        addFreeWindow(sym.ticker, {
          x: e.clientX - r.left + e.currentTarget.scrollLeft - 60,
          y: e.clientY - r.top + e.currentTarget.scrollTop - 12,
        });
      }}
    >
      {freeWindows.map((w) => <FloatingChartWindow key={w.id} win={w} />)}
      {freeWindows.length === 0 && (
        <div className="free-empty">Glissez un actif de la liste de droite ici pour ouvrir une fenêtre</div>
      )}
      {dropHint && <div className="free-drop-hint">Déposez pour ouvrir une fenêtre</div>}
      <button className="free-add-btn" onClick={() => addFreeWindow(symbol.ticker)} title="Ou glissez un actif de la liste de droite dans cette zone">
        ＋ Nouvelle fenêtre
      </button>
    </div>
  );
}
