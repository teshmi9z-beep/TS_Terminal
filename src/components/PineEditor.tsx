import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, nextId } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { compilePine, pineRuntimeErrors } from '../pine/compile';
import { mainChart } from './mainChart';
import examplePine from '../indicators/custom/stochPriceEnvelope.pine?raw';
import PanelControls from './PanelControls';

const NEW_TEMPLATE = `//@version=5
indicator("Mon indicateur", overlay=false)

longueur = input.int(14, "Longueur", minval=1)
valeur = ta.rsi(close, longueur)

plot(valeur, "RSI", color=color.purple, linewidth=2)
hline(70, "Haut", color=color.red)
hline(30, "Bas", color=color.green)
`;

// Pine editor (right panel): paste a TradingView script, check it, add it to the chart
export default function PineEditor() {
  const editor = useChartUi((s) => s.pineEditor);
  const showToast = useChartUi((s) => s.showToast);
  const scripts = useStore((s) => s.pineScripts);
  const upsertPineScript = useStore((s) => s.upsertPineScript);
  const removePineScript = useStore((s) => s.removePineScript);
  const addIndicator = useStore((s) => s.addIndicator);
  const indicators = useStore((s) => s.indicators);
  const [scriptId, setScriptId] = useState<string | undefined>(editor.scriptId);
  const initial = scripts.find((s) => s.id === editor.scriptId);
  const [source, setSource] = useState(initial?.source ?? NEW_TEMPLATE);
  const [debounced, setDebounced] = useState(source);
  const gutterRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // another script asked from the legend / code viewer
  useEffect(() => {
    if (!editor.scriptId || editor.scriptId === scriptId) return;
    const s = useStore.getState().pineScripts.find((x) => x.id === editor.scriptId);
    if (s) { setScriptId(s.id); setSource(s.source); setDebounced(s.source); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.scriptId]);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(source), 350);
    return () => clearTimeout(id);
  }, [source]);

  // compile + trial run on the chart's bars to catch runtime errors before adding
  const check = useMemo(() => {
    const compiled = compilePine({ id: 'draft', name: 'draft', source: debounced });
    let runtime: string | null = null;
    let outputs = 0;
    if (compiled.def) {
      const bars = mainChart.engine?.candles ?? [];
      const plots = compiled.def.compute(bars.slice(-500), { id: 'draft', type: 'PINE', period: 0, color: '#2962ff', overlay: compiled.meta.overlay, visible: true });
      runtime = pineRuntimeErrors.get('draft') ?? null;
      outputs = plots.length;
    }
    return { ...compiled, runtime, outputs };
  }, [debounced]);

  const current = scripts.find((s) => s.id === scriptId);
  const dirty = !current || current.source !== source;
  const onChart = !!scriptId && indicators.some((i) => i.type === 'PINE' && i.scriptId === scriptId);
  const ok = !check.error && !check.runtime && !!check.def;

  function save(): string {
    const id = scriptId ?? nextId();
    upsertPineScript({ id, name: check.meta.title, source, updatedAt: Date.now() });
    setScriptId(id);
    return id;
  }

  function addToChart() {
    const id = save();
    addIndicator({ id: nextId(), type: 'PINE', scriptId: id, overlay: check.meta.overlay, period: 0, color: '#2962ff' });
    showToast(`« ${check.meta.title} » ajouté au graphique`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = `${source.slice(0, a)}    ${source.slice(b)}`;
      setSource(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 4; });
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (ok) { save(); showToast('Script enregistré'); } }
  }

  const lineCount = source.split('\n').length;
  const errLine = (check.error ?? check.runtime)?.match(/^Ligne (\d+)/)?.[1];

  return (
    <div className="pine-editor">
      <div className="pe-head">
        <select
          value={scriptId ?? ''}
          onChange={(e) => {
            const s = scripts.find((x) => x.id === e.target.value);
            setScriptId(s?.id);
            setSource(s?.source ?? NEW_TEMPLATE);
          }}
        >
          <option value="">＋ Nouveau script</option>
          {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="pl-btn" title="Charger l’exemple Stoch Price Envelope" onClick={() => { setScriptId(undefined); setSource(examplePine); }}>Exemple</button>
        {scriptId && (
          <button
            className="pl-btn danger" title="Supprimer ce script (et ses indicateurs)"
            onClick={() => { if (window.confirm('Supprimer ce script ?')) { removePineScript(scriptId); setScriptId(undefined); setSource(NEW_TEMPLATE); } }}
          >
            🗑
          </button>
        )}
        <PanelControls />
      </div>
      <div className="pe-hint">Collez ici un script Pine (TradingView) puis « Ajouter au graphique ». Ctrl+S enregistre.</div>
      <div className="pe-code">
        <div className="pe-gutter" ref={gutterRef}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={errLine && Number(errLine) === i + 1 ? 'err' : ''}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={areaRef} spellCheck={false} value={source}
          onChange={(e) => setSource(e.target.value)} onKeyDown={onKeyDown}
          onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
        />
      </div>
      <div className={`pe-status ${ok ? 'ok' : 'bad'}`}>
        {check.error ? `✗ ${check.error}`
          : check.runtime ? `✗ Exécution : ${check.runtime}`
          : `✓ « ${check.meta.title} » · ${check.meta.overlay ? 'sur le prix' : 'panneau'} · ${check.meta.inputs} réglage${check.meta.inputs > 1 ? 's' : ''} · ${check.outputs} tracé${check.outputs > 1 ? 's' : ''}`}
      </div>
      {check.warnings.length > 0 && (
        <ul className="pe-warnings">{check.warnings.map((w) => <li key={w}>⚠ {w}</li>)}</ul>
      )}
      <div className="pe-actions">
        <button className="pill-btn" disabled={!ok || !dirty} onClick={() => { save(); showToast(onChart ? 'Script enregistré et graphique mis à jour' : 'Script enregistré'); }}>
          {onChart ? 'Enregistrer et mettre à jour' : 'Enregistrer'}
        </button>
        <button className="pill-btn primary" disabled={!ok} onClick={addToChart}>Ajouter au graphique</button>
      </div>
    </div>
  );
}
