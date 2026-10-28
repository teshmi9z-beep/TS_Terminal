import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import type { Drawing, VpSettings } from '../types';
import { ColorSwatch } from './ColorPicker';
import { TOOL_INFO } from './toolInfo';
import { computeProfile, defaultVp, isVolumeProfile, vpOf, vpRange } from './volumeProfile';
import { mainChart } from './mainChart';

// Settings of a volume profile ("Gamme fixe" / "Profil ancré"), like TradingView's:
// rows, value area, histogram width and side, buying / selling colours, POC, value
// area lines, background. Changes show at once; "Annuler" (or Échap) puts it back.
export default function VolumeProfileDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useStore((s) => s.drawings.find((x) => x.id === id));
  const updateDrawing = useStore((s) => s.updateDrawing);
  const snapshot = useRef<Drawing | null>(d ? structuredClone(d) : null);

  const restore = () => {
    const s = snapshot.current;
    if (s) useStore.getState().updateDrawing(s.id, { ...s, vp: s.vp });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      restore();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  if (!d || !isVolumeProfile(d.tool)) return null;
  const s = vpOf(d);
  const set = (patch: Partial<VpSettings>) => updateDrawing(d.id, { vp: { ...d.vp, ...patch } });
  const num = (v: string, lo: number, hi: number, fallback: number) => {
    const n = parseFloat(v.replace(',', '.'));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  const check = (label: string, on: boolean, onChange: (v: boolean) => void) => (
    <label className="idg-check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>
  );
  // what the profile is made of, for the note at the bottom
  const candles = mainChart.engine?.candles ?? [];
  const range = vpRange(d, candles);
  const profile = range ? computeProfile(candles, range.t0, range.t1, s) : null;
  const host = document.querySelector('.app') ?? document.body;

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg vpd">
        <div className="idg-head">
          <span>{d.tool === 'anchored_vp' ? 'Profil ancré' : 'Gamme fixe'}<small className="hld-sub">{TOOL_INFO[d.tool].label}</small></span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-body">
          <div className="idg-group">Calcul</div>
          <div className="idg-inline-row">
            <span className="idg-lbl">Nombre de lignes</span>
            <input
              key={`r${s.rows}`} className="idg-num vpd-num" type="number" min={4} max={200} defaultValue={s.rows}
              onBlur={(e) => set({ rows: Math.round(num(e.target.value, 4, 200, s.rows)) })} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
            <span className="idg-lbl">Zone de valeur</span>
            <input
              key={`v${s.valueArea}`} className="idg-num vpd-num" type="number" min={10} max={100} defaultValue={s.valueArea}
              onBlur={(e) => set({ valueArea: num(e.target.value, 10, 100, s.valueArea) })} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
            <span className="idg-lbl">%</span>
          </div>

          <div className="idg-group">Histogramme</div>
          <div className="idg-inline-row">
            <span className="idg-lbl">Largeur</span>
            <input type="range" min={5} max={100} value={s.width} onChange={(e) => set({ width: parseInt(e.target.value) })} />
            <span className="fibd-val">{s.width} %</span>
            <span className="idg-lbl">Côté</span>
            <span className="cmp-seg">
              <button className={s.placement === 'left' ? 'active' : ''} onClick={() => set({ placement: 'left' })}>Gauche</button>
              <button className={s.placement === 'right' ? 'active' : ''} onClick={() => set({ placement: 'right' })}>Droite</button>
            </span>
          </div>
          <div className="idg-inline-row">
            {check('Volume acheteur / vendeur séparés', s.split, (v) => set({ split: v }))}
          </div>
          <div className="idg-inline-row">
            <span className="idg-lbl">{s.split ? 'Acheteur (bougies haussières)' : 'Couleur'}</span>
            <ColorSwatch value={s.upColor} onChange={(c) => set({ upColor: c })} />
            {s.split && (
              <>
                <span className="idg-lbl">Vendeur (baissières)</span>
                <ColorSwatch value={s.downColor} onChange={(c) => set({ downColor: c })} />
              </>
            )}
          </div>

          <div className="idg-group">Lignes</div>
          <div className="idg-inline-row">
            {check('POC (prix le plus traité)', s.showPoc, (v) => set({ showPoc: v }))}
            <ColorSwatch value={s.pocColor} onChange={(c) => set({ pocColor: c })} />
            {check('prolonger à droite', s.extendPoc, (v) => set({ extendPoc: v }))}
          </div>
          <div className="idg-inline-row">
            {check('Haut et bas de la zone de valeur', s.showVaLines, (v) => set({ showVaLines: v }))}
          </div>
          <div className="idg-inline-row">
            {check('Fond de la zone', s.background, (v) => set({ background: v }))}
            <ColorSwatch value={s.bgColor} onChange={(c) => set({ bgColor: c })} />
          </div>

          <div className="vpd-note">
            Volume de chaque bougie du graphique réparti entre son plus bas et son plus haut.
            {profile?.counted && ' Ce marché n’a pas de volume ici : chaque bougie compte pour 1 (temps passé à chaque prix).'}
            {d.tool === 'anchored_vp' && ' Le profil va de la bougie choisie jusqu’à la dernière et suit les nouvelles bougies.'}
          </div>
        </div>
        <div className="idg-foot">
          <button className="idg-btn cmp-remove" onClick={() => { useStore.getState().removeDrawing(d.id); onClose(); }}>Supprimer</button>
          <button className="idg-btn" onClick={() => updateDrawing(d.id, { vp: defaultVp() })}>Réglages par défaut</button>
          <span className="idg-spacer" />
          <button className="idg-btn" onClick={() => { restore(); onClose(); }}>Annuler</button>
          <button className="idg-btn primary" onClick={onClose}>D’accord</button>
        </div>
      </div>
    </div>,
    host,
  );
}
