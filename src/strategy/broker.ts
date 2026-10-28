import type { Candle } from '../types';
import type { BrokerSettings, ExitReason, Side, Trade } from './types';

// Order simulator shared by the assisted strategies and the Pine strategy scripts,
// modelled on TradingView's broker emulator:
// - market orders sent on a bar's close are filled at the next bar's open
//   (or at that close with `fillOnClose`),
// - stops / targets / stop and limit entries are checked inside each bar along
//   the path open -> nearest extreme -> other extreme -> close,
// - one position at a time: an entry in the other direction reverses it.

export type EntryOrder = {
  id: string;
  side: Side;
  qty?: number;
  // stop / limit entry prices (Pine strategy.entry(stop=, limit=)); none = market
  stopPrice?: number;
  limitPrice?: number;
  comment?: string;
};

// exit bracket of an entry: absolute prices or distances from the fill price
export type ExitOrder = {
  id: string;
  fromEntry: string;
  stop?: number;
  limit?: number;
  stopOffset?: number;
  limitOffset?: number;
  comment?: string;
};

type Position = {
  side: Side;
  qty: number;
  entryPrice: number;
  entryBar: number;
  entryTime: number;
  entryId: string;
  entryLabel: string;
  stop: number | null;
  limit: number | null;
  exitLabel: string | null;
  best: number;
  worst: number;
  commissionIn: number;
};

const dirOf = (side: Side) => (side === 'long' ? 1 : -1);

export class Broker {
  readonly trades: Trade[] = [];
  readonly equity: number[] = [];
  readonly position: number[] = [];
  readonly warnings = new Set<string>();
  private readonly k: Candle[];
  private readonly s: BrokerSettings;
  private cash: number;
  private pos: Position | null = null;
  private entries: EntryOrder[] = [];
  private closeReq: { id: string | null; comment: string } | null = null;
  // exit brackets by entry id ('' = every entry)
  private exits = new Map<string, ExitOrder>();
  private i = -1;
  private seq = 1;

  constructor(candles: Candle[], settings: BrokerSettings) {
    this.k = candles;
    this.s = settings;
    this.cash = settings.initialCapital;
  }

  // ---------------------------------------------------------------- bar cycle

  // before the strategy is evaluated on bar i: fills at the open, then intrabar
  beginBar(i: number) {
    this.i = i;
    const c = this.k[i];
    if (!this.s.fillOnClose) this.executeMarket(c.open);
    this.intrabar(c);
  }

  // after the evaluation of bar i: orders filled on the close, then the bar's equity
  endBar(i: number) {
    const c = this.k[i];
    if (this.s.fillOnClose) this.executeMarket(c.close);
    this.equity[i] = this.equityAt(c.close);
    this.position[i] = this.positionSize;
  }

  // the position still open after the last bar, valued at its close
  openTrade(): Trade | null {
    const p = this.pos;
    if (!p) return null;
    const last = this.k.length - 1;
    return this.makeTrade(p, this.k[last].close, last, 'end', 'Ouverte', this.commission(p.qty, this.k[last].close));
  }

  // ---------------------------------------------------------------- orders

  entry(o: EntryOrder) {
    // one order per id: a new call replaces the pending one
    this.entries = this.entries.filter((x) => x.id !== o.id);
    if (o.stopPrice == null && o.limitPrice == null && this.pos?.side === o.side) return;
    this.entries.push(o);
  }

  exit(o: ExitOrder) {
    this.exits.set(o.fromEntry, o);
    // an exit sent while its position is open updates the bracket at once (trailing stops)
    if (this.pos && (o.fromEntry === '' || o.fromEntry === this.pos.entryId)) this.applyBracket(this.pos, o);
  }

  close(id: string | null, comment = '') {
    if (!this.pos || (id != null && id !== this.pos.entryId)) return;
    this.closeReq = { id, comment };
  }

  cancel(id: string | null) {
    this.entries = id == null ? [] : this.entries.filter((o) => o.id !== id);
    if (id == null) this.exits.clear(); else for (const [k, v] of this.exits) if (v.id === id) this.exits.delete(k);
  }

  // ---------------------------------------------------------------- state

  get bar() { return this.i; }
  get positionSize() { return this.pos ? dirOf(this.pos.side) * this.pos.qty : 0; }
  get positionSide(): Side | null { return this.pos?.side ?? null; }
  get avgPrice() { return this.pos ? this.pos.entryPrice : NaN; }
  get entryId() { return this.pos?.entryId ?? null; }
  get initialCapital() { return this.s.initialCapital; }
  get netProfit() { return this.cash - this.s.initialCapital + (this.pos?.commissionIn ?? 0); }
  get grossProfit() { return this.trades.reduce((s, t) => s + Math.max(0, t.pnl), 0); }
  get grossLoss() { return this.trades.reduce((s, t) => s + Math.min(0, t.pnl), 0); }
  get wins() { return this.trades.filter((t) => t.pnl > 0).length; }
  get losses() { return this.trades.filter((t) => t.pnl < 0).length; }
  // valued at the current bar's close
  get equityNow() { return this.i >= 0 ? this.equityAt(this.k[this.i].close) : this.s.initialCapital; }
  get openProfit() { return this.i >= 0 && this.pos ? this.openPnl(this.k[this.i].close) : 0; }

  private openPnl(price: number) {
    const p = this.pos;
    return p ? (price - p.entryPrice) * dirOf(p.side) * p.qty : 0;
  }

  private equityAt(price: number) {
    return this.cash + this.openPnl(price);
  }

  // ---------------------------------------------------------------- fills

  private commission(qty: number, price: number) {
    const v = this.s.commissionValue;
    if (!v) return 0;
    if (this.s.commissionType === 'percent') return (qty * price * v) / 100;
    if (this.s.commissionType === 'per_contract') return qty * v;
    return v;
  }

  // market orders: pending close first, then the entries
  private executeMarket(price: number) {
    if (this.closeReq && this.pos) this.closePosition(price, 'signal', this.closeReq.comment || 'Clôture');
    this.closeReq = null;
    const market = this.entries.filter((o) => o.stopPrice == null && o.limitPrice == null);
    if (!market.length) return;
    this.entries = this.entries.filter((o) => o.stopPrice != null || o.limitPrice != null);
    for (const o of market) this.fillEntry(o, price);
  }

  private defaultQty(price: number) {
    const eq = this.cash;
    switch (this.s.qtyMode) {
      case 'percent': return (eq * this.s.qtyValue) / 100 / price;
      case 'cash': return this.s.qtyValue / price;
      default: return this.s.qtyValue;
    }
  }

  private fillEntry(o: EntryOrder, price: number) {
    if (this.pos) {
      // same direction: no pyramiding
      if (this.pos.side === o.side) return;
      this.closePosition(price, 'reverse', o.comment || o.id);
    }
    const qty = o.qty ?? this.defaultQty(price);
    if (!(qty > 0) || !Number.isFinite(qty)) {
      this.warnings.add('Ordre ignoré : quantité nulle ou invalide.');
      return;
    }
    const commissionIn = this.commission(qty, price);
    this.cash -= commissionIn;
    const c = this.k[this.i];
    this.pos = {
      side: o.side, qty, entryPrice: price, entryBar: this.i, entryTime: c.time, entryId: o.id,
      entryLabel: o.comment || o.id, stop: null, limit: null, exitLabel: null, best: price, worst: price, commissionIn,
    };
    const ex = this.exits.get(o.id) ?? this.exits.get('');
    if (ex) this.applyBracket(this.pos, ex);
    // a bracket already on the wrong side of the fill (gap) closes the position at once
    const dir = dirOf(o.side);
    if (this.pos.stop != null && (this.pos.stop - price) * dir >= 0) this.closePosition(price, 'stop', this.pos.exitLabel ?? 'Stop');
    else if (this.pos.limit != null && (this.pos.limit - price) * dir <= 0) this.closePosition(price, 'target', this.pos.exitLabel ?? 'Objectif');
  }

  private applyBracket(p: Position, ex: ExitOrder) {
    const dir = dirOf(p.side);
    p.stop = ex.stop ?? (ex.stopOffset != null ? p.entryPrice - dir * ex.stopOffset : null);
    p.limit = ex.limit ?? (ex.limitOffset != null ? p.entryPrice + dir * ex.limitOffset : null);
    if (p.stop != null && !Number.isFinite(p.stop)) p.stop = null;
    if (p.limit != null && !Number.isFinite(p.limit)) p.limit = null;
    p.exitLabel = ex.comment || null;
  }

  private makeTrade(p: Position, price: number, bar: number, reason: ExitReason, label: string, commissionOut: number): Trade {
    const dir = dirOf(p.side);
    const gross = (price - p.entryPrice) * dir * p.qty;
    return {
      id: this.seq, side: p.side, qty: p.qty,
      entryBar: p.entryBar, entryTime: p.entryTime, entryPrice: p.entryPrice, entryLabel: p.entryLabel,
      exitBar: bar, exitTime: this.k[bar].time, exitPrice: price, exitLabel: label, exitReason: reason,
      pnl: gross - p.commissionIn - commissionOut,
      pricePct: ((price - p.entryPrice) / p.entryPrice) * 100 * dir,
      unitGain: (price - p.entryPrice) * dir,
      bars: bar - p.entryBar,
      // (+ 0 turns a -0 into 0)
      mfe: Math.max(0, (p.best - p.entryPrice) * dir * p.qty) + 0,
      mae: Math.min(0, (p.worst - p.entryPrice) * dir * p.qty) + 0,
      commission: p.commissionIn + commissionOut,
    };
  }

  private closePosition(price: number, reason: ExitReason, label: string) {
    const p = this.pos;
    if (!p) return;
    this.track(price);
    const commissionOut = this.commission(p.qty, price);
    this.cash += (price - p.entryPrice) * dirOf(p.side) * p.qty - commissionOut;
    this.trades.push(this.makeTrade(p, price, this.i, reason, label, commissionOut));
    this.seq++;
    this.pos = null;
    this.exits.delete(p.entryId);
    this.exits.delete('');
  }

  // best / worst price reached while in position
  private track(price: number) {
    const p = this.pos;
    if (!p) return;
    const dir = dirOf(p.side);
    if ((price - p.best) * dir > 0) p.best = price;
    if ((price - p.worst) * dir < 0) p.worst = price;
  }

  // ---------------------------------------------------------------- intrabar

  // TradingView's assumption: the bar goes first to the extreme nearest its open
  private intrabar(c: Candle) {
    const path = Math.abs(c.high - c.open) <= Math.abs(c.open - c.low)
      ? [c.open, c.high, c.low, c.close]
      : [c.open, c.low, c.high, c.close];
    // gaps: levels already passed at the open fill at the open
    this.atPrice(path[0]);
    for (let s = 1; s < path.length; s++) this.walk(path[s - 1], path[s]);
  }

  private atPrice(price: number) {
    const p = this.pos;
    if (p) {
      const dir = dirOf(p.side);
      if (p.stop != null && (price - p.stop) * dir <= 0) { this.closePosition(price, 'stop', p.exitLabel ?? 'Stop'); }
      else if (p.limit != null && (price - p.limit) * dir >= 0) { this.closePosition(price, 'target', p.exitLabel ?? 'Objectif'); }
    }
    for (const o of [...this.entries]) {
      if (this.triggered(o, price, price)) { this.entries = this.entries.filter((x) => x !== o); this.fillEntry(o, price); }
    }
    this.track(price);
  }

  // is a stop / limit entry reached on the move a -> b
  private triggered(o: EntryOrder, a: number, b: number) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const buy = o.side === 'long';
    if (o.stopPrice != null) return buy ? hi >= o.stopPrice : lo <= o.stopPrice;
    if (o.limitPrice != null) return buy ? lo <= o.limitPrice : hi >= o.limitPrice;
    return false;
  }

  // along one leg of the bar: fill whatever level is reached first, then continue
  private walk(a: number, b: number) {
    let from = a;
    for (let guard = 0; guard < 8; guard++) {
      const up = b >= from;
      const events: { at: number; run: () => void }[] = [];
      const reach = (level: number) => (up ? level >= from && level <= b : level <= from && level >= b);
      const p = this.pos;
      if (p) {
        const dir = dirOf(p.side);
        // a long's stop is hit going down, its target going up (and the reverse for a short)
        if (p.stop != null && (up ? dir < 0 : dir > 0) && reach(p.stop)) {
          const lvl = p.stop;
          events.push({ at: Math.abs(lvl - from), run: () => this.closePosition(lvl, 'stop', p.exitLabel ?? 'Stop') });
        }
        if (p.limit != null && (up ? dir > 0 : dir < 0) && reach(p.limit)) {
          const lvl = p.limit;
          events.push({ at: Math.abs(lvl - from), run: () => this.closePosition(lvl, 'target', p.exitLabel ?? 'Objectif') });
        }
      }
      for (const o of this.entries) {
        const lvl = o.stopPrice ?? o.limitPrice;
        if (lvl == null || !reach(lvl)) continue;
        const buy = o.side === 'long';
        const fires = o.stopPrice != null ? (buy ? up : !up) : (buy ? !up : up);
        if (fires) events.push({ at: Math.abs(lvl - from), run: () => { this.entries = this.entries.filter((x) => x !== o); this.fillEntry(o, lvl); } });
      }
      if (!events.length) break;
      events.sort((x, y) => x.at - y.at);
      const next = events[0];
      next.run();
      from = up ? from + next.at : from - next.at;
      this.track(from);
    }
    this.track(b);
  }
}
