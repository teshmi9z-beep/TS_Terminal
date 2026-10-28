import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Candle, Symbol } from '../types';
import type { PaperAccount, PaperOrder, PaperPosition, PaperTrade } from './store';
import { eurPerUnit, quoteCurrency } from '../data/fx';
import { LOCALE } from '../i18n/lang';

// Virtual trading during a bar replay: an account of its own (the live virtual
// account is never touched), in euros, that moves bar by bar with the replay.
// A session starts at 10 000 € and ends when the replay is left or restarted
// (or with "Terminer la session"); its trades are then kept in `sessions`.

export const REPLAY_CAPITAL = 10000;

export type ReplaySession = {
  id: string;
  // when it was played (computer time, ms)
  startedAt: number;
  endedAt?: number;
  // the replayed period: first bar traded, last bar seen (bar time, s)
  from: number | null;
  to: number | null;
  tickers: string[];
  initial: number;
  final?: number;
  // closed trades, P&L in € (costs included); times are replay times (ms)
  trades: PaperTrade[];
};

type Last = { price: number; time: number };

type ReplayTradingState = {
  account: PaperAccount;
  session: ReplaySession;
  sessions: ReplaySession[];
  // last replay bar of each symbol traded (positions of another symbol wait there)
  lastPrice: Record<string, Last>;
  open: (p: Omit<PaperPosition, 'id' | 'openedAt'>, at: number) => void;
  placeOrder: (o: Omit<PaperOrder, 'id' | 'createdAt'>, at: number) => void;
  cancelOrder: (id: string) => void;
  close: (id: string, price: number, reason?: PaperTrade['reason'], at?: number) => void;
  modify: (id: string, patch: Partial<Pick<PaperPosition, 'sl' | 'tp'>>) => void;
  modifyOrder: (id: string, patch: Partial<Pick<PaperOrder, 'price' | 'sl' | 'tp' | 'qty' | 'type'>>) => void;
  // fills and exits on a new replay bar; returns what happened (for the toasts)
  onBar: (ticker: string, bar: Candle) => string[];
  // closes what is open at its last replay price and files the session; false when nothing was traded
  endSession: () => ReplaySession | null;
  clearSessions: () => void;
};

let seq = 0;
const nextId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;
const newAccount = (): PaperAccount => ({ initial: REPLAY_CAPITAL, balance: REPLAY_CAPITAL, positions: [], orders: [], history: [] });
const newSession = (): ReplaySession => ({ id: nextId(), startedAt: Date.now(), from: null, to: null, tickers: [], initial: REPLAY_CAPITAL, trades: [] });

// per side, fraction of the price: the lab's real costs (robots/search.ts costOf) by kind of market
const FX_MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY'];
export function replayCost(sym: Symbol): number {
  const t = sym.ticker.toUpperCase();
  switch (sym.category) {
    case 'Crypto': return 0.001;
    case 'Forex':
      if (FX_MAJORS.includes(t)) return 0.0001;
      if (/TRY|ZAR|MXN/.test(t)) return 0.0008;
      if (/NOK|SEK|PLN|DKK|HKD|SGD|HUF|CZK/.test(t)) return 0.0004;
      return 0.0002;
    case 'Matieres premieres': return 0.0003;
    case 'Indices': return 0.0002;
    default: return 0.0005;
  }
}

// P&L of a trade in euros, both sides' costs taken off
export function tradePnlEur(p: Pick<PaperPosition, 'symbol' | 'side' | 'qty' | 'entry'>, exit: number): number {
  const raw = (exit - p.entry) * p.qty * (p.side === 'long' ? 1 : -1);
  const costs = (p.entry + exit) * p.qty * replayCost(p.symbol);
  return (raw - costs) * (eurPerUnit(quoteCurrency(p.symbol)) ?? 1);
}

// the path a bar is taken to follow inside it (TradingView's rule): the extreme
// nearer the open first
function pathOf(b: Candle): number[] {
  return b.high - b.open < b.open - b.low ? [b.open, b.high, b.low, b.close] : [b.open, b.low, b.high, b.close];
}

// where along the path an order triggers: at the open when the bar opens past it
// (a gap: filled at the open), else at its price on the first segment reaching it
function fillOn(o: PaperOrder, path: number[]): { price: number; rest: number[] } | null {
  const buy = o.side === 'long';
  const past = (x: number) => (o.type === 'limit' ? (buy ? x <= o.price : x >= o.price) : (buy ? x >= o.price : x <= o.price));
  if (past(path[0])) return { price: path[0], rest: path };
  for (let i = 0; i + 1 < path.length; i++) if (past(path[i + 1])) return { price: o.price, rest: [o.price, ...path.slice(i + 1)] };
  return null;
}

// the first of stop / target the rest of the path reaches
function exitOn(p: Pick<PaperPosition, 'side' | 'sl' | 'tp'>, rest: number[]): { price: number; reason: 'stop' | 'objectif' } | null {
  const long = p.side === 'long';
  const hitSl = (x: number) => p.sl != null && (long ? x <= p.sl : x >= p.sl);
  const hitTp = (x: number) => p.tp != null && (long ? x >= p.tp : x <= p.tp);
  if (hitSl(rest[0])) return { price: rest[0], reason: 'stop' };
  if (hitTp(rest[0])) return { price: rest[0], reason: 'objectif' };
  for (let i = 0; i + 1 < rest.length; i++) {
    const a = rest[i], b = rest[i + 1];
    const sl = hitSl(b), tp = hitTp(b);
    if (sl && tp) return Math.abs(p.sl! - a) <= Math.abs(p.tp! - a) ? { price: p.sl!, reason: 'stop' } : { price: p.tp!, reason: 'objectif' };
    if (sl) return { price: p.sl!, reason: 'stop' };
    if (tp) return { price: p.tp!, reason: 'objectif' };
  }
  return null;
}

const fmt = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export const useReplayTrading = create<ReplayTradingState>()(persist((set, get) => {
  // the session notes the symbols and the replayed period
  const note = (s: ReplaySession, ticker: string, at: number): ReplaySession => ({
    ...s, tickers: s.tickers.includes(ticker) ? s.tickers : [...s.tickers, ticker], from: s.from ?? at, to: Math.max(s.to ?? at, at),
  });
  const closeIn = (acc: PaperAccount, session: ReplaySession, pos: PaperPosition, price: number, reason: PaperTrade['reason'], at: number) => {
    const pnl = tradePnlEur(pos, price);
    const trade: PaperTrade = {
      id: pos.id, ticker: pos.symbol.ticker, side: pos.side, qty: pos.qty, entry: pos.entry, exit: price, pnl,
      openedAt: pos.openedAt, closedAt: at * 1000, reason,
    };
    return {
      account: { ...acc, balance: acc.balance + pnl, positions: acc.positions.filter((p) => p.id !== pos.id), history: [trade, ...acc.history] },
      session: { ...session, trades: [trade, ...session.trades] },
      pnl,
    };
  };

  return {
    account: newAccount(),
    session: newSession(),
    sessions: [],
    lastPrice: {},

    open: (p, at) => set((st) => ({
      account: { ...st.account, positions: [...st.account.positions, { ...p, id: nextId(), openedAt: at * 1000 }] },
      session: note(st.session, p.symbol.ticker, at),
      lastPrice: { ...st.lastPrice, [p.symbol.ticker]: { price: p.entry, time: at } },
    })),
    placeOrder: (o, at) => set((st) => ({
      account: { ...st.account, orders: [...st.account.orders, { ...o, id: nextId(), createdAt: at * 1000 }] },
      session: note(st.session, o.symbol.ticker, at),
    })),
    cancelOrder: (id) => set((st) => ({ account: { ...st.account, orders: st.account.orders.filter((o) => o.id !== id) } })),
    close: (id, price, reason = 'manuel', at) => set((st) => {
      const pos = st.account.positions.find((p) => p.id === id);
      if (!pos) return st;
      const when = at ?? st.lastPrice[pos.symbol.ticker]?.time ?? pos.openedAt / 1000;
      const r = closeIn(st.account, st.session, pos, price, reason, when);
      return { account: r.account, session: r.session };
    }),
    modify: (id, patch) => set((st) => ({
      account: { ...st.account, positions: st.account.positions.map((p) => (p.id === id ? { ...p, ...patch } : p)) },
    })),
    modifyOrder: (id, patch) => set((st) => ({
      account: { ...st.account, orders: st.account.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)) },
    })),

    onBar: (ticker, bar) => {
      const st = get();
      let account = st.account;
      let session = st.session;
      const events: string[] = [];
      const lastPrice = { ...st.lastPrice, [ticker]: { price: bar.close, time: bar.time } };
      const mine = (x: { symbol: Symbol }) => x.symbol.ticker === ticker;
      if (!account.orders.some(mine) && !account.positions.some(mine)) {
        set({ lastPrice });
        return events;
      }
      const path = pathOf(bar);
      // positions already open: the whole bar
      const rests = new Map<string, number[]>();
      for (const p of account.positions) if (mine(p)) rests.set(p.id, path);
      // pending orders filled on this bar: what is left of the bar after the fill
      for (const o of account.orders.filter(mine)) {
        const f = fillOn(o, path);
        if (!f) continue;
        const pos: PaperPosition = { id: nextId(), symbol: o.symbol, side: o.side, qty: o.qty, entry: f.price, sl: o.sl, tp: o.tp, openedAt: bar.time * 1000 };
        account = { ...account, orders: account.orders.filter((x) => x.id !== o.id), positions: [...account.positions, pos] };
        rests.set(pos.id, f.rest);
        events.push(`Replay : ${o.side === 'long' ? 'achat' : 'vente'} ${o.type === 'limit' ? 'limite' : 'stop'} exécuté à ${f.price}`);
      }
      for (const [id, rest] of rests) {
        const pos = account.positions.find((p) => p.id === id);
        const ex = pos && exitOn(pos, rest);
        if (!pos || !ex) continue;
        const r = closeIn(account, session, pos, ex.price, ex.reason, bar.time);
        account = r.account;
        session = r.session;
        events.push(`Replay : ${ex.reason === 'stop' ? 'stop' : 'objectif'} touché à ${ex.price} (${fmt(r.pnl)})`);
      }
      session = { ...session, to: Math.max(session.to ?? bar.time, bar.time) };
      set({ account, session, lastPrice });
      return events;
    },

    endSession: () => {
      const st = get();
      let account = st.account;
      let session = st.session;
      for (const pos of st.account.positions) {
        const last = st.lastPrice[pos.symbol.ticker];
        const r = closeIn(account, session, pos, last?.price ?? pos.entry, 'fin', last?.time ?? pos.openedAt / 1000);
        account = r.account;
        session = r.session;
      }
      const done = session.trades.length ? { ...session, endedAt: Date.now(), final: account.balance } : null;
      set({
        account: newAccount(), session: newSession(), lastPrice: {},
        sessions: done ? [done, ...st.sessions].slice(0, 200) : st.sessions,
      });
      return done;
    },
    clearSessions: () => set({ sessions: [] }),
  };
}, {
  name: 'replay-trading',
  version: 1,
}));
