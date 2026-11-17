import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store/store';
import type { AvwapBand, AvwapSettings, Drawing, DrawingShowOn, LineStyleName } from '../types';
import { ColorSwatch } from './ColorPicker';
import { LINE_STYLES } from './toolInfo';
import { AVWAP_LINE, AVWAP_SOURCES, avwapOf, defaultAvwap } from './anchoredVwap';

// Settings of an anchored VWAP, like TradingView's window: "Paramètres en entrée" (the bands'
// calculation, their three multipliers, the source), "Style" (the VWAP line, each band's upper and
// lower lines and background), "Visibilité" (timeframes). Changes show at once; "Annuler" (or
// Échap) puts it back.

type Tab = 'inputs' | 'style' | 'visibility';

function MultField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) { setPrev(value); setText(String(value)); }
  return (
    <input
      className="idg-num" style={{ width: 90 }} type="number" min={0} step={0.1} value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value.replace(',', '.'));
        if (Number.isFinite(v) && v >= 0) onChange(v);
      }}
    />
  );
}

export default function AvwapDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useStore((s) => s.drawings.find((x) => x.id === id));
  const updateDrawing = useStore((s) => s.updateDrawing);
  const timeframe = useStore((s) => s.timeframe);
  const snapshot = useRef<Drawing | null>(d ? structuredClone(d) : null);
  const [tab, setTab] = useState<Tab>('inputs');

  const restore = () => {
    const s = snapshot.current;
    const cur = useStore.getState().drawings.find((x) => x.id === id);
    // (fields absent from the copy are cleared: undefined overwrites them)
    if (s && cur) useStore.getState().updateDrawing(s.id, Object.fromEntries(Object.keys({ ...cur, ...s }).map((k) => [k, (s as Record<string, unknown>)[k]])) as Partial<Drawing>);
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

  if (!d || d.tool !== 'anchored_vwap') return null;
  const s = avwapOf(d);
  const set = (patch: Partial<AvwapSettings>) => updateDrawing(d.id, { avwap: { ...s, ...patch } });
  const setBand = (i: number, patch: Partial<AvwapBand>) => set({ bands: s.bands.map((b, k) => (k === i ? { ...b, ...patch } : b)) });
  const drawnOn = d.tf ?? timeframe;
  const host = document.querySelector('.app') ?? document.body;
  const tabs: [Tab, string][] = [['inputs', 'Paramètres en entrée'], ['style', 'Style'], ['visibility', 'Visibilité']];

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg dgd avd">
        <div className="idg-head">
          <span>VWAP ancré</span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-tabs">
          {tabs.map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div className="idg-body">
          {tab === 'inputs' && (
            <>
              <div className="idg-group">Paramètres des bandes</div>
              <div className="idg-row">
                <span className="idg-lbl">Mode de calcul des bandes</span>
                <span className="avd-ctl">
                  <select className="idg-select" value={s.mode} onChange={(e) => set({ mode: e.target.value as AvwapSettings['mode'] })}>
                    <option value="stdev">Déviation standard</option>
                    <option value="percent">Pourcentage</option>
                  </select>
                  <span
                    className="avd-info"
                    title="Déviation standard : chaque bande est à N écarts-types du prix autour du VWAP, pondérés par le volume depuis l’ancre. Pourcentage : à N % du VWAP."
                  >i</span>
                </span>
              </div>
              {s.bands.map((b, i) => (
                <div key={i} className="idg-row">
                  <label className="idg-check"><input type="checkbox" checked={b.on} onChange={(e) => setBand(i, { on: e.target.checked })} /><span>Multiplicateur de bandes #{i + 1}</span></label>
                  <MultField value={b.mult} onChange={(mult) => setBand(i, { mult })} />
                </div>
              ))}
              <div className="idg-row avd-source">
                <span className="idg-lbl">Source</span>
                <select className="idg-select" value={s.source} onChange={(e) => set({ source: e.target.value as AvwapSettings['source'] })}>
                  {AVWAP_SOURCES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
            </>
          )}

          {tab === 'style' && (
            <>
              <div className="idg-style-row">
                <span className="idg-lbl">VWAP</span>
                <span className="idg-style-ctl">
                  <ColorSwatch value={d.color} onChange={(color) => updateDrawing(d.id, { color })} />
                  <select className="idg-select idg-width" title="Épaisseur" value={d.lineWidth} onChange={(e) => updateDrawing(d.id, { lineWidth: parseInt(e.target.value) })}>
                    {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                  </select>
                  <select className="idg-select" title="Style de ligne" value={d.lineStyle ?? 'solid'} onChange={(e) => updateDrawing(d.id, { lineStyle: e.target.value as LineStyleName })}>
                    {LINE_STYLES.map((l) => <option key={l.id} value={l.id}>{l.glyph} {l.label}</option>)}
                  </select>
                </span>
              </div>
              {s.bands.map((b, i) => (
                <div key={i} className="avd-band">
                  <div className="idg-style-row">
                    <label className="idg-check"><input type="checkbox" checked={b.on} onChange={(e) => setBand(i, { on: e.target.checked })} /><span>Bande supérieure #{i + 1}</span></label>
                    <ColorSwatch value={b.upColor} onChange={(upColor) => setBand(i, { upColor })} />
                  </div>
                  <div className="idg-style-row">
                    <label className="idg-check"><input type="checkbox" checked={b.on} onChange={(e) => setBand(i, { on: e.target.checked })} /><span>Bande inférieure #{i + 1}</span></label>
                    <ColorSwatch value={b.loColor} onChange={(loColor) => setBand(i, { loColor })} />
                  </div>
                  <div className="idg-style-row">
                    <label className="idg-check"><input type="checkbox" checked={b.fill} onChange={(e) => setBand(i, { fill: e.target.checked })} /><span>Remplissage des bandes #{i + 1}</span></label>
                    <ColorSwatch value={b.fillColor} onChange={(fillColor) => setBand(i, { fillColor, fill: true })} />
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === 'visibility' && (
            <div className="idg-inline-row">
              <span className="idg-lbl">Afficher dans</span>
              <select className="idg-select hld-show" value={d.showOn ?? 'all'} onChange={(e) => updateDrawing(d.id, { showOn: e.target.value as DrawingShowOn, tf: drawnOn })}>
                <option value="all">Toutes les unités de temps</option>
                <option value="this">Seulement en {drawnOn}</option>
                <option value="lower">En {drawnOn} et plus petites</option>
                <option value="higher">En {drawnOn} et plus grandes</option>
              </select>
            </div>
          )}
        </div>
        <div className="idg-foot">
          <button className="idg-btn" onClick={() => updateDrawing(d.id, { avwap: defaultAvwap(), ...AVWAP_LINE, lineStyle: undefined })}>Réglages par défaut</button>
          <span className="idg-spacer" />
          <button className="idg-btn" onClick={() => { restore(); onClose(); }}>Annuler</button>
          <button className="idg-btn primary" onClick={onClose}>D’accord</button>
        </div>
      </div>
    </div>,
    host,
  );
}
