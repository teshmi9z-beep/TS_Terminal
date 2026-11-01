import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PaperSide } from './store';

// The broker the "Trader" button trades through, like TradingView's "Tradez avec votre courtier":
// the platform's virtual account ('paper'), IG's demo account ('ig') or IG's real-money account
// ('ig-live'), each reached through its own relay of the server (scripts/broker-relay.ts). Prices here
// are IG's own; src/components/brokerAccount.ts turns them into the chart's and checks the guards
// (Garde-fous) before any order goes.

export type BrokerId = 'paper' | 'ig' | 'ig-live';
export const isLive = (b: BrokerId) => b === 'ig-live';
export const brokerLabel = (b: BrokerId) => (b === 'ig' ? 'IG démo' : b === 'ig-live' ? 'IG réel' : 'Paper Trading');
const RELAY: Record<BrokerId, string> = { paper: '/api/broker/', ig: '/api/broker/', 'ig-live': '/api/broker-live/' };

export type BrokerAccount = { id: string; name: string; currency: string; balance: number; pnl: number; available: number };
// the account the relay is signed in to (its amounts come with the snapshot)
export type BrokerSession = Pick<BrokerAccount, 'id' | 'name' | 'currency'>;
export type BrokerPosition = {
  id: string; epic: string; name: string; side: PaperSide; size: number; level: number; sl: number | null; tp: number | null;
  bid: number | null; offer: number | null; scale: number; pnl: number | null; currency: string; openedAt: number;
  // what one point is worth per contract, in `currency`
  perPoint: number;
};
export type BrokerOrder = {
  id: string; epic: string; name: string; side: PaperSide; size: number; type: 'limit' | 'stop'; level: number;
  sl: number | null; tp: number | null; bid: number | null; offer: number | null; scale: number; currency: string; createdAt: number;
};
export type BrokerTrade = {
  id: string; name: string; side: PaperSide; size: number; entry: number | null; exit: number | null; pnl: number | null;
  currency: string; openedAt: number; closedAt: number;
};
export type BrokerSnapshot = { account: BrokerAccount; positions: BrokerPosition[]; orders: BrokerOrder[]; history: BrokerTrade[] | null };
// one IG market: its price and what it allows (scale: IG's points in one unit of price, 10 000 for
// most forex pairs, whose prices are still plain rates)
export type IgMarket = {
  epic: string; name: string; bid: number | null; offer: number | null; status: string; scale: number; decimals: number; delay: number;
  currency: string; contractSize: number; minSize: number | null; minStop: { unit: string; value: number } | null;
  // only what the positions / orders tell (its rules not asked yet)
  partial?: true;
};
export type IgSearchHit = { epic: string; name: string; type: string; expiry: string; bid: number | null; offer: number | null; status: string };
export type IgPick = { epic: string; name: string; fromIg?: true };
// the gap between IG's price and the chart's, measured at the last refresh: IG = chart + offset
export type Bridge = { epic: string; offset: number };

// The guards of a broker's account (the "Garde-fous" window, like FTMO's Mentor app), each one on or
// off: what a new order must respect before it is sent. Closing, cancelling and tightening a stop are
// always allowed.
export type Guards = {
  // ask before each order
  confirm: boolean;
  // no order without a stop loss (nor a stop taken off a position)
  stopRequired: boolean;
  // contracts per order
  maxSize: { on: boolean; value: number };
  // % of the account's capital lost at the stop, per order
  maxRisk: { on: boolean; value: number };
  // % of the day's starting capital that may be lost in the day; reached, no new order until the next day
  dailyLoss: { on: boolean; value: number };
  // open positions and pending orders together
  maxOpen: { on: boolean; value: number };
  // orders only between these hours (this computer's time)
  hours: { on: boolean; from: string; to: string };
  // 'YYYY-MM-DD': no new order that day (the limit of the day reached, or locked by hand)
  lockedDay: string | null;
};
const GUARDS_OFF: Guards = {
  confirm: true, stopRequired: false, maxSize: { on: false, value: 1 }, maxRisk: { on: false, value: 1 },
  dailyLoss: { on: false, value: 3 }, maxOpen: { on: false, value: 3 }, hours: { on: false, from: '08:00', to: '22:00' }, lockedDay: null,
};
// real money: every guard on from the start
const GUARDS_LIVE: Guards = {
  ...GUARDS_OFF, stopRequired: true, maxSize: { on: true, value: 1 }, maxRisk: { on: true, value: 1 },
  dailyLoss: { on: true, value: 3 }, maxOpen: { on: true, value: 3 },
};
export const defaultGuards = (b: BrokerId): Guards => (isLive(b) ? GUARDS_LIVE : GUARDS_OFF);
// today on this computer, 'YYYY-MM-DD'
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

type BrokerState = {
  active: BrokerId;
  setActive: (b: BrokerId) => void;
  guards: Partial<Record<BrokerId, Guards>>;
  setGuards: (b: BrokerId, patch: Partial<Guards>) => void;
  // the IG market each platform ticker trades (picked automatically, changed in the order ticket);
  // fromIg: opened from the "Marchés IG" panel, its charts then show IG's logo before their name
  markets: Record<string, IgPick>;
  setMarket: (ticker: string, m: IgPick) => void;
  // the link of a ticker to the IG contract it was opened from, undone (its IG logo goes; the
  // ticket picks the contract on its own again)
  unlinkMarket: (ticker: string) => void;
  // not kept: the relay's state
  account: BrokerSession | null;
  error: string | null;
  snap: BrokerSnapshot | null;
  igMarkets: Record<string, IgMarket>;
  bridges: Record<string, Bridge>;
  // the bottom panel shows the history (it is asked from IG only then, or for the daily loss guard)
  wantHistory: boolean;
  setWantHistory: (v: boolean) => void;
};

export const useBroker = create<BrokerState>()(persist((set) => ({
  active: 'paper',
  // another account: what was read from the previous one is dropped (it signs in on its own relay)
  setActive: (b) => set((s) => (s.active === b ? s : { active: b, account: null, snap: null, error: null })),
  guards: {},
  setGuards: (b, patch) => set((s) => ({ guards: { ...s.guards, [b]: { ...(s.guards[b] ?? defaultGuards(b)), ...patch } } })),
  markets: {},
  // a contract picked again (in the ticket) stays one opened from the IG panel
  setMarket: (ticker, m) => set((s) => ({ markets: { ...s.markets, [ticker]: { ...m, ...(m.fromIg ?? s.markets[ticker]?.fromIg ? { fromIg: true } : {}) } } })),
  unlinkMarket: (ticker) => set((s) => {
    const markets = { ...s.markets };
    delete markets[ticker];
    return { markets };
  }),
  account: null,
  error: null,
  snap: null,
  igMarkets: {},
  bridges: {},
  wantHistory: false,
  setWantHistory: (v) => set({ wantHistory: v }),
}), {
  name: 'broker',
  // version 2: the markets picked before IG's French names were known are picked again;
  // version 3: "confirm each order" became one of the demo account's guards;
  // version 6: IG's index CFDs ("au comptant") were opened on the platform's own index markets (the
  // futures US100..., then for a few hours the cash indices and IBKR's CFDs): they have IG symbols of
  // their own now (IGUST100...), and those markets' tickets pick their IG contract again
  version: 6,
  migrate: (persisted, version) => {
    const s = { ...((persisted ?? {}) as Partial<BrokerState> & { confirmOrders?: boolean }) };
    if (version < 2) s.markets = {};
    if (version < 6 && s.markets) {
      const futures = ['US500', 'US100', 'US30', 'US2000', 'DE40', 'FR40', 'J225', 'HK50'];
      const others = ['SPX500', 'NDX100', 'DJI', 'RUT2000', 'DAX40', 'CAC40', 'NIKKEI', 'HSI', 'FTSE100',
        'IBUS500', 'IBUST100', 'IBUS30', 'IBDE40', 'IBFR40', 'IBJP225', 'IBHK50'];
      s.markets = Object.fromEntries(Object.entries(s.markets).filter(([t, m]) => !(
        (futures.includes(t) && (m.fromIg || /au comptant|\bcash\b/i.test(m.name))) || (others.includes(t) && m.fromIg)
      )));
    }
    if (version < 3) {
      s.guards = { ig: { ...GUARDS_OFF, confirm: s.confirmOrders !== false } };
      delete s.confirmOrders;
    }
    return s as BrokerState;
  },
  partialize: (s) => ({ active: s.active, guards: s.guards, markets: s.markets }),
}));

// the guards of an account, with the defaults for those never set
export const guardsOf = (b: BrokerId) => useBroker.getState().guards[b] ?? defaultGuards(b);

export async function brokerCall<T>(path: string, body?: unknown, broker = useBroker.getState().active): Promise<T> {
  const r = await fetch(`${RELAY[broker]}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

type Status = { account: BrokerSession | null; error: string | null };

export async function brokerStatus() {
  const b = useBroker.getState().active;
  try {
    const s = await brokerCall<Status>('status', undefined, b);
    if (useBroker.getState().active !== b) return;
    useBroker.setState({ account: s.account, error: s.error, ...(s.account ? {} : { snap: null }) });
  } catch (e) {
    if (useBroker.getState().active === b) useBroker.setState({ account: null, snap: null, error: e instanceof Error ? e.message : String(e) });
  }
}

// `realMoney`: the box ticked in the real account's login (its relay refuses without it)
export async function connectIg(broker: 'ig' | 'ig-live', login: { apiKey: string; identifier: string; password: string; accountId?: string }, remember: boolean, realMoney = false) {
  const s = await brokerCall<Status>('connect', { ...login, remember: remember && !isLive(broker), realMoney }, broker);
  useBroker.getState().setActive(broker);
  useBroker.setState({ account: s.account, error: null, snap: null });
  await refreshBroker();
}

export async function disconnectBroker() {
  await brokerCall('disconnect', {}).catch(() => undefined);
  useBroker.setState({ account: null, error: null, snap: null, active: 'paper' });
}

export async function refreshBroker() {
  const st = useBroker.getState();
  if (!st.account) return;
  const b = st.active;
  const history = st.wantHistory || guardsOf(b).dailyLoss.on;
  try {
    const snap = await brokerCall<BrokerSnapshot>(`snapshot${history ? '?history=1' : ''}`, undefined, b);
    if (useBroker.getState().active !== b) return;
    // the prices of the markets held come with the positions and orders
    const igMarkets = { ...useBroker.getState().igMarkets };
    for (const x of [...snap.positions, ...snap.orders]) {
      const m = igMarkets[x.epic];
      igMarkets[x.epic] = m ? { ...m, bid: x.bid, offer: x.offer, scale: x.scale } : {
        epic: x.epic, name: x.name, bid: x.bid, offer: x.offer, status: '', scale: x.scale, decimals: 2, delay: 0,
        currency: x.currency, contractSize: 1, minSize: null, minStop: null, partial: true,
      };
    }
    useBroker.setState({ snap: { ...snap, history: snap.history ?? useBroker.getState().snap?.history ?? null }, account: snap.account, error: null, igMarkets });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (useBroker.getState().active !== b) return;
    // the relay lost the session (server restarted without "Rester connecté", or the real account)
    if (/Pas connecté/.test(error)) useBroker.setState({ account: null, snap: null, error: null });
    else useBroker.setState({ error });
  }
}

export async function loadIgMarket(epic: string): Promise<IgMarket> {
  const m = await brokerCall<IgMarket>(`market?epic=${encodeURIComponent(epic)}`);
  useBroker.setState((s) => ({ igMarkets: { ...s.igMarkets, [epic]: m } }));
  return m;
}

export const searchIg = (q: string) => brokerCall<IgSearchHit[]>(`search?q=${encodeURIComponent(q)}`);

// IG's lists of markets (its own and the user's) and the markets of one
export type IgList = { id: string; name: string; ig: boolean };
export const igLists = () => brokerCall<IgList[]>('lists');
export const igList = (id: string) => brokerCall<IgSearchHit[]>(`lists?id=${encodeURIComponent(id)}`);
