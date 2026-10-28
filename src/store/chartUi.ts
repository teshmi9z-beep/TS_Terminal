import { create } from 'zustand';
import type { IndicatorType, Symbol, TechAlert, Timeframe } from '../types';
import type { FeedSource } from '../data/feeds/types';
import { useStore, type PaperSide, type Popout } from './store';
import type { OrderDraft } from '../components/orderDraft';
import type { BacktestResult } from '../strategy/types';
import type { Operand } from '../strategy/rules';

// transient UI state shared between the chart and its surrounding panels (never persisted)

export type SearchMode = 'switch' | 'add' | 'compare';
export type DialogId = 'indicators' | 'settings' | 'symbolInfo' | 'offline';

// the symbol menu of a small chart (2 / 4 windows, free windows): its own symbol, timeframe,
// price and hidden series (without one, the menu is the main chart's)
export type SymbolMenuTarget = {
  symbol: Symbol;
  timeframe: Timeframe;
  price: { price: number; precision: number } | null;
  hidden: boolean;
  setHidden: (v: boolean) => void;
};

// the "Créer une alerte" dialog: a new alert (on an indicator's plot when opened from its legend)
// or one being changed
export type AlertDraft = { edit?: TechAlert; indicatorId?: string; plot?: string };

// bar replay: 'select' waits for a click on the chart, 'on' replays from `time`
export type ReplayState = {
  mode: 'off' | 'select' | 'on';
  // the start bar picked on the chart (or at random)
  time: number | null;
  // the last bar shown: where the replay stands, kept by a chart tab that is left
  at: number | null;
  // bumped to put the chart back at `at` (a chart tab shown again)
  jump: number;
  playing: boolean;
  // bars per second
  speed: number;
};
export type RangeSpan = number | 'ytd' | 'all';

export type FeedStatus = {
  loading: boolean;
  source?: FeedSource;
  label?: string;
  realtime?: boolean;
  // an index future estimated in real time while its prices are delayed
  estimated?: boolean;
  error?: string;
};

type ChartUi = {
  // bar time under the crosshair (null = follow the last bar)
  hoverTime: number | null;
  setHoverTime: (t: number | null) => void;
  // bumped when bars change so legends re-read values
  dataVersion: number;
  bumpData: () => void;

  maximizedId: string | null;
  setMaximizedId: (id: string | null) => void;

  search: { open: boolean; mode: SearchMode; initial: string };
  openSearch: (mode: SearchMode, initial?: string) => void;
  closeSearch: () => void;

  toast: { id: number; text: string } | null;
  showToast: (text: string) => void;

  rangeRequest: { id: number; tf: Timeframe; span: RangeSpan } | null;
  requestRange: (tf: Timeframe, span: RangeSpan) => void;

  feedStatus: FeedStatus;
  setFeedStatus: (s: FeedStatus) => void;

  autoScale: boolean;
  setAutoScale: (v: boolean) => void;

  dialog: DialogId | null;
  openDialog: (d: DialogId) => void;
  closeDialog: () => void;

  alertDraft: AlertDraft | null;
  openAlert: (d: AlertDraft | null) => void;

  // indicator whose source code is shown
  codeFor: { type: IndicatorType; scriptId?: string } | null;
  setCodeFor: (t: { type: IndicatorType; scriptId?: string } | null) => void;

  // Pine editor: a new script, or the script being edited
  pineEditor: { open: boolean; scriptId?: string };
  openPineEditor: (scriptId?: string) => void;
  closePineEditor: () => void;

  // the symbol "..." menu, at screen coordinates
  symbolMenu: { x: number; y: number; target?: SymbolMenuTarget } | null;
  setSymbolMenu: (p: { x: number; y: number; target?: SymbolMenuTarget } | null) => void;
  // "Info du symbole" of a small chart's symbol (null: the main chart's)
  symbolInfoFor: Symbol | null;
  openSymbolInfo: (s: Symbol) => void;

  // a small chart shown big ("⛶"): the layout to go back to (2 / 4 windows, free windows)
  returnLayout: 2 | 4 | 'free' | null;
  setReturnLayout: (l: 2 | 4 | 'free' | null) => void;

  mainHidden: boolean;
  setMainHidden: (v: boolean) => void;

  replay: ReplayState;
  setReplay: (patch: Partial<ReplayState>) => void;

  // detached windows of a loaded workspace that the browser refused to open at once
  // symbols the screener wants quotes for
  screenerSymbols: Symbol[];
  setScreenerSymbols: (s: Symbol[]) => void;
  // default quantity of the chart's quick buy / sell buttons
  paperQty: number;
  setPaperQty: (q: number) => void;
  // "ordre sur le graphique": the next press on the chart sets the entry, the drag the stop
  orderPlacing: boolean;
  setOrderPlacing: (v: boolean) => void;
  // side and type chosen on the order ticket (right panel)
  orderTicket: { side: PaperSide; type: 'market' | 'limit' | 'stop' };
  setOrderTicket: (patch: Partial<ChartUi['orderTicket']>) => void;
  // the order drawn on the chart, shared by the chart and the order ticket
  orderDraft: OrderDraft | null;
  setOrderDraft: (d: OrderDraft | null) => void;
  // the ticket in limit / stop mode shows a line under the mouse on the chart (orderAiming);
  // right-click or Échap turn that off (orderAimOff) until Limite / Stop is picked again
  orderAiming: boolean;
  setOrderAiming: (v: boolean) => void;
  orderAimOff: boolean;
  setOrderAimOff: (v: boolean) => void;
  // right-click or Échap while placing an order: the order being placed goes away
  cancelOrderMode: () => void;
  // "Changer de symbole" of a compared symbol: the search replaces that one instead of adding
  compareTarget: string | null;
  setCompareTarget: (id: string | null) => void;
  // a text drawing being typed in place on the chart
  editTextId: string | null;
  setEditTextId: (id: string | null) => void;

  // last strategy tester run
  backtest: { status: 'idle' | 'loading' | 'done' | 'error'; progress?: string; result?: BacktestResult; error?: string };
  setBacktest: (b: ChartUi['backtest']) => void;
  // assisted strategy editor waiting for a click on a chart indicator
  strategyPick: ((op: Operand) => void) | null;
  setStrategyPick: (f: ((op: Operand) => void) | null) => void;
  // the open right-bar module covers the whole workspace
  rightFullscreen: boolean;
  setRightFullscreen: (v: boolean) => void;

  pendingPopouts: Popout[];
  setPendingPopouts: (p: Popout[]) => void;
  workspaceManagerOpen: boolean;
  setWorkspaceManagerOpen: (v: boolean) => void;
};

let seq = 1;

export const useChartUi = create<ChartUi>()((set) => ({
  hoverTime: null,
  setHoverTime: (t) => set((st) => (st.hoverTime === t ? st : { hoverTime: t })),
  dataVersion: 0,
  bumpData: () => set((st) => ({ dataVersion: st.dataVersion + 1 })),

  maximizedId: null,
  setMaximizedId: (id) => set({ maximizedId: id }),

  search: { open: false, mode: 'switch', initial: '' },
  openSearch: (mode, initial = '') => set({ search: { open: true, mode, initial } }),
  closeSearch: () => set((st) => ({ search: { ...st.search, open: false } })),

  toast: null,
  showToast: (text) => {
    const id = seq++;
    set({ toast: { id, text } });
    setTimeout(() => set((st) => (st.toast?.id === id ? { toast: null } : st)), 6000);
  },

  rangeRequest: null,
  requestRange: (tf, span) => set({ rangeRequest: { id: seq++, tf, span } }),

  feedStatus: { loading: true },
  setFeedStatus: (s) => set({ feedStatus: s }),

  autoScale: true,
  setAutoScale: (v) => set((st) => (st.autoScale === v ? st : { autoScale: v })),

  dialog: null,
  openDialog: (d) => set({ dialog: d, symbolInfoFor: null }),
  closeDialog: () => set({ dialog: null }),

  alertDraft: null,
  openAlert: (d) => set({ alertDraft: d }),

  codeFor: null,
  setCodeFor: (t) => set({ codeFor: t }),

  pineEditor: { open: false },
  openPineEditor: (scriptId) => {
    set({ pineEditor: { open: true, scriptId }, codeFor: null, dialog: null });
    useStore.getState().setRightPanel('pine');
  },
  closePineEditor: () => set({ pineEditor: { open: false } }),

  symbolMenu: null,
  setSymbolMenu: (p) => set({ symbolMenu: p }),
  symbolInfoFor: null,
  openSymbolInfo: (s) => set({ dialog: 'symbolInfo', symbolInfoFor: s }),

  returnLayout: null,
  setReturnLayout: (l) => set({ returnLayout: l }),

  mainHidden: false,
  setMainHidden: (v) => set({ mainHidden: v }),

  replay: { mode: 'off', time: null, at: null, jump: 0, playing: false, speed: 1 },
  setReplay: (patch) => set((st) => ({ replay: { ...st.replay, ...patch } })),

  screenerSymbols: [],
  setScreenerSymbols: (s) => set({ screenerSymbols: s }),
  paperQty: 1,
  setPaperQty: (q) => set({ paperQty: q }),
  orderPlacing: false,
  setOrderPlacing: (v) => set({ orderPlacing: v }),
  orderTicket: { side: 'long', type: 'market' },
  setOrderTicket: (patch) => set((st) => ({ orderTicket: { ...st.orderTicket, ...patch } })),
  orderDraft: null,
  setOrderDraft: (d) => set({ orderDraft: d }),
  orderAiming: false,
  setOrderAiming: (v) => set((st) => (st.orderAiming === v ? st : { orderAiming: v })),
  orderAimOff: false,
  setOrderAimOff: (v) => set({ orderAimOff: v }),
  cancelOrderMode: () => set({ orderDraft: null, orderPlacing: false, orderAimOff: true }),
  compareTarget: null,
  setCompareTarget: (id) => set({ compareTarget: id }),
  editTextId: null,
  setEditTextId: (id) => set({ editTextId: id }),

  backtest: { status: 'idle' },
  setBacktest: (b) => set({ backtest: b }),
  strategyPick: null,
  setStrategyPick: (f) => set({ strategyPick: f }),
  rightFullscreen: false,
  setRightFullscreen: (v) => set({ rightFullscreen: v }),

  pendingPopouts: [],
  setPendingPopouts: (p) => set({ pendingPopouts: p }),
  workspaceManagerOpen: false,
  setWorkspaceManagerOpen: (v) => set({ workspaceManagerOpen: v }),
}));

// short two-tone chime for triggered alerts
export function playAlertSound() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.18);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { /* audio unavailable */ }
}
