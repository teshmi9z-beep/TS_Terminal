import type { Candle } from '../../types';
import type { FeedSession, MarketMeta } from './types';
import { ibBars, ibSpan } from './ib';
import { LOCALE } from '../../i18n/lang';

// what a share's older history is doing, said over its charts: IBKR's page on its way (`busy`),
// or why there is nothing older (`text`: the gateway is closed, a subscription is missing...)
export type HistoryNote = { ticker: string; busy?: boolean; text?: string };
export const HISTORY_NOTE = 'feed-history-note';
const tell = (n: HistoryNote) => window.dispatchEvent(new CustomEvent<HistoryNote>(HISTORY_NOTE, { detail: n }));

function why(msg: string, end: number): string {
  const day = new Date(end * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  if (/injoignable|indisponible/.test(msg)) return `Historique avant le ${day} : ouvrez IB Gateway, connectez-vous, puis rouvrez ce graphique.`;
  if (/\b162\b/.test(msg)) return `Historique avant le ${day} : IBKR le donne avec l’abonnement aux données de cette bourse.`;
  if (/\b200\b/.test(msg)) return `Historique avant le ${day} : IBKR ne connaît pas ce titre.`;
  return `Historique avant le ${day} : ${msg}`;
}

// A source's history continued further back by Interactive Brokers once the source has nothing
// older: Yahoo keeps a share's hourly bars for 730 days only, IBKR since about 2005 (and its days
// further still), when the IB Gateway runs on this computer. The recent bars and the live ones
// stay the source's; IBKR is asked only for the pages before its first bar.
export class IbDeeperSession implements FeedSession {
  readonly source: FeedSession['source'];
  readonly label: string;
  get realtime() { return this.inner.realtime; }
  private inner: FeedSession;
  private ticker: string;
  private id: string;
  private bar: string;
  private span: string;
  private deep = true;
  private first = Infinity;

  // `bar`: the relay's bar name of the source's own interval (1h under Yahoo's 60m)
  constructor(inner: FeedSession, ticker: string, id: string, bar: string) {
    this.inner = inner;
    this.ticker = ticker;
    this.id = id;
    this.bar = bar;
    this.span = ibSpan(bar) ?? '1 M';
    this.source = inner.source;
    this.label = inner.label;
  }

  get hasMore() { return this.inner.hasMore || this.deep; }
  set hasMore(v: boolean) { this.inner.hasMore = v; if (!v) this.deep = false; }

  private seen(bars: Candle[]) {
    if (bars.length) this.first = Math.min(this.first, bars[0].time);
  }

  async load(): Promise<Candle[]> {
    const bars = await this.inner.load();
    this.seen(bars);
    return bars;
  }

  async loadOlder(): Promise<Candle[]> {
    if (this.inner.hasMore) {
      const older = await this.inner.loadOlder();
      this.seen(older);
      if (older.length || this.inner.hasMore) return older;
    }
    if (!this.deep || !Number.isFinite(this.first)) return [];
    const end = this.first;
    tell({ ticker: this.ticker, busy: true });
    try {
      const older = (await ibBars(this.id, this.bar, this.span, end)).filter((c) => c.time < end);
      // an empty page is the start of IBKR's history
      if (!older.length) this.deep = false;
      this.seen(older);
      tell({ ticker: this.ticker });
      return older;
    } catch (e) {
      // no gateway, no market data permission, unknown contract: nothing older to hope for in
      // this chart (opened again, it asks again); a slow answer is asked again on the next scroll
      const msg = e instanceof Error ? e.message : String(e);
      if (/ne répond pas/.test(msg)) { tell({ ticker: this.ticker }); throw e; }
      console.warn(`[feed] historique IBKR ${this.id} :`, msg);
      this.deep = false;
      tell({ ticker: this.ticker, text: why(msg, end) });
      return [];
    }
  }

  subscribe(onBar: (c: Candle) => void, onMeta?: (m: MarketMeta) => void): () => void {
    return this.inner.subscribe(onBar, onMeta);
  }
}
