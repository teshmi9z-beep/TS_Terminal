import type { Symbol } from '../types';
import { binanceId, ibId, yahooId } from './feeds/resolve';

// The "Développeur · Data" downloads: where a market's history can come from, and how far
// back each source goes. Shared by the page (to offer the choices) and the dev server
// (scripts/history-download.ts, which downloads).

export type DlSource = 'binance' | 'ibkr' | 'yahoo';
export type DlPlan = {
  source: DlSource;
  // the source's own name for the market (Binance pair, IBKR contract id, Yahoo symbol)
  id: string;
  label: string;
  // how far back the source goes for a timeframe (days), Infinity: since the start
  maxDays: (tf: string) => number;
  note: string;
  // Yahoo symbol of a cash index whose closes the bars are moved onto, session by session
  // (a CFD standing in for an index IBKR won't give)
  align?: string;
};

export const DL_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export const DL_SECONDS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

// IBKR contracts for the markets the platform reads elsewhere: the cash indices (IBKR's
// index data), the futures the platform takes from Yahoo, stitched from the real contracts
const IB_EXTRA: Record<string, string> = {
  NDX100: 'IND:NDX:NASDAQ:USD', SPX500: 'IND:SPX:CBOE:USD', RUT2000: 'IND:RUT:RUSSELL:USD',
  DAX40: 'IND:DAX:EUREX:EUR', CAC40: 'IND:CAC40:MONEP:EUR', NIKKEI: 'IND:N225:OSE.JPN:JPY', HSI: 'IND:HSI:HKFE:HKD',
  // IBKR refuses the Dow's index without its subscription: the Dow CFD, at the cash index's level
  DJI: 'CFD:IBUS30:SMART:USD',
  // (US30, US500 and US100 carry their own: the charts read them from IBKR too)
  US2000: 'FUT:RTY:CME:USD:RTY', J225: 'FUT:NIY:CME:JPY:NIY',
};

// IBKR's id for a market, if it has one
export function ibkrId(sym: Symbol): string | null {
  const own = ibId(sym) ?? IB_EXTRA[sym.ticker];
  if (own) return own;
  // US shares (no exchange suffix): IBKR's smart routing
  if (sym.category === 'Actions' && /^[A-Z]{1,5}$/.test(sym.ticker) && !sym.yahoo?.includes('.')) return `STK:${sym.ticker}:SMART:USD`;
  return null;
}

const YAHOO_DAYS: Record<string, number> = { '1m': 29, '5m': 59, '15m': 59, '30m': 59, '1h': 729, '4h': 729, '1d': Infinity };

// the sources able to give a market's history, the deepest first
export function downloadPlans(sym: Symbol): DlPlan[] {
  const out: DlPlan[] = [];
  const bn = binanceId(sym);
  if (bn && sym.category === 'Crypto') {
    out.push({ source: 'binance', id: bn, label: `Binance · ${bn}`, maxDays: () => Infinity, note: 'Tout l’historique depuis la cotation, en quelques minutes.' });
  }
  const ib = ibkrId(sym);
  if (ib) {
    const fut = ib.startsWith('FUT:');
    const align = sym.ticker === 'DJI' ? '^DJI' : undefined;
    out.push({ align,
      source: 'ibkr', id: ib, label: `Interactive Brokers · ${ib.split(':').slice(0, 2).join(' ')}`,
      // expired futures: IBKR lists those of the last year or so (US100 on 2026-10-05: from June 2025)
      maxDays: (tf) => (fut && tf !== '1d' ? 480 : Infinity),
      note: `${fut ? 'Échéances réelles mises bout à bout : IBKR ne garde qu’un peu plus d’un an d’échéances expirées. ' : 'Plusieurs années. '}${align ? 'Le CFD du Dow, calé chaque jour sur la clôture officielle de l’indice. ' : ''}IB Gateway doit être ouvert et connecté. Environ 15 000 barres par minute.`,
    });
  }
  const y = yahooId(sym);
  if (y) out.push({ source: 'yahoo', id: y, label: `Yahoo · ${y}`, maxDays: (tf) => YAHOO_DAYS[tf] ?? 59, note: 'Rapide mais court : 30 jours en 1 min, 60 jours de 5 à 30 min, 2 ans en 1 h et 4 h.' });
  return out;
}

// bars a download will bring (a rough count, for the time it takes): crypto trades all the
// time, shares and cash indices 6.5 h a weekday, the rest about 23 h
export function barsEstimate(sym: Symbol, plan: DlPlan, tf: string, days: number): number {
  const crypto = sym.category === 'Crypto';
  if (tf === '1d') return Math.round(days * (crypto ? 1 : 5 / 7));
  const session = /^(IND|STK):/.test(plan.id) || (plan.source === 'yahoo' && (sym.category === 'Actions' || plan.id.startsWith('^')));
  const hours = crypto ? 24 : session ? 6.5 * 5 / 7 : 23 * 5 / 7;
  return Math.round((days * hours * 3600) / (DL_SECONDS[tf] ?? 3600));
}
