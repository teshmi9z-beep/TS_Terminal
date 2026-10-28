import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import type { Drawing, FibSettings } from '../types';
import { ColorSwatch } from './ColorPicker';
import { LINE_STYLES } from './toolInfo';
import { builtinFib, fibOf, type FibTool } from './fibSettings';
import { LOCALE } from '../i18n/lang';

type Tab = 'style' | 'coords';

// settings of a fib drawing, laid out like TradingView's: trend line, levels
// (on / value / colour) in two columns, one colour, background, extension,
// reverse, labels. Changes show at once; "Annuler" (or Échap) puts it back.
export default function FibDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useStore((s) => s.drawings.find((x) => x.id === id));
  const updateDrawing = useStore((s) => s.updateDrawing);
  const setFibDefault = useStore((s) => s.setFibDefault);
  const snapshot = useRef<Drawing | null>(d ? structuredClone(d) : null);
  const [tab, setTab] = useState<Tab>('style');
  const [menu, setMenu] = useState(false);
  const [newLevel, setNewLevel] = useState('');

  const cancel = () => {
    const s = snapshot.current;
    if (s) useStore.getState().updateDrawing(s.id, { ...s });
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = snapshot.current;
      if (s) useStore.getState().updateDrawing(s.id, { ...s });
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!d || (d.tool !== 'fib_retracement' && d.tool !== 'fib_extension')) return null;
  const tool: FibTool = d.tool;
  const f = fibOf(d);
  const set = (patch: Partial<FibSettings>) => updateDrawing(d.id, { fib: { ...f, ...patch } });
  const setLevel = (i: number, patch: Partial<FibSettings['levels'][number]>) =>
    set({ levels: f.levels.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const check = (label: string, on: boolean, onChange: (v: boolean) => void) => (
    <label className="idg-check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>
  );
  const addLevel = () => {
    const v = parseFloat(newLevel.replace(',', '.'));
    if (!Number.isFinite(v) || f.levels.some((l) => l.value === v)) return;
    set({ levels: [...f.levels, { value: v, color: '#787b86', on: true }].sort((a, b) => a.value - b.value) });
    setNewLevel('');
  };
  const half = Math.ceil(f.levels.length / 2);
  const host = document.querySelector('.app') ?? document.body;

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg fibd">
        <div className="idg-head">
          <span>{tool === 'fib_retracement' ? 'Retracement de Fibonacci' : 'Extension de Fibonacci'}</span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-tabs">
          <button className={tab === 'style' ? 'active' : ''} onClick={() => setTab('style')}>Style</button>
          <button className={tab === 'coords' ? 'active' : ''} onClick={() => setTab('coords')}>Coordonnées</button>
        </div>
        {tab === 'style' && (
          <div className="idg-body">
            <div className="idg-inline-row">
              {check('Ligne de tendance', f.trendLine, (v) => set({ trendLine: v }))}
            </div>
            <div className="idg-inline-row">
              <span className="idg-lbl">Lignes des niveaux</span>
              <select className="idg-select idg-width" title="Épaisseur" value={d.lineWidth} onChange={(e) => updateDrawing(d.id, { lineWidth: parseInt(e.target.value) })}>
                {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
              </select>
              <select className="idg-select" title="Style de trait" value={d.lineStyle ?? 'solid'} onChange={(e) => updateDrawing(d.id, { lineStyle: e.target.value as Drawing['lineStyle'] })}>
                {LINE_STYLES.map((l) => <option key={l.id} value={l.id}>{l.glyph} {l.label}</option>)}
              </select>
            </div>
            <div className="fibd-levels">
              {[f.levels.slice(0, half), f.levels.slice(half)].map((col, c) => (
                <div key={c} className="fibd-col">
                  {col.map((l, k) => {
                    const i = c * half + k;
                    return (
                      <div key={`${l.value}-${i}`} className="fibd-level">
                        <input type="checkbox" checked={l.on} onChange={(e) => setLevel(i, { on: e.target.checked })} />
                        <input
                          className="idg-num" type="number" step="any" defaultValue={l.value}
                          onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setLevel(i, { value: v }); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        />
                        <ColorSwatch value={l.color} onChange={(col2) => setLevel(i, { color: col2 })} />
                        <button className="fibd-del" title="Retirer ce niveau" onClick={() => set({ levels: f.levels.filter((_, k2) => k2 !== i) })}>✕</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="idg-inline-row">
              <input className="idg-text" style={{ width: 90 }} placeholder="ex : 0.705" value={newLevel} onChange={(e) => setNewLevel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addLevel(); }} />
              <button className="pill-btn" onClick={addLevel}>Ajouter un niveau</button>
            </div>
            <div className="idg-inline-row">
              {check('Utiliser une seule couleur', f.oneColor, (v) => set({ oneColor: v }))}
              {f.oneColor && <ColorSwatch value={d.color} onChange={(c) => updateDrawing(d.id, { color: c })} />}
            </div>
            <div className="idg-inline-row">
              {check('Arrière-plan', f.background, (v) => set({ background: v }))}
              <span className="idg-lbl">Transparence</span>
              <input type="range" min={0} max={100} value={f.bgTransparency} onChange={(e) => set({ bgTransparency: parseInt(e.target.value) })} />
              <span className="fibd-val">{f.bgTransparency} %</span>
            </div>
            <div className="idg-inline-row">
              {check('Prolonger à gauche', f.extendLeft, (v) => set({ extendLeft: v }))}
              {check('Prolonger à droite', f.extendRight, (v) => set({ extendRight: v }))}
            </div>
            <div className="idg-inline-row">
              {check('Inverser', f.reverse, (v) => set({ reverse: v }))}
            </div>
            <div className="idg-group">Étiquettes</div>
            <div className="idg-inline-row">
              {check('Prix', f.showPrices, (v) => set({ showPrices: v }))}
              {check('Niveaux', f.showLevels, (v) => set({ showLevels: v }))}
              <select className="idg-select" value={f.levelsAs} onChange={(e) => set({ levelsAs: e.target.value as FibSettings['levelsAs'] })}>
                <option value="values">Valeurs</option>
                <option value="percent">Pourcentages</option>
              </select>
            </div>
            <div className="idg-inline-row">
              <span className="idg-lbl">Position</span>
              <select className="idg-select" value={f.labelsAt} onChange={(e) => set({ labelsAt: e.target.value as FibSettings['labelsAt'] })}>
                <option value="left">Gauche</option>
                <option value="right">Droite</option>
              </select>
              <span className="idg-lbl">Taille</span>
              <select className="idg-select" value={f.fontSize} onChange={(e) => set({ fontSize: parseInt(e.target.value) })}>
                {[10, 11, 12, 14, 16, 20].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        )}
        {tab === 'coords' && (
          <div className="idg-body">
            {d.points.slice(0, 2).map((p, i) => (
              <div key={i} className="idg-inline-row">
                <span className="idg-lbl">Point {i + 1} · prix</span>
                <input
                  className="idg-num" type="number" step="any" defaultValue={p.price}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!Number.isFinite(v)) return;
                    updateDrawing(d.id, { points: d.points.map((q, k) => (k === i ? { ...q, price: v } : q)) });
                  }}
                />
                <span className="idg-lbl">{new Date(p.time * 1000).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })}</span>
              </div>
            ))}
          </div>
        )}
        <div className="idg-foot">
          <div className="idg-defaults">
            <button className="idg-btn" onClick={() => setMenu(!menu)}>Modèle ▾</button>
            {menu && (
              <div className="idg-menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { updateDrawing(d.id, { fib: builtinFib(tool) }); setMenu(false); }}>Réinitialiser les paramètres</button>
                <button onClick={() => { setFibDefault(tool, structuredClone(f)); setMenu(false); }}>Enregistrer par défaut</button>
                {useStore.getState().fibDefaults[tool] && <button onClick={() => { setFibDefault(tool, null); setMenu(false); }}>Oublier le défaut enregistré</button>}
              </div>
            )}
          </div>
          <span className="idg-spacer" />
          <button className="idg-btn" onClick={cancel}>Annuler</button>
          <button className="idg-btn primary" onClick={onClose}>D’accord</button>
        </div>
      </div>
    </div>,
    host,
  );
}
