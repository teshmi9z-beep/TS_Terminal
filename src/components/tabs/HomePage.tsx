import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore, ALL_TOOLS, nextId, type ToolId, type Workspace } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { exportWorkspace } from '../workspaces';
import ToolIcon from './ToolIcon';
import { createLayout, openLayout, openTool } from './tabActions';
import { LANG } from '../../i18n/lang';

// TradingView desktop's "Nouvel onglet" page: the chart layouts ("Superchart")
// and every tool, each opening in this tab

const TILE_LABELS: Record<ToolId, ReactNode> = {
  screener: <>Screeners <i>·</i> Stocks</>,
  heatmap: <>Cartes thermiques <i>·</i> Stocks</>,
  calendar: 'Calendriers',
  news: 'Flux d’actualités',
  portfolios: 'Portefeuilles',
  yields: 'Courbes de rendement',
  options: 'Options',
  fundamentals: 'Graphiques fondamentaux',
  markets: 'Marchés',
  community: <>Communauté <i>·</i> Indicateurs</>,
  macro: 'Macro Maps',
  robots: 'Robots de trading',
  data: <>Développeur <i>·</i> Data</>,
};

const MONTHS = LANG === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] : ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
const shortDate = (t: number) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`; };

// the decoration behind each tile's icon, in the spirit of TradingView's
function TileArt({ tool }: { tool: ToolId }) {
  switch (tool) {
    case 'screener': return <div className="ha ha-logos"><span>A</span><span>T</span><span className="big" /><span>∞</span><span>M</span></div>;
    case 'heatmap': return <div className="ha ha-grid">{Array.from({ length: 12 }, (_, i) => <span key={i} className={['r', 'g', 'n'][i % 3]} />)}<em>MA</em><em className="b">APPL</em></div>;
    case 'calendar': return <div className="ha ha-cal"><span>9</span><span>10</span><span>11</span><span className="c" /><span>12</span><span>13</span><span>14</span><span>15</span></div>;
    case 'news': return <div className="ha ha-news">{[0, 1, 2].map((i) => <div key={i}><b>⚡</b><span /></div>)}</div>;
    case 'portfolios': return <div className="ha ha-pf"><span className="p1">17%</span><span className="p2">24%</span><span className="p3">10%</span><span className="p4">19%</span></div>;
    case 'yields':
      return <svg className="ha" viewBox="0 0 280 170" preserveAspectRatio="none"><polyline points="0,120 20,100 40,130 60,70 80,90 100,40 120,110 140,60 160,140 180,50 200,95 220,30 240,80 260,45 280,60" fill="none" stroke="currentColor" strokeWidth="1" /><polyline points="0,150 30,125 60,140 90,95 120,130 150,80 180,120 210,70 240,100 280,85" fill="none" stroke="currentColor" strokeWidth="1" opacity=".6" /></svg>;
    case 'options':
      return <svg className="ha" viewBox="0 0 280 170" preserveAspectRatio="none"><path d="M10 120 Q70 -10 110 70 T200 120" fill="none" stroke="currentColor" strokeDasharray="3 5" /><path d="M0 170 L280 60" stroke="currentColor" opacity=".5" /><path d="M220 0 Q250 60 280 20" fill="none" stroke="currentColor" strokeDasharray="3 5" /></svg>;
    case 'fundamentals':
      return <svg className="ha" viewBox="0 0 280 170" preserveAspectRatio="none"><polyline points="10,60 60,80 110,40 160,70 210,30 270,50" fill="none" stroke="currentColor" /><polyline points="10,140 70,150 130,160 190,150 250,130" fill="none" stroke="currentColor" /><text x="30" y="30" fill="currentColor" fontSize="14">%</text><text x="240" y="150" fill="currentColor" fontSize="14">$</text></svg>;
    case 'markets': return <div className="ha ha-globe" />;
    case 'community': return <pre className="ha ha-code">{'strategy("My strategy", ove\n crossover(close, 1\nstrategy.entry("Long Entry\nrt Entry", strategy.sho\n close, 14), ta.sma(close'}</pre>;
    case 'macro': return <div className="ha ha-map" />;
    case 'robots':
      return <svg className="ha" viewBox="0 0 280 170" preserveAspectRatio="none"><polyline points="0,150 30,140 60,145 90,120 120,125 150,95 180,100 210,70 240,60 280,35" fill="none" stroke="currentColor" strokeWidth="1.5" /><polyline points="0,160 40,155 80,158 120,150 160,152 200,140 240,142 280,130" fill="none" stroke="currentColor" opacity=".5" /><text x="20" y="40" fill="currentColor" fontSize="13">55 % · 1,9</text></svg>;
    case 'data': return <div className="ha ha-grid">{Array.from({ length: 12 }, (_, i) => <span key={i} className={['g', 'g', 'n', 'r'][(i * 7) % 4]} />)}<em>1h</em><em className="b">5 ans</em></div>;
  }
}

function copyLayout(ws: Workspace) {
  useStore.getState().upsertWorkspace({ ...structuredClone(ws), id: nextId(), name: `${ws.name} (copie)`, shortcut: undefined, savedAt: Date.now() });
}

function LayoutCard({ ws, fav }: { ws: Workspace; fav: boolean }) {
  const toggleFav = useStore((s) => s.toggleFavoriteLayout);
  const upsert = useStore((s) => s.upsertWorkspace);
  const remove = useStore((s) => s.removeWorkspace);
  const openTab = useStore((s) => s.tabs.some((t) => t.kind === 'chart' && t.layoutId === ws.id));
  const [menu, setMenu] = useState(false);
  const main = ws.main;
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);
  const act = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); setMenu(false); f(); };
  return (
    <div className="home-layout" onClick={() => openLayout(ws)} title={openTab ? 'Déjà ouverte dans un onglet' : 'Ouvrir la mise en page'}>
      <button className={`home-star ${fav ? 'on' : ''}`} title={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'} onClick={(e) => { e.stopPropagation(); toggleFav(ws.id); }}>{fav ? '★' : '☆'}</button>
      <div className="home-layout-name">{ws.name}{openTab && <span className="home-open-dot" />}</div>
      <div className="home-layout-meta">{main.symbol?.ticker ?? '—'}, {main.timeframe ?? '—'} • {ws.savedAt ? shortDate(ws.savedAt) : '—'}</div>
      <button className="home-dots" title="Plus d’options" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }} onMouseDown={(e) => e.stopPropagation()}>⋮</button>
      {menu && (
        <div className="home-menu" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={act(() => openLayout(ws))}>Ouvrir</button>
          <button onClick={act(() => openLayout(ws, true))}>Ouvrir dans un nouvel onglet</button>
          <button onClick={act(() => { const n = window.prompt('Nom de la mise en page :', ws.name); if (n) upsert({ ...ws, name: n }); })}>Renommer</button>
          <button onClick={act(() => copyLayout(ws))}>Faire une copie</button>
          <button onClick={act(() => exportWorkspace(ws))}>Exporter</button>
          <button className="danger" onClick={act(() => { if (window.confirm(`Supprimer la mise en page « ${ws.name} » ?`)) remove(ws.id); })}>Supprimer</button>
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  const workspaces = useStore((s) => s.workspaces);
  const favorites = useStore((s) => s.favoriteLayouts);
  const sort = useStore((s) => s.layoutSort);
  const setSort = useStore((s) => s.setLayoutSort);
  const homeTools = useStore((s) => s.homeTools);
  const setHomeTools = useStore((s) => s.setHomeTools);
  const hintSeen = useStore((s) => s.homeHintSeen);
  const setHintSeen = useStore((s) => s.setHomeHintSeen);
  const uiTheme = useStore((s) => s.uiTheme);
  const setUiTheme = useStore((s) => s.setUiTheme);
  const [q, setQ] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [menu, setMenu] = useState(false);

  const layouts = useMemo(() => {
    const text = q.trim().toLowerCase();
    const list = workspaces.filter((w) => !text || w.name.toLowerCase().includes(text) || w.main.symbol?.ticker.toLowerCase().includes(text));
    const sorted = sort === 'name' ? [...list].sort((a, b) => a.name.localeCompare(b.name, LANG))
      : sort === 'created' ? [...list] : [...list].sort((a, b) => b.savedAt - a.savedAt);
    return [...sorted.filter((w) => favorites.includes(w.id)), ...sorted.filter((w) => !favorites.includes(w.id))];
  }, [workspaces, favorites, sort, q]);

  const tools = ALL_TOOLS.filter((t) => homeTools.includes(t));

  return (
    <div className="home" onMouseDown={() => { setSortOpen(false); setCustom(false); setMenu(false); }}>
      <div className="home-top">
        <div className="home-head">
          <h1>Superchart</h1>
          <div className="home-search">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2L16 16" /></svg>
            <input placeholder="Rechercher" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="home-sort" onMouseDown={(e) => e.stopPropagation()}>
            <button className="home-round" title="Trier" onClick={() => setSortOpen(!sortOpen)}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 16V4M3 7l3-3 3 3M11 6h6M11 10h4.5M11 14h3" /></svg>
            </button>
            {sortOpen && (
              <div className="home-menu right">
                {([['recent', 'Modifiées récemment'], ['name', 'Nom (A → Z)'], ['created', 'Ordre de création']] as const).map(([id, label]) => (
                  <button key={id} className={sort === id ? 'active' : ''} onClick={() => { setSort(id); setSortOpen(false); }}>{label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="home-layouts">
          <button className="home-new" onClick={createLayout}><span>＋</span> Créer une nouvelle mise en page</button>
          {layouts.map((ws) => <LayoutCard key={ws.id} ws={ws} fav={favorites.includes(ws.id)} />)}
          {!layouts.length && q && <div className="home-empty">Aucune mise en page ne correspond à « {q} ».</div>}
        </div>
      </div>

      <div className="home-band" />

      <div className="home-tools">
        {tools.map((t) => (
          <button key={t} className="home-tile" onClick={() => openTool(t)} onAuxClick={(e) => { if (e.button === 1) openTool(t, true); }}>
            <div className="home-tile-art"><TileArt tool={t} /><span className="home-tile-icon"><ToolIcon tool={t} size={40} /></span></div>
            <div className="home-tile-label">{TILE_LABELS[t]}</div>
          </button>
        ))}
        {!tools.length && <div className="home-empty">Tous les outils sont masqués : bouton de personnalisation en bas à droite.</div>}
      </div>

      <img className="home-logo" src="/favicon.svg" alt="" />
      <div className="home-fab" onMouseDown={(e) => e.stopPropagation()}>
        {!hintSeen && (
          <div className="home-hint">
            Personnalisez votre espace de travail. Ne conservez que les outils dont vous avez besoin.
            <button onClick={() => setHintSeen(true)}>Compris</button>
          </div>
        )}
        <button className="home-round" title="Personnaliser les outils" onClick={() => { setCustom(!custom); setMenu(false); setHintSeen(true); }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 3v14M14 3v14" /><circle cx="6" cy="12" r="2.2" fill="var(--home-bg)" /><circle cx="14" cy="7" r="2.2" fill="var(--home-bg)" /></svg>
          {!hintSeen && <span className="home-dot" />}
        </button>
        <button className="home-round" title="Menu" onClick={() => { setMenu(!menu); setCustom(false); }}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 6h12M4 10h12M4 14h12" /></svg>
        </button>
        {custom && (
          <div className="home-menu up">
            <div className="home-menu-head">Outils affichés</div>
            {ALL_TOOLS.map((t) => (
              <label key={t} className="home-check">
                <input type="checkbox" checked={homeTools.includes(t)} onChange={(e) => setHomeTools(e.target.checked ? [...homeTools, t] : homeTools.filter((x) => x !== t))} />
                <ToolIcon tool={t} size={16} /> {TILE_LABELS[t]}
              </label>
            ))}
            <button className="home-reset" onClick={() => setHomeTools(ALL_TOOLS)}>Tout afficher</button>
          </div>
        )}
        {menu && (
          <div className="home-menu up">
            <button onClick={() => { setUiTheme(uiTheme === 'dark' ? 'light' : 'dark'); setMenu(false); }}>{uiTheme === 'dark' ? 'Thème clair' : 'Thème sombre'}</button>
            <button onClick={() => { createLayout(); setMenu(false); }}>Nouvelle mise en page</button>
            <button onClick={() => { useChartUi.getState().openDialog('offline'); setMenu(false); }}>Données hors ligne…</button>
            <button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); setMenu(false); }}>Plein écran</button>
          </div>
        )}
      </div>
    </div>
  );
}
