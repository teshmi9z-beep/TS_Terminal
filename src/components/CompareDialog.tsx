import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type CompareItem, type CompareScale } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { ColorSwatch } from './ColorPicker';

const SCALES: { id: CompareScale; label: string; hint: string }[] = [
  { id: 'percent', label: 'Pourcentage', hint: 'Le graphique passe en % depuis la première barre visible : les évolutions se comparent directement.' },
  { id: 'same', label: 'Même échelle que le prix', hint: 'En prix, sur l’échelle du graphique : pour des actifs de prix proches.' },
  { id: 'own', label: 'Échelle indépendante', hint: 'En prix, sur sa propre échelle (sans axe) : sa courbe occupe toute la hauteur.' },
];

// settings of a compared symbol: symbol, candles or line, colour, width, scale.
// Changes show at once; "Annuler" (or Échap) puts it back.
export default function CompareDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const c = useStore((s) => s.compares.find((x) => x.id === id));
  const update = useStore((s) => s.updateCompare);
  const remove = useStore((s) => s.removeCompare);
  const snapshot = useRef<CompareItem | null>(c ? structuredClone(c) : null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (snapshot.current) useStore.getState().updateCompare(id, snapshot.current);
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  if (!c) return null;
  const set = (patch: Partial<Omit<CompareItem, 'id'>>) => update(id, patch);
  const cancel = () => { if (snapshot.current) update(id, snapshot.current); onClose(); };
  const host = document.querySelector('.app') ?? document.body;

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg cmpd">
        <div className="idg-head">
          <span><span className="cmp-swatch" style={{ background: c.color }} /> Comparer · {c.symbol.ticker}</span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-body">
          <div className="idg-inline-row">
            <span className="idg-lbl">Symbole</span>
            <b>{c.symbol.ticker}</b> <span className="muted">{c.symbol.name}</span>
            <span className="idg-spacer" />
            <button
              className="idg-btn"
              onClick={() => { const ui = useChartUi.getState(); ui.setCompareTarget(id); ui.openSearch('compare'); onClose(); }}
            >
              Changer…
            </button>
          </div>
          <div className="idg-inline-row">
            <span className="idg-lbl">Style</span>
            <span className="cmp-seg">
              <button className={c.style === 'line' ? 'active' : ''} onClick={() => set({ style: 'line' })}>Ligne</button>
              <button className={c.style === 'candles' ? 'active' : ''} onClick={() => set({ style: 'candles' })}>Bougies</button>
            </span>
          </div>
          <div className="idg-inline-row">
            <span className="idg-lbl">Couleur</span>
            <ColorSwatch value={c.color} onChange={(color) => set({ color })} />
            {c.style === 'line' && (
              <>
                <span className="idg-lbl">Épaisseur</span>
                <select className="idg-select idg-width" value={c.lineWidth} onChange={(e) => set({ lineWidth: parseInt(e.target.value) })}>
                  {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                </select>
              </>
            )}
            {c.style === 'candles' && <span className="muted cmp-note">hausse pleine, baisse creuse</span>}
          </div>
          <div className="idg-group">Mise à l’échelle</div>
          <div className="cmp-scales">
            {SCALES.map((s) => (
              <label key={s.id} className={`cmp-scale ${c.scale === s.id ? 'active' : ''}`}>
                <input type="radio" name={`cmp-scale-${id}`} checked={c.scale === s.id} onChange={() => set({ scale: s.id })} />
                <span><b>{s.label}</b><small>{s.hint}</small></span>
              </label>
            ))}
          </div>
          <div className="idg-inline-row">
            <label className="idg-check"><input type="checkbox" checked={c.visible} onChange={(e) => set({ visible: e.target.checked })} /><span>Visible</span></label>
          </div>
        </div>
        <div className="idg-foot">
          <button className="idg-btn cmp-remove" onClick={() => { remove(id); onClose(); }}>Retirer</button>
          <span className="idg-spacer" />
          <button className="idg-btn" onClick={cancel}>Annuler</button>
          <button className="idg-btn primary" onClick={onClose}>D’accord</button>
        </div>
      </div>
    </div>,
    host,
  );
}
