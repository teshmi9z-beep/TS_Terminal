import { useRef, useState, type ReactElement } from 'react';
import { useStore } from '../store/store';
import { POPOUT_ID, type TopBarButtonId } from '../store/store';
import { openPopout } from './popouts';
import { useChartUi } from '../store/chartUi';
import type { ChartSettings } from '../types';
import { sortTfs, tfLongLabel, tfShortLabel } from '../data/timeframes';
import TimeframeMenu from './TimeframeMenu';
import WorkspaceMenu from './WorkspaceMenu';
import LayoutMenu from './LayoutMenu';
import ProfileMenu from './ProfileMenu';
import { SymbolLogo } from './SymbolLogo';
import { downloadScreenshot } from './mainChart';
import { GearIcon } from './GearIcon';
import { endReplaySession } from './tradingAccount';
import LinkMenu from './LinkMenu';
import { LANG, setLang } from '../i18n/lang';

const STYLES: { id: ChartSettings['candleStyle']; label: string; icon: ReactElement }[] = [
  { id: 'candles', label: 'Bougies', icon: <CandlesIcon /> },
  { id: 'heikin_ashi', label: 'Heikin Ashi', icon: <CandlesIcon hollow /> },
  { id: 'bars', label: 'Barres', icon: <BarsIcon /> },
  { id: 'line', label: 'Ligne', icon: <LineIcon /> },
  { id: 'area', label: 'Aire', icon: <AreaIcon /> },
];

export default function TopBar() {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const setTimeframe = useStore((s) => s.setTimeframe);
  const uiTheme = useStore((s) => s.uiTheme);
  const setUiTheme = useStore((s) => s.setUiTheme);
  const topBarOrder = useStore((s) => s.topBarOrder);
  const reorderTopBar = useStore((s) => s.reorderTopBar);
  const compareCount = useStore((s) => s.compares.length);
  const alerts = useStore((s) => s.alerts);
  const layout = useStore((s) => s.layout);
  const candleStyle = useStore((s) => s.chartSettings.candleStyle);
  const updateChartSettings = useStore((s) => s.updateChartSettings);
  const favoriteTimeframes = useStore((s) => s.favoriteTimeframes);
  const workspaces = useStore((s) => s.workspaces);
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const [wsMenuAt, setWsMenuAt] = useState<{ left: number; top: number } | null>(null);
  const openSearch = useChartUi((s) => s.openSearch);
  const openDialog = useChartUi((s) => s.openDialog);
  const replayMode = useChartUi((s) => s.replay.mode);
  const setReplay = useChartUi((s) => s.setReplay);
  const [tfMenuAt, setTfMenuAt] = useState<{ left: number; top: number } | null>(null);
  const [styleMenuAt, setStyleMenuAt] = useState<{ left: number; top: number } | null>(null);
  // dropdowns open under their button, kept inside the window
  const below = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { left: Math.max(4, Math.min(r.left, window.innerWidth - 340)), top: r.bottom + 4 }; };
  const [showLayout, setShowLayout] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const rightPanel = useStore((s) => s.rightPanel);
  const setRightPanel = useStore((s) => s.setRightPanel);
  const dragIndex = useRef<number | null>(null);
  const activeAlerts = alerts.filter((a) => !a.triggered).length;

  const currentWs = workspaces.find((w) => w.id === currentWorkspaceId);
  const BUTTONS: Record<TopBarButtonId, ReactElement> = {
    workspaces: (
      <button className="tb-btn" title="Espaces de travail (enregistrer / charger / exporter)" onClick={(e) => setWsMenuAt(wsMenuAt ? null : below(e.currentTarget))}>
        <WorkspaceIcon /><span className="tb-ws-name">{currentWs?.name ?? 'Espaces'}</span>
      </button>
    ),
    // the compared symbols are listed (and set) in the chart's legend, top left
    compare: (
      <button
        className="tb-btn" onClick={() => { useChartUi.getState().setCompareTarget(null); openSearch('compare'); }}
        title={compareCount >= 5 ? '5 symboles comparés au maximum (réglages et retrait dans la légende du graphique)' : 'Comparer un symbole (5 au maximum, réglages dans la légende du graphique)'}
      >
        <CompareIcon /><span>Comparer{compareCount ? ` (${compareCount})` : ''}</span>
      </button>
    ),
    alerts: (
      <button className={`tb-btn ${rightPanel === 'alerts' ? 'tb-active' : ''}`} title="Alertes de prix" onClick={() => setRightPanel(rightPanel === 'alerts' ? null : 'alerts')}>
        <BellIcon /><span>Alertes</span>{activeAlerts > 0 && <span className="tb-badge">{activeAlerts}</span>}
      </button>
    ),
    windows: <button className="tb-btn" title="Disposition des graphiques et fenêtres détachées" onClick={() => setShowLayout(true)}><LayoutIcon /></button>,
    detach: (
      <button className="tb-btn" title="Ouvrir ce graphique dans une nouvelle fenêtre (déplaçable sur un autre écran)" onClick={() => openPopout(symbol, timeframe)}>
        <DetachIcon />
      </button>
    ),
    profiles: <button className="tb-btn" title="Modèles enregistrés" onClick={() => setShowProfiles(true)}><SaveIcon /></button>,
    settings: <button className="tb-btn" title="Paramètres du graphique" onClick={() => openDialog('settings')}><GearIcon /></button>,
    screenshot: (
      <button className="tb-btn" title="Capture du graphique (PNG)" disabled={layout !== 1} onClick={() => downloadScreenshot(symbol.ticker)}>
        <CameraIcon />
      </button>
    ),
    fullscreen: (
      <button
        className="tb-btn" title="Plein écran"
        onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen(); }}
      >
        <FullscreenIcon />
      </button>
    ),
    theme: (
      <button className="tb-btn" title={uiTheme === 'dark' ? 'Thème clair' : 'Thème sombre'} onClick={() => setUiTheme(uiTheme === 'dark' ? 'light' : 'dark')}>
        {uiTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
    ),
    // written in the other language on purpose: it is the way back for someone who can't read this one
    language: (
      <button
        className="tb-btn" translate="no" title={LANG === 'fr' ? 'Switch to English' : 'Passer en français'}
        onClick={() => setLang(LANG === 'fr' ? 'en' : 'fr')}
      >
        <GlobeIcon /><span>{LANG === 'fr' ? 'EN' : 'FR'}</span>
      </button>
    ),
  };

  const currentStyle = STYLES.find((s) => s.id === candleStyle) ?? STYLES[0];
  // starred intervals, plus the current one when it isn't starred
  const tfButtons = sortTfs(favoriteTimeframes.includes(timeframe) ? favoriteTimeframes : [...favoriteTimeframes, timeframe]);
  const replayOn = replayMode !== 'off';

  return (
    <div className="top-bar">
      <button className="tb-symbol" onClick={() => openSearch('switch')} title="Rechercher un symbole (ou tapez directement sur le graphique)">
        <SymbolLogo sym={symbol} size={18} />
        <span>{symbol.ticker}</span>
        <SearchIcon />
      </button>
      <LinkMenu />
      <div className="tb-sep" />
      <div className="tf-group">
        {tfButtons.map((tf) => (
          <button key={tf} className={`tf-btn ${timeframe === tf ? 'active' : ''}`} onClick={() => setTimeframe(tf)} title={tfLongLabel(tf)}>
            {tfShortLabel(tf)}
          </button>
        ))}
        <div className="tb-dropdown">
          <button
            className={`tf-btn tf-chevron ${tfMenuAt ? 'active' : ''}`} title="Toutes les unités de temps"
            onClick={(e) => setTfMenuAt(tfMenuAt ? null : below(e.currentTarget))}
          >
            <ChevronIcon />
          </button>
          {tfMenuAt && <TimeframeMenu anchor={tfMenuAt} onClose={() => setTfMenuAt(null)} />}
        </div>
      </div>
      <div className="tb-sep" />
      <div className="tb-dropdown">
        <button className="tb-btn" title="Type de graphique" onClick={(e) => setStyleMenuAt(styleMenuAt ? null : below(e.currentTarget))}>
          {currentStyle.icon}
        </button>
        {styleMenuAt && (
          <>
            <div className="tb-dropdown-backdrop" onClick={() => setStyleMenuAt(null)} />
            <div className="tb-dropdown-menu" style={{ left: styleMenuAt.left, top: styleMenuAt.top }}>
              {STYLES.map((st) => (
                <button
                  key={st.id}
                  className={`tb-menu-item ${st.id === candleStyle ? 'active' : ''}`}
                  onClick={() => { updateChartSettings({ candleStyle: st.id }); setStyleMenuAt(null); }}
                >
                  {st.icon}<span>{st.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <button className="tb-btn" onClick={() => openDialog('indicators')} title="Indicateurs"><FxIcon /><span>Indicateurs</span></button>
      <button
        className={`tb-btn ${replayOn ? 'tb-active' : ''}`} disabled={layout !== 1}
        title={replayOn ? 'Quitter le replay' : 'Replay : rejouer le marché barre par barre'}
        onClick={() => { if (replayOn) endReplaySession(); setReplay(replayOn ? { mode: 'off', playing: false, time: null, at: null } : { mode: 'select', playing: false }); }}
      >
        <ReplayIcon /><span>Replay</span>
      </button>
      <div className="tb-sep" />
      <div className="top-bar-right">
        {topBarOrder.map((id, i) => POPOUT_ID && (id === 'windows' || id === 'detach' || id === 'workspaces') ? null : (
          <div
            key={id}
            className="draggable-btn"
            draggable
            onDragStart={() => { dragIndex.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (dragIndex.current !== null) reorderTopBar(dragIndex.current, i); dragIndex.current = null; }}
          >
            {BUTTONS[id]}
          </div>
        ))}
      </div>
      <div className="top-bar-spacer" />
      {!POPOUT_ID && (
        // like TradingView: the order ticket opens from the top right, above the watchlist
        <button
          className={`tb-trade ${rightPanel === 'trading' ? 'active' : ''}`} title="Passer un ordre (compte virtuel)"
          onClick={() => useStore.getState().toggleTradingPanel()}
        >
          <TradeIcon /><span>Trader</span>
        </button>
      )}
      {showLayout && <LayoutMenu onClose={() => setShowLayout(false)} />}
      {wsMenuAt && <WorkspaceMenu at={wsMenuAt} onClose={() => setWsMenuAt(null)} />}
      {showProfiles && <ProfileMenu onClose={() => setShowProfiles(false)} />}
    </div>
  );
}

const ic = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function CandlesIcon({ hollow }: { hollow?: boolean }) {
  return (
    <svg {...ic}>
      <path d="M5 2v3M5 12v4M13 3v3M13 11v3" />
      <rect x="3" y="5" width="4" height="7" fill={hollow ? 'none' : 'currentColor'} />
      <rect x="11" y="6" width="4" height="5" />
    </svg>
  );
}
function BarsIcon() { return <svg {...ic}><path d="M5 3v12M3 6h2M5 12h2M13 4v10M11 11h2M13 6h2" /></svg>; }
function LineIcon() { return <svg {...ic}><path d="M2 13l4-5 3 3 4-6 3 3" /></svg>; }
function AreaIcon() { return <svg {...ic}><path d="M2 13l4-5 3 3 4-6 3 3v7H2z" fill="currentColor" fillOpacity="0.25" /></svg>; }
function TradeIcon() { return <svg {...ic}><path d="M3 12l4-4 3 3 5-6" /><path d="M11 5h4v4" /></svg>; }
function FxIcon() { return <svg {...ic}><path d="M9.5 3.5c-1.8-.6-3 .2-3.2 2L5.5 13c-.2 1.8-1.4 2.5-3 2" /><path d="M4 7.5h5M10 8l5 6M15 8l-5 6" /></svg>; }
function CompareIcon() { return <svg {...ic}><circle cx="9" cy="9" r="6.5" /><path d="M9 6v6M6 9h6" /></svg>; }
function BellIcon() { return <svg {...ic}><path d="M4.5 12.5V8a4.5 4.5 0 019 0v4.5l1.5 1.5H3z" /><path d="M7.5 15.5a1.5 1.5 0 003 0" /></svg>; }
function LayoutIcon() { return <svg {...ic}><rect x="2.5" y="2.5" width="13" height="13" rx="1.5" /><path d="M9 2.5v13M2.5 9h13" /></svg>; }
function SaveIcon() { return <svg {...ic}><path d="M3 3h9.5L15 5.5V15H3z" /><path d="M6 3v4h6V3M6 15v-5h6v5" /></svg>; }
function CameraIcon() { return <svg {...ic}><path d="M2.5 6h3l1.2-2h4.6L12.5 6h3v8.5h-13z" /><circle cx="9" cy="10" r="2.6" /></svg>; }
function FullscreenIcon() { return <svg {...ic}><path d="M2.5 6.5v-4h4M11.5 2.5h4v4M15.5 11.5v4h-4M6.5 15.5h-4v-4" /></svg>; }
function SunIcon() { return <svg {...ic}><circle cx="9" cy="9" r="3.2" /><path d="M9 1.5v1.8M9 14.7v1.8M1.5 9h1.8M14.7 9h1.8M3.7 3.7l1.3 1.3M13 13l1.3 1.3M3.7 14.3L5 13M13 5l1.3-1.3" /></svg>; }
function MoonIcon() { return <svg {...ic}><path d="M14.5 11A6 6 0 017 3.5a6 6 0 107.5 7.5z" /></svg>; }
function GlobeIcon() { return <svg {...ic}><circle cx="9" cy="9" r="6.5" /><path d="M2.5 9h13M9 2.5c-2 2-2.8 4-2.8 6.5S7 13.5 9 15.5M9 2.5c2 2 2.8 4 2.8 6.5S11 13.5 9 15.5" /></svg>; }
function WorkspaceIcon() { return <svg {...ic}><rect x="2" y="3" width="6" height="5" rx="1" /><rect x="10" y="3" width="6" height="5" rx="1" /><rect x="2" y="10" width="14" height="5" rx="1" /></svg>; }
function DetachIcon() { return <svg {...ic}><path d="M10 3h5v5M15 3l-7 7" /><path d="M13 11v4H3V5h4" /></svg>; }
function ChevronIcon() { return <svg {...ic} width={14} height={14}><path d="M4 7l5 5 5-5" /></svg>; }
function ReplayIcon() { return <svg {...ic}><path d="M9.5 4.5L4 9l5.5 4.5zM15.5 4.5L10 9l5.5 4.5z" /></svg>; }
function SearchIcon() { return <svg {...ic} width={14} height={14}><circle cx="8" cy="8" r="5" /><path d="M12 12l3.5 3.5" /></svg>; }
