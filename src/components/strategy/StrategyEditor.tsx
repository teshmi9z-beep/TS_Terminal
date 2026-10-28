import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, nextId } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { INDICATORS, INDICATOR_LIST, indicatorTitle } from '../../indicators/registry';
import type { BuiltinIndicatorType, IndicatorConfig } from '../../types';
import {
  OPERATORS, PRICE_LABELS, newConditionId, operandLabel, operandPlots,
  type Condition, type ConditionGroup, type Operand, type PriceField, type RulesStrategy, type StopRule, type TargetRule,
} from '../../strategy/rules';
import { rulesToPine } from '../../strategy/codegen';
import { inspectPineStrategy } from '../../strategy/pineStrategy';
import { newAssisted, newCode, type StrategyDoc } from '../../strategy/doc';
import type { QtyMode } from '../../strategy/types';
import { LOCALE } from '../../i18n/lang';

// ---------------------------------------------------------------- operands

function operandColor(o: Operand): string | undefined {
  if (o.kind !== 'indicator') return undefined;
  return o.cfg.plotColors?.[o.plot] ?? o.cfg.bandColors?.[o.plot === 'up' ? 'upper' : o.plot === 'low' ? 'lower' : 'mid'] ?? o.cfg.color;
}

function chartOperands(indicators: IndicatorConfig[]): { op: Operand; label: string; color: string }[] {
  return indicators.flatMap((cfg) => {
    const plots = operandPlots(cfg);
    return plots.map((p) => {
      const op: Operand = { kind: 'indicator', cfg: { ...cfg }, plot: p.key };
      return { op, label: plots.length > 1 ? `${indicatorTitle(cfg)} · ${p.name}` : indicatorTitle(cfg), color: operandColor(op) ?? cfg.color };
    });
  });
}

// popover to choose one side of a condition: an indicator of the chart (or a
// click on it), the price, a value, or any other indicator
function OperandPicker({ anchor, value, onChange, onClose }: {
  anchor: DOMRect; value: Operand; onChange: (op: Operand) => void; onClose: () => void;
}) {
  const indicators = useStore((s) => s.indicators);
  const addIndicator = useStore((s) => s.addIndicator);
  const setPick = useChartUi((s) => s.setStrategyPick);
  const [num, setNum] = useState(value.kind === 'value' ? String(value.value) : '');
  const [libType, setLibType] = useState<BuiltinIndicatorType>(value.kind === 'indicator' && value.cfg.type !== 'PINE' && value.cfg.type !== 'STRATEGY' ? value.cfg.type : 'SMA');
  const libDef = INDICATORS[libType];
  const [libPeriod, setLibPeriod] = useState(value.kind === 'indicator' && value.cfg.type === libType ? value.cfg.period : libDef.defaults.period);
  const [libPlot, setLibPlot] = useState('');
  const [alsoChart, setAlsoChart] = useState(true);
  const fromChart = chartOperands(indicators);

  const libCfg: IndicatorConfig = { id: nextId(), type: libType, overlay: libDef.overlay, visible: true, ...structuredClone(libDef.defaults), period: libPeriod };
  const libPlots = operandPlots(libCfg);

  const below = anchor.top < window.innerHeight / 2;
  const style: React.CSSProperties = {
    left: Math.max(8, Math.min(anchor.left, window.innerWidth - 340)),
    ...(below ? { top: anchor.bottom + 4, maxHeight: window.innerHeight - anchor.bottom - 16 } : { bottom: window.innerHeight - anchor.top + 4, maxHeight: anchor.top - 16 }),
  };

  return (
    <>
      <div className="se-backdrop" onMouseDown={onClose} />
      <div className="se-picker" style={style}>
        <button
          className="se-pick-chart"
          onClick={() => {
            setPick((op) => { onChange(op); useChartUi.getState().setStrategyPick(null); });
            // the chart must be visible to click on it
            useStore.getState().setBottomDock({ maximized: false });
            onClose();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" /><path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" /></svg>
          Sélectionner sur le graphique
        </button>

        <div className="se-picker-sub">Indicateurs du graphique</div>
        {fromChart.length === 0 && <div className="se-picker-empty">Aucun indicateur sur le graphique.</div>}
        <div className="se-picker-list">
          {fromChart.map((x, i) => (
            <button key={i} className="se-picker-item" onClick={() => { onChange(x.op); onClose(); }}>
              <span className="se-dot" style={{ background: x.color }} />{x.label}
            </button>
          ))}
        </div>

        <div className="se-picker-sub">Prix</div>
        <div className="se-picker-chips">
          {(Object.keys(PRICE_LABELS) as PriceField[]).map((f) => (
            <button key={f} className={`ss-chip ${value.kind === 'price' && value.field === f ? 'active' : ''}`} onClick={() => { onChange({ kind: 'price', field: f }); onClose(); }}>
              {PRICE_LABELS[f]}
            </button>
          ))}
        </div>

        <div className="se-picker-sub">Valeur</div>
        <div className="se-picker-row">
          <input
            type="number" step="any" placeholder="ex : 70" value={num} onChange={(e) => setNum(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && num.trim()) { onChange({ kind: 'value', value: parseFloat(num) }); onClose(); } }}
          />
          <button className="pill-btn" disabled={!num.trim() || isNaN(parseFloat(num))} onClick={() => { onChange({ kind: 'value', value: parseFloat(num) }); onClose(); }}>OK</button>
        </div>

        <div className="se-picker-sub">Autre indicateur</div>
        <div className="se-picker-row">
          <select value={libType} onChange={(e) => { const t = e.target.value as BuiltinIndicatorType; setLibType(t); setLibPeriod(INDICATORS[t].defaults.period); setLibPlot(''); }}>
            {INDICATOR_LIST.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
          </select>
          {libDef.defaults.period > 0 && (
            <input type="number" min={1} className="se-num" title="Période" value={libPeriod} onChange={(e) => setLibPeriod(Math.max(1, parseInt(e.target.value) || 1))} />
          )}
        </div>
        {libPlots.length > 1 && (
          <div className="se-picker-row">
            <select value={libPlot || libPlots[0].key} onChange={(e) => setLibPlot(e.target.value)}>
              {libPlots.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div className="se-picker-row">
          <label className="se-check"><input type="checkbox" checked={alsoChart} onChange={(e) => setAlsoChart(e.target.checked)} /> l’ajouter au graphique</label>
          <button
            className="pill-btn primary" disabled={!libPlots.length}
            onClick={() => {
              if (alsoChart) addIndicator(libCfg);
              onChange({ kind: 'indicator', cfg: libCfg, plot: libPlot || libPlots[0].key });
              onClose();
            }}
          >
            Utiliser
          </button>
        </div>
      </div>
    </>
  );
}

function OperandChip({ value, onChange }: { value: Operand; onChange: (op: Operand) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const color = operandColor(value);
  return (
    <>
      <button className={`se-chip ${value.kind}`} title="Changer" onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
        {color && <span className="se-dot" style={{ background: color }} />}
        {operandLabel(value)}
      </button>
      {anchor && <OperandPicker anchor={anchor} value={value} onChange={onChange} onClose={() => setAnchor(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- conditions

function ConditionRow({ c, onChange, onRemove }: { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const unary = OPERATORS.find((o) => o.id === c.op)?.unary;
  return (
    <div className="se-cond">
      <OperandChip value={c.left} onChange={(left) => onChange({ ...c, left })} />
      <select className="se-op" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as Condition['op'] })}>
        {OPERATORS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {!unary && <OperandChip value={c.right} onChange={(right) => onChange({ ...c, right })} />}
      <button className="pl-btn danger se-cond-del" title="Supprimer la condition" onClick={onRemove}>✕</button>
    </div>
  );
}

function GroupEditor({ group, onChange, defaultOp }: { group: ConditionGroup; onChange: (g: ConditionGroup) => void; defaultOp: Condition['op'] }) {
  const indicators = useStore((s) => s.indicators);
  function add() {
    const ops = chartOperands(indicators).map((x) => x.op);
    const left: Operand = ops[0] ?? { kind: 'price', field: 'close' };
    const right: Operand = ops[1] ?? (ops[0] ? { kind: 'price', field: 'close' } : { kind: 'value', value: 0 });
    onChange({ ...group, conditions: [...group.conditions, { id: newConditionId(), left, op: defaultOp, right }] });
  }
  return (
    <div className="se-group">
      {group.conditions.map((c, i) => (
        <div key={c.id}>
          {i > 0 && (
            <button className="se-join" title="Changer ET / OU" onClick={() => onChange({ ...group, join: group.join === 'and' ? 'or' : 'and' })}>
              {group.join === 'and' ? 'ET' : 'OU'}
            </button>
          )}
          <ConditionRow
            c={c}
            onChange={(nc) => onChange({ ...group, conditions: group.conditions.map((x) => (x.id === c.id ? nc : x)) })}
            onRemove={() => onChange({ ...group, conditions: group.conditions.filter((x) => x.id !== c.id) })}
          />
        </div>
      ))}
      <button className="se-add" onClick={add}>＋ Ajouter une condition</button>
    </div>
  );
}

// ---------------------------------------------------------------- stops, targets, money management

function NumField({ label, value, onChange, step = 'any', min }: { label: string; value: number; onChange: (v: number) => void; step?: string; min?: number }) {
  return (
    <label className="se-field">
      <span>{label}</span>
      <input type="number" step={step} min={min} value={value} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }} />
    </label>
  );
}

function StopTargetCard({ r, set }: { r: RulesStrategy; set: (p: Partial<RulesStrategy>) => void }) {
  const s = r.stop, t = r.target;
  const setStop = (kind: StopRule['kind']) => set({
    stop: kind === 'swing' ? { kind, bars: 3 } : kind === 'percent' ? { kind, value: 1 } : kind === 'points' ? { kind, value: 10 } : kind === 'atr' ? { kind, length: 14, mult: 2 } : { kind: 'none' },
  });
  const setTarget = (kind: TargetRule['kind']) => set({
    target: kind === 'rr' ? { kind, ratio: 1 } : kind === 'percent' ? { kind, value: 2 } : kind === 'points' ? { kind, value: 20 } : { kind: 'none' },
  });
  const rrPreset = t.kind === 'rr' && [1, 2, 3].includes(t.ratio) ? String(t.ratio) : 'autre';
  return (
    <div className="se-card">
      <div className="se-card-head neutral">Stops & objectifs</div>
      <label className="se-field">
        <span>Stop loss</span>
        <select value={s.kind} onChange={(e) => setStop(e.target.value as StopRule['kind'])}>
          <option value="swing">Plus bas / plus haut des N dernières bougies</option>
          <option value="percent">Pourcentage du prix</option>
          <option value="points">Points (écart de prix)</option>
          <option value="atr">ATR × multiplicateur</option>
          <option value="none">Aucun</option>
        </select>
      </label>
      {s.kind === 'swing' && <NumField label="Nombre de bougies" value={s.bars} min={1} step="1" onChange={(v) => set({ stop: { kind: 'swing', bars: Math.max(1, Math.round(v)) } })} />}
      {s.kind === 'percent' && <NumField label="Stop (%)" value={s.value} onChange={(v) => set({ stop: { kind: 'percent', value: v } })} />}
      {s.kind === 'points' && <NumField label="Stop (points)" value={s.value} onChange={(v) => set({ stop: { kind: 'points', value: v } })} />}
      {s.kind === 'atr' && (
        <>
          <NumField label="Période ATR" value={s.length} step="1" min={1} onChange={(v) => set({ stop: { ...s, length: Math.max(1, Math.round(v)) } })} />
          <NumField label="Multiplicateur" value={s.mult} onChange={(v) => set({ stop: { ...s, mult: v } })} />
        </>
      )}
      <label className="se-field">
        <span>Objectif</span>
        <select value={t.kind} onChange={(e) => setTarget(e.target.value as TargetRule['kind'])}>
          <option value="rr">Ratio risque / rendement</option>
          <option value="percent">Pourcentage du prix</option>
          <option value="points">Points (écart de prix)</option>
          <option value="none">Aucun</option>
        </select>
      </label>
      {t.kind === 'rr' && (
        <label className="se-field">
          <span>R / R (gain = R × risque)</span>
          <span className="se-inline">
            <select value={rrPreset} onChange={(e) => { if (e.target.value !== 'autre') set({ target: { kind: 'rr', ratio: parseFloat(e.target.value) } }); else set({ target: { kind: 'rr', ratio: 1.5 } }); }}>
              <option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="autre">autre…</option>
            </select>
            {rrPreset === 'autre' && <input type="number" step="0.1" min={0.1} value={t.ratio} onChange={(e) => { const v = parseFloat(e.target.value); if (v > 0) set({ target: { kind: 'rr', ratio: v } }); }} />}
          </span>
        </label>
      )}
      {t.kind === 'rr' && s.kind === 'none' && <div className="se-warn">Le ratio R/R a besoin d’un stop loss.</div>}
      {t.kind === 'percent' && <NumField label="Objectif (%)" value={t.value} onChange={(v) => set({ target: { kind: 'percent', value: v } })} />}
      {t.kind === 'points' && <NumField label="Objectif (points)" value={t.value} onChange={(v) => set({ target: { kind: 'points', value: v } })} />}
    </div>
  );
}

const SIZING: { id: QtyMode; label: string; unit: string }[] = [
  { id: 'risk', label: 'Risque par trade (% du capital)', unit: '%' },
  { id: 'percent', label: 'Taille en % du capital', unit: '%' },
  { id: 'cash', label: 'Montant fixe par trade', unit: '' },
  { id: 'fixed', label: 'Quantité fixe (contrats / unités)', unit: '' },
];

function MoneyCard({ r, set }: { r: RulesStrategy; set: (p: Partial<RulesStrategy>) => void }) {
  return (
    <div className="se-card">
      <div className="se-card-head neutral">Money management</div>
      <label className="se-field">
        <span>Taille des positions</span>
        <select value={r.sizing.mode} onChange={(e) => { const mode = e.target.value as QtyMode; set({ sizing: { mode, value: mode === 'risk' ? 1 : mode === 'percent' ? 100 : mode === 'cash' ? 10000 : 1 } }); }}>
          {SIZING.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <NumField label={SIZING.find((s) => s.id === r.sizing.mode)?.label ?? 'Valeur'} value={r.sizing.value} onChange={(v) => set({ sizing: { ...r.sizing, value: v } })} />
      <NumField label="Capital initial" value={r.initialCapital} step="1000" min={1} onChange={(v) => set({ initialCapital: Math.max(1, v) })} />
      <NumField label="Commission (% par ordre)" value={r.commissionPct} step="0.01" min={0} onChange={(v) => set({ commissionPct: Math.max(0, v) })} />
      <label className="se-field">
        <span>Exécution des ordres</span>
        <select value={r.fillOnClose ? 'close' : 'open'} onChange={(e) => set({ fillOnClose: e.target.value === 'close' })}>
          <option value="open">Ouverture de la bougie suivante</option>
          <option value="close">Clôture de la bougie du signal</option>
        </select>
      </label>
      <label className="se-check"><input type="checkbox" checked={r.reverse} onChange={(e) => set({ reverse: e.target.checked })} /> Un signal contraire retourne la position</label>
    </div>
  );
}

function AssistedEditor({ r, set }: { r: RulesStrategy; set: (p: Partial<RulesStrategy>) => void }) {
  return (
    <div className="se-grid">
      <div className={`se-card ${r.longEnabled ? '' : 'off'}`}>
        <div className="se-card-head buy">
          <label className="se-check"><input type="checkbox" checked={r.longEnabled} onChange={(e) => set({ longEnabled: e.target.checked })} /> Acheter</label>
          <small>entrée à l’achat</small>
        </div>
        <GroupEditor group={r.longEntry} defaultOp="crosses_above" onChange={(g) => set({ longEntry: g })} />
      </div>
      <div className={`se-card ${r.longEnabled ? '' : 'off'}`}>
        <div className="se-card-head buy-exit">Vendre <small>sortie de l’achat (optionnel)</small></div>
        <GroupEditor group={r.longExit} defaultOp="crosses_below" onChange={(g) => set({ longExit: g })} />
      </div>
      <div className={`se-card ${r.shortEnabled ? '' : 'off'}`}>
        <div className="se-card-head sell">
          <label className="se-check"><input type="checkbox" checked={r.shortEnabled} onChange={(e) => set({ shortEnabled: e.target.checked })} /> Vendre à découvert</label>
          <small>entrée à la vente</small>
        </div>
        <GroupEditor group={r.shortEntry} defaultOp="crosses_below" onChange={(g) => set({ shortEntry: g })} />
      </div>
      <div className={`se-card ${r.shortEnabled ? '' : 'off'}`}>
        <div className="se-card-head sell-exit">Racheter <small>sortie de la vente (optionnel)</small></div>
        <GroupEditor group={r.shortExit} defaultOp="crosses_above" onChange={(g) => set({ shortExit: g })} />
      </div>
      <StopTargetCard r={r} set={set} />
      <MoneyCard r={r} set={set} />
    </div>
  );
}

// ---------------------------------------------------------------- code

function GeneratedCode({ doc, onConvert }: { doc: StrategyDoc; onConvert: (code: string) => void }) {
  const { code, missing } = useMemo(() => rulesToPine(doc.name, doc.rules), [doc.name, doc.rules]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="se-generated">
      <div className="se-gen-bar">
        <span>Code Pine Script équivalent (utilisable tel quel sur TradingView)</span>
        <button className="pill-btn" onClick={() => { void navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copié ✓' : 'Copier'}</button>
        <button className="pill-btn" disabled={missing.length > 0} title={missing.length ? 'Certains indicateurs n’ont pas d’équivalent Pine' : ''} onClick={() => onConvert(code)}>
          Modifier en code
        </button>
      </div>
      {missing.length > 0 && <div className="se-warn">Sans équivalent ta.* : {missing.join(', ')} (le backtest de la création assistée les utilise quand même).</div>}
      <pre className="se-code-view">{code}</pre>
    </div>
  );
}

function CodeEditor({ doc, update }: { doc: StrategyDoc; update: (p: Partial<StrategyDoc>) => void }) {
  const [src, setSrc] = useState(doc.code);
  const [debounced, setDebounced] = useState(doc.code);
  const gutterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (src === doc.code) return;
    const id = setTimeout(() => { setDebounced(src); update({ code: src }); }, 500);
    return () => clearTimeout(id);
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = useMemo(() => inspectPineStrategy(debounced), [debounced]);
  const lines = src.split('\n').length;
  return (
    <div className="se-code-layout">
      <div className="pe-code se-code">
        <div className="pe-gutter" ref={gutterRef}>
          {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <textarea
          spellCheck={false} value={src} onChange={(e) => setSrc(e.target.value)}
          onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd;
              const next = src.slice(0, a) + '    ' + src.slice(b);
              setSrc(next);
              requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 4; });
            }
          }}
        />
      </div>
      <div className="se-code-side">
        {info.error
          ? <div className="pe-status bad">✗ {info.error}</div>
          : info.isStrategy
            ? <div className="pe-status ok">✓ {info.title}</div>
            : <div className="pe-status bad">✗ Il faut une déclaration strategy("…")</div>}
        {info.warnings.map((w, i) => <div key={i} className="se-warn">{w}</div>)}
        {!info.error && (
          <div className="se-code-meta">
            Capital {info.settings.initialCapital.toLocaleString(LOCALE)} · taille {info.settings.qtyMode === 'percent' ? `${info.settings.qtyValue} % du capital` : info.settings.qtyMode === 'cash' ? `${info.settings.qtyValue} par trade` : `${info.settings.qtyValue} unité(s)`}
          </div>
        )}
        {info.inputs.length > 0 && <div className="se-picker-sub">Paramètres</div>}
        {info.inputs.map((inp) => {
          const v = doc.inputs?.[inp.key] ?? inp.default;
          const setV = (nv: number | boolean | string) => update({ inputs: { ...doc.inputs, [inp.key]: nv } });
          const label = inp.label || inp.key;
          if (inp.kind === 'bool') return <label key={inp.key} className="se-check"><input type="checkbox" checked={v === true} onChange={(e) => setV(e.target.checked)} /> {label}</label>;
          if (inp.options?.length) {
            return (
              <label key={inp.key} className="se-field">
                <span>{label}</span>
                <select value={String(v)} onChange={(e) => setV(inp.kind === 'number' ? parseFloat(e.target.value) : e.target.value)}>
                  {inp.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            );
          }
          if (inp.kind === 'number') return <NumField key={inp.key} label={label} value={Number(v)} step={String(inp.step ?? 'any')} onChange={setV} />;
          return (
            <label key={inp.key} className="se-field">
              <span>{label}</span>
              <input value={String(v)} onChange={(e) => setV(e.target.value)} />
            </label>
          );
        })}
        {doc.inputs && Object.keys(doc.inputs).length > 0 && <button className="si-more" onClick={() => update({ inputs: {} })}>Valeurs par défaut</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor

export default function StrategyEditor() {
  const strategies = useStore((s) => s.strategies);
  const activeId = useStore((s) => s.activeStrategyId);
  const upsert = useStore((s) => s.upsertStrategy);
  const remove = useStore((s) => s.removeStrategy);
  const setActive = useStore((s) => s.setActiveStrategy);
  const setDock = useStore((s) => s.setBottomDock);
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const [assistedView, setAssistedView] = useState<'rules' | 'code'>('rules');
  const [newMenu, setNewMenu] = useState(false);
  const doc = strategies.find((d) => d.id === activeId) ?? strategies[0];

  const create = (d: StrategyDoc) => { upsert(d); setActive(d.id); setNewMenu(false); setAssistedView('rules'); };

  if (!doc) {
    return (
      <div className="se-empty">
        Aucune stratégie.
        <button className="pill-btn primary" onClick={() => create(newAssisted('Nouvelle stratégie'))}>Création assistée</button>
        <button className="pill-btn" onClick={() => create(newCode('Nouvelle stratégie'))}>Code Pine</button>
      </div>
    );
  }

  const update = (p: Partial<StrategyDoc>) => upsert({ ...doc, ...p, updatedAt: Date.now() });
  const setRules = (p: Partial<RulesStrategy>) => update({ rules: { ...doc.rules, ...p } });

  return (
    <div className="strategy-editor">
      <div className="se-toolbar">
        <select className="se-select" value={doc.id} onChange={(e) => setActive(e.target.value)}>
          {strategies.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.mode === 'assisted' ? 'assistée' : 'code'})</option>)}
        </select>
        <button className="pl-btn" title="Renommer" onClick={() => { const n = window.prompt('Nom de la stratégie :', doc.name); if (n) update({ name: n }); }}>✎</button>
        <div className="se-new">
          <button className="pill-btn" onClick={() => setNewMenu(!newMenu)}>＋ Nouvelle</button>
          {newMenu && (
            <>
              <div className="se-backdrop" onMouseDown={() => setNewMenu(false)} />
              <div className="se-new-menu">
                <button onClick={() => create(newAssisted('Nouvelle stratégie'))}>Création assistée<small>conditions choisies sur le graphique</small></button>
                <button onClick={() => create(newCode('Nouvelle stratégie'))}>Code Pine Script<small>strategy.entry / exit / close</small></button>
              </div>
            </>
          )}
        </div>
        <button className="pl-btn" title="Dupliquer" onClick={() => create({ ...structuredClone(doc), id: `st${Date.now().toString(36)}`, name: `${doc.name} (copie)`, updatedAt: Date.now() })}>⧉</button>
        <button
          className="pl-btn danger" title="Supprimer" disabled={strategies.length <= 1}
          onClick={() => { if (window.confirm(`Supprimer la stratégie « ${doc.name} » ?`)) remove(doc.id); }}
        >🗑</button>
        {doc.mode === 'assisted' && (
          <div className="se-seg">
            <button className={assistedView === 'rules' ? 'active' : ''} onClick={() => setAssistedView('rules')}>Création assistée</button>
            <button className={assistedView === 'code' ? 'active' : ''} onClick={() => setAssistedView('code')}>Code généré</button>
          </div>
        )}
        <div className="se-spacer" />
        <span className="se-target">sur {symbol.ticker} · {timeframe}</span>
        {/* like TradingView's "Ajouter au graphique": the strategy is drawn on the chart and tested */}
        <button className="pill-btn primary se-run" onClick={() => { useStore.getState().setStrategyOnChart(doc.id); setDock({ tab: 'tester' }); }}>▶ Lancer le backtest</button>
      </div>
      <div className="se-body">
        {doc.mode === 'code' ? (
          <CodeEditor key={doc.id} doc={doc} update={update} />
        ) : assistedView === 'rules' ? (
          <AssistedEditor r={doc.rules} set={setRules} />
        ) : (
          <GeneratedCode doc={doc} onConvert={(code) => create({ ...newCode(`${doc.name} (code)`), code })} />
        )}
      </div>
    </div>
  );
}
