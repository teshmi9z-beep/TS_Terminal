import type { Candle, Symbol, TechAlert, Timeframe, WatchlistTab } from '../types';
import { useStore } from '../store/store';
import { useChartUi, playAlertSound } from '../store/chartUi';
import { openFeed, type FeedSession } from '../data/feeds';
import { getIndicatorDef } from '../indicators/registry';
import { computeWithSources } from '../indicators/derived';
import { alertMet, alertSummary, barsNeeded, valueReader } from './evaluate';

// Alerts on indicators, live: one feed per (symbol, timeframe) the active alerts need, shared by
// them. Each new price recomputes the indicators of each alert on that feed (at most once a
// second) and checks its conditions on the forming bar; "à la clôture" alerts are checked once,
// on the bar that just closed. Runs in the main window while the platform is open.

// a watchlist alert follows this many symbols at most
export const WATCHLIST_MAX = 60;

class AlertFeed {
  readonly symbol: Symbol;
  readonly tf: Timeframe;
  ids = new Set<string>();
  need = 500;
  ok = false;
  status = 'connexion…';
  private session: FeedSession | null = null;
  private candles: Candle[] = [];
  private off: (() => void) | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastLive = 0;
  // the bar each alert last went off on: at most once per bar
  private firedOn = new Map<string, number>();

  constructor(symbol: Symbol, tf: Timeframe) {
    this.symbol = symbol;
    this.tf = tf;
  }

  async start() {
    try {
      const { session, candles } = await openFeed(this.symbol, this.tf, { save: false });
      if (this.stopped) return;
      if (session.source === 'sim' || session.source === 'local') { this.status = 'pas de prix en direct pour ce marché'; publish(); return; }
      this.session = session;
      this.candles = candles;
      this.status = 'chargement de l’historique…';
      publish();
      await this.fill();
      if (this.stopped) return;
      this.ok = true;
      this.status = `en veille · ${session.label}`;
      publish();
      this.off = session.subscribe((c) => this.onBar(c));
    } catch (e) {
      this.status = `erreur : ${e instanceof Error ? e.message : String(e)}`;
      publish();
    }
  }

  // older pages until the indicators have enough bars to settle
  async fill() {
    const s = this.session;
    while (s && this.candles.length < this.need && s.hasMore && !this.stopped) {
      const older = await s.loadOlder().catch(() => []);
      if (!older.length) break;
      const first = this.candles[0]?.time ?? Infinity;
      this.candles = [...older.filter((c) => c.time < first), ...this.candles];
    }
  }

  stop() {
    this.stopped = true;
    this.off?.();
    if (this.timer) clearTimeout(this.timer);
  }

  private onBar(c: Candle) {
    const k = this.candles;
    const last = k[k.length - 1];
    if (!last || c.time > last.time) {
      k.push(c);
      const keep = Math.max(this.need, 1000) * 2;
      if (k.length > keep) k.splice(0, k.length - keep);
      // the bar before just closed
      if (last) this.check(true);
    } else if (c.time === last.time) k[k.length - 1] = c;
    else return;
    // at most once a second, checked when the price comes in: a hidden window slows its timers
    // down (to once a minute after a while), not the prices it receives
    const now = Date.now();
    if (now - this.lastLive >= 1000) {
      this.lastLive = now;
      this.check(false);
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.lastLive = Date.now(); this.check(false); }, 1000 - (now - this.lastLive));
    }
  }

  // closed: the bar that just closed (the one before the last); else the bar still forming
  private check(closed: boolean) {
    const k = this.candles;
    const i = closed ? k.length - 2 : k.length - 1;
    if (i < 1 || this.stopped) return;
    const bar = k[i].time;
    for (const id of this.ids) {
      const a = useStore.getState().techAlerts.find((x) => x.id === id);
      if (!a || !a.active) continue;
      if (a.expires && Date.now() > a.expires) { expire(a); continue; }
      if ((a.trigger === 'close') !== closed || this.firedOn.get(id) === bar) continue;
      // already gone off on this bar before the page was reloaded
      if (!closed && a.target.kind === 'symbol' && a.lastFired && a.lastFired >= bar * 1000) continue;
      let met = false;
      try {
        met = alertMet(a, i, valueReader(k, computeWithSources(a.indicators, k, getIndicatorDef)));
      } catch { /* an indicator failing on these bars: no alert */ }
      if (!met) continue;
      this.firedOn.set(id, bar);
      fire(a, this.symbol.ticker);
    }
  }
}

export function desktopNotify(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/favicon.svg' });
  } catch { /* notifications unavailable */ }
}

function fire(a: TechAlert, ticker: string) {
  const st = useStore.getState();
  const cur = st.techAlerts.find((x) => x.id === a.id) ?? a;
  const now = Date.now();
  st.updateTechAlert(a.id, { fired: cur.fired + 1, lastFired: now, ...(a.trigger === 'once' ? { active: false } : {}) });
  const text = a.message?.trim() || alertSummary(a);
  st.logAlert({ alertId: a.id, time: now, ticker, text: text === a.name ? text : `${a.name} : ${text}` });
  useChartUi.getState().showToast(`🔔 ${ticker} · ${a.name}`);
  playAlertSound();
  if (a.desktop) desktopNotify(`${ticker} · ${a.name}`, text);
}

function expire(a: TechAlert) {
  const st = useStore.getState();
  if (!st.techAlerts.find((x) => x.id === a.id)?.active) return;
  st.updateTechAlert(a.id, { active: false });
  st.logAlert({ alertId: a.id, time: Date.now(), ticker: '', text: `${a.name} : expirée` });
}

// ---------------------------------------------------------------- manager

const feeds = new Map<string, AlertFeed>();
const listeners = new Set<() => void>();
function publish() { for (const l of listeners) l(); }

export function onAlertStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function alertSymbols(a: Pick<TechAlert, 'target'>, watchlists: WatchlistTab[]): Symbol[] {
  if (a.target.kind === 'symbol') return [a.target.symbol];
  const id = a.target.watchlistId;
  const out = new Map<string, Symbol>();
  for (const r of watchlists.find((t) => t.id === id)?.items ?? []) if (r.kind === 'asset' && !out.has(r.data.ticker)) out.set(r.data.ticker, r.data);
  return [...out.values()].slice(0, WATCHLIST_MAX);
}

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

// starts / stops feeds to match the active alerts (a watchlist alert: its symbols now)
export function syncAlerts(alerts: TechAlert[], watchlists: WatchlistTab[]) {
  const now = Date.now();
  const wanted = new Map<string, { symbol: Symbol; tf: Timeframe; ids: Set<string>; need: number }>();
  for (const a of alerts) {
    if (!a.active) continue;
    if (a.expires && a.expires <= now) { expire(a); continue; }
    for (const s of alertSymbols(a, watchlists)) {
      const key = `${s.ticker}|${a.tf}`;
      const w = wanted.get(key) ?? { symbol: s, tf: a.tf, ids: new Set<string>(), need: 0 };
      w.ids.add(a.id);
      w.need = Math.max(w.need, barsNeeded(a));
      wanted.set(key, w);
    }
  }
  for (const [key, f] of feeds) if (!wanted.has(key)) { f.stop(); feeds.delete(key); }
  for (const [key, w] of wanted) {
    const f = feeds.get(key);
    if (f) {
      f.ids = w.ids;
      if (w.need > f.need) { f.need = w.need; void f.fill(); }
      continue;
    }
    const nf = new AlertFeed(w.symbol, w.tf);
    nf.ids = w.ids;
    nf.need = w.need;
    feeds.set(key, nf);
    void nf.start();
  }
  // the next expiry stops its alert even if no price comes
  clearTimeout(expiryTimer);
  const next = Math.min(...alerts.filter((a) => a.active && a.expires).map((a) => a.expires!));
  if (Number.isFinite(next)) {
    expiryTimer = setTimeout(() => { const st = useStore.getState(); syncAlerts(st.techAlerts, st.watchlists); }, Math.min(Math.max(0, next - now) + 50, 2 ** 31 - 1));
  }
  publish();
}

// what an alert is doing, for the Alertes panel
export function alertStatus(a: TechAlert): string {
  if (!a.active) return a.expires && a.expires <= Date.now() ? 'expirée' : a.trigger === 'once' && a.fired ? 'déclenchée, arrêtée' : 'arrêtée';
  const fs = [...feeds.values()].filter((f) => f.ids.has(a.id));
  if (!fs.length) return a.target.kind === 'watchlist' ? 'liste vide' : '…';
  if (fs.length === 1) return fs[0].status;
  const ok = fs.filter((f) => f.ok).length;
  const failed = fs.filter((f) => !f.ok && /pas de prix|erreur/.test(f.status)).length;
  return `${ok} / ${fs.length} marchés en veille${failed ? ` · ${failed} sans prix en direct` : ''}`;
}
