import type { Candle, IndicatorConfig } from '../types';
import { useStore, nextId, type AutoRobot, type PaperOrder, type PaperPosition } from '../store/store';
import { openFeed } from '../data/feeds';
import { dowParams } from '../indicators/custom/dowStructure';
import { atr14 } from './dow';
import { dowRobotRun } from './dowBacktest';
import { LOCALE } from '../i18n/lang';

// A Dow structure robot in automatic mode (src/robots/dowBacktest.ts): it follows its market live
// and trades the virtual account. At each closed bar the engine runs on the bars so far:
// - a box waiting for the price (a break of structure, trend on its side, not used yet): a limit
//   order at the box's edge with its stop beyond the box (+ 0.1 ATR), moved when the box changes,
//   cancelled when it dies, as the engine's entry "on contact" during a bar;
// - an entry on a close (a liquidity sweep, a rejection candle): bought / sold at the new bar's
//   open;
// - the structure turning against the position: closed at the new bar's open. Stops and targets
//   are filled by the virtual account on live prices.

const fmt = (v: number) => (Number.isFinite(v) ? v.toLocaleString(LOCALE, { maximumSignificantDigits: 6 }) : '—');

export class DowRobotRun {
  readonly robot: AutoRobot;
  status = 'Connexion…';
  private readonly publish: () => void;
  private readonly notify: (text: string) => void;
  private readonly cfg: IndicatorConfig;
  private bars: Candle[] = [];
  private off: (() => void) | null = null;
  private stopped = false;

  constructor(robot: AutoRobot, publish: () => void, notify: (text: string) => void) {
    this.robot = robot;
    this.publish = publish;
    this.notify = notify;
    this.cfg = { id: robot.id, type: 'DOW_STRUCTURE', period: 0, color: '#2962ff', overlay: true, visible: true, inputs: robot.inputs ?? {} };
  }

  async start() {
    try {
      const { session, candles } = await openFeed(this.robot.symbol, this.robot.tf, { save: false });
      if (this.stopped) return;
      if (session.source === 'sim' || session.source === 'local') { this.set(`Pas de données en direct pour ${this.robot.symbol.ticker}`); return; }
      // enough bars for the structure (swings, legs, the ATR)
      let all = candles;
      while (all.length < 600 && session.hasMore && !this.stopped) {
        this.set(`Chargement de l’historique (${all.length} / 600 bougies)…`);
        const older = await session.loadOlder();
        if (!older.length) break;
        all = [...older, ...all];
      }
      if (this.stopped) return;
      this.bars = all.slice(-1500);
      this.set(`En veille · ${session.label}`);
      this.off = session.subscribe((c) => this.onBar(c));
      this.step(false);
    } catch (e) {
      this.set(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stop() {
    this.stopped = true;
    this.off?.();
    // its pending order goes with it
    const st = useStore.getState();
    for (const o of this.orders()) st.paperCancelOrder(o.id);
  }

  private set(s: string) { this.status = s; this.publish(); }
  private positions(): PaperPosition[] { return useStore.getState().paper.positions.filter((p) => p.robot?.robotId === this.robot.id); }
  private orders(): PaperOrder[] { return useStore.getState().paper.orders.filter((o) => o.robot?.robotId === this.robot.id); }

  private onBar(c: Candle) {
    const k = this.bars;
    const last = k[k.length - 1];
    if (!last || c.time > last.time) {
      k.push(c);
      if (k.length > 1500) k.shift();
      if (last) this.step(true);
    } else if (c.time === last.time) k[k.length - 1] = c;
  }

  // the engine on the closed bars; `fresh`: a bar just closed (entries and exits at the new open)
  private step(fresh: boolean) {
    const k = this.bars;
    if (k.length < 100) return;
    const closed = k.slice(0, -1), now = k[k.length - 1];
    const b = { n: closed.length, t: closed.map((x) => x.time), o: closed.map((x) => x.open), h: closed.map((x) => x.high), l: closed.map((x) => x.low), c: closed.map((x) => x.close) };
    const res = dowRobotRun(b, this.cfg, true);
    const last = b.n - 1;
    const p = dowParams(this.cfg);
    const st = useStore.getState();
    const mine = this.positions();
    const eng = res.open;

    // the positions: kept while the engine still holds one on their side, else out
    for (const pos of mine) {
      const up = pos.side === 'long';
      if (eng && eng.up === up) {
        if (Number.isFinite(eng.stop) && eng.stop !== pos.sl) st.paperModify(pos.id, { sl: eng.stop });
        continue;
      }
      if (!fresh) continue;
      st.paperClose(pos.id, now.open, 'robot');
      this.notify(`${this.robot.name} : structure retournée, position clôturée à ${fmt(now.open)}`);
    }

    // an entry the engine took on the close of the bar (sweep, rejection): at the new open
    if (fresh && eng && eng.idx === last && !this.positions().length && Math.abs(eng.entry - b.c[last]) < 1e-9) {
      this.open(eng.up, now.open, eng.stop, eng.target);
    }

    // the box waiting for the price: a limit order at its edge
    const z = res.zones[res.zones.length - 1];
    const trend = res.trend[last];
    const waiting = !eng && !this.positions().length && p.mode === 'box' && p.entry === 'contact' && z && !z.used && !z.dead
      && trend === (z.up ? 1 : -1) && (p.dir === 0 || p.dir === (z.up ? 1 : -1)) && !(p.maxAge > 0 && last - z.start >= p.maxAge);
    let want: { up: boolean; price: number; sl: number; tp?: number } | null = null;
    if (waiting) {
      const pad = p.pad * atr14(b)[last];
      const price = z.up ? z.top : z.bottom, sl = z.up ? z.bottom - pad : z.top + pad;
      const risk = Math.abs(price - sl);
      if (risk > 0 && !(p.maxCostR > 0 && (2 * p.cost * price) / risk > p.maxCostR)) {
        want = { up: z.up, price, sl, ...(p.target === 'fixed' ? { tp: price + (z.up ? 1 : -1) * p.targetR * risk } : {}) };
      }
    }
    const have = this.orders();
    const same = (o: PaperOrder) => want && o.side === (want.up ? 'long' : 'short') && Math.abs(o.price - want.price) < 1e-9 && Math.abs((o.sl ?? 0) - want.sl) <= Math.abs(want.price - want.sl) * 0.02;
    for (const o of have) if (!same(o)) st.paperCancelOrder(o.id);
    if (want && !have.some(same)) {
      const risk = Math.abs(want.price - want.sl);
      const qty = ((st.paper.balance * this.robot.riskPct) / 100) / risk;
      st.paperPlaceOrder({
        symbol: this.robot.symbol, side: want.up ? 'long' : 'short', qty, type: 'limit', price: want.price, sl: want.sl, ...(want.tp ? { tp: want.tp } : {}),
        robot: { robotId: this.robot.id, group: nextId(), leg: 'A', R: risk, entry: want.price, step: 1 },
      });
    }

    const pos = this.positions()[0];
    this.set(pos
      ? `En position · ${pos.side === 'long' ? 'achat' : 'vente'} à ${fmt(pos.entry)}, stop ${fmt(pos.sl ?? NaN)}`
      : want ? `Ordre limite · ${want.up ? 'achat' : 'vente'} à ${fmt(want.price)}, stop ${fmt(want.sl)}`
        : `En veille · tendance ${trend > 0 ? 'haussière' : trend < 0 ? 'baissière' : 'indécise'}, pas de boîte à jouer`);
  }

  private open(up: boolean, entry: number, stop: number, target: number) {
    const st = useStore.getState();
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || (up ? stop >= entry : stop <= entry)) return;
    const qty = ((st.paper.balance * this.robot.riskPct) / 100) / risk;
    st.paperOpen({
      symbol: this.robot.symbol, side: up ? 'long' : 'short', qty, entry, sl: stop, ...(Number.isFinite(target) ? { tp: target } : {}),
      robot: { robotId: this.robot.id, group: nextId(), leg: 'A', R: risk, entry, step: 1 },
    });
    this.notify(`${this.robot.name} : ${up ? 'achat' : 'vente'} ${this.robot.symbol.ticker} à ${fmt(entry)}, stop ${fmt(stop)}`);
  }
}
