import { Features, toBars, resample, type Bars } from './features';
import { FILTERS, SIGNALS, STOPS } from './catalog';
import { simulate, statsOf, type LegParams, type LegTrade, type Stats } from './engine';

// The search over one market / timeframe: every signal x regime filter x stop x
// direction x exit settings. The first 70 % of the history picks, the last 30 %
// (never used to choose) must confirm.

export type DatasetFile = { id: string; market: string; source: string; symbol: string; tf: string; bars: number[][] };

export const LEG_SETS: LegParams[] = [
  { tpR: 1, trailK: 2 }, { tpR: 1, trailK: 3 },
  { tpR: 1.5, trailK: 2 }, { tpR: 1.5, trailK: 3 },
  { tpR: 2, trailK: 2 }, { tpR: 2, trailK: 3 },
];
export const DIRS = [0, 1, -1] as const;

// what a round of the lab tries. r1: every signal with 6 exit settings. r2: the
// families that worked, finer settings; the 20 exit settings only for the
// combinations that already pass the tuning period with one of 3 quick ones.
export type Plan = {
  signals: (id: string) => boolean; filters: (id: string) => boolean; stops: (id: string) => boolean;
  screenLegs: LegParams[]; refineLegs: LegParams[]; tfs: (tf: string) => boolean;
};
const R1_STOPS = ['atr1', 'atr1.5', 'atr2', 'atr3', 'swing5', 'swing10'];
const REFINE: LegParams[] = [];
for (const tpR of [1, 1.5, 2, 2.5, 3]) for (const trailK of [1.5, 2, 3, 4]) REFINE.push({ tpR, trailK });
// the Stoch Price Envelope range / trend filters (their own rounds)
const ENV_FILTER = /^(b_|s_h|h\d[hdw]_)/;
const SPE_TFS = ['15m', '30m', '1h', '4h', '1d'];
export const PLANS: Record<string, Plan> = {
  r1: {
    signals: (id) => !/^spe_break_\d+_p|^spe_break_(20|30)$|^env_|^hr_/.test(id),
    filters: (id) => !/^(zl50|zl400|stairs_|tsh_zl200|htf|atrx)/.test(id) && !ENV_FILTER.test(id),
    stops: (id) => R1_STOPS.includes(id),
    screenLegs: LEG_SETS, refineLegs: [], tfs: () => true,
  },
  r2: {
    signals: (id) => /^(spe_break|tsh_flip|tsh_start|tsh_sig|zl_x|zl_cross|fvg_retest|sr_ext|sr_kd)/.test(id),
    filters: (id) => !ENV_FILTER.test(id),
    stops: (id) => !id.startsWith('rng_'),
    screenLegs: [{ tpR: 1.5, trailK: 2 }, { tpR: 2, trailK: 3 }, { tpR: 1, trailK: 3 }],
    refineLegs: REFINE,
    tfs: (tf) => !['1m', '5m'].includes(tf),
  },
  // r3: the same families with the higher-timeframe and volatility filters
  r3: {
    signals: (id) => /^(spe_break|tsh_flip|tsh_start|tsh_sig|zl_x|zl_cross|fvg_retest|sr_ext|sr_kd)/.test(id),
    filters: (id) => /^(htf|atrx)/.test(id),
    stops: (id) => !id.startsWith('rng_'),
    screenLegs: [{ tpR: 1.5, trailK: 2 }, { tpR: 2, trailK: 3 }, { tpR: 1, trailK: 3 }],
    refineLegs: REFINE,
    tfs: (tf) => !['1m', '5m'].includes(tf),
  },
  // s1: the Stoch Price Envelope alone, range or trend read on this timeframe and on a higher one
  s1: {
    signals: (id) => /^(env_|spe_)/.test(id),
    filters: (id) => id === 'none' || ENV_FILTER.test(id),
    stops: (id) => ['atr1', 'atr1.5', 'atr2', 'atr3', 'swing5', 'swing10', 'swing20'].includes(id),
    screenLegs: [{ tpR: 1.5, trailK: 2 }, { tpR: 2, trailK: 3 }, { tpR: 1, trailK: 3 }],
    refineLegs: REFINE,
    tfs: (tf) => SPE_TFS.includes(tf),
  },
};

// per side, fraction of the price: fees + spread + slippage, when the venue is unknown
export const COSTS: Record<string, number> = { Crypto: 0.001, Forex: 0.0002, Commodity: 0.0003, Index: 0.0002, Stock: 0.0005 };

// What a retail account really pays per side on the venue the market trades on (fees plus
// the usual spread). Until 2026-09-25 the lab counted far less (0.01 % for gold or oil
// on Binance Futures, whose fee alone is 0.05 %; 0.004 % for any forex pair): tight-stop
// intraday robots looked profitable only thanks to it (cost in R = 2 x cost x price / stop).
const FX_MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY'];
export function costOf(ds: { id: string; market: string; symbol: string }): number {
  const prefix = ds.id.split('_')[0];
  const s = ds.symbol.toUpperCase();
  // Binance spot: 0.1 % a side; Binance Futures (the TradFi perpetuals): 0.05 % taker plus the spread
  if (prefix === 'binance') return 0.001;
  if (prefix === 'bnfut') return 0.0006;
  if (ds.market === 'Forex') {
    if (FX_MAJORS.includes(s)) return 0.0001;
    // the lira, rand and peso: wide spreads; the Nordic, Central European and Asian pairs: narrower
    if (/TRY|ZAR|MXN/.test(s)) return 0.0008;
    if (/NOK|SEK|PLN|DKK|HKD|SGD|HUF|CZK/.test(s)) return 0.0004;
    return 0.0002;
  }
  return COSTS[ds.market] ?? 0.0005;
}

export const CRITERIA = { winRate: 50, ratio: 1.3, minTradesIS: 60, minTradesOOS: 30 };
export const SPLIT = 0.7;
export const WARMUP = 250;

export type Candidate = {
  ds: string; signal: string; filter: string; stop: string; dir: 0 | 1 | -1; legs: LegParams;
  is: Stats; oos: Stats; full: Stats;
  // settings of the same signal, filter and side (other stops / exits) that also pass, out of robustTotal
  robust?: number;
  robustTotal?: number;
};

export type DatasetSummary = {
  id: string; symbol: string; tf: string; market: string; source: string; bars: number; from: number; to: number;
  tested: number; passIS: number; passBoth: number; ms: number;
  // best total R among strategies with a win rate above 50 % in both periods (even with a small ratio)
  best: { signal: string; filter: string; winRate: number; ratio: number; totalR: number } | null;
  families: Record<string, { tested: number; passed: number }>;
};

const passes = (s: Stats, min: number) => s.trades >= min && s.winRate > CRITERIA.winRate && s.ratio > CRITERIA.ratio && s.totalR > 0;

export function isIntraday(tf: string) { return /m$|^1h$|^2h$/.test(tf); }

export function loadBars(ds: DatasetFile): Bars {
  return toBars(ds.bars);
}

export function derive4h(ds: DatasetFile): DatasetFile {
  return { ...ds, id: ds.id.replace(/_1h$/, '_4h'), tf: '4h', bars: resample(ds.bars, 4 * 3600) };
}

// the whole context of one dataset, reused by the search and the report
export class Lab {
  readonly ds: DatasetFile;
  readonly b: Bars;
  readonly f: Features;
  readonly split: number;
  readonly cost: number;
  private readonly filters = new Map<string, { long: Uint8Array; short: Uint8Array }>();
  private readonly stops = new Map<string, { long: Float64Array; short: Float64Array }>();
  private readonly sigs = new Map<string, Int8Array>();

  constructor(ds: DatasetFile) {
    this.ds = ds;
    this.b = loadBars(ds);
    this.f = new Features(this.b);
    this.split = Math.floor(this.b.n * SPLIT);
    this.cost = costOf(ds);
  }

  signal(id: string) {
    let s = this.sigs.get(id);
    if (!s) { s = SIGNALS.find((x) => x.id === id)!.make(this.f); this.sigs.set(id, s); }
    return s;
  }
  filter(id: string) {
    let v = this.filters.get(id);
    if (!v) { v = FILTERS.find((x) => x.id === id)!.make(this.f); this.filters.set(id, v); }
    return v;
  }
  // the hour-range stops depend on the signal's range
  stop(id: string, signal?: string) {
    const key = id.startsWith('rng_') ? `${id}|${signal}` : id;
    let v = this.stops.get(key);
    if (!v) { v = STOPS.find((x) => x.id === id)!.make(this.f, signal); this.stops.set(key, v); }
    return v;
  }
  // frees what one signal needed: the hour-range rounds go through thousands of signals
  forget(signal: string) {
    this.sigs.delete(signal);
    for (const k of [...this.stops.keys()]) if (k.includes('|')) this.stops.delete(k);
    this.f.drop('hr');
  }

  run(c: Pick<Candidate, 'signal' | 'filter' | 'stop' | 'dir' | 'legs'>): LegTrade[] {
    const a = this.filter(c.filter), s = this.stop(c.stop, c.signal);
    return simulate(this.b, {
      sig: this.signal(c.signal), allowLong: a.long, allowShort: a.short, stopLong: s.long, stopShort: s.short,
      dir: c.dir, legs: c.legs, cost: this.cost, atr: this.f.atr(14), warmup: WARMUP,
      // HistData's bars are bid prices: its rollover dips are left out
      skip: this.ds.source === 'HistData' ? this.f.rollover() : undefined,
    });
  }

  search(plan: Plan = PLANS.r1, maxKeep = 150): { summary: DatasetSummary; candidates: Candidate[] } {
    const t0 = Date.now();
    const { ds, b } = this;
    const intraday = isIntraday(ds.tf);
    const candidates: Candidate[] = [];
    const families: DatasetSummary['families'] = {};
    let tested = 0, passIS = 0, passBoth = 0;
    let best: DatasetSummary['best'] = null;
    const stops = STOPS.filter((s) => plan.stops(s.id));
    const legSets = [...plan.screenLegs, ...plan.refineLegs.filter((r) => !plan.screenLegs.some((x) => x.tpR === r.tpR && x.trailK === r.trailK))];
    for (const sg of SIGNALS) {
      if (!plan.signals(sg.id)) continue;
      const sig = this.signal(sg.id);
      let count = 0;
      for (let i = WARMUP; i < b.n; i++) if (sig[i]) count++;
      // too few signals for the minimum number of trades
      if (count < 30) { if (sg.id.startsWith('hr_')) this.forget(sg.id); continue; }
      const fam = (families[sg.family] ??= { tested: 0, passed: 0 });
      for (const fl of FILTERS) {
        if ((fl.intraday && !intraday) || (fl.tfs && !fl.tfs.includes(ds.tf)) || !plan.filters(fl.id)) continue;
        for (const st of stops) {
          for (const dir of DIRS) {
            let screened = false;
            for (let li = 0; li < legSets.length; li++) {
              // the finer exits only where a quick one already passes the tuning period
              if (li >= plan.screenLegs.length && !screened) break;
              const legs = legSets[li];
              const spec = { signal: sg.id, filter: fl.id, stop: st.id, dir, legs };
              const trades = this.run(spec);
              tested++; fam.tested++;
              const is = statsOf(trades, 0, this.split);
              if (!passes(is, CRITERIA.minTradesIS)) {
                if (is.winRate > 50 && is.trades >= CRITERIA.minTradesIS) {
                  const full = statsOf(trades);
                  if (full.winRate > 50 && (!best || full.totalR > best.totalR)) best = { signal: sg.id, filter: fl.id, winRate: full.winRate, ratio: full.ratio, totalR: full.totalR };
                }
                continue;
              }
              passIS++;
              screened = true;
              const oos = statsOf(trades, this.split);
              if (!passes(oos, CRITERIA.minTradesOOS)) continue;
              passBoth++; fam.passed++;
              const full = statsOf(trades);
              candidates.push({ ds: ds.id, ...spec, is, oos, full });
            }
          }
        }
      }
      if (sg.id.startsWith('hr_')) this.forget(sg.id);
    }
    const hood = new Map<string, number>();
    const hk = (c: Candidate) => `${c.signal}|${c.filter}|${c.dir}`;
    for (const c of candidates) hood.set(hk(c), (hood.get(hk(c)) ?? 0) + 1);
    for (const c of candidates) { c.robust = hood.get(hk(c)); c.robustTotal = stops.length * legSets.length; }
    candidates.sort((x, y) => y.full.totalR - x.full.totalR);
    return {
      candidates: candidates.slice(0, maxKeep),
      summary: {
        id: ds.id, symbol: ds.symbol, tf: ds.tf, market: ds.market, source: ds.source, bars: b.n, from: b.t[0], to: b.t[b.n - 1],
        tested, passIS, passBoth, ms: Date.now() - t0, best, families,
      },
    };
  }
}
