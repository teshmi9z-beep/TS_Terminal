import { useEffect, useMemo, useState } from 'react';
import { useStore, nextId } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { INDICATOR_LIST, getIndicatorDef, type IndicatorCategory, type IndicatorDef } from '../indicators/registry';

const CATEGORIES: ('Tous' | IndicatorCategory)[] = ['Tous', 'Personnalises', 'Tendance', 'Oscillateurs', 'Volatilite', 'Volume'];
const CAT_LABEL: Record<string, string> = {
  Tous: 'Tous', Personnalises: 'Mes scripts', Tendance: 'Tendance', Oscillateurs: 'Oscillateurs', Volatilite: 'Volatilité', Volume: 'Volume',
};
// TradingView's "Mes scripts": indicators and strategies
type ScriptKind = 'all' | 'indicators' | 'strategies';

export default function IndicatorMenu({ onClose }: { onClose: () => void }) {
  const addIndicator = useStore((s) => s.addIndicator);
  const indicators = useStore((s) => s.indicators);
  const pineScripts = useStore((s) => s.pineScripts);
  const strategies = useStore((s) => s.strategies);
  const setStrategyOnChart = useStore((s) => s.setStrategyOnChart);
  const setActiveStrategy = useStore((s) => s.setActiveStrategy);
  const setBottomDock = useStore((s) => s.setBottomDock);
  const openPineEditor = useChartUi((s) => s.openPineEditor);
  const [kind, setKind] = useState<ScriptKind>('all');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<'Tous' | IndicatorCategory>('Tous');
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const mine = cat === 'Tous' || cat === 'Personnalises';
  const showIndicators = !mine || cat === 'Tous' || kind !== 'strategies';
  const showStrategies = mine && kind !== 'indicators';
  const list = useMemo(() => INDICATOR_LIST.filter((d) => (cat === 'Tous' || d.category === cat)
    && (!q || d.label.toLowerCase().includes(q) || d.short.toLowerCase().includes(q))), [q, cat]);
  const strategyRows = strategies.filter((s) => !q || s.name.toLowerCase().includes(q));
  const onChart = indicators.find((i) => i.type === 'STRATEGY')?.strategyId;

  // like TradingView: a strategy goes on the chart and opens the strategy tester
  function addStrategy(id: string) {
    setStrategyOnChart(id);
    setBottomDock({ tab: 'tester' });
    onClose();
  }

  function add(def: IndicatorDef) {
    addIndicator({ id: nextId(), type: def.type, overlay: def.overlay, ...structuredClone(def.defaults) });
    setAdded(def.type);
    setTimeout(() => setAdded((a) => (a === def.type ? null : a)), 1200);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="symbol-search indicator-menu" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ss-head">
          <span className="ss-title">Indicateurs</span>
          <button className="remove-btn" onClick={onClose}>✕</button>
        </div>
        <div className="ss-input-row">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2L16 16" /></svg>
          <input autoFocus placeholder="Rechercher un indicateur" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="ss-filters">
          {CATEGORIES.map((c) => (
            <button key={c} className={`ss-chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{CAT_LABEL[c]}</button>
          ))}
        </div>
        {cat === 'Personnalises' && (
          <div className="ss-filters ind-kinds">
            {([['all', 'Tout'], ['indicators', 'Indicateurs'], ['strategies', 'Stratégies']] as const).map(([k, label]) => (
              <button key={k} className={`ss-chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{label}</button>
            ))}
          </div>
        )}
        <div className="ss-list">
          {showStrategies && strategyRows.map((s) => (
            <div key={s.id} className="ss-item" onClick={() => addStrategy(s.id)}>
              <span className="ind-menu-dot strategy" title="Stratégie">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1.5 11l3.5-4 3 2.5 4.5-6" /><path d="M9.5 3.5h3v3" /></svg>
              </span>
              <span className="ind-menu-name">{s.name}</span>
              <span className="ss-name">Stratégie {s.mode === 'assisted' ? '(création assistée)' : '(Pine Script)'}</span>
              <button
                className="pl-btn" title="Modifier dans l’éditeur de stratégie"
                onClick={(e) => { e.stopPropagation(); setActiveStrategy(s.id); setBottomDock({ tab: 'editor' }); onClose(); }}
              >✎</button>
              <span className={`ss-add ${onChart === s.id ? 'done' : ''}`}>{onChart === s.id ? '✓' : '+'}</span>
            </div>
          ))}
          {showIndicators && (cat === 'Tous' || cat === 'Personnalises') && (
            <div className="ss-item pine-new" onClick={() => { onClose(); openPineEditor(); }}>
              <span className="ind-menu-dot pine">{'{}'}</span>
              <span className="ind-menu-name">Nouveau script Pine</span>
              <span className="ss-name">Collez un indicateur TradingView (Pine Script v5)</span>
              <span className="ss-type">éditeur</span>
              <span className="ss-add">＋</span>
            </div>
          )}
          {showIndicators && (cat === 'Tous' || cat === 'Personnalises') && pineScripts
            .filter((s) => !query.trim() || s.name.toLowerCase().includes(query.trim().toLowerCase()))
            .map((s) => {
              const def = getIndicatorDef({ type: 'PINE', scriptId: s.id });
              const count = indicators.filter((i) => i.type === 'PINE' && i.scriptId === s.id).length;
              return (
                <div
                  key={s.id} className="ss-item"
                  onClick={() => {
                    if (!def) { openPineEditor(s.id); onClose(); return; }
                    addIndicator({ id: nextId(), type: 'PINE', scriptId: s.id, overlay: def.overlay, period: 0, color: def.defaults.color });
                    setAdded(s.id);
                    setTimeout(() => setAdded((a) => (a === s.id ? null : a)), 1200);
                  }}
                >
                  <span className="ind-menu-dot pine">{'{}'}</span>
                  <span className="ind-menu-name">{s.name}</span>
                  <span className="ss-name">{def ? 'Script Pine' : 'Script Pine avec erreur : cliquer pour corriger'}</span>
                  <button className="pl-btn" title="Modifier dans l’éditeur" onClick={(e) => { e.stopPropagation(); onClose(); openPineEditor(s.id); }}>✎</button>
                  <span className={`ss-add ${added === s.id ? 'done' : ''}`}>{added === s.id ? '✓' : count ? `+ (${count})` : '+'}</span>
                </div>
              );
            })}
          {showIndicators && list.map((d) => {
            const count = indicators.filter((i) => i.type === d.type).length;
            return (
              <div key={d.type} className="ss-item" onClick={() => add(d)}>
                <span className="ind-menu-dot" style={{ background: d.defaults.color }} />
                <span className="ind-menu-name">{d.label}</span>
                <span className="ss-name">{d.description}</span>
                <span className="ss-type">{d.overlay ? 'sur le prix' : 'panneau'}</span>
                <span className={`ss-add ${added === d.type ? 'done' : ''}`}>{added === d.type ? '✓' : count ? `+ (${count})` : '+'}</span>
              </div>
            );
          })}
        </div>
        <div className="ss-foot">Clique pour ajouter. Les panneaux se redimensionnent en glissant leur séparateur, et se réduisent / agrandissent avec les boutons en haut à droite de chaque panneau.</div>
      </div>
    </div>
  );
}
