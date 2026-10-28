import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { eurPerUnit } from '../data/fx';
import { FEE_USD, rootOf } from '../options/model';

// The options replay account: 10 000 € of its own (neither the live virtual account nor the
// replay one are touched), options on the CME index futures bought or sold during a bar
// replay, settled at their intrinsic value when the replay passes their expiry.

export const OPTIONS_CAPITAL = 10000;

export type OptionPosition = {
  id: string;
  future: string;
  call: boolean;
  strike: number;
  expiry: number;
  expiryLabel: string;
  side: 'long' | 'short';
  qty: number;
  // premium paid or received, in points
  entry: number;
  // the future and the time when it was opened (replay time, s)
  entryF: number;
  openedAt: number;
  // its value bar after bar, for the small chart
  marks: { t: number; v: number }[];
};

export type OptionTrade = Omit<OptionPosition, 'marks'> & { exit: number; closedAt: number; pnl: number; reason: 'manuel' | 'échéance' };

type State = {
  balance: number;
  positions: OptionPosition[];
  history: OptionTrade[];
  open: (p: Omit<OptionPosition, 'id' | 'marks'>) => void;
  close: (id: string, price: number, at: number, reason?: OptionTrade['reason']) => number;
  mark: (id: string, t: number, v: number) => void;
  // every position of `future` whose expiry the replay passed, settled on the future's price
  settle: (future: string, F: number, t: number) => OptionTrade[];
  reset: () => void;
};

const usd = () => eurPerUnit('USD') ?? 0.92;

// P&L of an option position in euros, commissions of both sides taken off
export function optionPnlEur(p: Pick<OptionPosition, 'future' | 'side' | 'qty' | 'entry'>, price: number): number {
  const mult = rootOf(p.future)?.mult ?? 1;
  const raw = (price - p.entry) * mult * p.qty * (p.side === 'long' ? 1 : -1);
  return (raw - 2 * FEE_USD * p.qty) * usd();
}

export const intrinsic = (p: Pick<OptionPosition, 'call' | 'strike'>, F: number) => Math.max(0, p.call ? F - p.strike : p.strike - F);

let seq = 0;
const nextId = () => `o${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useOptionsReplay = create<State>()(persist((set, get) => {
  const closeIn = (st: State, pos: OptionPosition, price: number, at: number, reason: OptionTrade['reason']) => {
    const pnl = optionPnlEur(pos, price);
    const { marks: _, ...rest } = pos;
    const trade: OptionTrade = { ...rest, exit: price, closedAt: at, pnl, reason };
    return { balance: st.balance + pnl, positions: st.positions.filter((x) => x.id !== pos.id), history: [trade, ...st.history].slice(0, 500), trade };
  };
  return {
    balance: OPTIONS_CAPITAL,
    positions: [],
    history: [],
    open: (p) => set((st) => ({ positions: [...st.positions, { ...p, id: nextId(), marks: [{ t: p.openedAt, v: p.entry }] }] })),
    close: (id, price, at, reason = 'manuel') => {
      const st = get();
      const pos = st.positions.find((x) => x.id === id);
      if (!pos) return 0;
      const r = closeIn(st, pos, price, at, reason);
      set({ balance: r.balance, positions: r.positions, history: r.history });
      return r.trade.pnl;
    },
    mark: (id, t, v) => set((st) => ({
      positions: st.positions.map((p) => {
        if (p.id !== id) return p;
        const last = p.marks[p.marks.length - 1];
        if (last && last.t >= t) return last.t === t ? { ...p, marks: [...p.marks.slice(0, -1), { t, v }] } : p;
        return { ...p, marks: [...p.marks, { t, v }].slice(-2000) };
      }),
    })),
    settle: (future, F, t) => {
      let st = get();
      const done: OptionTrade[] = [];
      for (const p of st.positions) {
        if (p.future !== future || p.expiry > t) continue;
        const r = closeIn(st, p, intrinsic(p, F), p.expiry, 'échéance');
        st = { ...st, balance: r.balance, positions: r.positions, history: r.history };
        done.push(r.trade);
      }
      if (done.length) set({ balance: st.balance, positions: st.positions, history: st.history });
      return done;
    },
    reset: () => set({ balance: OPTIONS_CAPITAL, positions: [], history: [] }),
  };
}, { name: 'options-replay', version: 1 }));
