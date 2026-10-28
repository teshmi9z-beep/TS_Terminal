import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import type { Drawing, DrawingShowOn, HLineSettings } from '../types';
import { ColorSwatch } from './ColorPicker';
import { LINE_STYLES, TOOL_INFO } from './toolInfo';
import { hlineOf, isHLine } from './hlineSettings';
import { mainChart } from './mainChart';
import { logicalToTime, timeFormatters, timeToLogical } from './chartUtils';

// Settings of a horizontal line, like ProRealTime's "Ligne horizontale" window:
// colour, width, style; its point (date, value); which sides run to the edge;
// its label (text, price, timeframe, distance to the last price, box, size,
// alignment); the timeframes it shows on. Changes show at once; "Annuler" (or
// Échap) puts it back.
export default function HLineDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useStore((s) => s.drawings.find((x) => x.id === id));
  const updateDrawing = useStore((s) => s.updateDrawing);
  const timeframe = useStore((s) => s.timeframe);
  const timeZone = useStore((s) => s.timeZone);
  const snapshot = useRef<Drawing | null>(d ? structuredClone(d) : null);
  const [price, setPrice] = useState(d?.points[0] ? d.points[0].price.toFixed(mainChart.engine?.precision ?? 2) : '');

  const restore = () => {
    const s = snapshot.current;
    if (s) useStore.getState().updateDrawing(s.id, { ...s, hline: s.hline, tf: s.tf, showOn: s.showOn });
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

  if (!d || !isHLine(d.tool)) return null;
  const h = hlineOf(d);
  const set = (patch: Partial<HLineSettings>) => updateDrawing(d.id, { hline: { ...d.hline, ...patch } });
  const pt = d.points[0];
  const precision = mainChart.engine?.precision ?? 2;
  const commitPrice = () => {
    const v = parseFloat(price.replace(',', '.').replace(/\s/g, ''));
    if (Number.isFinite(v)) updateDrawing(d.id, { points: [{ ...pt, price: v }, ...d.points.slice(1)] });
    else setPrice(pt.price.toFixed(precision));
  };
  // one bar earlier / later, on the chart's bars
  const stepBar = (dir: -1 | 1) => {
    const candles = mainChart.engine?.candles ?? [];
    const l = timeToLogical(candles, pt.time);
    const t = l == null ? null : logicalToTime(candles, Math.round(l) + dir);
    if (t != null) updateDrawing(d.id, { points: [{ ...pt, time: t }, ...d.points.slice(1)] });
  };
  const check = (label: string, on: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label className={`idg-check ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span>
    </label>
  );
  const drawnOn = d.tf ?? timeframe;
  const showOn = d.showOn ?? 'all';
  const host = document.querySelector('.app') ?? document.body;

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg hld">
        <div className="idg-head">
          <span>Ligne horizontale<small className="hld-sub">{TOOL_INFO[d.tool].label}</small></span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-body">
          <div className="idg-inline-row">
            <span className="idg-lbl">Couleur</span>
            <ColorSwatch value={d.color} onChange={(color) => updateDrawing(d.id, { color })} />
            <span className="idg-lbl">Épaisseur</span>
            <select className="idg-select idg-width" value={d.lineWidth} onChange={(e) => updateDrawing(d.id, { lineWidth: parseInt(e.target.value) })}>
              {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
            </select>
            <span className="idg-lbl">Style</span>
            <select className="idg-select" value={d.lineStyle ?? 'solid'} onChange={(e) => updateDrawing(d.id, { lineStyle: e.target.value as Drawing['lineStyle'] })}>
              {LINE_STYLES.map((l) => <option key={l.id} value={l.id}>{l.glyph} {l.label}</option>)}
            </select>
          </div>

          <div className="hld-cols">
            <div className="hld-box">
              <div className="idg-group">Point</div>
              <div className="idg-inline-row">
                <button className="idg-btn hld-step" title="Une bougie plus tôt" onClick={() => stepBar(-1)}>‹</button>
                <span className="hld-date">{timeFormatters(timeZone, timeframe).timeFormatter(pt.time as never)}</span>
                <button className="idg-btn hld-step" title="Une bougie plus tard" onClick={() => stepBar(1)}>›</button>
              </div>
              <div className="idg-inline-row">
                <span className="idg-lbl">Valeur</span>
                <input
                  className="idg-num" value={price} onChange={(e) => setPrice(e.target.value)}
                  onBlur={commitPrice} onKeyDown={(e) => { if (e.key === 'Enter') commitPrice(); }}
                />
              </div>
            </div>
            <div className="hld-box">
              <div className="idg-group">Extrémités</div>
              {/* one side at least runs to the edge */}
              {check('Gauche : prolonger jusqu’au bord', h.extendLeft, (v) => set({ extendLeft: v }), h.extendLeft && !h.extendRight)}
              {check('Droite : prolonger jusqu’au bord', h.extendRight, (v) => set({ extendRight: v }), h.extendRight && !h.extendLeft)}
            </div>
          </div>

          <div className="idg-group">Texte</div>
          <input className="idg-text hld-text" placeholder="Texte…" value={h.text} onChange={(e) => set({ text: e.target.value })} />
          <div className="hld-grid">
            {check('Afficher le prix', h.showPrice, (v) => set({ showPrice: v }))}
            {check('Unité de temps de la ligne', h.showTf, (v) => { set({ showTf: v }); if (v && !d.tf) updateDrawing(d.id, { tf: timeframe }); })}
            {check('Écart avec le dernier prix', h.showDist, (v) => set({ showDist: v }))}
            {check('% d’écart avec le dernier prix', h.showPct, (v) => set({ showPct: v }))}
            {check('Encadré', h.boxed, (v) => set({ boxed: v }))}
            {check('Couleur identique à la ligne', h.sameColor, (v) => set({ sameColor: v }))}
          </div>
          <div className="idg-inline-row">
            <span className="idg-lbl">Taille</span>
            <select className="idg-select" value={h.size} onChange={(e) => set({ size: parseInt(e.target.value) })}>
              {[-2, 0, 2, 4, 6, 8].map((v) => <option key={v} value={v}>{v > 0 ? `+${v}` : v === 0 ? '+0' : v}</option>)}
            </select>
            <span className="idg-lbl">Position</span>
            <span className="cmp-seg">
              {(['left', 'center', 'right'] as const).map((a) => (
                <button key={a} className={h.align === a ? 'active' : ''} onClick={() => set({ align: a })}>
                  {a === 'left' ? 'Gauche' : a === 'center' ? 'Centre' : 'Droite'}
                </button>
              ))}
            </span>
          </div>

          <div className="idg-group">Unité de temps : {drawnOn}</div>
          <div className="idg-inline-row">
            <span className="idg-lbl">Afficher dans</span>
            <select
              className="idg-select hld-show" value={showOn}
              onChange={(e) => updateDrawing(d.id, { showOn: e.target.value as DrawingShowOn, tf: drawnOn })}
            >
              <option value="all">Toutes les unités de temps</option>
              <option value="this">Seulement en {drawnOn}</option>
              <option value="lower">En {drawnOn} et plus petites</option>
              <option value="higher">En {drawnOn} et plus grandes</option>
            </select>
          </div>
        </div>
        <div className="idg-foot">
          <button className="idg-btn cmp-remove" onClick={() => { useStore.getState().removeDrawing(d.id); onClose(); }}>Supprimer</button>
          <span className="idg-spacer" />
          <button className="idg-btn" onClick={() => { restore(); onClose(); }}>Annuler</button>
          <button className="idg-btn primary" onClick={() => { commitPrice(); onClose(); }}>D’accord</button>
        </div>
      </div>
    </div>,
    host,
  );
}
