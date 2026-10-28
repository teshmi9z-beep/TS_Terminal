import { num, str, tvScan, resolveTv } from './tv';

// Option chains from TradingView's options screener: US stocks / ETFs / indices (OPRA)
// and futures options (CME, COMEX, NYMEX, CBOT). Volume and open interest come from
// Yahoo Finance (relayed as /api/yoptions) for the US listed options only.

export type Underlying = {
  id: string; // what the options are written on: NASDAQ:AAPL, SP:SPX, CME_MINI:ESZ2026
  ticker: string; // shown on the price pill: AAPL, ESZ2026
  input: string; // what was asked: ES1!
  name: string; logoid: string | null;
  price: number; change: number | null; changeAbs: number | null; currency: string;
  kind: 'stock' | 'index' | 'future';
  multiplier: number;
  yahoo: string | null; // Yahoo symbol for volume / open interest
};

const FUTURES_EX = /^(CME|CME_MINI|CBOT|CBOT_MINI|COMEX|NYMEX|ICEUS|ICEEUR|EUREX)$/;
// contract multiplier of the futures options, by root
const FUTURES_MULT: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, RTY: 50, GC: 100, MGC: 10, SI: 5000, HG: 25000, PL: 50,
  CL: 1000, NG: 10000, RB: 42000, HO: 42000, ZN: 1000, ZB: 1000, ZF: 1000, ZT: 2000, ZC: 50, ZS: 50, ZW: 50, ZL: 600, ZM: 100,
  '6E': 125000, '6J': 12500000, '6B': 62500,
};
const INDICES: Record<string, { id: string; yahoo: string }> = {
  SPX: { id: 'SP:SPX', yahoo: '^SPX' }, NDX: { id: 'NASDAQ:NDX', yahoo: '^NDX' },
};

async function quote(market: string, id: string) {
  const { rows } = await tvScan(market, { symbols: { tickers: [id] }, columns: ['close', 'description', 'logoid', 'change', 'change_abs', 'currency', 'name'] });
  const d = rows[0]?.d;
  const price = d ? num(d[0]) : null;
  return d && price != null
    ? { price, name: str(d[1]), logoid: str(d[2]) || null, change: num(d[3]), changeAbs: num(d[4]), currency: str(d[5]) || 'USD', ticker: str(d[6]) }
    : null;
}

const today = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// "ES1!" / "CME_MINI:ES1!" -> the nearest contract (the options of ES are written on ESZ2026...)
async function futureContract(text: string): Promise<{ id: string; root: string } | null> {
  const [ex, tk] = text.includes(':') ? text.split(':') : ['', text];
  const root = tk.replace(/\d!$/, '');
  const filter: object[] = [{ left: 'name', operation: 'equal', right: `${root}1!` }];
  const cont = await tvScan('futures', { filter, columns: ['root'], range: [0, 5] });
  const r = cont.rows.find((x) => !ex || x.s.startsWith(`${ex}:`)) ?? cont.rows[0];
  if (!r) return null;
  const rootId = str(r.d[0]) || `${r.s.split(':')[0]}:${root}`;
  const { rows } = await tvScan('futures', {
    filter: [{ left: 'root', operation: 'equal', right: rootId }, { left: 'expiration', operation: 'greater', right: today() }],
    columns: ['expiration'], sort: { sortBy: 'expiration', sortOrder: 'asc' }, range: [0, 1],
  });
  return rows[0] ? { id: rows[0].s, root } : null;
}

export async function resolveUnderlying(text: string): Promise<Underlying | null> {
  const t = text.trim().toUpperCase();
  if (!t) return null;
  const [ex, tk] = t.includes(':') ? t.split(':') : ['', t];
  // futures: ES1!, CME_MINI:ES1!, CME_MINI:ESZ2026
  if (/\d!$/.test(tk) || FUTURES_EX.test(ex)) {
    const c = /\d!$/.test(tk) ? await futureContract(t) : { id: t, root: tk.replace(/[FGHJKMNQUVXZ]\d{4}$/, '') };
    if (!c) return null;
    const q = await quote('futures', c.id);
    if (!q) return null;
    return { id: c.id, ticker: c.id.split(':')[1], input: tk, name: q.name, logoid: q.logoid, price: q.price, change: q.change, changeAbs: q.changeAbs, currency: q.currency, kind: 'future', multiplier: FUTURES_MULT[c.root] ?? 1, yahoo: null };
  }
  const idx = INDICES[tk];
  if (idx) {
    const q = await quote('global', idx.id);
    if (!q) return null;
    return { id: idx.id, ticker: tk, input: tk, name: q.name, logoid: q.logoid, price: q.price, change: q.change, changeAbs: q.changeAbs, currency: q.currency, kind: 'index', multiplier: 100, yahoo: idx.yahoo };
  }
  const r = t.includes(':') ? { id: t } : await resolveTv(t, 'america');
  if (!r) return null;
  const q = await quote('america', r.id);
  if (!q) return null;
  const ticker = r.id.split(':')[1];
  return { id: r.id, ticker, input: ticker, name: q.name, logoid: q.logoid, price: q.price, change: q.change, changeAbs: q.changeAbs, currency: q.currency, kind: 'stock', multiplier: 100, yahoo: ticker.replace('.', '-') };
}

// ---------------------------------------------------------------- expirations

export type Expiration = { key: string; exp: number; root: string; atmIv: number | null };

const expKey = (exp: number, root: string) => `${exp}|${root}`;
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.p as Promise<T>;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

const base = (u: Underlying) => ({
  filter: [{ left: 'type', operation: 'equal', right: 'option' }],
  index_filters: [{ name: 'underlying_symbol', values: [u.id] }],
});

// YYYYMMDD -> timestamp (ms) at the US close
export const expiryTime = (e: number) => Date.UTC(Math.floor(e / 10000), Math.floor(e / 100) % 100 - 1, e % 100, 20);
export const daysTo = (e: number) => Math.max(0, Math.round((Date.UTC(Math.floor(e / 10000), Math.floor(e / 100) % 100 - 1, e % 100) - Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000));

// every expiration (and its root, "EW4", "SPXW"...), with the implied volatility at the money;
// only the strikes around the price are read, which keeps the request small
export function fetchExpirations(u: Underlying): Promise<Expiration[]> {
  return cached(`exp|${u.id}`, 5 * 60_000, async () => {
    const b = base(u);
    const { rows } = await tvScan('options', {
      ...b,
      filter: [...b.filter, { left: 'strike', operation: 'in_range', right: [u.price * 0.97, u.price * 1.03] }],
      columns: ['expiration', 'root', 'strike', 'iv'], range: [0, 20000],
    });
    const now = Date.now();
    const by = new Map<string, Expiration & { best: number }>();
    for (const r of rows) {
      const exp = num(r.d[0]), root = str(r.d[1]), strike = num(r.d[2]), iv = num(r.d[3]);
      if (exp == null || expiryTime(exp) < now) continue;
      const k = expKey(exp, root);
      const e = by.get(k) ?? { key: k, exp, root, atmIv: null, best: Infinity };
      const dist = strike == null ? Infinity : Math.abs(strike - u.price);
      if (iv != null && iv > 0 && dist < e.best) { e.best = dist; e.atmIv = iv; }
      by.set(k, e);
    }
    return [...by.values()].map((e): Expiration => ({ key: e.key, exp: e.exp, root: e.root, atmIv: e.atmIv })).sort((a, b) => a.exp - b.exp || a.root.localeCompare(b.root));
  });
}

// ---------------------------------------------------------------- chains

export type OptionRow = {
  id: string; strike: number; type: 'call' | 'put';
  bid: number | null; ask: number | null; theo: number | null;
  iv: number | null; delta: number | null; gamma: number | null; theta: number | null; vega: number | null; rho: number | null;
  volume: number | null; oi: number | null;
};
export type Chain = { key: string; exp: number; root: string; rows: OptionRow[]; hasVolume: boolean };

type YahooContract = { contractSymbol: string; strike: number; volume?: number; openInterest?: number };
async function yahooChain(symbol: string, exp: number): Promise<Map<string, { volume: number | null; oi: number | null }>> {
  const date = Date.UTC(Math.floor(exp / 10000), Math.floor(exp / 100) % 100 - 1, exp % 100) / 1000;
  const res = await fetch(`/api/yoptions?symbol=${encodeURIComponent(symbol)}&date=${date}`);
  if (!res.ok) return new Map();
  const json = (await res.json()) as { optionChain?: { result?: { options?: { calls?: YahooContract[]; puts?: YahooContract[] }[] }[] } };
  const o = json.optionChain?.result?.[0]?.options?.[0];
  const out = new Map<string, { volume: number | null; oi: number | null }>();
  const add = (list: YahooContract[] | undefined, type: 'call' | 'put') => {
    for (const c of list ?? []) {
      const root = /^[A-Z]+/.exec(c.contractSymbol)?.[0] ?? '';
      const v = { volume: c.volume ?? null, oi: c.openInterest ?? null };
      out.set(`${root}|${type}|${c.strike}`, v);
      if (!out.has(`|${type}|${c.strike}`)) out.set(`|${type}|${c.strike}`, v);
    }
  };
  add(o?.calls, 'call');
  add(o?.puts, 'put');
  return out;
}

export function fetchChain(u: Underlying, e: Pick<Expiration, 'exp' | 'root'>): Promise<Chain> {
  return cached(`chain|${u.id}|${e.exp}|${e.root}`, 60_000, async () => {
    const b = base(u);
    const [scan, vol] = await Promise.all([
      tvScan('options', {
        ...b,
        filter: [...b.filter, { left: 'expiration', operation: 'equal', right: e.exp }, { left: 'root', operation: 'equal', right: e.root }],
        columns: ['strike', 'option-type', 'bid', 'ask', 'theoPrice', 'iv', 'delta', 'gamma', 'theta', 'vega', 'rho'],
        sort: { sortBy: 'strike', sortOrder: 'asc' },
        range: [0, 3000],
      }),
      u.yahoo ? yahooChain(u.yahoo, e.exp).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);
    const rows = scan.rows.map((r): OptionRow => {
      const strike = num(r.d[0]) ?? 0, type = str(r.d[1]) === 'put' ? 'put' : 'call';
      const v = vol.get(`${e.root}|${type}|${strike}`) ?? vol.get(`|${type}|${strike}`);
      return {
        id: r.s, strike, type,
        bid: num(r.d[2]), ask: num(r.d[3]), theo: num(r.d[4]), iv: num(r.d[5]),
        delta: num(r.d[6]), gamma: num(r.d[7]), theta: num(r.d[8]), vega: num(r.d[9]), rho: num(r.d[10]),
        volume: v?.volume ?? null, oi: v?.oi ?? null,
      };
    });
    return { key: expKey(e.exp, e.root), exp: e.exp, root: e.root, rows, hasVolume: vol.size > 0 };
  });
}

// calls and puts of a strike side by side
export type StrikeRow = { strike: number; call?: OptionRow; put?: OptionRow };
export function byStrike(rows: OptionRow[]): StrikeRow[] {
  const m = new Map<number, StrikeRow>();
  for (const o of rows) {
    const r = m.get(o.strike) ?? { strike: o.strike };
    r[o.type] = o;
    m.set(o.strike, r);
  }
  return [...m.values()].sort((a, b) => a.strike - b.strike);
}

export const mid = (o: OptionRow | undefined) =>
  !o ? null : o.bid != null && o.ask != null && o.ask > 0 ? (o.bid + o.ask) / 2 : o.theo;

// ---------------------------------------------------------------- payoff

export type Leg = { id: string; type: 'call' | 'put'; strike: number; qty: number; premium: number; iv: number; expiration: number; root: string; mult: number };

// standard normal CDF (Abramowitz-Stegun)
export function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export function blackScholes(type: 'call' | 'put', s: number, k: number, years: number, iv: number, r = 0.04): number {
  if (years <= 0 || iv <= 0) return Math.max(0, type === 'call' ? s - k : k - s);
  const v = iv * Math.sqrt(years);
  const d1 = (Math.log(s / k) + (r + (iv * iv) / 2) * years) / v;
  const d2 = d1 - v;
  return type === 'call' ? s * ncdf(d1) - k * Math.exp(-r * years) * ncdf(d2) : k * Math.exp(-r * years) * ncdf(-d2) - s * ncdf(-d1);
}

const YEAR_MS = 3.156e10;

// P&L of the legs at the underlying price s: at expiry, or at `now` (theoretical, Black-Scholes)
export function legsPnl(legs: Leg[], s: number, now?: number): number {
  let pnl = 0;
  for (const l of legs) {
    const value = now == null
      ? Math.max(0, l.type === 'call' ? s - l.strike : l.strike - s)
      : blackScholes(l.type, s, l.strike, Math.max(0, (expiryTime(l.expiration) - now) / YEAR_MS), l.iv);
    pnl += (value - l.premium) * l.qty * l.mult;
  }
  return pnl;
}

export type PayoffStats = { cost: number; maxGain: number | null; maxLoss: number | null; breakevens: number[] };

export function payoffStats(legs: Leg[], lo: number, hi: number): PayoffStats {
  const cost = legs.reduce((s, l) => s + l.premium * l.qty * l.mult, 0);
  const n = 600;
  let max = -Infinity, min = Infinity;
  const breakevens: number[] = [];
  let prev = legsPnl(legs, lo);
  for (let i = 0; i <= n; i++) {
    const s = lo + ((hi - lo) * i) / n;
    const v = legsPnl(legs, s);
    max = Math.max(max, v);
    min = Math.min(min, v);
    if (i > 0 && Math.sign(v) !== Math.sign(prev) && v !== 0) {
      const s0 = lo + ((hi - lo) * (i - 1)) / n;
      breakevens.push(s0 + ((s - s0) * -prev) / (v - prev));
    }
    prev = v;
  }
  // the extremes are at a strike or at 0 (puts); beyond the last strike, the slope of the calls
  for (const s of [0, ...legs.map((l) => l.strike)]) {
    const v = legsPnl(legs, s);
    max = Math.max(max, v);
    min = Math.min(min, v);
  }
  const slope = legs.reduce((s, l) => s + (l.type === 'call' ? l.qty : 0), 0);
  return { cost, maxGain: slope > 0 ? null : max, maxLoss: slope < 0 ? null : min, breakevens };
}

// chance that the P&L at expiry is positive, the underlying following a lognormal law
export function probabilityOfProfit(legs: Leg[], spot: number, iv: number, years: number): number {
  if (years <= 0 || iv <= 0) return legsPnl(legs, spot) > 0 ? 1 : 0;
  const sd = iv * Math.sqrt(years);
  const n = 400;
  let p = 0, prevCdf = 0;
  for (let i = 1; i <= n; i++) {
    const z = -4 + (8 * i) / n;
    const cdf = ncdf(z);
    const s = spot * Math.exp(-0.5 * sd * sd + sd * (z - 4 / n));
    if (legsPnl(legs, s) > 0) p += cdf - prevCdf;
    prevCdf = cdf;
  }
  return p;
}

// strike where the options of an expiration are worth the least at expiry ("max pain")
export function maxPain(rows: StrikeRow[]): number | null {
  let best: number | null = null, bestV = Infinity;
  for (const k of rows) {
    let v = 0;
    for (const r of rows) {
      if (r.call?.oi) v += Math.max(0, k.strike - r.strike) * r.call.oi;
      if (r.put?.oi) v += Math.max(0, r.strike - k.strike) * r.put.oi;
    }
    if (v < bestV) { bestV = v; best = k.strike; }
  }
  return bestV > 0 ? best : null;
}
