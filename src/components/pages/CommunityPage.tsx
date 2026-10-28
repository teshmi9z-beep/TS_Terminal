import { useEffect, useState } from 'react';
import { peekKept, useKept } from '../kept';
import { fetchSource, scriptImage, scriptPage, searchScripts, versionOf, type CommunityScript } from '../../data/community';
import { compilePine } from '../../pine/compile';
import { inspectPineStrategy } from '../../strategy/pineStrategy';
import { newCode } from '../../strategy/doc';
import { getIndicatorDef } from '../../indicators/registry';
import { useStore, nextId } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { fr } from '../../data/format';
import { goToChart } from '../tabs/tabActions';
import { Chips, Loading, PageHeader } from './common';
import { LOCALE } from '../../i18n/lang';

const POPULAR = ['Supertrend', 'RSI', 'MACD', 'Order blocks', 'Fair value gap', 'VWAP', 'Volume profile', 'Smart money', 'Ichimoku', 'Bollinger', 'Divergence', 'Session'];
type Kind = 'all' | 'study' | 'strategy';
type View = 'explore' | 'mine';

const ACCESS = { 1: 'Open source', 2: 'Protégé', 3: 'Sur invitation' } as const;

// adds a published script to the platform: an indicator on the chart, or a strategy in the tester
function useInstall() {
  const openPineEditor = useChartUi((s) => s.openPineEditor);
  return (s: CommunityScript, source: string, edit = false) => {
    const st = useStore.getState();
    if (s.kind === 'strategy') {
      const doc = { ...newCode(s.name), code: source };
      st.upsertStrategy(doc);
      goToChart();
      useStore.getState().setStrategyOnChart(doc.id);
      useStore.getState().setBottomDock({ tab: edit ? 'editor' : 'tester' });
      return;
    }
    const existing = st.pineScripts.find((p) => p.source === source);
    const script = existing ?? { id: nextId(), name: s.name, source, updatedAt: Date.now() };
    if (!existing) st.upsertPineScript(script);
    goToChart();
    const def = getIndicatorDef({ type: 'PINE', scriptId: script.id });
    if (edit || !def) { openPineEditor(script.id); if (edit) return; }
    if (def) useStore.getState().addIndicator({ id: nextId(), type: 'PINE', scriptId: script.id, overlay: def.overlay, period: 0, color: def.defaults.color });
  };
}

function Detail({ s, onClose }: { s: CommunityScript; onClose: () => void }) {
  const install = useInstall();
  const [source, setSource] = useState<string | null | undefined>(s.source ?? (s.access === 1 ? undefined : null));
  useEffect(() => {
    if (source !== undefined) return;
    const ctrl = new AbortController();
    fetchSource(s.id, ctrl.signal).then(setSource, () => { if (!ctrl.signal.aborted) setSource(null); });
    return () => ctrl.abort();
  }, [s.id, source]);
  const check = source
    ? s.kind === 'strategy'
      ? (() => { const r = inspectPineStrategy(source); return { error: r.error, warnings: r.warnings }; })()
      : (() => { const r = compilePine({ id: `community-${s.id}`, name: s.name, source }); return { error: r.error, warnings: r.warnings }; })()
    : null;
  const version = versionOf(source ?? null) ?? s.version;
  return (
    <div className="cm-detail-back" onMouseDown={onClose}>
      <div className="cm-detail" onMouseDown={(e) => e.stopPropagation()}>
        <button className="cm-close" onClick={onClose}>✕</button>
        {s.image && <img className="cm-detail-img" src={scriptImage(s.image)} alt="" />}
        <div className="cm-detail-body">
          <div className="cm-badges">
            <span className={`cm-badge ${s.kind}`}>{s.kind === 'strategy' ? 'Stratégie' : s.kind === 'library' ? 'Bibliothèque' : 'Indicateur'}</span>
            <span className={`cm-badge access${s.access}`}>{ACCESS[s.access]}</span>
            {version && <span className="cm-badge">Pine v{version}</span>}
            {s.recommended && <span className="cm-badge pick">Choix des éditeurs</span>}
          </div>
          <h2>{s.name}</h2>
          <div className="cm-meta">par <b>{s.author}</b> · ♥ {fr(s.likes, 0)}</div>
          {source === undefined && <Loading text="Chargement du code source…" />}
          {source === null && (
            <div className="pg-note">Code source non public ({ACCESS[s.access].toLowerCase()}) : le script ne peut être utilisé que sur TradingView.</div>
          )}
          {source && check && (
            <div className={`cm-check ${check.error ? 'err' : 'ok'}`}>
              {check.error ? `Non compatible avec l’interpréteur de la plateforme : ${check.error}` : 'Compatible avec l’interpréteur Pine de la plateforme.'}
              {!check.error && check.warnings.length > 0 && <ul>{check.warnings.slice(0, 4).map((w) => <li key={w}>{w}</li>)}</ul>}
            </div>
          )}
          <div className="cm-actions">
            {source && s.kind !== 'library' && (
              <>
                <button className="pill-btn primary" onClick={() => install(s, source)}>{s.kind === 'strategy' ? 'Ajouter au testeur de stratégie' : 'Ajouter au graphique'}</button>
                <button className="pill-btn" onClick={() => install(s, source, true)}>Ouvrir dans l’éditeur</button>
              </>
            )}
            <a className="pill-btn" href={scriptPage(s)} target="_blank" rel="noreferrer">Voir sur TradingView ↗</a>
          </div>
          {source && <pre className="cm-source">{source}</pre>}
        </div>
      </div>
    </div>
  );
}

function Mine() {
  const pineScripts = useStore((s) => s.pineScripts);
  const strategies = useStore((s) => s.strategies);
  const openPineEditor = useChartUi((s) => s.openPineEditor);
  const addIndicator = useStore((s) => s.addIndicator);
  const code = strategies.filter((s) => s.mode === 'code');
  return (
    <div className="pg-scroll">
      <table className="pg-table">
        <thead><tr><th className="left">Nom</th><th className="left">Type</th><th>Modifié</th><th /></tr></thead>
        <tbody>
          {pineScripts.map((p) => {
            const def = getIndicatorDef({ type: 'PINE', scriptId: p.id });
            return (
              <tr key={p.id}>
                <td className="left"><b>{p.name}</b></td>
                <td className="left">Indicateur Pine{def ? '' : ' (erreur)'}</td>
                <td>{new Date(p.updatedAt).toLocaleDateString(LOCALE)}</td>
                <td className="cm-row-actions">
                  {def && <button className="pill-btn" onClick={() => { goToChart(); addIndicator({ id: nextId(), type: 'PINE', scriptId: p.id, overlay: def.overlay, period: 0, color: def.defaults.color }); }}>Ajouter au graphique</button>}
                  <button className="pill-btn" onClick={() => { goToChart(); openPineEditor(p.id); }}>Modifier</button>
                </td>
              </tr>
            );
          })}
          {code.map((d) => (
            <tr key={d.id}>
              <td className="left"><b>{d.name}</b></td>
              <td className="left">Stratégie Pine</td>
              <td>{new Date(d.updatedAt).toLocaleDateString(LOCALE)}</td>
              <td className="cm-row-actions">
                <button className="pill-btn" onClick={() => { goToChart(); useStore.getState().setStrategyOnChart(d.id); useStore.getState().setBottomDock({ tab: 'tester' }); }}>Tester</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!pineScripts.length && !code.length && <div className="pg-empty">Aucun script. Ajoutez-en depuis l’onglet Explorer ou l’éditeur Pine.</div>}
    </div>
  );
}

// TradingView's community scripts: search published indicators/strategies and use the open source ones
export default function CommunityPage() {
  const [view, setView] = useKept<View>('community.view', 'explore');
  const [text, setText] = useKept('community.text', 'Supertrend');
  const [query, setQuery] = useKept('community.query', 'Supertrend');
  const [kind, setKind] = useKept<Kind>('community.kind', 'all');
  const [openOnly, setOpenOnly] = useKept('community.openOnly', true);
  const [pages, setPages] = useKept<{ query: string; items: CommunityScript[]; more: boolean } | null>('community.pages', null, true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useKept<CommunityScript | null>('community.selected', null, true);

  useEffect(() => {
    // back on the tab: the results (with the pages loaded below) are still there
    if (peekKept<{ query: string }>('community.pages')?.query === query) return;
    const ctrl = new AbortController();
    searchScripts(query, 0, ctrl.signal).then((r) => { setPages({ query, ...r }); setError(null); }, (e: unknown) => {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => ctrl.abort();
  }, [query, setPages]);

  const more = async () => {
    if (!pages) return;
    setLoadingMore(true);
    const r = await searchScripts(query, pages.items.length).catch(() => null);
    setLoadingMore(false);
    if (r) setPages({ query, items: [...pages.items, ...r.items], more: r.more });
  };

  const current = pages?.query === query ? pages : null;
  const items = (current?.items ?? []).filter((s) => (kind === 'all' || s.kind === kind) && (!openOnly || s.access === 1));

  return (
    <div className="pg">
      <PageHeader title="Scripts de la communauté">
        <div className="nw-search">
          <input placeholder="Rechercher des scripts (ex : RSI, Supertrend)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { setQuery(text.trim()); setView('explore'); } }} />
          <button className="pill-btn" onClick={() => { if (text.trim()) { setQuery(text.trim()); setView('explore'); } }}>Rechercher</button>
        </div>
      </PageHeader>
      <div className="pg-toolbar">
        <Chips<View> value={view} onChange={setView} options={[['explore', 'Explorer'], ['mine', 'Mes scripts']]} />
        {view === 'explore' && (
          <>
            <Chips<Kind> value={kind} onChange={setKind} options={[['all', 'Tous'], ['study', 'Indicateurs'], ['strategy', 'Stratégies']]} />
            <label className="cm-toggle"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open source uniquement</label>
          </>
        )}
      </div>
      {view === 'mine' ? <Mine /> : (
        <>
          <div className="cm-popular">
            {POPULAR.map((p) => <button key={p} className={`pg-chip ${p === query ? 'active' : ''}`} onClick={() => { setText(p); setQuery(p); }}>{p}</button>)}
          </div>
          {error && <div className="pg-error">{error}</div>}
          <div className="pg-scroll">
            {!current && !error && <Loading />}
            <div className="cm-grid">
              {items.map((s) => (
                <button key={s.id} className="cm-card" onClick={() => setSelected(s)}>
                  <div className="cm-img">
                    {s.image ? <img src={scriptImage(s.image)} alt="" loading="lazy" /> : <span>{'{}'}</span>}
                    <span className={`cm-kind ${s.kind}`}>{s.kind === 'strategy' ? 'Stratégie' : s.kind === 'library' ? 'Bibliothèque' : 'Indicateur'}</span>
                    {s.access !== 1 && <span className="cm-lock" title={ACCESS[s.access]}>🔒</span>}
                  </div>
                  <div className="cm-title">{s.name}</div>
                  <div className="cm-foot"><span>{s.author}</span><span>♥ {fr(s.likes, 0)}</span></div>
                </button>
              ))}
            </div>
            {current && !items.length && <div className="pg-empty">Aucun script{openOnly ? ' open source' : ''} trouvé.</div>}
            {current?.more && <div className="cm-more"><button className="pill-btn" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? 'Chargement…' : 'Plus de résultats'}</button></div>}
          </div>
        </>
      )}
      {selected && <Detail key={selected.id} s={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
