import type { PaperOrder, PaperSide } from '../store/store';

// An order drawn on the chart and not sent yet. `rule` is set when it comes from
// the order ticket in limit or stop mode: the entry then decides the side (a
// limit above the price sells and below it buys, a stop the other way round).
export type OrderDraft = { side: PaperSide; entry: number; sl: number; tp: number; rule?: 'limit' | 'stop' };

export const sideSign = (side: PaperSide) => (side === 'long' ? 1 : -1);

// a limit order waits for a better price, a stop order for a breakout
export function orderType(side: PaperSide, entry: number, last: number | null): PaperOrder['type'] {
  if (last == null) return 'limit';
  return side === 'long' ? (entry <= last ? 'limit' : 'stop') : (entry >= last ? 'limit' : 'stop');
}

// the side a limit or stop order takes at this price
export function sideFor(rule: 'limit' | 'stop', price: number, last: number | null, fallback: PaperSide): PaperSide {
  if (last == null) return fallback;
  const above = price >= last;
  return rule === 'limit' ? (above ? 'short' : 'long') : (above ? 'long' : 'short');
}

// same stop and target distances, on the given side of the entry
export function relay(d: OrderDraft, side: PaperSide, entry: number, round: (v: number) => number): OrderDraft {
  const risk = Math.abs(d.entry - d.sl);
  const reward = Math.abs(d.tp - d.entry);
  const s = sideSign(side);
  return { ...d, side, entry, sl: round(entry - s * risk), tp: round(entry + s * reward) };
}

// the entry moved: with a rule the side follows the price, the stop and target keep their distances
export function moveEntry(d: OrderDraft, entry: number, last: number | null, round: (v: number) => number): OrderDraft {
  return relay(d, d.rule ? sideFor(d.rule, entry, last, d.side) : d.side, entry, round);
}

// a new order: stop 1 % away, target at 2 R
export function newDraft(side: PaperSide, entry: number, round: (v: number) => number, rule?: 'limit' | 'stop'): OrderDraft {
  const sl = round(entry * (1 - sideSign(side) * 0.01));
  return { side, entry, sl, tp: round(entry + 2 * (entry - sl)), rule };
}
