import type { Candle } from '../types';
import { useStore, nextId, type AutoRobot, type PaperPosition } from '../store/store';
import { openFeed } from '../data/feeds';
import { nyOffset } from './features';
import { NB_SESSIONS, nbBand, nbDayTrade, nbNoise, nbRuleOf, nbSessionOf, nbSessions, type NbSessionKey } from './noiseBand';
import { LOCALE } from '../i18n/lang';

// The noise-band robot in automatic mode (src/robots/noiseBand.ts, NOT PROVEN): it follows its
// market's 15-minute bars live and trades the virtual account. At each closed bar of the session
// it checks whether that bar is the day's first 30-minute close out of the band; if so it buys
// / sells at the new bar's open, two entries with the same stop: A with its target, B kept to
// the session's end. Whatever is still open when the session ends is closed at its last price.

const KEEP = 4000;
const fmt = (v: number) => (Number.isFinite(v) ? v.toLocaleString(LOCALE, { maximumFractionDigits: v > 500 ? 1 : v > 20 ? 2 : 4 }) : '—');

export class NbRobotRun {
  readonly robot: AutoRobot;
  status = 'Connexion…';
  private readonly publish: () => void;
  private readonly notify: (text: string) => void;
  private readonly key: NbSessionKey;
  private bars: Candle[] = [];
  private offs: (() => void)[] = [];
  private stopped = false;

  constructor(robot: AutoRobot, publish: () => void, notify: (text: string) => void) {
    this.robot = robot;
    this.publish = publish;
    this.notify = notify;
    this.key = nbSessionOf(robot.inputs?.session, robot.symbol.ticker, robot.symbol.category);
  }

  async start() {
    try {
      const m15 = await openFeed(this.robot.symbol, '15m', { save: false });
      if (this.stopped) return;
      if (m15.session.source === 'sim' || m15.session.source === 'local') { this.set(`Pas de données en direct pour ${this.robot.symbol.ticker}`); return; }
      // the noise needs the sessions before: about 6 weeks of bars
      const need = (nbRuleOf(this.robot.inputs).look + 12) * 86400 * 1.5;
      let bars = m15.candles;
      for (let i = 0; i < 40 && bars.length && bars[bars.length - 1].time - bars[0].time < need && m15.session.hasMore && !this.stopped; i++) {
        this.set(`Chargement des bougies 15 min (${bars.length})…`);
        const older = await m15.session.loadOlder();
        if (!older.length) break;
        bars = [...older, ...bars];
      }
      if (this.stopped) return;
      this.bars = bars.slice(-KEEP);
      this.offs.push(m15.session.subscribe((c) => this.onBar(c)));
      this.check(false);
    } catch (e) {
      this.set(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stop() {
    this.stopped = true;
    for (const off of this.offs) off();
  }

  private set(s: string) { this.status = s; this.publish(); }

  private positions(): PaperPosition[] {
    return useStore.getState().paper.positions.filter((p) => p.robot?.robotId === this.robot.id);
  }

  private onBar(c: Candle) {
    const k = this.bars;
    const last = k[k.length - 1];
    if (!last || c.time > last.time) {
      k.push(c);
      if (k.length > KEEP) k.shift();
      if (last) this.check(true);
    } else if (c.time === last.time) k[k.length - 1] = c;
  }

  // the New York day and whether the time is inside the session
  private where(t: number) {
    const def = NB_SESSIONS[this.key];
    const local = t + nyOffset(t), sec = ((local % 86400) + 86400) % 86400;
    return { day: Math.floor(local / 86400), inside: sec >= def.open && sec < def.close };
  }

  // on a new bar (`fresh`: it just opened, the one before just closed)
  private check(fresh: boolean) {
    const k = this.bars, st = useStore.getState();
    if (k.length < 2) return;
    const nb = k[k.length - 1], cb = k[k.length - 2];
    const now = this.where(nb.time), def = NB_SESSIONS[this.key];

    // the session is over (or the positions are from another day): out
    for (const p of this.positions()) {
      const was = this.where(Math.floor(p.openedAt / 1000));
      if (now.inside && was.day === now.day) continue;
      const prev = this.where(cb.time);
      const px = prev.inside && prev.day === was.day ? cb.close : nb.open;
      st.paperClose(p.id, px, 'robot');
      this.notify(`${this.robot.name} : fin de séance, position clôturée à ${fmt(px)}`);
    }
    if (!now.inside) { this.set(`En veille · hors séance (${def.label})`); return; }

    const b = { t: k.map((c) => c.time), o: k.map((c) => c.open), h: k.map((c) => c.high), l: k.map((c) => c.low), c: k.map((c) => c.close), n: k.length };
    const rule = nbRuleOf(this.robot.inputs);
    const se = nbSessions(b, this.key, 900);
    const d = se.days.length - 1, D = se.days[d];
    if (!D || D.date !== now.day) { this.set('En veille · première bougie de la séance attendue'); return; }
    if (D.idx[0] < 0) { this.set('En veille · séance commencée sans sa première bougie'); return; }
    const band = nbBand(b, se, D, nbNoise(b, se, rule.look)[d], rule.k);
    if (!band) { this.set(`En veille · il faut ${rule.look} séances complètes d’historique`); return; }
    const t = nbDayTrade(b, se, D, band, false, rule);
    const j = D.idx.indexOf(k.length - 1);
    const edges = j >= 0 ? `bande ${fmt(band.lo[j])} / ${fmt(band.hi[j])}` : '';
    if (!t) { this.set(`Actif · pas encore de signal · ${edges}`); return; }
    const side = t.side > 0 ? 'achat' : 'vente';
    // only the signal whose entry is this new bar (an earlier one was taken or missed)
    if (!fresh || t.entryBar !== k.length - 1) {
      this.set(this.positions().length ? `En position · ${side} à ${fmt(t.entry)}, stop ${fmt(t.stop)}` : `Signal du jour passé (${side} à ${fmt(t.entry)}) · plus d’entrée aujourd’hui`);
      return;
    }
    const qty = ((st.paper.balance * this.robot.riskPct) / 100) / t.risk;
    const group = nextId();
    const pside = t.side > 0 ? 'long' : 'short';
    st.paperOpen({ symbol: this.robot.symbol, side: pside, qty, entry: t.entry, sl: t.stop, tp: t.target, robot: { robotId: this.robot.id, group, leg: 'A', R: t.risk, entry: t.entry, step: 1 } });
    st.paperOpen({ symbol: this.robot.symbol, side: pside, qty, entry: t.entry, sl: t.stop, robot: { robotId: this.robot.id, group, leg: 'B', R: t.risk, entry: t.entry, step: 1 } });
    this.notify(`${this.robot.name} : ${side} ${this.robot.symbol.ticker} à ${fmt(t.entry)}, stop ${fmt(t.stop)}, objectif A ${fmt(t.target)}, B jusqu’à la fin de séance (robot non prouvé)`);
    this.set(`En position · ${side} à ${fmt(t.entry)}, stop ${fmt(t.stop)}`);
  }
}
