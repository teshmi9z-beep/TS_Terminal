import type { Symbol } from '../types';
import { yahooId } from './feeds/resolve';
import { yfFetch } from './feeds/yahoo';
import { num, resolveTv, str, tvIdOfBuiltin, tvScan } from './tv';
import { fetchNews, type NewsItem } from './news';
import { LANG } from '../i18n/lang';

// What TradingView shows about an asset, on its chart (earnings E, dividends D, news ⚡) and in
// the watchlist's details: TradingView's screener for the profile (sector, 52 weeks, analysts,
// dividends, last and next earnings), Yahoo for the dividends since the start and the earnings
// dates up to mid-2025, Nasdaq for the last four earnings of US listings, TradingView's news flow.

// ---------------------------------------------------------------- TradingView's name of a symbol

// Yahoo's suffix -> TradingView's exchange
const SUFFIX_EX: Record<string, string> = {
  PA: 'EURONEXT', AS: 'EURONEXT', BR: 'EURONEXT', LS: 'EURONEXT', IR: 'EURONEXT', DE: 'XETR', F: 'FWB', HE: 'OMXHEX',
  ST: 'OMXSTO', CO: 'OMXCOP', OL: 'OSL', L: 'LSE', SW: 'SIX', MI: 'MIL', MC: 'BME', VI: 'VIE', T: 'TSE', HK: 'HKEX', TO: 'TSX', AX: 'ASX',
};
const tvIds = new Map<string, Promise<string | null>>();

// "EXCHANGE:TICKER" for TradingView, null when there is none to ask
export function tvIdOf(sym: Symbol): Promise<string | null> {
  let hit = tvIds.get(sym.ticker);
  if (hit) return hit;
  hit = (async () => {
    const builtin = tvIdOfBuiltin(sym.ticker);
    if (builtin) return builtin;
    if (sym.category === 'Crypto') return `BINANCE:${sym.ticker.replace(/USD$/, 'USDT')}`;
    if (sym.category === 'Forex' && /^[A-Z]{6}$/.test(sym.ticker)) return `FX:${sym.ticker}`;
    const y = yahooId(sym);
    if (!y) return null;
    const m = /^(.+)\.([A-Z]{1,2})$/.exec(y);
    if (m && SUFFIX_EX[m[2]]) return `${SUFFIX_EX[m[2]]}:${m[2] === 'HK' ? String(parseInt(m[1], 10)) : m[1].replace('-', '.')}`;
    // a US listing: its exchange (an ADR like NOK is not the company's primary listing)
    if (sym.category === 'Actions' && /^[A-Z]+(-[A-Z])?$/.test(y)) {
      const name = y.replace('-', '.');
      const primary = await resolveTv(name, 'america').catch(() => null);
      if (primary) return primary.id;
      const { rows } = await tvScan('america', {
        filter: [{ left: 'name', operation: 'equal', right: name }],
        columns: ['description'], sort: { sortBy: 'volume', sortOrder: 'desc' }, range: [0, 1],
      }).catch(() => ({ rows: [] as { s: string }[] }));
      return rows[0]?.s ?? null;
    }
    return null;
  })();
  tvIds.set(sym.ticker, hit);
  return hit;
}

// ---------------------------------------------------------------- the profile

export type AssetProfile = {
  tvId: string;
  name: string;
  sector: string;
  industry: string;
  exchange: string;
  currency: string;
  type: string;
  high52: number | null;
  low52: number | null;
  marketCap: number | null;
  // analysts: counts from strong buy to strong sell, the mean mark (1 strong buy .. 5 strong sell), 1-year target
  rating: { mark: number; counts: [number, number, number, number, number]; total: number } | null;
  target: { oneYear: number | null; high: number | null; low: number | null } | null;
  dividends: {
    yield: number | null; payout: number | null;
    last: { amount: number | null; exDate: number | null; payDate: number | null };
    next: { amount: number | null; exDate: number | null; payDate: number | null } | null;
  } | null;
  earnings: {
    period: string;
    last: { date: number | null; eps: number | null; epsEstimate: number | null; revenue: number | null; revenueEstimate: number | null };
    next: { date: number | null; when: 'before' | 'after' | null; period: string; epsEstimate: number | null; revenueEstimate: number | null } | null;
  } | null;
};

const PROFILE_COLS = [
  'description', 'sector.tr', 'industry.tr', 'exchange', 'currency', 'type', 'price_52_week_high', 'price_52_week_low', 'market_cap_basic',
  'recommendation_mark', 'recommendation_buy', 'recommendation_over', 'recommendation_hold', 'recommendation_under', 'recommendation_sell', 'recommendation_total',
  'price_target_1y', 'price_target_high', 'price_target_low',
  'dividends_yield_current', 'dividend_payout_ratio_ttm', 'dividend_amount_recent', 'ex_dividend_date_recent', 'dividend_payment_date_recent',
  'dividend_amount_upcoming', 'ex_dividend_date_upcoming', 'dividend_payment_date_upcoming',
  'fiscal_period_current', 'earnings_release_date', 'earnings_per_share_fq', 'earnings_per_share_forecast_fq', 'revenue_fq', 'revenue_forecast_fq',
  'earnings_release_next_date', 'earnings_release_next_time', 'earnings_per_share_forecast_next_fq', 'revenue_forecast_next_fq',
];

// "2026-Q2" -> "T2 2026", "2026-H1" -> "S1 2026", "2026" -> "2026"
export function periodLabel(p: string): string {
  const m = /^(\d{4})-([QH])(\d)$/.exec(p);
  return m ? `${m[2] === 'Q' ? 'T' : 'S'}${m[3]} ${m[1]}` : p;
}
// the period after "2026-Q2" (quarters, halves or years)
function nextPeriod(p: string): string {
  const m = /^(\d{4})-([QH])(\d)$/.exec(p);
  if (!m) return /^\d{4}$/.test(p) ? String(+p + 1) : '';
  const max = m[2] === 'Q' ? 4 : 2, k = +m[3];
  return k >= max ? `${+m[1] + 1}-${m[2]}1` : `${m[1]}-${m[2]}${k + 1}`;
}

const profiles = new Map<string, { at: number; value: Promise<AssetProfile | null> }>();

export function assetProfile(sym: Symbol): Promise<AssetProfile | null> {
  const hit = profiles.get(sym.ticker);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const value = (async (): Promise<AssetProfile | null> => {
    const id = await tvIdOf(sym);
    if (!id) return null;
    const { rows } = await tvScan('global', { symbols: { tickers: [id] }, columns: PROFILE_COLS, options: { lang: LANG } });
    const d = rows[0]?.d;
    if (!d) return null;
    const v = (k: string) => d[PROFILE_COLS.indexOf(k)];
    const n = (k: string) => num(v(k));
    const total = n('recommendation_total') ?? 0;
    const period = str(v('fiscal_period_current'));
    const hasDiv = n('dividends_yield_current') != null || n('dividend_amount_recent') != null;
    const hasEarn = n('earnings_release_date') != null || n('earnings_release_next_date') != null;
    const nextTime = n('earnings_release_next_time');
    return {
      tvId: rows[0].s,
      name: str(v('description')), sector: str(v('sector.tr')), industry: str(v('industry.tr')),
      exchange: str(v('exchange')), currency: str(v('currency')), type: str(v('type')),
      high52: n('price_52_week_high'), low52: n('price_52_week_low'), marketCap: n('market_cap_basic'),
      rating: total > 0 && n('recommendation_mark') != null ? {
        mark: n('recommendation_mark')!,
        counts: [n('recommendation_buy') ?? 0, n('recommendation_over') ?? 0, n('recommendation_hold') ?? 0, n('recommendation_under') ?? 0, n('recommendation_sell') ?? 0],
        total,
      } : null,
      target: n('price_target_1y') != null ? { oneYear: n('price_target_1y'), high: n('price_target_high'), low: n('price_target_low') } : null,
      dividends: hasDiv ? {
        yield: n('dividends_yield_current'), payout: n('dividend_payout_ratio_ttm'),
        last: { amount: n('dividend_amount_recent'), exDate: n('ex_dividend_date_recent'), payDate: n('dividend_payment_date_recent') },
        next: n('ex_dividend_date_upcoming') != null
          ? { amount: n('dividend_amount_upcoming'), exDate: n('ex_dividend_date_upcoming'), payDate: n('dividend_payment_date_upcoming') } : null,
      } : null,
      earnings: hasEarn ? {
        period,
        last: { date: n('earnings_release_date'), eps: n('earnings_per_share_fq'), epsEstimate: n('earnings_per_share_forecast_fq'), revenue: n('revenue_fq'), revenueEstimate: n('revenue_forecast_fq') },
        next: n('earnings_release_next_date') != null ? {
          date: n('earnings_release_next_date'), when: nextTime === -1 ? 'before' : nextTime === 1 ? 'after' : null, period: nextPeriod(period),
          epsEstimate: n('earnings_per_share_forecast_next_fq'), revenueEstimate: n('revenue_forecast_next_fq'),
        } : null,
      } : null,
    };
  })().catch(() => null);
  profiles.set(sym.ticker, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- the events on the chart

export type EarningsEvent = {
  kind: 'earnings'; time: number; upcoming: boolean;
  // "T2 2026", or the quarter's end ("juin 2026")
  period: string;
  when: 'before' | 'after' | null;
  eps: number | null; epsEstimate: number | null; surprisePct: number | null;
  revenue: number | null; revenueEstimate: number | null;
};
export type DividendEvent = { kind: 'dividend'; time: number; upcoming: boolean; amount: number | null; payDate: number | null };
export type NewsEvent = { kind: 'news'; time: number; items: NewsItem[] };
export type AssetEvent = EarningsEvent | DividendEvent | NewsEvent;

const DAY = 86400;
const sameEvent = (a: number, b: number, days: number) => Math.abs(a - b) < days * DAY;
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const monthFr = (m: number, y: number) => `${['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'][m]} ${y}`;

async function yahooEarnings(y: string): Promise<EarningsEvent[]> {
  const r = await fetch(`/api/yearnings?symbol=${encodeURIComponent(y)}`);
  if (!r.ok) return [];
  const j = await r.json();
  const doc = j?.finance?.result?.[0]?.documents?.[0];
  if (!doc) return [];
  const col = (id: string) => doc.columns.findIndex((c: { id: string }) => c.id === id);
  const [iName, iDate, iEst, iAct, iSur] = ['eventname', 'startdatetime', 'epsestimate', 'epsactual', 'epssurprisepct'].map(col);
  const out: EarningsEvent[] = [];
  for (const row of doc.rows as unknown[][]) {
    const name = row[iName];
    if (name && !/earning/i.test(String(name))) continue;
    const t = Date.parse(String(row[iDate])) / 1000;
    if (!Number.isFinite(t)) continue;
    out.push({
      kind: 'earnings', time: t, upcoming: t > Date.now() / 1000, period: '', when: null,
      eps: num(row[iAct]), epsEstimate: num(row[iEst]), surprisePct: num(row[iSur]), revenue: null, revenueEstimate: null,
    });
  }
  return out;
}

// US listings: Nasdaq's last four earnings
async function nasdaqEarnings(ticker: string): Promise<EarningsEvent[]> {
  const r = await fetch(`/nasdaq/api/company/${encodeURIComponent(ticker)}/earnings-surprise`);
  if (!r.ok) return [];
  const j = await r.json();
  const rows: { fiscalQtrEnd?: string; dateReported?: string; eps?: number | string; consensusForecast?: string; percentageSurprise?: string }[] = j?.data?.earningsSurpriseTable?.rows ?? [];
  const out: EarningsEvent[] = [];
  for (const x of rows) {
    const m = /^(\d+)\/(\d+)\/(\d{4})$/.exec(x.dateReported ?? '');
    if (!m) continue;
    const q = /^([A-Za-z]{3}) (\d{4})$/.exec(x.fiscalQtrEnd ?? '');
    out.push({
      kind: 'earnings', time: Date.UTC(+m[3], +m[1] - 1, +m[2], 12) / 1000, upcoming: false,
      period: q ? `fin ${monthFr(MONTHS[q[1]] ?? 0, +q[2])}` : '', when: null,
      eps: num(Number(x.eps)), epsEstimate: num(Number(x.consensusForecast)), surprisePct: num(Number(x.percentageSurprise)),
      revenue: null, revenueEstimate: null,
    });
  }
  return out;
}

async function yahooDividends(y: string): Promise<DividendEvent[]> {
  const j = await yfFetch<any>(`/v8/finance/chart/${encodeURIComponent(y)}?interval=1mo&range=max&events=div`);
  const divs = j?.chart?.result?.[0]?.events?.dividends ?? {};
  return Object.values(divs as Record<string, { amount: number; date: number }>)
    .map((d) => ({ kind: 'dividend' as const, time: d.date, upcoming: false, amount: d.amount, payDate: null }));
}

// the same event from several sources: the newer source's figures win, the others fill the gaps
function mergeEarnings(lists: EarningsEvent[][]): EarningsEvent[] {
  const out: EarningsEvent[] = [];
  for (const list of lists) {
    for (const e of list) {
      const same = out.find((o) => sameEvent(o.time, e.time, 5));
      if (!same) { out.push(e); continue; }
      for (const k of ['eps', 'epsEstimate', 'surprisePct', 'revenue', 'revenueEstimate'] as const) same[k] ??= e[k];
      if (!same.period) same.period = e.period;
      same.when ??= e.when;
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

const events = new Map<string, { at: number; value: Promise<AssetEvent[]> }>();

// everything to mark on the chart, oldest first; news only when asked (they change often)
export function assetEvents(sym: Symbol): Promise<AssetEvent[]> {
  const hit = events.get(sym.ticker);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.value;
  const value = (async () => {
    const y = sym.category === 'Actions' ? yahooId(sym) : null;
    const [profile, yEarn, nEarn, yDiv] = await Promise.all([
      assetProfile(sym),
      y ? yahooEarnings(y).catch(() => []) : Promise.resolve([]),
      y && /^[A-Z]+(-[A-Z])?$/.test(y) ? nasdaqEarnings(y.replace('-', '.')).catch(() => []) : Promise.resolve([]),
      y ? yahooDividends(y).catch(() => []) : Promise.resolve([]),
    ]);
    // TradingView: the last earnings (with revenue) and the next one
    const tv: EarningsEvent[] = [];
    const ea = profile?.earnings;
    if (ea?.last.date != null) {
      const surprise = ea.last.eps != null && ea.last.epsEstimate ? ((ea.last.eps - ea.last.epsEstimate) / Math.abs(ea.last.epsEstimate)) * 100 : null;
      tv.push({
        kind: 'earnings', time: ea.last.date, upcoming: false, period: periodLabel(ea.period), when: null,
        eps: ea.last.eps, epsEstimate: ea.last.epsEstimate, surprisePct: surprise, revenue: ea.last.revenue, revenueEstimate: ea.last.revenueEstimate,
      });
    }
    if (ea?.next?.date != null) {
      tv.push({
        kind: 'earnings', time: ea.next.date, upcoming: true, period: periodLabel(ea.next.period), when: ea.next.when,
        eps: null, epsEstimate: ea.next.epsEstimate, surprisePct: null, revenue: null, revenueEstimate: ea.next.revenueEstimate,
      });
    }
    const earnings = mergeEarnings([tv, nEarn, yEarn]);
    // dividends: Yahoo's history, TradingView's payment dates and the next one
    const divs = yDiv.sort((a, b) => a.time - b.time);
    const dv = profile?.dividends;
    if (dv?.last.exDate != null) {
      const same = divs.find((d) => sameEvent(d.time, dv.last.exDate!, 4));
      if (same) same.payDate = dv.last.payDate;
      else divs.push({ kind: 'dividend', time: dv.last.exDate, upcoming: false, amount: dv.last.amount, payDate: dv.last.payDate });
    }
    if (dv?.next?.exDate != null && !divs.some((d) => sameEvent(d.time, dv.next!.exDate!, 4))) {
      divs.push({ kind: 'dividend', time: dv.next.exDate, upcoming: dv.next.exDate > Date.now() / 1000, amount: dv.next.amount, payDate: dv.next.payDate });
    }
    return [...earnings, ...divs].sort((a, b) => a.time - b.time);
  })().catch(() => []);
  events.set(sym.ticker, { at: Date.now(), value });
  return value;
}

const news = new Map<string, { at: number; value: Promise<NewsItem[]> }>();

// TradingView's news of the asset, newest first
export function assetNews(sym: Symbol): Promise<NewsItem[]> {
  const hit = news.get(sym.ticker);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = tvIdOf(sym).then((id) => (id ? fetchNews({ symbol: id }) : [])).catch(() => []);
  news.set(sym.ticker, { at: Date.now(), value });
  return value;
}
