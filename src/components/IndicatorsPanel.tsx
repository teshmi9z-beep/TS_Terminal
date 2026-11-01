import { useState } from 'react';
import { useStore } from '../store/store';
import { getIndicatorDef, indicatorTitle } from '../indicators/registry';
import { sourceRef } from '../indicators/derived';
import { tfShortLabel } from '../data/timeframes';
import type { IndicatorConfig } from '../types';
import IndicatorDialog from './IndicatorDialog';
import ListBackupsDialog from './ListBackupsDialog';

// The left column of the "Indicateurs" window, as in ProRealTime's: the chart's template ("Modèles
// de graphiques": a saved set of indicators, "*" once the chart's differ from it) with save and new,
// then the chart's indicators, each shown or hidden by its box, its settings a click on its name.
// The library on the right of the window adds to this list.

const ic = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// a set of indicators as text, ids and pane heights left out (a template put on a chart gets ids
// of its own; dragging a pane separator isn't a change of indicators)
function signature(list: IndicatorConfig[]): string {
  const index = new Map(list.map((i, n) => [i.id, n]));
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, stable(o[k])]));
  };
  return JSON.stringify(list.map((i) => {
    const ref = sourceRef(i);
    return stable({ ...i, id: undefined, paneStretch: undefined, collapsed: undefined, source: ref ? `ind:${index.get(ref.id)}:${ref.plot}` : i.source });
  }));
}

export default function IndicatorsPanel() {
  const indicators = useStore((s) => s.indicators);
  const templates = useStore((s) => s.indicatorTemplates);
  const currentName = useStore((s) => s.indicatorTemplate);
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const updateIndicator = useStore((s) => s.updateIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [tools, setTools] = useState(false);
  const [backups, setBackups] = useState(false);

  const current = templates.find((t) => t.name === currentName) ?? null;
  const dirty = current ? signature(current.indicators) !== signature(indicators) : indicators.length > 0;
  const store = () => useStore.getState();

  function saveAs() {
    const name = window.prompt('Nom du modèle :', current?.name ?? '')?.trim();
    if (!name) return;
    if (name !== current?.name && templates.some((t) => t.name === name) && !window.confirm(`Remplacer le modèle « ${name} » par les indicateurs du graphique ?`)) return;
    store().saveIndicatorTemplate(name);
  }
  // the floppy: into the template shown, a name asked for when there is none
  const save = () => (current ? store().saveIndicatorTemplate(current.name) : saveAs());

  function pick(name: string) {
    if (!name) { store().setIndicatorTemplate(null); return; }
    if (dirty && indicators.length && !window.confirm(`Les indicateurs du graphique ne sont pas enregistrés. Les remplacer par le modèle « ${name} » ?`)) return;
    store().applyIndicatorTemplate(name);
  }

  function rename() {
    setTools(false);
    if (!current) return;
    const to = window.prompt('Nouveau nom du modèle :', current.name)?.trim();
    if (!to || to === current.name) return;
    if (templates.some((t) => t.name === to) && !window.confirm(`Remplacer le modèle « ${to} » ?`)) return;
    store().renameIndicatorTemplate(current.name, to);
  }

  function remove() {
    setTools(false);
    if (current && window.confirm(`Supprimer le modèle « ${current.name} » ?`)) store().deleteIndicatorTemplate(current.name);
  }

  return (
    <div className="ip-panel">
      <div className="ip-title">
        Modèles de graphiques
        <span className="ip-tools">
          <button className="ip-icon" title="Gérer le modèle" onClick={() => setTools(!tools)}>
            <svg {...ic}><path d="M10.5 2.5a3 3 0 00-3.3 4l-4.4 4.4a1.2 1.2 0 001.7 1.7l4.4-4.4a3 3 0 004-3.3L11 6.8 9.2 5l1.9-1.9z" /></svg>
          </button>
          {tools && (
            <>
              <div className="tb-dropdown-backdrop" onClick={() => setTools(false)} />
              <div className="ip-menu">
                <button className="tb-menu-item" disabled={!current} onClick={rename}>Renommer le modèle…</button>
                <button className="tb-menu-item" disabled={!current} onClick={remove}>Supprimer le modèle</button>
                <button className="tb-menu-item" onClick={() => { setTools(false); setBackups(true); }}>Retrouver des modèles (sauvegardes)…</button>
              </div>
            </>
          )}
        </span>
      </div>
      <div className="ip-tpl">
        <select value={current?.name ?? ''} onChange={(e) => pick(e.target.value)} title="Modèle d’indicateurs du graphique">
          <option value="">Sans nom{!current && dirty ? '*' : ''}</option>
          {templates.map((t) => <option key={t.name} value={t.name}>{t.name}{t.name === current?.name && dirty ? '*' : ''}</option>)}
        </select>
        <button className="ip-icon" title={current ? `Enregistrer dans « ${current.name} »` : 'Enregistrer le modèle'} disabled={!indicators.length} onClick={save}>
          <svg {...ic}><path d="M2.5 2.5h9l2 2v9h-11z" /><path d="M5 2.5v3.5h5.5V2.5M5 13.5V9.5h6v4" /></svg>
        </button>
        <button className="ip-icon ip-new" title="Enregistrer comme nouveau modèle" disabled={!indicators.length} onClick={saveAs}>
          <svg {...ic} strokeWidth={1.8}><circle cx="8" cy="8" r="6.2" fill="currentColor" stroke="none" /><path d="M8 5v6M5 8h6" stroke="#fff" /></svg>
        </button>
      </div>

      <div className="ip-head">Indicateurs</div>
      <div className="ip-tree">
        <div className="ip-root">{symbol.ticker} · {tfShortLabel(timeframe)}</div>
        {indicators.map((i) => (
          <div key={i.id} className={`ip-row ${i.visible === false ? 'off' : ''}`}>
            <input type="checkbox" checked={i.visible !== false} title={i.visible === false ? 'Afficher' : 'Masquer'} onChange={(e) => updateIndicator(i.id, { visible: e.target.checked })} />
            <span className="ip-color" style={{ background: i.color ?? getIndicatorDef(i)?.defaults.color ?? 'var(--text-muted)' }} />
            <button className="ip-name" title="Paramètres" onClick={() => setSettingsId(i.id)}>{indicatorTitle(i)}</button>
            <button className="remove-btn" title="Retirer du graphique" onClick={() => removeIndicator(i.id)}>✕</button>
          </div>
        ))}
        {indicators.length === 0 && <div className="ip-empty">Aucun indicateur sur ce graphique : ajoutez-en depuis la liste de droite, ou choisissez un modèle.</div>}
      </div>
      {settingsId && <IndicatorDialog id={settingsId} onClose={() => setSettingsId(null)} />}
      {backups && <ListBackupsDialog onClose={() => setBackups(false)} />}
    </div>
  );
}
