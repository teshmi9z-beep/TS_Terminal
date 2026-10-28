import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore, indicatorKey } from '../store/store';
import { getIndicatorDef, indicatorTitle, sourcePlots } from '../indicators/registry';
import { PRICE_SOURCES, dependentsOf, sourceKey } from '../indicators/derived';
import type { IndicatorDef, InputDef } from '../indicators/types';
import type { IndicatorConfig, TfVisibility, VisibilityUnit } from '../types';
import { ColorSwatch } from './ColorPicker';

// TradingView's indicator settings dialog: "Paramètres en entrée" (inputs grouped
// and on one line as declared with group= / inline=), "Style" (color with opacity,
// width, visibility of each plot, levels), "Visibilité" (timeframes). Changes apply
// at once; "Annuler" puts the settings back as they were when the dialog opened.

const SOURCES = PRICE_SOURCES;

type Tab = 'inputs' | 'style' | 'visibility';

// ---------------------------------------------------------------- small fields

function NumberField({ value, onChange, min, max, step, width = 72 }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; width?: number;
}) {
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) { setPrev(value); setText(String(value)); }
  return (
    <input
      className="idg-num" style={{ width }} type="number" value={text} min={min} max={max} step={step ?? 'any'}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value.replace(',', '.'));
        if (!isNaN(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
      }}
    />
  );
}

const hhmm = (s: string) => `${s.slice(0, 2)}:${s.slice(2, 4)}`;

// Pine session "HHMM-HHMM" as two time fields (other formats stay editable as text)
function SessionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = /^(\d{4})-(\d{4})(.*)$/.exec(value);
  if (!m) return <input className="idg-text" value={value} onChange={(e) => onChange(e.target.value)} />;
  const set = (a: string, b: string) => onChange(`${a.replace(':', '')}-${b.replace(':', '')}${m[3]}`);
  return (
    <span className="idg-session">
      <input type="time" value={hhmm(m[1])} onChange={(e) => e.target.value && set(e.target.value, hhmm(m[2]))} />
      <span>–</span>
      <input type="time" value={hhmm(m[2])} onChange={(e) => e.target.value && set(hhmm(m[1]), e.target.value)} />
    </span>
  );
}

// ---------------------------------------------------------------- inputs tab

function inputValue(cfg: IndicatorConfig, inp: InputDef) {
  return cfg.inputs?.[inp.key] ?? inp.default;
}

function InputControl({ cfg, inp, set, inline }: { cfg: IndicatorConfig; inp: InputDef; set: (key: string, v: number | boolean | string) => void; inline: boolean }) {
  const v = inputValue(cfg, inp);
  const label = inp.label && <span className="idg-lbl" title={inp.tooltip}>{inp.label}</span>;
  if (inp.kind === 'bool') {
    return (
      <label className="idg-check" title={inp.tooltip}>
        <input type="checkbox" checked={v === true} onChange={(e) => set(inp.key, e.target.checked)} />
        {inp.label && <span>{inp.label}</span>}
      </label>
    );
  }
  let control: ReactNode;
  if (inp.kind === 'color') control = <ColorSwatch value={String(v)} onChange={(c) => set(inp.key, c)} />;
  else if (inp.kind === 'session') control = <SessionField value={String(v)} onChange={(s) => set(inp.key, s)} />;
  else if (inp.kind === 'source' || inp.options?.length) {
    const base = inp.kind === 'source' ? SOURCES : inp.options!;
    // a value missing from the list (a robot's signal variant) stays shown
    const options = base.includes(String(v)) ? base : [...base, String(v)];
    control = (
      <select className="idg-select" value={String(v)} onChange={(e) => set(inp.key, inp.kind === 'number' ? parseFloat(e.target.value) : e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (inp.kind === 'string') control = <input className="idg-text" value={String(v)} onChange={(e) => set(inp.key, e.target.value)} />;
  else control = <NumberField value={Number(v)} min={inp.min} max={inp.max} step={inp.step} width={inline ? 64 : 90} onChange={(n) => set(inp.key, n)} />;
  if (inline) return <span className="idg-inl">{label}{control}</span>;
  return <>{label ?? <span />}{control}</>;
}

// Source of the indicators that have one: a price field, or a plot of another indicator of the
// chart (not one computed on this one, which would loop)
function SourceRow({ cfg, def, update }: { cfg: IndicatorConfig; def: IndicatorDef; update: (p: Partial<IndicatorConfig>) => void }) {
  const all = useStore((s) => s.indicators);
  const banned = new Set([cfg.id, ...dependentsOf(all, cfg.id)]);
  const others = all.filter((o) => !banned.has(o.id) && o.type !== 'STRATEGY').flatMap((o) => {
    const d = getIndicatorDef(o);
    const plots = d ? sourcePlots(o, d) : [];
    return plots.map((p) => ({ v: sourceKey(o.id, p.key), label: `${indicatorTitle(o)}${plots.length > 1 ? ` : ${p.name}` : ''}` }));
  });
  const value = cfg.source ?? def.source!;
  const known = SOURCES.includes(value) || others.some((o) => o.v === value);
  return (
    <div className="idg-row">
      <span className="idg-lbl" title="Le prix, ou la courbe d’un autre indicateur du graphique (indicateur sur indicateur)">Source</span>
      <select className="idg-select" value={known ? value : def.source} onChange={(e) => update({ source: e.target.value === def.source ? undefined : e.target.value })}>
        {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        {others.length > 0 && (
          <optgroup label="Indicateurs du graphique">
            {others.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </optgroup>
        )}
      </select>
    </div>
  );
}

// sections by group=, rows of the inputs sharing an inline= id
function InputsTab({ cfg, def, update }: { cfg: IndicatorConfig; def: IndicatorDef; update: (p: Partial<IndicatorConfig>) => void }) {
  const set = (key: string, v: number | boolean | string) => update({ inputs: { ...cfg.inputs, [key]: v } });
  const sections: { group: string; rows: InputDef[][] }[] = [];
  for (const inp of def.inputs ?? []) {
    const group = inp.group ?? '';
    let sec = sections.find((s) => s.group === group);
    if (!sec) { sec = { group, rows: [] }; sections.push(sec); }
    const last = sec.rows[sec.rows.length - 1];
    if (inp.inline && last && last[0].inline === inp.inline) last.push(inp); else sec.rows.push([inp]);
  }
  const t = cfg.type;
  return (
    <div className="idg-body">
      {def.defaults.period > 0 && (
        <div className="idg-row">
          <span className="idg-lbl">{t === 'STOCH' ? '%K longueur' : t === 'MACD' ? 'Longueur rapide' : 'Longueur'}</span>
          <NumberField value={cfg.period} min={1} max={5000} step={1} onChange={(v) => update({ period: Math.round(v) })} />
        </div>
      )}
      {def.source && <SourceRow cfg={cfg} def={def} update={update} />}
      {t === 'STOCH' && (
        <div className="idg-row"><span className="idg-lbl">%D lissage</span><NumberField value={cfg.dPeriod ?? 3} min={1} max={500} step={1} onChange={(v) => update({ dPeriod: Math.round(v) })} /></div>
      )}
      {t === 'MACD' && (
        <>
          <div className="idg-row"><span className="idg-lbl">Longueur lente</span><NumberField value={cfg.slowPeriod ?? 26} min={2} max={500} step={1} onChange={(v) => update({ slowPeriod: Math.round(v) })} /></div>
          <div className="idg-row"><span className="idg-lbl">Lissage du signal</span><NumberField value={cfg.signalPeriod ?? 9} min={1} max={200} step={1} onChange={(v) => update({ signalPeriod: Math.round(v) })} /></div>
        </>
      )}
      {t === 'BOLLINGER' && (
        <div className="idg-row"><span className="idg-lbl">Écart-type</span><NumberField value={cfg.stdDev ?? 2} min={0.1} max={10} step={0.1} onChange={(v) => update({ stdDev: v })} /></div>
      )}
      {sections.map((sec) => (
        <div key={sec.group || '_'} className="idg-section">
          {sec.group && <div className="idg-group">{sec.group}</div>}
          {sec.rows.map((row) => (row.length > 1 || row[0].inline ? (
            <div key={row[0].key} className="idg-inline-row">
              {row.map((inp) => <InputControl key={inp.key} cfg={cfg} inp={inp} set={set} inline />)}
            </div>
          ) : (
            <div key={row[0].key} className={`idg-row ${row[0].kind === 'bool' ? 'bool' : ''}`}>
              <InputControl cfg={cfg} inp={row[0]} set={set} inline={false} />
            </div>
          )))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- style tab

type StyleRow = { key: string; name: string; kind: string; color?: string; setColor?: (c: string) => void; shown?: boolean; setShown?: (v: boolean) => void; width?: number; setWidth?: (w: number) => void };

function styleRows(cfg: IndicatorConfig, def: IndicatorDef, update: (p: Partial<IndicatorConfig>) => void): StyleRow[] {
  const bb = cfg.type === 'BOLLINGER';
  const BAND: Record<string, 'upper' | 'mid' | 'lower'> = { up: 'upper', mid: 'mid', low: 'lower' };
  const isPine = cfg.type === 'PINE';
  const plots = isPine
    ? (def.styles ?? []).map((s) => ({ key: s.key, name: s.name, kind: 'line', color: s.color, width: 1 as number | undefined }))
    : def.compute([], bb ? { ...cfg, bandVisible: { upper: true, mid: true, lower: true } } : cfg)
      .map((p) => ({ key: p.key, name: p.name, kind: p.kind, color: p.color, width: p.width }));
  const lineCount = plots.filter((p) => p.kind === 'line' || p.kind === 'histogram').length;
  const styled = new Set((def.styles ?? []).map((s) => s.key));
  const rows: StyleRow[] = plots.map((p) => {
    const row: StyleRow = { key: p.key, name: p.name, kind: p.kind };
    // visibility
    if (bb) {
      const vis = cfg.bandVisible ?? { upper: true, mid: true, lower: true };
      row.shown = vis[BAND[p.key]];
      row.setShown = (v) => update({ bandVisible: { ...vis, [BAND[p.key]]: v } });
    } else {
      row.shown = !cfg.plotHidden?.[p.key];
      row.setShown = (v) => update({ plotHidden: { ...cfg.plotHidden, [p.key]: !v } });
    }
    // color: the indicator's own settings when it has some, else an override
    if (p.kind !== 'boxes' && p.kind !== 'labels' && p.kind !== 'candles') {
      if (bb) {
        const cols = cfg.bandColors ?? { upper: '#2962ff', mid: cfg.color, lower: '#2962ff' };
        row.color = cols[BAND[p.key]];
        row.setColor = (c) => update({ bandColors: { ...cols, [BAND[p.key]]: c } });
      } else if (!styled.has(p.key) && lineCount === 1 && !isPine && cfg.type !== 'VOLUME' && def.styles === undefined) {
        row.color = cfg.color;
        row.setColor = (c) => update({ color: c });
      } else if (cfg.type !== 'VOLUME') {
        row.color = cfg.plotColors?.[p.key] ?? (styled.has(p.key) ? def.styles!.find((s) => s.key === p.key)!.color : p.color);
        row.setColor = (c) => update({ plotColors: { ...cfg.plotColors, [p.key]: c } });
      }
    }
    if (p.kind === 'line') {
      row.width = cfg.plotWidths?.[p.key] ?? p.width ?? 2;
      row.setWidth = (w) => update({ plotWidths: { ...cfg.plotWidths, [p.key]: w } });
    }
    return row;
  });
  // styles that are not a plot (colors of the HA candles...)
  for (const s of def.styles ?? []) {
    if (plots.some((p) => p.key === s.key)) continue;
    rows.push({ key: s.key, name: s.name, kind: 'color', color: cfg.plotColors?.[s.key] ?? s.color, setColor: (c) => update({ plotColors: { ...cfg.plotColors, [s.key]: c } }) });
  }
  if (cfg.type === 'VOLUME') {
    rows.push({ key: 'vu', name: 'Hausse', kind: 'color', color: cfg.volUpColor ?? '#26a69a', setColor: (c) => update({ volUpColor: c.slice(0, 7) }) });
    rows.push({ key: 'vd', name: 'Baisse', kind: 'color', color: cfg.volDownColor ?? '#ef5350', setColor: (c) => update({ volDownColor: c.slice(0, 7) }) });
  }
  return rows;
}

function LevelsEditor({ cfg, defaults, update }: { cfg: IndicatorConfig; defaults: number[]; update: (p: Partial<IndicatorConfig>) => void }) {
  const [value, setValue] = useState('');
  const levels = cfg.levels ?? defaults;
  function add() {
    const v = parseFloat(value.replace(',', '.'));
    if (isNaN(v) || levels.includes(v)) return;
    update({ levels: [...levels, v].sort((a, b) => b - a) });
    setValue('');
  }
  return (
    <div className="idg-section">
      <div className="idg-group">Niveaux</div>
      <div className="idg-inline-row">
        <span className="idg-lbl">Couleur des niveaux</span>
        <ColorSwatch value={cfg.levelColor ?? '#787b86'} onChange={(c) => update({ levelColor: c })} />
      </div>
      <div className="lv-chips">
        {levels.map((lv) => (
          <button key={lv} className="fib-level-chip active" title="Retirer ce niveau" onClick={() => update({ levels: levels.filter((x) => x !== lv) })}>{lv} ✕</button>
        ))}
        {levels.length === 0 && <span className="lv-empty">aucun</span>}
      </div>
      <div className="idg-inline-row">
        <input className="idg-text" style={{ width: 90 }} type="number" placeholder="ex : 80" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="pill-btn" onClick={add}>Ajouter</button>
        {cfg.levels != null && <button className="si-more" onClick={() => update({ levels: undefined, levelColor: undefined })}>Niveaux par défaut</button>}
      </div>
    </div>
  );
}

function StyleTab({ cfg, def, update }: { cfg: IndicatorConfig; def: IndicatorDef; update: (p: Partial<IndicatorConfig>) => void }) {
  const rows = styleRows(cfg, def, update);
  return (
    <div className="idg-body">
      {rows.map((r) => (
        <div key={r.key} className="idg-style-row">
          {r.setShown
            ? <label className="idg-check"><input type="checkbox" checked={r.shown} onChange={(e) => r.setShown!(e.target.checked)} /><span>{r.name}</span></label>
            : <span className="idg-lbl">{r.name}</span>}
          <span className="idg-style-ctl">
            {r.setColor && <ColorSwatch value={r.color ?? '#2962ff'} onChange={r.setColor} />}
            {r.setWidth && (
              <select className="idg-select idg-width" title="Épaisseur" value={r.width} onChange={(e) => r.setWidth!(parseInt(e.target.value))}>
                {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w} px</option>)}
              </select>
            )}
          </span>
        </div>
      ))}
      {!rows.length && <div className="idg-empty">Les couleurs de cet indicateur se règlent dans « Paramètres en entrée ».</div>}
      {!def.overlay && <LevelsEditor cfg={cfg} defaults={def.levels ?? []} update={update} />}
    </div>
  );
}

// ---------------------------------------------------------------- visibility tab

const UNITS: { unit: VisibilityUnit; label: string; max: number }[] = [
  { unit: 'T', label: 'Ticks', max: 1000 },
  { unit: 's', label: 'Secondes', max: 59 },
  { unit: 'm', label: 'Minutes', max: 59 },
  { unit: 'h', label: 'Heures', max: 24 },
  { unit: 'D', label: 'Jours', max: 366 },
  { unit: 'W', label: 'Semaines', max: 52 },
  { unit: 'M', label: 'Mois', max: 12 },
];

function VisibilityTab({ cfg, update }: { cfg: IndicatorConfig; update: (p: Partial<IndicatorConfig>) => void }) {
  const cur = (u: (typeof UNITS)[number]) => cfg.tfVisibility?.[u.unit] ?? { on: true, min: 1, max: u.max };
  const set = (unit: VisibilityUnit, patch: Partial<{ on: boolean; min: number; max: number }>) => {
    const u = UNITS.find((x) => x.unit === unit)!;
    const next: TfVisibility = { ...cfg.tfVisibility, [unit]: { ...cur(u), ...patch } };
    update({ tfVisibility: next });
  };
  return (
    <div className="idg-body">
      {UNITS.map((u) => {
        const v = cur(u);
        return (
          <div key={u.unit} className="idg-vis-row">
            <label className="idg-check"><input type="checkbox" checked={v.on} onChange={(e) => set(u.unit, { on: e.target.checked })} /><span>{u.label}</span></label>
            <span className={`idg-vis-range ${v.on ? '' : 'off'}`}>
              <NumberField value={v.min} min={1} max={u.max} step={1} width={60} onChange={(n) => set(u.unit, { min: Math.round(n) })} />
              <span>–</span>
              <NumberField value={v.max} min={1} max={u.max} step={1} width={60} onChange={(n) => set(u.unit, { max: Math.round(n) })} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- dialog

const SAVED_FIELDS = [
  'period', 'color', 'stdDev', 'bandColors', 'bandVisible', 'dPeriod', 'slowPeriod', 'signalPeriod', 'volUpColor', 'volDownColor',
  'inputs', 'plotColors', 'plotWidths', 'plotHidden', 'levels', 'levelColor', 'tfVisibility',
] as const;

export default function IndicatorDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const cfg = useStore((s) => s.indicators.find((i) => i.id === id));
  const updateIndicator = useStore((s) => s.updateIndicator);
  const replaceIndicator = useStore((s) => s.replaceIndicator);
  const savedDefault = useStore((s) => (cfg ? s.indicatorDefaults[indicatorKey(cfg)] : undefined));
  const setIndicatorDefault = useStore((s) => s.setIndicatorDefault);
  const snapshot = useRef(cfg ? structuredClone(cfg) : null);
  const def = cfg ? getIndicatorDef(cfg) : undefined;
  const hasInputs = !!def && (def.defaults.period > 0 || !!def.inputs?.length || ['STOCH', 'MACD', 'BOLLINGER'].includes(cfg!.type));
  const [tab, setTab] = useState<Tab>(hasInputs ? 'inputs' : 'style');
  const [menu, setMenu] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const cancel = () => { if (snapshot.current) replaceIndicator(snapshot.current); onClose(); };
  // Échap = Annuler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (snapshot.current) useStore.getState().replaceIndicator(snapshot.current);
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!cfg || !def) return null;
  const update = (p: Partial<IndicatorConfig>) => updateIndicator(cfg.id, p);

  function dragFrom(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    const onMove = (ev: MouseEvent) => setPos({ x: Math.max(0, ev.clientX - dx), y: Math.max(0, ev.clientY - dy) });
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const resetAll = () => {
    const base: IndicatorConfig = {
      id: cfg.id, type: cfg.type, scriptId: cfg.scriptId, strategyId: cfg.strategyId, overlay: cfg.overlay, visible: cfg.visible,
      collapsed: cfg.collapsed, paneStretch: cfg.paneStretch, ...structuredClone(def.defaults),
    };
    replaceIndicator({ ...base, ...(savedDefault ? structuredClone(savedDefault) : {}) });
  };
  const host = document.querySelector('.app') ?? document.body;

  return createPortal(
    <div className="idg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="idg" style={pos ? { position: 'fixed', left: pos.x, top: pos.y, margin: 0 } : undefined}>
        <div className="idg-head" onMouseDown={dragFrom}>
          <span>{def.short}</span>
          <button className="idg-x" title="Fermer" onClick={onClose}>✕</button>
        </div>
        <div className="idg-tabs">
          {hasInputs && <button className={tab === 'inputs' ? 'active' : ''} onClick={() => setTab('inputs')}>Paramètres en entrée</button>}
          <button className={tab === 'style' ? 'active' : ''} onClick={() => setTab('style')}>Style</button>
          <button className={tab === 'visibility' ? 'active' : ''} onClick={() => setTab('visibility')}>Visibilité</button>
        </div>
        {tab === 'inputs' && <InputsTab cfg={cfg} def={def} update={update} />}
        {tab === 'style' && <StyleTab cfg={cfg} def={def} update={update} />}
        {tab === 'visibility' && <VisibilityTab cfg={cfg} update={update} />}
        <div className="idg-foot">
          <div className="idg-defaults">
            <button className="idg-btn" onClick={() => setMenu(!menu)}>Configurer ▾</button>
            {menu && (
              <div className="idg-menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { resetAll(); setMenu(false); }}>Réinitialiser les paramètres</button>
                <button
                  onClick={() => {
                    const picked: Partial<IndicatorConfig> = {};
                    for (const k of SAVED_FIELDS) if (cfg[k] !== undefined) (picked as Record<string, unknown>)[k] = structuredClone(cfg[k]);
                    setIndicatorDefault(indicatorKey(cfg), picked);
                    setMenu(false);
                  }}
                >
                  Enregistrer comme défaut
                </button>
                {savedDefault && <button onClick={() => { setIndicatorDefault(indicatorKey(cfg), null); setMenu(false); }}>Oublier le défaut enregistré</button>}
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
