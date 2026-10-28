import type { Candle } from '../types';
import { useStore, nextId, type AutoRobot, type PaperPosition, type RobotLegTag } from '../store/store';
import { useChartUi, playAlertSound } from '../store/chartUi';
import { openFeed } from '../data/feeds';
import { Features, toBars } from './features';
import { FILTERS, SIGNALS, STOPS, barsNeeded } from './catalog';
import { EmRobotRun } from './emRunner';
import { DowRobotRun } from './dowRunner';

// Automatic mode: each enabled robot follows its market and timeframe live and
// trades the virtual account like in the lab. On each closed bar it:
// - moves the stops: B (suiveur) to break-even / +(k-1) R at each k R reached and
//   under trailK x ATR; the thirds of C (paliers) to break-even once 1 R is taken,
//   to +1 R once 2 R is taken,
// - closes everything on an opposite signal (and reverses),
// - opens the 3 entries of a new signal at the next bar's open price: A with its
//   fixed stop and target, B with a stop only, C as three thirds aimed at 1, 2, 3 R.
// Stops and targets themselves are filled by the virtual account on live prices.

// bars kept: enough for the robot's filter (a higher timeframe needs many), at most 20 000
const maxBarsOf = (robot: AutoRobot) => Math.min(20_000, barsNeeded(robot.spec.filter, robot.tf));

class RobotRun {
  readonly robot: AutoRobot;
  private off: (() => void) | null = null;
  private candles: Candle[] = [];
  private stopped = false;
  private readonly maxBars: number;
  status = 'Connexion…';

  constructor(robot: AutoRobot) {
    this.robot = robot;
    this.maxBars = maxBarsOf(robot);
  }

  async start() {
    try {
      const { session, candles } = await openFeed(this.robot.symbol, this.robot.tf, { save: false });
      if (this.stopped) return;
      if (session.source === 'sim' || session.source === 'local') { this.status = 'Pas de données en direct pour ce marché'; publish(); return; }
      let all = candles;
      while (all.length < this.maxBars && session.hasMore && !this.stopped) {
        this.status = `Chargement de l’historique (${all.length} / ${this.maxBars} bougies)…`;
        publish();
        const older = await session.loadOlder();
        if (!older.length) break;
        all = [...older, ...all];
      }
      if (this.stopped) return;
      this.candles = all.slice(-this.maxBars);
      this.status = `En veille · ${session.label}`;
      publish();
      this.off = session.subscribe((c) => this.onBar(c));
    } catch (e) {
      this.status = `Erreur : ${e instanceof Error ? e.message : String(e)}`;
      publish();
    }
  }

  stop() {
    this.stopped = true;
    this.off?.();
  }

  private onBar(c: Candle) {
    const k = this.candles;
    const last = k[k.length - 1];
    if (!last || c.time > last.time) {
      k.push(c);
      if (k.length > this.maxBars) k.shift();
      // the previous bar just closed
      if (last) this.onClose();
    } else if (c.time === last.time) k[k.length - 1] = c;
  }

  private positions(): PaperPosition[] {
    return useStore.getState().paper.positions.filter((p) => p.robot?.robotId === this.robot.id);
  }

  private onClose() {
    const k = this.candles;
    if (k.length < 60) return;
    const { spec } = this.robot;
    const b = toBars(k.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]));
    const f = new Features(b);
    const i = b.n - 2;
    const sig = (SIGNALS.find((s) => s.id === spec.signal) ?? SIGNALS[0]).make(f)[i];
    const allow = (FILTERS.find((x) => x.id === spec.filter) ?? FILTERS[0]).make(f);
    const stops = (STOPS.find((x) => x.id === spec.stop) ?? STOPS[0]).make(f, spec.signal);
    const atr = f.atr(14)[i];
    const st = useStore.getState();
    const open = this.positions();

    // manage the open entries on the closed bar
    const legs = new Set(open.map((p) => p.robot!.leg));
    for (const p of open) {
      const t = p.robot!, s = p.side === 'long' ? 1 : -1, R = t.R;
      let sl = p.sl ?? t.entry - s * R;
      if (t.leg === 'B') {
        const reach = s > 0 ? b.h[i] : b.l[i];
        let step = t.step;
        while ((reach - (t.entry + s * step * R)) * s >= 0) {
          const lock = step === 1 ? t.entry : t.entry + s * (step - 1) * R;
          if ((lock - sl) * s > 0) sl = lock;
          step++;
        }
        const trail = b.c[i] - s * spec.trailK * atr;
        if (Number.isFinite(trail) && (trail - sl) * s > 0) sl = trail;
        if (sl !== p.sl || step !== t.step) st.paperModify(p.id, { sl });
        if (step !== t.step) useStore.setState((x) => ({ paper: { ...x.paper, positions: x.paper.positions.map((q) => (q.id === p.id ? { ...q, robot: { ...t, step } } : q)) } }));
      } else if (t.leg === 'C2' || t.leg === 'C3') {
        // a third already taken moves the stop of those left
        const lock = !legs.has('C2') && t.leg === 'C3' ? t.entry + s * R : !legs.has('C1') ? t.entry : null;
        if (lock != null && (lock - sl) * s > 0) st.paperModify(p.id, { sl: lock });
      }
    }

    if (!sig) return;
    const side = sig;
    const openSide = open.length ? (open[0].side === 'long' ? 1 : -1) : 0;
    if (openSide && openSide !== side) {
      // opposite signal: close everything at the new bar's open
      const px = k[k.length - 1].open;
      for (const p of open) st.paperClose(p.id, px, 'robot');
      notify(`${this.robot.name} : signal contraire, positions clôturées`);
    } else if (openSide) return;
    if (spec.dir && side !== spec.dir) return;
    if (side > 0 ? !allow.long[i] : !allow.short[i]) return;
    const R = side > 0 ? stops.long[i] : stops.short[i];
    const entry = k[k.length - 1].open;
    if (!(R > 0) || !(entry > 0)) return;
    const risk = (useStore.getState().paper.balance * this.robot.riskPct) / 100;
    const qty = risk / R;
    const group = nextId();
    const pside = side > 0 ? 'long' : 'short';
    const tag = (leg: RobotLegTag['leg']): RobotLegTag => ({ robotId: this.robot.id, group, leg, R, entry, step: 1 });
    const at = (m: number) => entry + side * m * R;
    const sl = entry - side * R;
    st.paperOpen({ symbol: this.robot.symbol, side: pside, qty, entry, sl, tp: at(spec.tpR), robot: tag('A') });
    st.paperOpen({ symbol: this.robot.symbol, side: pside, qty, entry, sl, robot: tag('B') });
    for (const [m, leg] of [[1, 'C1'], [2, 'C2'], [3, 'C3']] as const) st.paperOpen({ symbol: this.robot.symbol, side: pside, qty: qty / 3, entry, sl, tp: at(m), robot: tag(leg) });
    notify(`${this.robot.name} : ${side > 0 ? 'achat' : 'vente'} ${this.robot.symbol.ticker} à ${entry} (3 entrées de ${this.robot.riskPct} %)`);
  }
}

function notify(text: string) {
  useChartUi.getState().showToast(`🤖 ${text}`);
  playAlertSound();
}

// ---------------------------------------------------------------- manager

const runs = new Map<string, RobotRun | EmRobotRun | DowRobotRun>();
const listeners = new Set<() => void>();
function publish() { for (const l of listeners) l(); }

// status of each running robot, for the Robots tab
export function robotStatus(id: string): string | null {
  return runs.get(id)?.status ?? null;
}
export function onRobotStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// starts / stops runs to match the enabled robots (settings changed: restarted)
export function syncAutoRobots(list: AutoRobot[]) {
  const wanted = new Map(list.filter((r) => r.enabled).map((r) => [r.id, r]));
  for (const [id, run] of runs) {
    const w = wanted.get(id);
    if (!w || JSON.stringify(w) !== JSON.stringify(run.robot)) { run.stop(); runs.delete(id); }
  }
  for (const [id, r] of wanted) {
    if (runs.has(id)) continue;
    // the Expected Move and Dow structure robots have their own runners
    const run = r.kind === 'em' ? new EmRobotRun(r, publish, notify) : r.kind === 'dow' ? new DowRobotRun(r, publish, notify) : new RobotRun(r);
    runs.set(id, run);
    void run.start();
  }
  publish();
}
