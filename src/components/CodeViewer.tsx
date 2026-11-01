import { useEffect, useState } from 'react';
import { useChartUi } from '../store/chartUi';
import { getIndicatorDef } from '../indicators/registry';
import { useStore, nextId } from '../store/store';
import { indicatorSources } from '../indicators/sources';
import { highlightLine, type CodeLang as Lang } from './codeHighlight';

// read-only source panel opened by the "{}" button of an indicator, like TradingView's
export default function CodeViewer() {
  const target = useChartUi((s) => s.codeFor);
  const openPineEditor = useChartUi((s) => s.openPineEditor);
  const pineScripts = useStore((s) => s.pineScripts);
  const upsertPineScript = useStore((s) => s.upsertPineScript);
  const setCodeFor = useChartUi((s) => s.setCodeFor);
  const [tab, setTab] = useState<Lang>('pine');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCodeFor(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCodeFor]);

  if (!target) return null;
  const type = target.type;
  const def = getIndicatorDef(target);
  const script = type === 'PINE' ? pineScripts.find((x) => x.id === target.scriptId) : undefined;
  const src = type === 'PINE' ? { pine: script?.source } : indicatorSources(type);
  const lang: Lang = tab === 'ts' && src.ts ? 'ts' : src.pine ? 'pine' : 'ts';
  const code = (lang === 'pine' ? src.pine : src.ts) ?? '';
  const lines = code.replace(/\n$/, '').split('\n');

  // a built-in indicator: its Pine version becomes a script of "Mes scripts" opened in the Pine
  // editor (TradingView's "Créer une copie modifiable"); a copy not changed yet is opened again.
  // Opened from the chart, the copy takes that indicator's place when first saved.
  function editCopy() {
    const source = src.pine!;
    const known = pineScripts.find((x) => x.source === source);
    const id = known?.id ?? nextId();
    if (!known) upsertPineScript({ id, name: def?.label ?? type, source, updatedAt: Date.now() });
    openPineEditor(id, target?.indicatorId);
  }

  function copy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => setCodeFor(null)}>
      <div className="code-viewer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cv-head">
          <span className="cv-title">{'{ }'} {def?.label ?? type}</span>
          <div className="cv-tabs">
            {src.pine && <button className={`cv-tab ${lang === 'pine' ? 'active' : ''}`} onClick={() => setTab('pine')}>Pine Script</button>}
            {src.ts && <button className={`cv-tab ${lang === 'ts' ? 'active' : ''}`} onClick={() => setTab('ts')}>TypeScript (plateforme)</button>}
          </div>
          {script && <button className="pill-btn" onClick={() => openPineEditor(script.id)}>✎ Modifier</button>}
          {!script && src.pine && (
            <button className="pill-btn" title="Créer une copie modifiable dans Mes scripts (nom, calcul, couleurs…) et l’ouvrir dans l’éditeur Pine" onClick={editCopy}>✎ Modifier le code</button>
          )}
          <button className="pill-btn" onClick={copy}>{copied ? 'Copié ✓' : 'Copier'}</button>
          <button className="remove-btn cv-close" onClick={() => setCodeFor(null)}>✕</button>
        </div>
        <div className="cv-note">
          {lang === 'pine'
            ? type === 'PINE' ? 'Script Pine exécuté par l’interpréteur Pine de la plateforme.' : type === 'STOCH_ENV' ? 'Script Pine d’origine (référence TradingView).' : 'Équivalent Pine Script v5 de cet indicateur (référence TradingView).'
            : 'Code réellement exécuté par la plateforme (lecture seule).'}
        </div>
        <pre className="cv-code">
          {lines.map((l, i) => (
            <div key={i} className="cv-line">
              <span className="cv-ln">{i + 1}</span>
              <span className="cv-src">{highlightLine(l, lang)}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
