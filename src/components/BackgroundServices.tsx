import { useEffect, useMemo } from 'react';
import { useStore, type PaperPosition } from '../store/store';
import { useChartUi, playAlertSound } from '../store/chartUi';
import { useQuotes, quoteManager } from '../data/feeds/quotes';
import type { Symbol, Timeframe } from '../types';
import { warmFeeds } from '../data/feeds';
import { fxSymbol, quoteCurrency } from '../data/fx';
import { syncAutoRobots } from '../robots/autoRunner';
import { syncAlerts } from '../alerts/runner';
import { chartSymbol, findSymbol } from './symbolDnd';
import { brokerStatus, loadIgMarket, refreshBroker, useBroker } from '../store/broker';
import { igMarketOf, tickersOfSnapshot, updateBridges } from './brokerAccount';

// Quotes for everything that needs a live price (whatever panel is shown):
// the active watchlist, the charted symbol, open positions / orders, the screener.
export function QuoteFeeder() {
  const watchlists = useStore((s) => s.watchlists);
  const activeId = useStore((s) => s.activeWatchlistId);
  const symbol = useStore((s) => s.symbol);
  const paper = useStore((s) => s.paper);
  const screener = useChartUi((s) => s.screenerSymbols);
  const tabs = useStore((s) => s.tabs);
  const portfolios = useStore((s) => s.portfolios);
  const alerts = useStore((s) => s.alerts);
  const brokerSnap = useBroker((s) => s.snap);

  const wanted = useMemo(() => {
    const map = new Map<string, Symbol>();
    const add = (s: Symbol) => { if (!map.has(s.ticker)) map.set(s.ticker, s); };
    const tab = watchlists.find((t) => t.id === activeId) ?? watchlists[0];
    tab?.items.forEach((r) => { if (r.kind === 'asset') add(r.data); });
    add(symbol);
    paper.positions.forEach((p) => add(p.symbol));
    paper.orders.forEach((o) => add(o.symbol));
    // the symbols of the broker's positions and orders (their lines on the chart need the chart's price)
    for (const t of tickersOfSnapshot(brokerSnap)) { const s = findSymbol(t); if (s) add(s); }
    screener.forEach(add);
    // the other chart tabs (their price is shown in the tab) and the portfolios
    tabs.forEach((t) => { if (t.state?.symbol) add(t.state.symbol); });
    portfolios.forEach((p) => p.transactions.forEach((t) => add(t.symbol)));
    // the armed price alerts, even on a symbol shown nowhere (else they could never go off)
    for (const a of alerts) {
      const s = a.triggered ? null : a.symbol ?? findSymbol(a.ticker);
      if (s) add(s);
    }
    // the EUR rate of the charted symbol and of the virtual account's symbols (amounts shown in euros)
    for (const s of [symbol, ...paper.positions.map((p) => p.symbol), ...paper.orders.map((o) => o.symbol)]) {
      const fx = fxSymbol(quoteCurrency(s));
      if (fx) add(fx);
    }
    return [...map.values()];
  }, [watchlists, activeId, symbol, paper.positions, paper.orders, brokerSnap, screener, tabs, portfolios, alerts]);
  const key = wanted.map((s) => s.ticker).join(',');

  useEffect(() => {
    quoteManager.setWanted(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

const hit = (side: PaperPosition['side'], price: number, level: number | undefined, kind: 'sl' | 'tp') => {
  if (level == null || !Number.isFinite(level)) return false;
  const longLike = side === 'long';
  return kind === 'sl' ? (longLike ? price <= level : price >= level) : (longLike ? price >= level : price <= level);
};

// Virtual account engine: fills pending limit / stop orders and closes positions
// on stop-loss / take-profit, from live quotes.
function PaperEngine() {
  useEffect(() => useQuotes.subscribe((state) => {
    const st = useStore.getState();
    const { positions, orders } = st.paper;
    if (!positions.length && !orders.length) return;
    const ui = useChartUi.getState();
    for (const o of orders) {
      const q = state.quotes[o.symbol.ticker];
      if (!q) continue;
      const buy = o.side === 'long';
      const trig = o.type === 'limit' ? (buy ? q.last <= o.price : q.last >= o.price) : (buy ? q.last >= o.price : q.last <= o.price);
      if (!trig) continue;
      // a price that jumped past the order: a limit fills at that better price,
      // a stop at that worse one (like a broker), not at the order's price
      const fill = o.type === 'limit' ? (buy ? Math.min(o.price, q.last) : Math.max(o.price, q.last)) : (buy ? Math.max(o.price, q.last) : Math.min(o.price, q.last));
      st.paperCancelOrder(o.id);
      st.paperOpen({ symbol: o.symbol, side: o.side, qty: o.qty, entry: fill, sl: o.sl, tp: o.tp, ...(o.robot ? { robot: o.robot } : {}) });
      ui.showToast(`Ordre ${o.type === 'limit' ? 'limite' : 'stop'} exécuté : ${buy ? 'achat' : 'vente'} ${o.qty} ${o.symbol.ticker} à ${fill}`);
      playAlertSound();
    }
    for (const p of positions) {
      const q = state.quotes[p.symbol.ticker];
      if (!q) continue;
      const reason = hit(p.side, q.last, p.sl, 'sl') ? 'stop' : hit(p.side, q.last, p.tp, 'tp') ? 'objectif' : null;
      if (!reason) continue;
      // same for a gap: the stop exits at the worse price, the target at the better one
      const long = p.side === 'long';
      const exit = reason === 'stop' ? (long ? Math.min(p.sl!, q.last) : Math.max(p.sl!, q.last)) : (long ? Math.max(p.tp!, q.last) : Math.min(p.tp!, q.last));
      st.paperClose(p.id, exit, reason);
      const pnl = (exit - p.entry) * p.qty * (p.side === 'long' ? 1 : -1);
      ui.showToast(`${reason === 'stop' ? 'Stop' : 'Objectif'} touché sur ${p.symbol.ticker} : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
      playAlertSound();
    }
  }), []);
  return null;
}

// The broker picked in the "Trader" menu: its session, account, positions and orders, and the gap
// between its prices and the chart's. IG allows few requests a minute: the relay shares them.
function BrokerSync() {
  const active = useBroker((s) => s.active);
  const connected = useBroker((s) => !!s.account);
  const wantHistory = useBroker((s) => s.wantHistory);
  const symbol = useStore((s) => s.symbol);
  useEffect(() => { if (active !== 'paper') void brokerStatus(); }, [active]);
  useEffect(() => {
    if (active === 'paper' || !connected) return;
    let alive = true;
    const tick = async () => {
      await refreshBroker();
      if (!alive) return;
      const st = useBroker.getState();
      // the rules of the markets held (decimals, minimum size), asked once
      const held = new Set([...(st.snap?.positions ?? []), ...(st.snap?.orders ?? [])].map((x) => x.epic));
      for (const epic of held) if (st.igMarkets[epic]?.partial) void loadIgMarket(epic).catch(() => undefined);
      updateBridges([...new Set([useStore.getState().symbol.ticker, ...tickersOfSnapshot(st.snap)])]);
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [active, connected, wantHistory]);
  // the charted symbol's IG market and price, for the ticket and the chart's lines
  useEffect(() => {
    if (active === 'paper' || !connected) return;
    let alive = true;
    const load = async () => {
      const m = await igMarketOf(symbol).catch(() => null);
      if (!m || !alive) return;
      await loadIgMarket(m.epic).catch(() => undefined);
      if (alive) updateBridges([symbol.ticker]);
    };
    void load();
    const id = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(id); };
  }, [active, connected, symbol]);
  // the gap with IG measured again as soon as the chart's price comes (a new symbol's bars load after
  // IG's price) and as it moves, at most once a second
  useEffect(() => {
    if (active === 'paper' || !connected) return;
    let timer = 0;
    const measure = () => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = 0; updateBridges([useStore.getState().symbol.ticker]); }, 1000);
    };
    measure();
    const offQuotes = useQuotes.subscribe(measure);
    const offChart = useChartUi.subscribe((s, p) => { if (s.dataVersion !== p.dataVersion) measure(); });
    return () => { offQuotes(); offChart(); clearTimeout(timer); };
  }, [active, connected, symbol]);
  return null;
}

// the robots of the "Robots de trading" tab set to trade the virtual account
function RobotRunner() {
  const robots = useStore((s) => s.autoRobots);
  useEffect(() => { syncAutoRobots(robots); }, [robots]);
  useEffect(() => () => syncAutoRobots([]), []);
  return null;
}

// the alerts on indicators (src/alerts): feeds follow the active alerts
function AlertRunner() {
  const alerts = useStore((s) => s.techAlerts);
  const watchlists = useStore((s) => s.watchlists);
  useEffect(() => { syncAlerts(alerts, watchlists); }, [alerts, watchlists]);
  useEffect(() => () => syncAlerts([], []), []);
  return null;
}

// the charts of the 2 to 6 window layouts loaded in the background while one chart is shown, so that
// switching to them is quick (an IBKR future's first page takes seconds)
function GridWarmer() {
  const layout = useStore((s) => s.layout);
  const grid = useStore((s) => s.gridCharts);
  useEffect(() => {
    if (layout !== 1) return;
    const t = setTimeout(() => {
      const byTf = new Map<Timeframe, Symbol[]>();
      for (const g of grid.slice(0, 6)) {
        const s = g?.tf ? chartSymbol(g) : null;
        if (s && g.tf) byTf.set(g.tf, [...(byTf.get(g.tf) ?? []), s]);
      }
      for (const [tf, syms] of byTf) warmFeeds(syms, tf);
    }, 5000);
    return () => clearTimeout(t);
  }, [layout, grid]);
  return null;
}

export default function BackgroundServices() {
  return (
    <>
      <QuoteFeeder />
      <PaperEngine />
      <BrokerSync />
      <RobotRunner />
      <AlertRunner />
      <GridWarmer />
    </>
  );
}
