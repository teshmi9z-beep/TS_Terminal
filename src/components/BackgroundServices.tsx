import { useEffect, useMemo } from 'react';
import { useStore, type PaperPosition } from '../store/store';
import { useChartUi, playAlertSound } from '../store/chartUi';
import { useQuotes, quoteManager } from '../data/feeds/quotes';
import type { Symbol } from '../types';
import { fxSymbol, quoteCurrency } from '../data/fx';
import { syncAutoRobots } from '../robots/autoRunner';
import { syncAlerts } from '../alerts/runner';
import { findSymbol } from './symbolDnd';

// Quotes for everything that needs a live price (whatever panel is shown):
// the active watchlist, the charted symbol, open positions / orders, the screener.
function QuoteFeeder() {
  const watchlists = useStore((s) => s.watchlists);
  const activeId = useStore((s) => s.activeWatchlistId);
  const symbol = useStore((s) => s.symbol);
  const paper = useStore((s) => s.paper);
  const screener = useChartUi((s) => s.screenerSymbols);
  const tabs = useStore((s) => s.tabs);
  const portfolios = useStore((s) => s.portfolios);
  const alerts = useStore((s) => s.alerts);

  const wanted = useMemo(() => {
    const map = new Map<string, Symbol>();
    const add = (s: Symbol) => { if (!map.has(s.ticker)) map.set(s.ticker, s); };
    const tab = watchlists.find((t) => t.id === activeId) ?? watchlists[0];
    tab?.items.forEach((r) => { if (r.kind === 'asset') add(r.data); });
    add(symbol);
    paper.positions.forEach((p) => add(p.symbol));
    paper.orders.forEach((o) => add(o.symbol));
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
  }, [watchlists, activeId, symbol, paper.positions, paper.orders, screener, tabs, portfolios, alerts]);
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

export default function BackgroundServices() {
  return (
    <>
      <QuoteFeeder />
      <PaperEngine />
      <RobotRunner />
      <AlertRunner />
    </>
  );
}
