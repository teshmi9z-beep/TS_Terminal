import type { Symbol } from '../../types';
import { feedChain } from './resolve';
import { bnFetch } from './binance';
import { yfFetch } from './yahoo';

export type SessionPeriod = { start: number; end: number };

export type SymbolInfo = {
  fullSymbol: string;
  name: string;
  type: string;
  exchange: string;
  sector?: string;
  industry?: string;
  website?: string;
  description?: string;
  country?: string;
  employees?: number;
  currency?: string;
  tickSize?: number;
  pointValue?: number;
  dataSource: string;
  figi?: string;
  compositeFigi?: string;
  shareClassFigi?: string;
  // exchange timezone
  timezoneName?: string;
  gmtoffset?: number;
  // today's sessions (epoch seconds) or round-the-clock trading
  sessions?: { pre?: SessionPeriod; regular?: SessionPeriod; post?: SessionPeriod } | '24x7';
  marketState?: string;
};

const TYPE_LABEL: Record<string, string> = {
  EQUITY: 'Action', ETF: 'ETF', INDEX: 'Indice', CURRENCY: 'Forex', CRYPTOCURRENCY: 'Crypto',
  FUTURE: 'Contrat à terme', MUTUALFUND: 'Fonds',
};

// TradingView-style exchange prefixes for the most common Yahoo exchanges
function exchangePrefix(yahooExchange: string): string {
  const e = yahooExchange.toLowerCase();
  if (e.startsWith('nasdaq')) return 'NASDAQ';
  if (e.startsWith('nyse')) return e === 'nyse' ? 'NYSE' : 'AMEX';
  if (e === 'paris' || e === 'amsterdam' || e === 'brussels' || e === 'lisbon') return 'EURONEXT';
  if (e === 'xetra') return 'XETR';
  if (e === 'ccy') return 'FX';
  if (e === 'london') return 'LSE';
  return yahooExchange.toUpperCase().replace(/\s+/g, '');
}

// Yahoo suffix -> OpenFIGI exchange code
const FIGI_EXCH: Record<string, string> = {
  '': 'US', PA: 'FP', DE: 'GY', F: 'GF', L: 'LN', AS: 'NA', MI: 'IM', SW: 'SE', MC: 'SM', BR: 'BB',
  TO: 'CN', T: 'JT', HK: 'HK', AX: 'AT', ST: 'SS', CO: 'DC', OL: 'NO', HE: 'FH', LS: 'PL', VI: 'AV',
};

async function fetchFigi(yahooSymbol: string) {
  const [base, suffix = ''] = yahooSymbol.split('.');
  const exchCode = FIGI_EXCH[suffix];
  if (!exchCode) return null;
  const r = await fetch('/figi/v3/mapping', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ idType: 'TICKER', idValue: base.replace('-', '/'), exchCode }]),
  });
  if (!r.ok) return null;
  const json = await r.json();
  return (json?.[0]?.data?.[0] ?? null) as { figi: string; compositeFIGI?: string; shareClassFIGI?: string } | null;
}

async function binanceInfo(sym: Symbol, id: string): Promise<SymbolInfo> {
  const json = await bnFetch<any>(`/api/v3/exchangeInfo?symbol=${id}`);
  const s = json?.symbols?.[0];
  const tick = s?.filters?.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize;
  return {
    fullSymbol: `BINANCE:${id}`,
    name: s ? `${s.baseAsset} / ${s.quoteAsset}` : sym.name,
    type: 'Crypto',
    exchange: 'Binance',
    currency: s?.quoteAsset,
    tickSize: tick ? parseFloat(tick) : undefined,
    pointValue: 1,
    dataSource: 'Binance (temps réel, WebSocket)',
    timezoneName: 'UTC',
    gmtoffset: 0,
    sessions: '24x7',
    marketState: s?.status === 'TRADING' ? 'REGULAR' : s?.status,
  };
}

async function yahooInfo(sym: Symbol, id: string): Promise<SymbolInfo> {
  const [chart, summary] = await Promise.all([
    yfFetch<any>(`/v8/finance/chart/${encodeURIComponent(id)}?interval=1m&range=1d`).catch(() => null),
    fetch(`/api/yinfo?symbol=${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const meta = chart?.chart?.result?.[0]?.meta ?? {};
  const q = summary?.quoteSummary?.result?.[0] ?? {};
  const profile = q.assetProfile ?? q.summaryProfile ?? {};
  const price = q.price ?? {};
  const quoteType: string = q.quoteType?.quoteType ?? meta.instrumentType ?? '';
  const exchangeName: string = price.exchangeName ?? meta.fullExchangeName ?? meta.exchangeName ?? '';
  const delay: number | undefined = price.exchangeDataDelayedBy;
  const priceHint: number | undefined = price.priceHint?.raw ?? meta.priceHint;
  const period = meta.currentTradingPeriod;
  const figi = quoteType === 'EQUITY' || quoteType === 'ETF' ? await fetchFigi(id).catch(() => null) : null;
  return {
    fullSymbol: `${exchangePrefix(exchangeName || 'YAHOO')}:${sym.ticker.replace(/^\^/, '')}`,
    name: q.quoteType?.longName ?? price.longName ?? meta.longName ?? sym.name,
    type: TYPE_LABEL[quoteType] ?? (quoteType || sym.category),
    exchange: exchangeName,
    sector: profile.sectorDisp ?? profile.sector,
    industry: profile.industryDisp ?? profile.industry,
    website: profile.website,
    description: profile.longBusinessSummary,
    country: profile.country,
    employees: profile.fullTimeEmployees,
    currency: price.currency ?? meta.currency,
    tickSize: priceHint != null ? 10 ** -priceHint : undefined,
    pointValue: quoteType === 'FUTURE' ? undefined : 1,
    dataSource: delay ? `Yahoo Finance (différé de ${delay} min)` : 'Yahoo Finance',
    figi: figi?.figi,
    compositeFigi: figi?.compositeFIGI,
    shareClassFigi: figi?.shareClassFIGI,
    timezoneName: meta.exchangeTimezoneName,
    gmtoffset: meta.gmtoffset,
    sessions: quoteType === 'CRYPTOCURRENCY' ? '24x7' : period ? { pre: period.pre, regular: period.regular, post: period.post } : undefined,
    marketState: price.marketState,
  };
}

export async function fetchSymbolInfo(sym: Symbol): Promise<SymbolInfo> {
  for (const ref of feedChain(sym)) {
    try {
      if (ref.source === 'binance') return await binanceInfo(sym, ref.id);
      if (ref.source === 'yahoo') return await yahooInfo(sym, ref.id);
      if (ref.source === 'ib') {
        const [secType, symbol, , currency] = ref.id.split(':');
        return {
          fullSymbol: `IBKR:${symbol}`, name: sym.name, type: secType === 'CFD' ? 'CFD sur indice' : sym.category,
          exchange: 'Interactive Brokers', currency, dataSource: 'Interactive Brokers (IB Gateway), différé de 15 min sans abonnement',
        };
      }
    } catch { /* try the next source */ }
  }
  return {
    fullSymbol: sym.ticker, name: sym.name, type: sym.category, exchange: '—', dataSource: 'Simulation',
  };
}
