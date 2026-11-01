import { useEffect } from 'react';
import './App.css';
import './tabs.css';
import './tools.css';
import TopBar from './components/TopBar';
import LeftToolbar from './components/LeftToolbar';
import RightSidebar from './components/RightSidebar';
import LeftWatchlist from './components/LeftWatchlist';
import BottomDock from './components/strategy/BottomDock';
import BackgroundServices, { QuoteFeeder } from './components/BackgroundServices';
import ChartContainer from './components/ChartContainer';
import BottomBar from './components/BottomBar';
import MultiChartGrid from './components/MultiChartGrid';
import FreeWindowsCanvas from './components/FreeWindowsCanvas';
import SymbolSearch from './components/SymbolSearch';
import IndicatorMenu from './components/IndicatorMenu';
import ChartSettingsPanel from './components/ChartSettingsPanel';
import SymbolInfoDialog from './components/SymbolInfoDialog';
import OfflineDialog from './components/OfflineDialog';
import BrokerDialog, { TradingSettingsDialog } from './components/BrokerDialog';
import GuardsDialog from './components/GuardsDialog';
import SymbolMenu from './components/SymbolMenu';
import CodeViewer from './components/CodeViewer';
import FloatingPineEditor from './components/FloatingPineEditor';
import AlertDialog from './components/alerts/AlertDialog';
import { addAlertAtPrice, addTextNote } from './components/symbolActions';
import FavoritesToolbar from './components/FavoritesToolbar';
import WorkspaceManager from './components/WorkspaceManager';
import PendingPopoutsBar from './components/PendingPopoutsBar';
import { applyWorkspace } from './components/workspaces';
import TabBar, { LayoutAutosave } from './components/tabs/TabBar';
import HomePage from './components/tabs/HomePage';
import ToolPage from './components/tabs/ToolPage';
import { TOOL_LABELS, goToChart, openChartTab, openTool, showOnChart } from './components/tabs/tabActions';
import { startToolWindow, startToolWindowHub } from './components/toolWindows';
import { startPopoutHub, startPopoutReporter, startThemeSync } from './components/popouts';
import { startChartLink } from './components/chartLink';
import { startListBackup } from './components/listBackup';
import { useStore, POPOUT_ID, POPOUT_TOOL } from './store/store';
import { useChartUi } from './store/chartUi';

function Toast() {
  const toast = useChartUi((s) => s.toast);
  if (!toast) return null;
  return <div key={toast.id} className="alert-toast">{toast.text}</div>;
}

// after "⛶" on a small chart: a bar back to the 2 / 4 windows or the free windows left
function ReturnToLayout() {
  const back = useChartUi((s) => s.returnLayout);
  const setBack = useChartUi((s) => s.setReturnLayout);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const nFree = useStore((s) => s.freeWindows.length);
  // gone once another layout is picked (layout menu)
  useEffect(() => { if (layout !== 1 && back) setBack(null); }, [layout, back, setBack]);
  if (!back || layout !== 1) return null;
  const label = back === 'free' ? `Revenir aux fenêtres libres${nFree > 1 ? ` (${nFree})` : ''}` : `Revenir aux ${back} fenêtres`;
  return (
    <div className="return-layout-bar">
      <button className="pill-btn" onClick={() => { setBack(null); setLayout(back); }}>↩ {label}</button>
      <button className="remove-btn" title="Rester en mode 1 fenêtre" onClick={() => setBack(null)}>✕</button>
    </div>
  );
}

function App() {
  const uiTheme = useStore((s) => s.uiTheme);
  const layout = useStore((s) => s.layout);
  const watchlistLeft = useStore((s) => s.watchlistSide === 'left' && s.leftWatchlistOpen);
  const dockMaximized = useStore((s) => s.bottomDock.tab != null && s.bottomDock.maximized);
  const searchOpen = useChartUi((s) => s.search.open);
  const dialog = useChartUi((s) => s.dialog);
  const closeDialog = useChartUi((s) => s.closeDialog);
  const codeFor = useChartUi((s) => s.codeFor);
  const alertDraft = useChartUi((s) => s.alertDraft);
  const workspaceManagerOpen = useChartUi((s) => s.workspaceManagerOpen);
  const ticker = useStore((s) => s.symbol.ticker);
  const timeframe = useStore((s) => s.timeframe);
  // detached windows always show their chart, or the tool page dragged out of the tabs
  const tab = useStore((s) => (POPOUT_ID ? undefined : s.tabs.find((t) => t.id === s.activeTabId)));
  const page = POPOUT_TOOL ?? (tab?.kind === 'home' ? 'home' : tab?.kind === 'tool' ? tab.tool ?? null : null);

  // detached windows report to the main one, which keeps the list of them
  useEffect(() => (POPOUT_ID ? startPopoutReporter() : startPopoutHub()), []);
  // the main window's watchlists, saved on disk after each change
  useEffect(() => (POPOUT_ID ? undefined : startListBackup()), []);
  // light / dark follows in every window
  useEffect(() => startThemeSync(), []);
  // linked charts (symbol, timeframe, scrolling) follow each other across windows
  useEffect(() => (POPOUT_TOOL ? undefined : startChartLink()), []);
  // a tool window works on the main window's data; the main window takes its changes and opens its charts
  useEffect(() => (POPOUT_TOOL ? startToolWindow() : POPOUT_ID ? undefined : startToolWindowHub({ showOnChart, goToChart, openChartTab, openTool })), []);

  // the window title tells the detached windows apart in the taskbar
  useEffect(() => {
    document.title = POPOUT_TOOL ? `${TOOL_LABELS[POPOUT_TOOL]} — TeshTerminal` : POPOUT_ID ? `${ticker} · ${timeframe} — TeshTerminal` : 'TeshTerminal';
  }, [ticker, timeframe]);

  // like TradingView: typing a letter anywhere opens the symbol search pre-filled
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // F1..F10: load the workspace bound to that key (main window only)
      if (!POPOUT_ID && /^F([1-9]|10)$/.test(e.key) && !e.ctrlKey && !e.altKey) {
        const ws = useStore.getState().workspaces.find((w) => w.shortcut === e.key);
        if (ws) { e.preventDefault(); goToChart(); void applyWorkspace(ws); return; }
      }
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      // Alt+A: alert at the current price, Alt+N: text note (TradingView shortcuts)
      if (e.altKey && !e.ctrlKey && (e.code === 'KeyA' || e.code === 'KeyN')) {
        e.preventDefault();
        if (e.code === 'KeyA') addAlertAtPrice(); else addTextNote();
        return;
      }
      const ui = useChartUi.getState();
      const st = useStore.getState();
      if (POPOUT_TOOL || (!POPOUT_ID && st.tabs.find((x) => x.id === st.activeTabId)?.kind !== 'chart')) return;
      if (e.ctrlKey || e.metaKey || e.altKey || ui.search.open || ui.dialog || ui.codeFor || ui.alertDraft) return;
      if (/^[a-zA-Z0-9]$/.test(e.key)) {
        e.preventDefault();
        useChartUi.getState().openSearch('switch', e.key.toUpperCase());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app" data-theme={uiTheme}>
      {!POPOUT_ID && <TabBar />}
      {!POPOUT_ID && <LayoutAutosave />}
      {page === 'home' ? <HomePage /> : page ? <ToolPage key={page} tool={page} /> : (
        <>
          <TopBar />
          <div className="app-body">
            {!POPOUT_ID && watchlistLeft && <LeftWatchlist />}
            <LeftToolbar />
            <div className="center-column">
              <div className={`center-main ${dockMaximized && !POPOUT_ID ? 'hidden' : ''}`}>
                {layout === 1 || POPOUT_ID ? (
                  <div className="chart-column">
                    {!POPOUT_ID && <ReturnToLayout />}
                    <ChartContainer />
                    <BottomBar />
                  </div>
                ) : layout === 'free' ? <FreeWindowsCanvas /> : <MultiChartGrid />}
              </div>
              {!POPOUT_ID && <BottomDock />}
            </div>
            {!POPOUT_ID && <RightSidebar />}
          </div>
          <FavoritesToolbar />
        </>
      )}
      {!POPOUT_ID && <BackgroundServices />}
      {POPOUT_TOOL && <QuoteFeeder />}
      {!POPOUT_ID && <PendingPopoutsBar />}
      {workspaceManagerOpen && <WorkspaceManager />}
      {searchOpen && <SymbolSearch />}
      {dialog === 'indicators' && <IndicatorMenu onClose={closeDialog} />}
      {dialog === 'settings' && <ChartSettingsPanel onClose={closeDialog} />}
      {dialog === 'symbolInfo' && <SymbolInfoDialog />}
      {dialog === 'offline' && <OfflineDialog onClose={closeDialog} />}
      {dialog === 'brokers' && !POPOUT_ID && <BrokerDialog onClose={closeDialog} />}
      {dialog === 'tradingSettings' && !POPOUT_ID && <TradingSettingsDialog onClose={closeDialog} />}
      {dialog === 'guards' && !POPOUT_ID && <GuardsDialog onClose={closeDialog} />}
      {!POPOUT_ID && <FloatingPineEditor />}
      {codeFor && <CodeViewer />}
      {alertDraft && !POPOUT_ID && <AlertDialog key={alertDraft.edit?.id ?? `${alertDraft.indicatorId ?? ''}:${alertDraft.plot ?? ''}`} />}
      <SymbolMenu />
      <Toast />
    </div>
  );
}

export default App;
