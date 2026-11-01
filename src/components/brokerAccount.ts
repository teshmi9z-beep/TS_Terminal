import type { PaperAccount, PaperOrder, PaperPosition, PaperSide } from '../store/store';
import { useStore } from '../store/store';
import { playAlertSound, useChartUi } from '../store/chartUi';
import {
  brokerCall, brokerLabel, guardsOf, isLive, loadIgMarket, refreshBroker, searchIg, today, useBroker,
  type Bridge, type BrokerSnapshot, type IgSearchHit,
} from '../store/broker';
import { eurPerUnit } from '../data/fx';
import { LOCALE } from '../i18n/lang';
import type { Symbol } from '../types';
import { SYMBOLS } from '../data/symbols';
import type { TradingApi } from './tradingAccount';
import { useQuotes } from '../data/feeds/quotes';
import { findSymbol } from './symbolDnd';
import { showOnChart } from './tabs/tabActions';

// The broker's account seen as the platform's own (src/components/tradingAccount.ts): the chart, the
// order ticket and the quick buttons trade IG's demo account the way they trade the virtual one.
// IG quotes its own CFD price (an index at fair value...), so the chart's prices go to IG's and back
// through the gap measured between the two (store/broker Bridge). IG's levels are prices, but its
// stop / target distances are points: a forex point is 0.0001 (IG's scaling factor, 10 000).

// what to look for at IG for the platform's tickers: an index's CFDs and cash level trade IG's CFD
// "au comptant" on that index, its future IG's contract with an expiry (igCandidates). IG answers a French account with French names ("Allemagne 40 au
// comptant (1€)", "Or au comptant (Contrat 1€)"), English ones second; a market's name must hold the term.
const IG_TERMS: Record<string, string[]> = {
  'US 500': ['US 500'],
  'US Tech 100': ['US Tech 100'],
  'Wall Street': ['Wall Street'],
  'US Russell 2000': ['US Russell 2000', 'Russell 2000'],
  'Germany 40': ['Allemagne 40', 'Germany 40'],
  'France 40': ['France 40'],
  'Japan 225': ['Japon 225', 'Japan 225'],
  'Hong Kong HS50': ['Hong Kong HS50', 'Hong Kong'],
  'Spot Gold': ['Or au comptant', 'Spot Gold'],
  'Spot Silver': ['Argent au comptant', 'Spot Silver'],
  'US Crude': ['US Brut Léger', 'US Crude', 'US Light Crude'],
  'Natural Gas': ['Gaz naturel', 'Natural Gas'],
  'FTSE 100': ['FTSE 100'],
  'Europe 50': ['Europe 50', 'EU Stocks 50'],
  Copper: ['Cuivre', 'Copper'],
  Bitcoin: ['Bitcoin'],
  Ether: ['Ether'],
};
const IG_OF: Record<string, string> = {
  SPX500: 'US 500', US500: 'US 500', IBUS500: 'US 500', IGUS500: 'US 500',
  NDX100: 'US Tech 100', US100: 'US Tech 100', IBUST100: 'US Tech 100', IGUST100: 'US Tech 100',
  DJI: 'Wall Street', US30: 'Wall Street', IBUS30: 'Wall Street', IGUS30: 'Wall Street',
  RUT2000: 'US Russell 2000', US2000: 'US Russell 2000', IGUS2000: 'US Russell 2000',
  DAX40: 'Germany 40', DE40: 'Germany 40', IBDE40: 'Germany 40', IGDE40: 'Germany 40',
  CAC40: 'France 40', FR40: 'France 40', IBFR40: 'France 40', IGFR40: 'France 40',
  NIKKEI: 'Japan 225', J225: 'Japan 225', IBJP225: 'Japan 225', IGJP225: 'Japan 225',
  HSI: 'Hong Kong HS50', HK50: 'Hong Kong HS50', IBHK50: 'Hong Kong HS50', IGHK50: 'Hong Kong HS50',
  FTSE100: 'FTSE 100', IGUK100: 'FTSE 100', STOXX50: 'Europe 50',
  XAUUSD: 'Spot Gold', XAGUSD: 'Spot Silver', WTI: 'US Crude', NATGAS: 'Natural Gas', COPPER: 'Copper',
  BTCUSD: 'Bitcoin', ETHUSD: 'Ether',
};
// markets IG's search doesn't return (it gives only its first results)
const IG_HINTS: Record<string, IgSearchHit> = {
  Ether: { epic: 'CS.D.ETHUSD.CFE.IP', name: 'Ether (E1)', type: 'CURRENCIES', expiry: '-', bid: null, offer: null, status: '' },
};
function termsOf(s: Symbol): string[] {
  const known = IG_OF[s.ticker];
  if (known) return IG_TERMS[known];
  if (s.category === 'Forex' && /^[A-Z]{6}$/.test(s.ticker)) return [`${s.ticker.slice(0, 3)}/${s.ticker.slice(3)}`];
  return [s.ticker, s.name];
}

// never options, binaries, knock-outs, weekend markets or spread bets
export const usableIg = (h: IgSearchHit) => !/OPT|BINARY|SPRINT|BUNGEE|KNOCK/i.test(h.type) && h.expiry !== 'DFB' && !/week-?end/i.test(h.name);
// the contract's value written in its name: "(1€)", "(250$)", "(Contrat 1€)", "(E0.1)", "($0.1)"
const contractValue = (name: string) => {
  const m = /\((?:Contrat\s*)?(?:[$€£]|E|A\$)?\s*(\d+(?:[.,]\d+)?)\s*(?:[$€£]|A\$|NK)?\)/.exec(name);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
};
// first the CFD without expiry (an index "au comptant", a spot market), in euros and with the smallest
// contract (the one 10 000 € can trade); a pair the term doesn't name ("Bitcoin Cash/Bitcoin") last
function rank(h: IgSearchHit, term: string) {
  const v = contractValue(h.name);
  return (h.expiry === '-' ? 4 : 0) + (h.type === 'INDICES' && /cash|comptant/i.test(h.name) ? 2 : 0)
    + (/€|\(E\d|\bEUR\b/i.test(h.name) ? 1 : 0) + (v != null && v <= 1 ? 1 : 0)
    + (h.type === 'CURRENCIES' && h.name.includes('/') && /mini/i.test(h.name) ? 0.5 : 0)
    - (h.name.includes('/') && !term.includes('/') ? 3 : 0)
    // else the smaller contract ("(20$)" before "(100$)")
    - (v ?? 0) / 1e6;
}

// the IG markets a symbol can trade, the likeliest first
export async function igCandidates(s: Symbol): Promise<IgSearchHit[]> {
  // a known index, commodity or crypto is never a share whose name holds the same word; an index
  // future trades IG's contracts with an expiry only, the cash index (and a CFD) those "au comptant"
  const group = IG_OF[s.ticker];
  const forward = INDEX_FUTURES.has(s.ticker);
  const fits = (h: IgSearchHit) => !group || h.type !== 'INDICES' || (h.expiry !== '-') === forward;
  for (const term of termsOf(s)) {
    const hits = (await searchIg(term)).filter((h) => usableIg(h) && fits(h) && h.name.toLowerCase().includes(term.toLowerCase()) && !(group && h.type === 'SHARES'));
    if (hits.length) return hits.sort((a, b) => rank(b, term) - rank(a, term)).slice(0, 10);
  }
  const hint = group ? IG_HINTS[group] : undefined;
  return hint ? [hint] : [];
}

// the IG market a symbol trades: the one chosen before, else the likeliest (kept)
export async function igMarketOf(s: Symbol): Promise<{ epic: string; name: string } | null> {
  const known = useBroker.getState().markets[s.ticker];
  if (known) return known;
  // an IG symbol trades the very market it charts
  const hits = await igCandidates(s);
  const best = hits.find((h) => h.epic === s.ig) ?? hits[0];
  if (!best) return null;
  const m = { epic: best.epic, name: best.name };
  useBroker.getState().setMarket(s.ticker, m);
  // its price as the search gave it, until the market itself is asked
  useBroker.setState((st) => (st.igMarkets[best.epic] ? st : {
    igMarkets: {
      ...st.igMarkets,
      [best.epic]: { epic: best.epic, name: best.name, bid: best.bid, offer: best.offer, status: best.status, scale: 1, decimals: 2, delay: 0, currency: '', contractSize: 1, minSize: null, minStop: null, partial: true },
    },
  }));
  return m;
}

// the platform symbols IG's markets are charted with, by IG's name (French or English). An index has
// two kinds of contracts at IG, never charted on each other:
// - "au comptant" / "Cash" ("US Tech 100 au comptant (20$)"), IG's CFD: charted on the platform's IG
//   symbol (IGUST100, "US Tech 100 Cash"), with IG's own prices (data/feeds/ig.ts), never on the
//   platform's future (NQ1) nor on its cash index or IBKR's CFD. The Euro Stoxx and the smaller
//   European indices have no IG symbol: the cash index;
// - with an expiry ("US Tech 100 (20$)", DEC-26), at the future's level: charted on the future (US100).
const IG_INDICES: [RegExp, string, string][] = [
  [/^US 500\b/, 'IGUS500', 'US500'], [/^US Tech 100\b/, 'IGUST100', 'US100'], [/^Wall Street\b/, 'IGUS30', 'US30'], [/Russell 2000\b/, 'IGUS2000', 'US2000'],
  [/^(Allemagne|Germany) 40\b/, 'IGDE40', 'DE40'], [/^France 40\b/, 'IGFR40', 'FR40'], [/^(Japon|Japan) 225\b/, 'IGJP225', 'J225'], [/^Hong Kong HS50\b/, 'IGHK50', 'HK50'],
  [/^FTSE 100\b/, 'IGUK100', 'FTSE100'], [/^(Europe|EU Stocks) 50\b/, 'STOXX50', 'STOXX50'], [/^(Espagne|Spain) 35\b/, 'IBEX35', 'IBEX35'], [/^(Italie|Italy) 40\b/, 'FTSEMIB', 'FTSEMIB'],
  [/^(Suisse|Switzerland) 20\b/, 'SMI20', 'SMI20'], [/^(Pays-Bas|Netherlands) 25\b/, 'AEX', 'AEX'], [/^(Norvège|Norway) 25\b/, 'OBX', 'OBX'],
];
// the index futures of the platform (their IG contracts are those with an expiry)
export const INDEX_FUTURES = new Set(IG_INDICES.filter(([, cash, future]) => cash !== future).map(([, , future]) => future));
const isCashIg = (name: string) => /au comptant|\bcash\b/i.test(name);
const IG_CHARTS: [RegExp, string][] = [
  [/^(Or au comptant|Spot Gold)\b/, 'XAUUSD'], [/^(Argent au comptant|Spot Silver)\b/, 'XAGUSD'], [/US Brut Léger|US Light Crude|US Crude/, 'WTI'],
  [/^(Gaz naturel|Natural Gas)\b/, 'NATGAS'], [/^(Cuivre|Copper)\b/, 'COPPER'], [/^Bitcoin \(/, 'BTCUSD'], [/^Ether \(/, 'ETHUSD'],
];

// the platform symbol an IG market is charted with, by its name (an index, a commodity, a forex pair,
// a crypto of the platform's list), else the one it was traded from
export function symbolOfIg(epic: string, name: string): Symbol | null {
  for (const [re, cash, future] of IG_INDICES) if (re.test(name)) return findSymbol(isCashIg(name) ? cash : future);
  for (const [re, t] of IG_CHARTS) if (re.test(name)) return findSymbol(t);
  const fx = /^([A-Z]{3})\/([A-Z]{3})\b/.exec(name);
  if (fx) return findSymbol(fx[1] + fx[2]);
  const base = name.replace(/\s*\(.*$/, '').trim().toLowerCase();
  const crypto = SYMBOLS.find((s) => s.category === 'Crypto' && s.name.split(' / ')[0].toLowerCase() === base);
  if (crypto) return crypto;
  const known = tickerOfEpic(epic, useStore.getState().symbol.ticker);
  return known ? findSymbol(known) : null;
}

// a click on an IG market (a position, an order, the list of markets): its chart, and the ticket
// trading that very market; one the platform doesn't chart opens the symbol search with its name
export function openIgMarket(epic: string, name: string) {
  const sym = symbolOfIg(epic, name);
  if (!sym) {
    useChartUi.getState().openSearch('switch', name.replace(/\s*\(.*$/, '').replace(/\s+(au comptant|Cash)\b.*$/i, '').trim());
    return;
  }
  linkIgMarket(sym, epic, name);
  // on the chart tab, in the active window of a 2 / 4 / 6 grid (from a tool tab or window too)
  showOnChart(sym);
}

// the IG contract a chart symbol trades through (its ticket), and its price gap to the chart's
// (the lines of its positions and orders); also for a row dragged onto a chart
export function linkIgMarket(sym: Symbol, epic: string, name: string) {
  useBroker.getState().setMarket(sym.ticker, { epic, name, fromIg: true });
  void loadIgMarket(epic).then(() => updateBridges([sym.ticker])).catch(() => undefined);
}

// IG's price against the chart's now (its live quote: just after a change of symbol the chart still
// holds the previous one's bars); further than 3 % apart it is not the same market and nothing is converted
export function measureBridge(ticker: string, epic: string): Bridge | null {
  const m = useBroker.getState().igMarkets[epic];
  const last = useQuotes.getState().quotes[ticker]?.last;
  if (!m || m.bid == null || m.offer == null || last == null || !(last > 0)) return null;
  const mid = (m.bid + m.offer) / 2;
  const offset = mid - last;
  return Math.abs(offset) <= 0.03 * mid ? { epic, offset } : null;
}

// the gaps kept for the chart's lines: smoothed, so the lines don't shake with each refresh
export function updateBridges(tickers: string[]) {
  const st = useBroker.getState();
  const bridges = { ...st.bridges };
  for (const t of tickers) {
    const epic = st.markets[t]?.epic;
    const now = epic ? measureBridge(t, epic) : null;
    const old = bridges[t];
    if (!now) { if (old && old.epic !== epic) delete bridges[t]; continue; }
    // a jump of more than 0.5 % (another session, a roll) is taken at once
    const m = st.igMarkets[now.epic];
    const price = m?.bid != null && m.offer != null ? (m.bid + m.offer) / 2 : 0;
    bridges[t] = old && old.epic === now.epic && Math.abs(now.offset - old.offset) < 0.005 * price
      ? { ...now, offset: old.offset * 0.8 + now.offset * 0.2 } : now;
  }
  useBroker.setState({ bridges });
}

// the platform tickers that trade an IG market (the charted one first)
function tickerOfEpic(epic: string, current: string): string | null {
  const tickers = Object.entries(useBroker.getState().markets).filter(([, m]) => m.epic === epic).map(([t]) => t);
  return tickers.includes(current) ? current : tickers[0] ?? null;
}
export function tickersOfSnapshot(snap: BrokerSnapshot | null): string[] {
  if (!snap) return [];
  const markets = Object.entries(useBroker.getState().markets);
  const epics = new Set([...snap.positions, ...snap.orders].map((x) => x.epic));
  return markets.filter(([, m]) => epics.has(m.epic)).map(([t]) => t);
}

const EMPTY: PaperAccount = { initial: 0, balance: 0, positions: [], orders: [], history: [] };

// IG's positions and orders in the chart's prices, for the chart's lines (those of a market no
// platform symbol trades, or with no price to compare, stay in the panel under the chart only)
export function brokerView(current: string): PaperAccount {
  const st = useBroker.getState();
  const snap = st.snap;
  if (!snap) return EMPTY;
  const at = (epic: string, name: string) => {
    // an IG symbol charts every size of its market (1 €, 1 $, 20 $... the same prices)
    const own = symbolOfIg(epic, name);
    if (own?.ig) return { sym: own, offset: 0, from: (v: number) => v };
    const t = tickerOfEpic(epic, current);
    const b = t ? st.bridges[t] : undefined;
    const sym = t ? findSymbol(t) : null;
    return sym && b && b.epic === epic ? { sym, offset: b.offset, from: (v: number) => v - b.offset } : null;
  };
  // a point's worth: the position's own, else the market's (asked once for the markets held)
  const perPointOf = (epic: string) => (st.igMarkets[epic]?.partial ? 1 : st.igMarkets[epic]?.contractSize ?? 1);
  const positions: PaperPosition[] = snap.positions.flatMap((p) => {
    const x = at(p.epic, p.name);
    return x ? [{
      id: p.id, symbol: x.sym, side: p.side, qty: p.size, entry: x.from(p.level), sl: p.sl != null ? x.from(p.sl) : undefined, tp: p.tp != null ? x.from(p.tp) : undefined,
      openedAt: p.openedAt, broker: { offset: x.offset, perPoint: p.perPoint ?? perPointOf(p.epic), currency: p.currency, pnl: p.pnl },
    }] : [];
  });
  const orders: PaperOrder[] = snap.orders.flatMap((o) => {
    const x = at(o.epic, o.name);
    return x ? [{
      id: o.id, symbol: x.sym, side: o.side, qty: o.size, type: o.type, price: x.from(o.level), sl: o.sl != null ? x.from(o.sl) : undefined, tp: o.tp != null ? x.from(o.tp) : undefined,
      createdAt: o.createdAt, broker: { offset: x.offset, perPoint: perPointOf(o.epic), currency: o.currency },
    }] : [];
  });
  return { initial: snap.account.balance, balance: snap.account.balance, positions, orders, history: [] };
}

// ---------- orders ----------

type Confirm = { dealId: string; level: number | null; size: number | null; direction: 'BUY' | 'SELL' | null };
const sgn = (s: PaperSide) => (s === 'long' ? 1 : -1);
const toast = (t: string) => useChartUi.getState().showToast(t);
const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const connected = () => !!useBroker.getState().account;
// "IG démo" / "IG réel" in the questions, "IG" / "IG RÉEL" in the messages
const label = () => brokerLabel(useBroker.getState().active);
const tag = () => (isLive(useBroker.getState().active) ? 'IG RÉEL' : 'IG');
// the question asked before an order (the "confirm" guard), louder on real money
const ask = (text: string) => !guardsOf(useBroker.getState().active).confirm
  || window.confirm(isLive(useBroker.getState().active) ? `ARGENT RÉEL — ${text}` : text);
const eur = (v: number) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: number) => v.toLocaleString(LOCALE, { maximumFractionDigits: 2 });
const decimalsOf = (epic: string) => useBroker.getState().igMarkets[epic]?.decimals ?? 2;
// IG's points in one unit of price (10 000 for most forex pairs, 1 elsewhere)
const pointsIn = (scale: number | undefined) => (scale != null && scale > 1 ? scale : 1);
const roundTo = (v: number, d: number) => Number(v.toFixed(d));

function notConnected() {
  toast(`${label()} n’est pas connecté : menu Trader › Connecter un autre courtier`);
  useChartUi.getState().openDialog('brokers');
}

// ---------- guards (Garde-fous) ----------

// the day so far on the account: its capital at the start (today's closed trades taken back from the
// balance), its capital now, and what was lost since; null until IG's history is in
export function dayStats() {
  const snap = useBroker.getState().snap;
  if (!snap?.history) return null;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const realized = snap.history.filter((t) => t.closedAt >= midnight.getTime()).reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const start = snap.account.balance - realized;
  const now = snap.account.balance + snap.account.pnl;
  return { start, now, result: now - start, lost: Math.max(0, start - now) };
}

// orders allowed now by the hours guard (from > to: over midnight)
export function inHours(from: string, to: string, d = new Date()) {
  const now = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

// one of the market's currency in the account's (null when the rate is not known yet)
function toAccount(currency: string) {
  const acct = useBroker.getState().snap?.account.currency ?? 'EUR';
  if (!currency || currency === acct) return 1;
  return acct === 'EUR' ? eurPerUnit(currency, useQuotes.getState().quotes) : null;
}

// what a position or an order loses at its stop, in the account's currency
const riskOf = (stopDist: number, size: number, perPoint: number, currency: string) => {
  const rate = toAccount(currency);
  return rate == null ? null : stopDist * size * perPoint * rate;
};

// why a new order may not go (null: it may); the day's loss limit reached locks the day
type NewOrder = { size: number; stopDist: number | null; perPoint: number; currency: string };
export function guardBlock(o: NewOrder): string | null {
  const st = useBroker.getState();
  const b = st.active;
  const g = guardsOf(b);
  if (g.lockedDay === today()) return 'Garde-fou : ordres bloqués jusqu’à demain';
  if (g.hours.on && !inHours(g.hours.from, g.hours.to)) return `Garde-fou : ordres permis de ${g.hours.from} à ${g.hours.to} seulement`;
  if (g.stopRequired && o.stopDist == null) return 'Garde-fou : stop loss obligatoire';
  if (g.maxSize.on && o.size > g.maxSize.value) return `Garde-fou : ${g.maxSize.value} contrat(s) au maximum par ordre`;
  if (g.maxOpen.on && (st.snap?.positions.length ?? 0) + (st.snap?.orders.length ?? 0) >= g.maxOpen.value) {
    return `Garde-fou : ${g.maxOpen.value} positions et ordres au maximum`;
  }
  const acct = st.snap?.account;
  if (g.maxRisk.on) {
    if (o.stopDist == null) return 'Garde-fou : un stop est nécessaire pour mesurer le risque';
    const risk = riskOf(o.stopDist, o.size, o.perPoint, o.currency);
    if (!acct || risk == null) return 'Garde-fou : capital ou taux de change pas encore lu, réessayez dans un instant';
    const max = (acct.balance + acct.pnl) * g.maxRisk.value / 100;
    if (risk > max) return `Garde-fou : ${eur(risk)} ${acct.currency} perdus au stop, plus que ${pct(g.maxRisk.value)} % du capital (${eur(max)} ${acct.currency})`;
  }
  if (g.dailyLoss.on) {
    const d = dayStats();
    if (!d) return 'Garde-fou : historique du jour pas encore lu, réessayez dans un instant';
    if (d.lost >= d.start * g.dailyLoss.value / 100) {
      useBroker.getState().setGuards(b, { lockedDay: today() });
      return `Garde-fou : perte du jour (${eur(d.lost)} ${acct?.currency ?? ''}) au-delà de ${pct(g.dailyLoss.value)} % : ordres bloqués jusqu’à demain`;
    }
  }
  return null;
}

// a stop moved or taken off: refused when the stop is required, or when it makes the loss at the stop
// bigger than the risk allowed (a stop brought closer always goes)
function stopBlock(entry: number, oldSl: number | null, newSl: number | null, size: number, perPoint: number, currency: string): string | null {
  const g = guardsOf(useBroker.getState().active);
  if (newSl == null) return oldSl != null && g.stopRequired ? 'Garde-fou : stop loss obligatoire, il ne peut pas être retiré' : null;
  if (!g.maxRisk.on) return null;
  const acct = useBroker.getState().snap?.account;
  const risk = riskOf(Math.abs(entry - newSl), size, perPoint, currency);
  const before = oldSl != null ? riskOf(Math.abs(entry - oldSl), size, perPoint, currency) : Infinity;
  if (!acct || risk == null || before == null || risk <= before) return null;
  const max = (acct.balance + acct.pnl) * g.maxRisk.value / 100;
  return risk > max ? `Garde-fou : ce stop perdrait ${eur(risk)} ${acct.currency}, plus que ${pct(g.maxRisk.value)} % du capital` : null;
}

// sends one request to IG, says how it went and refreshes the account
async function deal(path: string, body: unknown, done: (c: Confirm) => string) {
  try {
    const c = await brokerCall<Confirm>(path, body);
    toast(done(c));
    playAlertSound();
  } catch (e) {
    toast(errorOf(e));
  } finally {
    void refreshBroker();
  }
}

// the market of a symbol with its rules and a fresh price
async function marketOf(s: Symbol) {
  const m = await igMarketOf(s);
  if (!m) throw new Error(`Aucun marché IG trouvé pour ${s.ticker}`);
  const info = await loadIgMarket(m.epic);
  return { ...m, info, points: pointsIn(info.scale) };
}

// a stop or target on the wrong side is refused here rather than by IG; the distances in IG's points
function distances(side: PaperSide, entry: number, sl: number | undefined, tp: number | undefined, points: number) {
  if (sl != null && (entry - sl) * sgn(side) <= 0) throw new Error('Le stop doit être du côté perdant de l’entrée');
  if (tp != null && (tp - entry) * sgn(side) <= 0) throw new Error('L’objectif doit être du côté gagnant de l’entrée');
  return {
    stopDistance: sl != null ? Math.abs(entry - sl) * points : undefined,
    limitDistance: tp != null ? Math.abs(tp - entry) * points : undefined,
  };
}
const pts = (v: number | undefined, d: number) => (v == null ? '' : v.toFixed(d));

// the gap of the position's / order's market, to turn the chart's prices into IG's (none on an IG
// symbol's chart, whatever the contract's size)
function bridgeOfEpic(epic: string, name: string): Bridge | null {
  if (symbolOfIg(epic, name)?.ig) return { epic, offset: 0 };
  const st = useBroker.getState();
  const t = tickerOfEpic(epic, useStore.getState().symbol.ticker);
  const b = t ? st.bridges[t] : undefined;
  return b && b.epic === epic ? b : null;
}

// a position's stop / target in IG's own prices (the panel under the chart edits them so)
export function amendIgPosition(id: string, sl: number | null, tp: number | null) {
  const st = useBroker.getState();
  const p = st.snap?.positions.find((x) => x.id === id);
  const why = p && stopBlock(p.level, p.sl, sl, p.size, p.perPoint, p.currency);
  if (why) { toast(why); return; }
  if (st.snap) useBroker.setState({ snap: { ...st.snap, positions: st.snap.positions.map((x) => (x.id === id ? { ...x, sl, tp } : x)) } });
  void deal('amend', { dealId: id, sl, tp }, () => `${tag()} : stop et objectif modifiés`);
}

export function brokerApi(): TradingApi {
  return {
    replay: false,
    paper: () => brokerView(useStore.getState().symbol.ticker),

    // at the market: the stop and target go as distances, so they sit where they were meant to from
    // IG's own fill price
    open: (p) => {
      if (!connected()) { notConnected(); return; }
      void (async () => {
        try {
          const m = await marketOf(p.symbol);
          const d = distances(p.side, p.entry, p.sl, p.tp, m.points);
          const why = guardBlock({ size: p.qty, stopDist: p.sl != null ? Math.abs(p.entry - p.sl) : null, perPoint: m.info.contractSize, currency: m.info.currency });
          if (why) { toast(why); return; }
          const extra = [d.stopDistance ? `stop à ${pts(d.stopDistance, 1)} pts` : '', d.limitDistance ? `objectif à ${pts(d.limitDistance, 1)} pts` : ''].filter(Boolean).join(', ');
          if (!ask(`Envoyer à ${label()} : ${p.side === 'long' ? 'achat' : 'vente'} de ${p.qty} contrat(s) ${m.name} au marché${extra ? `, ${extra}` : ''} ?`)) return;
          toast(`${tag()} : ordre envoyé…`);
          await deal('order', { epic: m.epic, side: p.side, size: p.qty, type: 'market', ...d },
            (c) => `${tag()} : ${p.side === 'long' ? 'achat' : 'vente'} ${c.size ?? p.qty} ${m.name} exécuté à ${c.level ?? '—'}`);
        } catch (e) { toast(errorOf(e)); }
      })();
    },

    // a limit or stop order at a chart price: placed at the same place on IG's price
    placeOrder: (o) => {
      if (!connected()) { notConnected(); return; }
      void (async () => {
        try {
          const m = await marketOf(o.symbol);
          const b = measureBridge(o.symbol.ticker, m.epic);
          if (!b) throw new Error(`Prix IG introuvable ou trop loin du graphique pour ${o.symbol.ticker} : vérifiez le marché IG choisi dans le ticket`);
          const level = roundTo(o.price + b.offset, m.info.decimals);
          const d = distances(o.side, o.price, o.sl, o.tp, m.points);
          const why = guardBlock({ size: o.qty, stopDist: o.sl != null ? Math.abs(o.price - o.sl) : null, perPoint: m.info.contractSize, currency: m.info.currency });
          if (why) { toast(why); return; }
          if (!ask(`Envoyer à ${label()} : ordre ${o.type === 'limit' ? 'limite' : 'stop'} ${o.side === 'long' ? 'achat' : 'vente'} de ${o.qty} contrat(s) ${m.name} à ${level} (prix IG) ?`)) return;
          toast(`${tag()} : ordre envoyé…`);
          await deal('order', { epic: m.epic, side: o.side, size: o.qty, type: o.type, level, ...d },
            () => `${tag()} : ordre ${o.type === 'limit' ? 'limite' : 'stop'} placé à ${level} sur ${m.name}`);
        } catch (e) { toast(errorOf(e)); }
      })();
    },

    cancelOrder: (id) => {
      const st = useBroker.getState();
      if (st.snap) useBroker.setState({ snap: { ...st.snap, orders: st.snap.orders.filter((o) => o.id !== id) } });
      void deal('cancel', { dealId: id }, () => `${tag()} : ordre annulé`);
    },

    close: (id) => {
      const p = useBroker.getState().snap?.positions.find((x) => x.id === id);
      if (!p) return;
      if (!ask(`Clôturer chez ${label()} : ${p.side === 'long' ? 'achat' : 'vente'} de ${p.size} ${p.name} ?`)) return;
      void deal('close', { dealId: id }, (c) => `${tag()} : position ${p.name} clôturée à ${c.level ?? '—'}`);
    },

    modify: (id, patch) => {
      const p = useBroker.getState().snap?.positions.find((x) => x.id === id);
      if (!p) return;
      const b = bridgeOfEpic(p.epic, p.name);
      if (!b) { toast('Prix IG trop loin du graphique : modifiez le stop dans le panneau sous le graphique'); return; }
      const toIg = (v: number | undefined) => (v == null ? null : roundTo(v + b.offset, decimalsOf(p.epic)));
      amendIgPosition(id, 'sl' in patch ? toIg(patch.sl) : p.sl, 'tp' in patch ? toIg(patch.tp) : p.tp);
    },

    modifyOrder: (id, patch) => {
      const st = useBroker.getState();
      const o = st.snap?.orders.find((x) => x.id === id);
      if (!o || !st.snap) return;
      if (patch.qty != null && patch.qty !== o.size) {
        toast('IG ne change pas la taille d’un ordre en attente : annulez-le puis replacez-le');
        if (Object.keys(patch).length === 1) return;
      }
      const b = bridgeOfEpic(o.epic, o.name);
      if (!b) { toast('Prix IG trop loin du graphique : annulez l’ordre puis replacez-le'); return; }
      const d = decimalsOf(o.epic);
      const toIg = (v: number | undefined) => (v == null ? null : roundTo(v + b.offset, d));
      const level = patch.price != null ? toIg(patch.price)! : o.level;
      // a stop / target not moved keeps its distance from the order's level
      const sl = 'sl' in patch ? toIg(patch.sl) : o.sl != null ? roundTo(o.sl - o.level + level, d) : null;
      const tp = 'tp' in patch ? toIg(patch.tp) : o.tp != null ? roundTo(o.tp - o.level + level, d) : null;
      const type = patch.type ?? o.type;
      const perPoint = st.igMarkets[o.epic]?.partial ? 1 : st.igMarkets[o.epic]?.contractSize ?? 1;
      const why = stopBlock(level, o.sl != null ? o.sl - o.level + level : null, sl, o.size, perPoint, o.currency);
      if (why) { toast(why); return; }
      useBroker.setState({ snap: { ...st.snap, orders: st.snap.orders.map((x) => (x.id === id ? { ...x, level, sl, tp, type } : x)) } });
      void deal('amend-order', {
        dealId: id, level, type,
        stopDistance: sl != null ? Math.abs(level - sl) * pointsIn(o.scale) : null, limitDistance: tp != null ? Math.abs(tp - level) * pointsIn(o.scale) : null,
      }, () => `${tag()} : ordre modifié (${level})`);
    },
  };
}
