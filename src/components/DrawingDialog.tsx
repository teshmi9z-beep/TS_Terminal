import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import type { Drawing, DrawingShowOn, Point } from '../types';
import { ColorSwatch } from './ColorPicker';
import { LINE_STYLES, TOOL_INFO } from './toolInfo';
import { mainChart } from './mainChart';
import { logicalToTime, timeFormatters, timeToLogical } from './chartUtils';
import { defaultFill, hasDrawingDialog } from './drawingStyle';

// Settings of a rectangle or a line, like TradingView's window: Style (border, background,
// sides running to the edge), Texte (rectangles), Coordonnées (each point's date and price),
// Visibilité (timeframes). Changes show at once; "Annuler" (or Échap) puts it back.

type Tab = 'style' | 'text' | 'coords' | 'visibility';

export default function DrawingDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useStore((s) => s.drawings.find((x) => x.id === id));
  const updateDrawing = useStore((s) => s.updateDrawing);
  const timeframe = useStore((s) => s.timeframe);
  const timeZone = useStore((s) => s.timeZone);
  const snapshot = useRef<Drawing | null>(d ? structuredClone(d) : null);
  const [tab, setTab] = useState<Tab>('style');

  const restore = () => {
    const s = snapshot.current;
    // (fields absent from the copy are cleared: undefined overwrites them)
    if (s && d) useStore.getState().updateDrawing(s.id, Object.fromEntries(Object.keys({ ...d, ...s }).map((k) => [k, (s as Record<string, unknown>)[k]])) as Partial<Drawing>);
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

  if (!d || !hasDrawingDialog(d)) return null;
  const rect = d.tool === 'rectangle';
  const set = (patch: Partial<Drawing>) => updateDrawing(d.id, patch);
  const check = (label: string, on: boolean, onChange: (v: boolean) => void) => (
    <label className="idg-check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>
  );
  const drawnOn = d.tf ?? timeframe;
  const host = document.querySelector('.app') ?? document.body;
  const tabs: [Tab, string][] = [['style', 'Style'], ...(rect ? [['text', 'Texte'] as [Tab, string]] : []), ['coords', 'Coordonnées'], ['visibility', 'Visibilité']];

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg hld dgd">
        <div className="idg-head">
          <span>{TOOL_INFO[d.tool].label}</span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-tabs">
          {tabs.map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div className="idg-body">
          {tab === 'style' && (
            <>
              <div className="idg-inline-row">
                <span className="idg-lbl dgd-lbl">{rect ? 'Bordure' : 'Ligne'}</span>
                <ColorSwatch value={d.color} onChange={(color) => set({ color })} />
                <select className="idg-select idg-width" title="Épaisseur" value={d.lineWidth} onChange={(e) => set({ lineWidth: parseInt(e.target.value) })}>
                  {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                </select>
                <select className="idg-select" title="Style de trait" value={d.lineStyle ?? 'solid'} onChange={(e) => set({ lineStyle: e.target.value as Drawing['lineStyle'] })}>
                  {LINE_STYLES.map((l) => <option key={l.id} value={l.id}>{l.glyph} {l.label}</option>)}
                </select>
              </div>
              {rect && (
                <div className="idg-inline-row">
                  <label className="idg-check dgd-lbl"><input type="checkbox" checked={!d.noFill} onChange={(e) => set({ noFill: !e.target.checked })} /><span>Fond</span></label>
                  <ColorSwatch value={d.fillColor ?? defaultFill(d.color)} onChange={(fillColor) => set({ fillColor, noFill: false })} title="Couleur et opacité du fond" />
                </div>
              )}
              {rect && (
                <>
                  {check('Prolonger à gauche', !!d.extendLeft, (v) => set({ extendLeft: v }))}
                  {check('Prolonger à droite', !!d.extendRight, (v) => set({ extendRight: v }))}
                </>
              )}
            </>
          )}

          {tab === 'text' && rect && (
            <>
              <div className="idg-inline-row">
                <ColorSwatch value={d.textColor ?? d.color} onChange={(textColor) => set({ textColor })} title="Couleur du texte" />
                <select className="idg-select" title="Taille" value={d.fontSize ?? 14} onChange={(e) => set({ fontSize: parseInt(e.target.value) })}>
                  {[10, 11, 12, 14, 16, 20, 24, 28, 32, 40].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className={`idg-btn dgd-tog ${d.bold ? 'active' : ''}`} title="Gras" onClick={() => set({ bold: !d.bold })}><b>B</b></button>
                <button className={`idg-btn dgd-tog ${d.italic ? 'active' : ''}`} title="Italique" onClick={() => set({ italic: !d.italic })}><i>I</i></button>
              </div>
              <textarea className="idg-text dgd-text" placeholder="Texte…" rows={4} value={d.text ?? ''} onChange={(e) => set({ text: e.target.value })} />
              <div className="idg-inline-row">
                <span className="idg-lbl">Position</span>
                <span className="cmp-seg">
                  {(['top', 'middle', 'bottom'] as const).map((v) => (
                    <button key={v} className={(d.textV ?? 'middle') === v ? 'active' : ''} onClick={() => set({ textV: v })}>{v === 'top' ? 'Haut' : v === 'middle' ? 'Milieu' : 'Bas'}</button>
                  ))}
                </span>
                <span className="cmp-seg">
                  {(['left', 'center', 'right'] as const).map((h) => (
                    <button key={h} className={(d.textH ?? 'center') === h ? 'active' : ''} onClick={() => set({ textH: h })}>{h === 'left' ? 'Gauche' : h === 'center' ? 'Centre' : 'Droite'}</button>
                  ))}
                </span>
              </div>
            </>
          )}

          {tab === 'coords' && d.points.slice(0, 2).map((p, i) => (
            // (a new price, from the chart or typed: the row starts again from it)
            <PointRow key={`${i}:${p.price}`} label={`Point ${i + 1}`} point={p} timeZone={timeZone} timeframe={timeframe}
              onChange={(np) => set({ points: d.points.map((q, k) => (k === i ? np : q)) })} />
          ))}

          {tab === 'visibility' && (
            <div className="idg-inline-row">
              <span className="idg-lbl">Afficher dans</span>
              <select className="idg-select hld-show" value={d.showOn ?? 'all'} onChange={(e) => set({ showOn: e.target.value as DrawingShowOn, tf: drawnOn })}>
                <option value="all">Toutes les unités de temps</option>
                <option value="this">Seulement en {drawnOn}</option>
                <option value="lower">En {drawnOn} et plus petites</option>
                <option value="higher">En {drawnOn} et plus grandes</option>
              </select>
            </div>
          )}
        </div>
        <div className="idg-foot">
          <button className="idg-btn cmp-remove" onClick={() => { useStore.getState().removeDrawing(d.id); onClose(); }}>Supprimer</button>
          <span className="idg-spacer" />
          <button className="idg-btn" onClick={() => { restore(); onClose(); }}>Annuler</button>
          <button className="idg-btn primary" onClick={onClose}>D’accord</button>
        </div>
      </div>
    </div>,
    host,
  );
}

// a point: its bar (one earlier / later) and its price
function PointRow({ label, point, timeZone, timeframe, onChange }: { label: string; point: Point; timeZone: string; timeframe: string; onChange: (p: Point) => void }) {
  const precision = mainChart.engine?.precision ?? 2;
  const [price, setPrice] = useState(point.price.toFixed(precision));
  const commit = () => {
    const v = parseFloat(price.replace(',', '.').replace(/\s/g, ''));
    if (Number.isFinite(v)) onChange({ ...point, price: v });
    else setPrice(point.price.toFixed(precision));
  };
  const step = (dir: -1 | 1) => {
    const candles = mainChart.engine?.candles ?? [];
    const l = timeToLogical(candles, point.time);
    const t = l == null ? null : logicalToTime(candles, Math.round(l) + dir);
    if (t != null) onChange({ ...point, time: t });
  };
  return (
    <div className="idg-inline-row">
      <span className="idg-lbl dgd-lbl">{label}</span>
      <input className="idg-num" title="Prix" value={price} onChange={(e) => setPrice(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      <button className="idg-btn hld-step" title="Une bougie plus tôt" onClick={() => step(-1)}>‹</button>
      <span className="hld-date">{timeFormatters(timeZone, timeframe as never).timeFormatter(point.time as never)}</span>
      <button className="idg-btn hld-step" title="Une bougie plus tard" onClick={() => step(1)}>›</button>
    </div>
  );
}
