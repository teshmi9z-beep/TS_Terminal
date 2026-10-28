import { create } from 'zustand';
import type { Symbol } from '../../types';
import { useStore } from '../../store/store';
import { useChartUi, playAlertSound } from '../../store/chartUi';
import { binanceId, ibId, yahooId } from './resolve';
import { bnFetch, bnStream, BadSymbolError } from './binance';
import { yahooSpark } from './yahoo';
import { ibQuotes } from './ib';
import { estimatorFor } from './futuresEstimate';
import type { FeedSource, MarketMeta } from './types';

export type Quote = MarketMeta & { last: number; source: FeedSource; ts: number };

export const useQuotes = create<{ quotes: Record<string, Quote> }>()(() => ({ quotes: {} }));

// updates are buffered and flushed a few times per second so a burst of ticks
// doesn't re-render the watchlist on every websocket frame
let pending: Record<string, Quote> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  const batch = pending;
  pending = {};
  useQuotes.setState((st) => ({ quotes: { ...st.quotes, ...batch } }));
}

export function reportQuote(ticker: string, source: FeedSource, meta: MarketMeta) {
  const prev = pending[ticker] ?? useQuotes.getState().quotes[ticker];
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null && !(typeof v === 'number' && isNaN(v))));
  const next = { ...prev, ...clean, source, ts: Date.now() } as Quote;
  if (next.last == null) return;
  pending[ticker] = next;
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
  if (prev?.last != null && meta.last != null && prev.last !== meta.last) checkAlerts(ticker, prev.last, meta.last);
}

function checkAlerts(ticker: string, from: number, to: number) {
  const st = useStore.getState();
  for (const a of st.alerts) {
    if (a.triggered || a.ticker !== ticker) continue;
    if ((from - a.price) * (to - a.price) <= 0) {
      st.triggerAlert(a.id);
      st.logAlert({ alertId: a.id, time: Date.now(), ticker, text: `Prix : a atteint ${a.price}` });
      useChartUi.getState().showToast(`🔔 ${ticker} a atteint ${a.price}`);
      playAlertSound();
    }
  }
}

class QuoteManager {
  private wanted: Symbol[] = [];
  private bnFailed = new Set<string>();
  private bnMap = new Map<string, string>();
  private bnKey = '';
  private bnOff: (() => void) | null = null;
  private yfMap = new Map<string, string>();
  private yfKey = '';
  private yfTimer: ReturnType<typeof setTimeout> | undefined;
  private ibMap = new Map<string, string>();
  private ibKey = '';
  private ibTimer: ReturnType<typeof setTimeout> | undefined;
  // Yahoo ids of the IBKR markets Yahoo also quotes (the CME futures), polled while the
  // gateway gives nothing for them; and when each ticker last got an IBKR price
  private ibBackup = new Map<string, string>();
  private ibSeen = new Map<string, number>();
  // the index futures estimated in real time while their prices are delayed (futuresEstimate.ts)
  private estOffs = new Map<string, () => void>();

  setWanted(symbols: Symbol[]) {
    this.wanted = symbols;
    this.rebuild();
  }

  private rebuild() {
    const bn = new Map<string, string>();
    const yf = new Map<string, string>();
    const ib = new Map<string, string>();
    const backup = new Map<string, string>();
    for (const s of this.wanted) {
      const i = ibId(s);
      if (i) {
        ib.set(i, s.ticker);
        const y = yahooId(s);
        if (y) backup.set(y, s.ticker);
        continue;
      }
      const b = binanceId(s);
      if (b && !this.bnFailed.has(s.ticker)) { bn.set(b, s.ticker); continue; }
      const y = yahooId(s);
      if (y) yf.set(y, s.ticker);
    }

    const bnKey = [...bn.keys()].sort().join(',');
    if (bnKey !== this.bnKey) {
      this.bnKey = bnKey;
      this.bnOff?.();
      this.bnOff = null;
      this.bnMap = bn;
      if (bn.size) {
        // snapshot first: the miniTicker stream only pushes on change
        for (const [id, ticker] of bn) {
          bnFetch(`/api/v3/ticker/24hr?symbol=${id}`)
            .then((r) => reportQuote(ticker, 'binance', {
              last: +r.lastPrice, prevClose: +r.openPrice, dayHigh: +r.highPrice, dayLow: +r.lowPrice, volume: +r.volume, exchange: 'Binance',
            }))
            .catch((e) => {
              if (e instanceof BadSymbolError) { this.bnFailed.add(ticker); this.rebuild(); }
            });
        }
        const streams = [...bn.keys()].map((id) => `${id.toLowerCase()}@miniTicker`).join('/');
        this.bnOff = bnStream(`/stream?streams=${streams}`, (m) => {
          const d = m?.data;
          const ticker = d && this.bnMap.get(d.s);
          if (ticker) reportQuote(ticker, 'binance', { last: +d.c, prevClose: +d.o, dayHigh: +d.h, dayLow: +d.l, volume: +d.v });
        });
      }
    }

    const yfKey = [...yf.keys(), '|', ...backup.keys()].sort().join(',');
    if (yfKey !== this.yfKey) {
      this.yfKey = yfKey;
      this.yfMap = yf;
      this.ibBackup = backup;
      clearTimeout(this.yfTimer);
      if (yf.size || backup.size) this.pollYahoo();
    }

    const estWanted = new Set(this.wanted.map((s) => s.ticker).filter((t) => estimatorFor(t)));
    for (const [t, off] of this.estOffs) if (!estWanted.has(t)) { off(); this.estOffs.delete(t); }
    for (const t of estWanted) {
      const est = estimatorFor(t);
      if (!est || this.estOffs.has(t)) continue;
      this.estOffs.set(t, est.listen(() => {
        const last = est.active ? est.last() : null;
        const source = Date.now() - (this.ibSeen.get(t) ?? 0) < 30_000 ? 'ib' : 'yahoo';
        if (last != null) reportQuote(t, source, { last, estimated: true, exchange: 'Estimé en temps réel' });
      }));
    }

    const ibKey = [...ib.keys()].sort().join(',');
    if (ibKey !== this.ibKey) {
      this.ibKey = ibKey;
      this.ibMap = ib;
      clearTimeout(this.ibTimer);
      if (ib.size) this.pollIb();
    }
  }

  // Interactive Brokers through the local gateway (nothing when it isn't running)
  private pollIb = async () => {
    const map = this.ibMap;
    let ok = true;
    try {
      const res = await ibQuotes([...map.keys()]);
      for (const [id, q] of Object.entries(res)) {
        const ticker = map.get(id);
        if (ticker && q.last) {
          this.ibSeen.set(ticker, Date.now());
          // while estimated, the delayed price only gives the previous close
          if (!q.live && estimatorFor(ticker)?.active) reportQuote(ticker, 'ib', { prevClose: q.prevClose });
          else reportQuote(ticker, 'ib', { last: q.last, prevClose: q.prevClose, exchange: q.live ? 'Interactive Brokers · temps réel' : 'Interactive Brokers · différé', estimated: false });
        }
      }
    } catch { ok = false; }
    // every 2 s: real-time futures move a lot between two reads
    if (map === this.ibMap) this.ibTimer = setTimeout(this.pollIb, ok ? 2000 : 30000);
  };

  private pollYahoo = async () => {
    const map = this.yfMap;
    // the gateway's markets Yahoo also has, when it gave none of them a price for 30 s
    const ids = new Map(map);
    for (const [y, ticker] of this.ibBackup) if (Date.now() - (this.ibSeen.get(ticker) ?? 0) > 30_000) ids.set(y, ticker);
    try {
      if (ids.size) {
        const res = await yahooSpark([...ids.keys()]);
        for (const [id, q] of Object.entries(res)) {
          const ticker = ids.get(id);
          if (ticker) reportQuote(ticker, 'yahoo', estimatorFor(ticker)?.active ? { prevClose: q.prevClose } : { ...q, estimated: false });
        }
      }
    } catch { /* keep last known quotes */ }
    if (map === this.yfMap) this.yfTimer = setTimeout(this.pollYahoo, 10000);
  };
}

export const quoteManager = new QuoteManager();
