import type { Candle } from '../types';
import { useStore, nextId, type AutoRobot, type PaperPosition } from '../store/store';
import { openFeed } from '../data/feeds';
import { SYMBOLS } from '../data/symbols';
import { familyOf, hhmm, inCashSession, localDay, zoned, type IndexFamily } from '../data/indexFamilies';
import { emLevels, emRegimeOk, emTrades, type EmDay, type EmLevels } from './emRule';
import { LOCALE } from '../i18n/lang';

// The Expected Move robot in automatic mode (src/robots/emRule.ts, NOT PROVEN): it follows its
// future's 15-minute bars live and trades the virtual account. At each closed bar of the cash
// session it checks whether that bar is the first to close beyond the robot's level (calibrated
// on the cash index's daily bars before today, the realized volatility at the open); if so, and
// the VIX at the open is 20 or more, it buys / sells at the new bar's open with its stop and its
// 3 R target, which the virtual account fills on live prices. Whatever is still open when the
// session ends is closed at the session's last price.

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toLocaleString(LOCALE, { maximumFractionDigits: d }) : '—');

export class EmRobotRun {
  readonly robot: AutoRobot;
  status = 'Connexion…';
  private readonly publish: () => void;
  private readonly notify: (text: string) => void;
  private fam: IndexFamily | null;
  private bars: Candle[] = [];
  private daily: Candle[] = [];
  private vix: Candle[] = [];
  private offs: (() => void)[] = [];
  private stopped = false;
  // the session the levels were frozen for
  private day = '';
  private lv: EmLevels | null = null;
  private vixOpen = NaN;

  constructor(robot: AutoRobot, publish: () => void, notify: (text: string) => void) {
    this.robot = robot;
    this.publish = publish;
    this.notify = notify;
    this.fam = familyOf(robot.symbol.ticker)?.family ?? null;
  }

  async start() {
    const f = this.fam;
    const cash = f ? SYMBOLS.find((s) => s.ticker === f.cash) : undefined;
    const vixSym = SYMBOLS.find((s) => s.ticker === 'VIX');
    if (!f || !cash || !vixSym) { this.set('Marché non pris en charge par ce robot'); return; }
    try {
      const [m15, d1, vx] = await Promise.all([
        openFeed(this.robot.symbol, '15m', { save: false }),
        openFeed(cash, '1D', { save: false }),
        openFeed(vixSym, '1D', { save: false }),
      ]);
      if (this.stopped) return;
      if (m15.session.source === 'sim' || m15.session.source === 'local') { this.set(`Pas de données en direct pour ${this.robot.symbol.ticker}`); return; }
      // the calibration: 120 sessions after 21 for the volatility, with some room
      let days = d1.candles;
      while (days.length < 200 && d1.session.hasMore && !this.stopped) {
        this.set(`Chargement du ${f.cash} journalier (${days.length} / 200)…`);
        const older = await d1.session.loadOlder();
        if (!older.length) break;
        days = [...older, ...days];
      }
      if (this.stopped) return;
      this.daily = days;
      this.vix = vx.candles;
      this.bars = m15.candles.slice(-300);
      const merge = (list: Candle[], c: Candle) => {
        const last = list[list.length - 1];
        if (!last || c.time > last.time) list.push(c); else if (c.time === last.time) list[list.length - 1] = c;
      };
      this.offs.push(d1.session.subscribe((c) => merge(this.daily, c)));
      this.offs.push(vx.session.subscribe((c) => merge(this.vix, c)));
      this.offs.push(m15.session.subscribe((c) => this.onBar(c)));
      this.refreshStatus();
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
      if (k.length > 300) k.shift();
      if (last) this.onClose();
    } else if (c.time === last.time) k[k.length - 1] = c;
  }

  // the VIX at the session's open: its own open for the US sessions, else the last close before
  private vixAt(day: string): number {
    const us = this.fam!.tz === 'America/New_York';
    if (us) { const b = this.vix.find((x) => iso(x.time) === day); if (b && b.open > 0) return b.open; }
    for (let i = this.vix.length - 1; i >= 0; i--) if (iso(this.vix[i].time) < day) return this.vix[i].close;
    return NaN;
  }

  // freezes the levels of the session `day`, opening at `open`
  private freeze(day: string, open: number) {
    if (this.day === day) return;
    this.day = day;
    const hist: EmDay[] = this.daily.filter((x) => iso(x.time) < day).map((x) => ({ day: iso(x.time), o: x.open, h: x.high, l: x.low, c: x.close, full: true }));
    this.lv = emLevels(hist, open);
    this.vixOpen = this.vixAt(day);
  }

  private refreshStatus() {
    const f = this.fam!, now = Math.floor(Date.now() / 1000);
    if (!inCashSession(f, now)) { this.set(`En veille · hors séance cash (${f.open} – ${f.close}, heure locale)`); return; }
    if (!this.lv) { this.set('En veille · niveaux pas encore calculés (première bougie de la séance attendue)'); return; }
    const ok = emRegimeOk(this.vixOpen);
    this.set(ok
      ? `Actif · VIX ${fmt(this.vixOpen, 1)} · niveaux ${fmt(this.lv.up)} / ${fmt(this.lv.dn)}`
      : `Pas de trade aujourd’hui · VIX ${fmt(this.vixOpen, 1)} < 20`);
  }

  private onClose() {
    const f = this.fam!, k = this.bars, st = useStore.getState();
    const nb = k[k.length - 1], cb = k[k.length - 2];
    const inS = (c: Candle) => inCashSession(f, c.time);
    const nbDay = localDay(f, nb.time);

    // the session is over (or the positions are from another day): out
    for (const p of this.positions()) {
      const pDay = localDay(f, Math.floor(p.openedAt / 1000));
      if (inS(nb) && pDay === nbDay) continue;
      const px = inS(cb) && localDay(f, cb.time) === pDay ? cb.close : nb.open;
      st.paperClose(p.id, px, 'robot');
      this.notify(`${this.robot.name} : fin de séance, position clôturée à ${fmt(px)}`);
    }

    // entries: on a new bar of the same session as the bar that just closed
    if (!inS(nb) || !inS(cb) || localDay(f, cb.time) !== nbDay) { this.refreshStatus(); return; }
    let first = k.length - 1;
    while (first > 0 && inS(k[first - 1]) && localDay(f, k[first - 1].time) === nbDay) first--;
    if (zoned(k[first].time, f.tz).minutes !== hhmm(f.open)) { this.set('En veille · séance commencée sans sa première bougie'); return; }
    const sess = k.slice(first);
    this.freeze(nbDay, sess[0].open);
    this.refreshStatus();
    if (!this.lv || !emRegimeOk(this.vixOpen)) return;
    const bars = { t: sess.map((x) => x.time), o: sess.map((x) => x.open), h: sess.map((x) => x.high), l: sess.map((x) => x.low), c: sess.map((x) => x.close) };
    for (const t of emTrades(bars, this.lv, false)) {
      // only the trade whose entry is this new bar (an earlier trigger was missed or already taken)
      if (t.entryIdx !== sess.length - 1) continue;
      const risk = Math.abs(t.entry - t.stop);
      const qty = ((st.paper.balance * this.robot.riskPct) / 100) / risk;
      const side = t.side > 0 ? 'long' : 'short';
      st.paperOpen({
        symbol: this.robot.symbol, side, qty, entry: t.entry, sl: t.stop, tp: t.target,
        robot: { robotId: this.robot.id, group: nextId(), leg: 'A', R: risk, entry: t.entry, step: 1 },
      });
      this.notify(`${this.robot.name} : ${t.side > 0 ? 'achat' : 'vente'} ${this.robot.symbol.ticker} à ${fmt(t.entry)}, stop ${fmt(t.stop)}, objectif ${fmt(t.target)} (robot non prouvé)`);
    }
  }
}
