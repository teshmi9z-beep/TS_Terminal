import { useEffect, useState, type ReactNode } from 'react';
import { useChartUi } from '../store/chartUi';
import { getIndicatorDef } from '../indicators/registry';
import { useStore } from '../store/store';
import { indicatorSources } from '../indicators/sources';

type Lang = 'pine' | 'ts';

const KEYWORDS: Record<Lang, RegExp> = {
  pine: /^(if|else|for|to|while|var|varip|and|or|not|true|false|na|switch|import|export|method|type)$/,
  ts: /^(import|export|from|const|let|var|function|return|if|else|for|while|of|in|new|type|as|true|false|null|undefined|this|typeof|break|continue)$/,
};
const TOKEN = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(#[0-9a-fA-F]{6,8}\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w.]*)/g;

// minimal syntax coloring: comments, strings, colors, numbers, keywords, ta./math. calls
function highlightLine(line: string, lang: Lang): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(line.slice(last, i));
    const [text, comment, str, color, num, word] = m;
    let cls = '';
    if (comment) cls = 'tk-comment';
    else if (str) cls = 'tk-string';
    else if (color) cls = 'tk-color';
    else if (num) cls = 'tk-number';
    else if (word && KEYWORDS[lang].test(word)) cls = 'tk-keyword';
    else if (word && /^(ta|math|input|color|plot|hline|indicator|strategy|str|array)(\.|$)/.test(word)) cls = 'tk-builtin';
    out.push(cls ? <span key={i} className={cls}>{text}</span> : text);
    last = i + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// read-only source panel opened by the "{}" button of an indicator, like TradingView's
export default function CodeViewer() {
  const target = useChartUi((s) => s.codeFor);
  const openPineEditor = useChartUi((s) => s.openPineEditor);
  const pineScripts = useStore((s) => s.pineScripts);
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
