import { FILTERS, HR_LENGTHS, SIGNALS, STOPS } from '../../src/robots/catalog';
import type { LegParams } from '../../src/robots/engine';

// The settings the "general" rounds try on every market of a class and timeframe (all
// forex pairs in 1 hour, all cryptos in 4 hours...). A robot that passes on many
// markets at once is much less likely to be luck than the best of 100 000 settings on
// a single one.
// - s2: the Stoch Price Envelope families that stood out in round night-s1, with the
//   range / trend filters of this timeframe and of the higher ones (envelopes 50, 200);
// - s3: for forex, commodities and indices intraday: entries with a confirmation, the
//   higher timeframe's envelope 100 too, and the London + New York sessions;
// - h1: the hour range (the candle of hour H, Paris time, and the close out of it) for
//   every hour and variant, with stops at the range and the plain exits: which hours
//   launch the day, on which markets;
// - h2: the hour range read with the market's regime: follow the break in a trend, take
//   it the other way in a range (the Stoch Price Envelope regimes of this timeframe and
//   of the higher one, choppiness, efficiency, the ZLEMA 200's side), first break only.

export type Spec = { signal: string; filter: string; stop: string; dir: 0 | 1 | -1; legs: LegParams };
type Grid = { signals: string[] | ((tf: string) => string[]); filters: (tf: string) => string[]; stops: string[]; dirs: (0 | 1 | -1)[]; legs: LegParams[] };

const baseFilters = ['none', ...['trend', 'notrange', 'range'].flatMap((r) => [50, 100, 200].map((k) => `b_${r}_${k}`))];
const htfFilters = (tf: string, re: RegExp) => FILTERS.filter((f) => f.tfs?.includes(tf) && re.test(f.id)).map((f) => f.id);

export const GRIDS: Record<string, Grid> = {
  s2: {
    signals: [
      'spe_break_20', 'spe_break_30', 'spe_break_50', 'spe_break_100', 'spe_break_200',
      'spe_break_20_p5', 'spe_break_30_p5', 'spe_break_50_p5', 'spe_break_100_p5',
      'spe_break_20_p20', 'spe_break_30_p20', 'spe_break_100_p20',
      'env_rev5_50', 'env_rev5_100', 'env_rev15_100', 'env_kx_20', 'env_kx_50',
      'env_osig_100', 'env_pb_sig_100', 'env_pb_mid_50', 'spe_rev_50',
    ],
    filters: (tf) => [...baseFilters, ...htfFilters(tf, /^h\d[hdw]_\w+_(50|200)$/)],
    stops: ['atr1', 'atr1.5', 'atr2', 'atr3', 'swing5', 'swing10'],
    dirs: [0, 1, -1],
    legs: [{ tpR: 1.5, trailK: 2 }, { tpR: 2, trailK: 3 }, { tpR: 2.5, trailK: 1.5 }, { tpR: 3, trailK: 3 }],
  },
  s3: {
    signals: [
      'spe_break_50', 'spe_break_100', 'spe_break_20_p5', 'spe_break_30_p5', 'spe_break_50_p5', 'spe_break_100_p5',
      'spe_break_20_p20', 'spe_break_30_p20', 'spe_break_100_p20',
      'env_pb_sig_50', 'env_pb_sig_100', 'env_pb_sig_200', 'env_pb_mid_50', 'env_pb_mid_100',
      'env_pbr_50', 'env_pbr_100', 'env_pbr_200', 'env_rrv_50', 'env_rrv_100', 'env_rrv_200',
      'env_rev5_50', 'env_rev15_50', 'env_rev15_100', 'spe_rev_100', 'env_kx_20', 'env_kx_50',
    ],
    filters: (tf) => [...baseFilters, ...(tf === '1d' ? [] : ['session']), ...htfFilters(tf, /^(s_)?h\d[hdw]_/)],
    stops: ['atr1', 'atr1.5', 'atr2', 'swing5', 'swing10'],
    dirs: [0, 1, -1],
    legs: [{ tpR: 1, trailK: 2 }, { tpR: 1.5, trailK: 2 }, { tpR: 2, trailK: 3 }],
  },
  h1: {
    signals: (tf) => hourRangeSignals(tf),
    filters: () => ['none'],
    stops: ['rng_opp', 'rng_mid', 'atr1.5'],
    dirs: [0, 1, -1],
    legs: [{ tpR: 1, trailK: 2 }, { tpR: 2, trailK: 3 }],
  },
  h2: {
    signals: (tf) => hourRangeSignals(tf).filter((id) => /^hr_\d+_(1h|2h|4h)_d_[cb]_[fr]$/.test(id)),
    filters: (tf) => [
      'b_range_100', 'b_trend_100', 'b_notrange_100', 'chop50', 'er30', 'zl200', 'htf4_zl50',
      ...(tf === '15m' ? ['h4h_range_50', 'h4h_trend_50'] : ['h1d_range_50', 'h1d_trend_50']),
    ],
    stops: ['rng_opp', 'rng_mid', 'atr1.5'],
    dirs: [0, 1, -1],
    legs: [{ tpR: 1, trailK: 2 }, { tpR: 2, trailK: 3 }],
  },
};

// the hour-range signals a timeframe can read: a range at least one bar long
const TF_MIN: Record<string, number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
export function hourRangeSignals(tf: string): string[] {
  return SIGNALS.filter((s) => {
    const m = /^hr_\d+_(\w+?)_/.exec(s.id);
    return m && TF_MIN[tf] && HR_LENGTHS[m[1]] >= TF_MIN[tf];
  }).map((s) => s.id);
}

// every setting of a grid on a timeframe, always in the same order (results are indexed by it)
export function specsOf(tf: string, grid = 's2'): Spec[] {
  const g = GRIDS[grid];
  const out: Spec[] = [];
  const signals = typeof g.signals === 'function' ? g.signals(tf) : g.signals;
  for (const signal of signals) for (const filter of g.filters(tf)) for (const stop of g.stops) for (const dir of g.dirs) for (const legs of g.legs) {
    out.push({ signal, filter, stop, dir, legs });
  }
  return out;
}

// stats kept per setting and market: tuning period, check period, whole history
export const FIELDS = ['isTrades', 'isWin', 'isRatio', 'isR', 'oosTrades', 'oosWin', 'oosRatio', 'oosR', 'fullR', 'fullDD'] as const;
export const NF = FIELDS.length;

// the stops and filters exist (a typo would silently test nothing)
for (const g of Object.values(GRIDS)) for (const s of g.stops) if (!STOPS.some((x) => x.id === s)) throw new Error(`stop inconnu : ${s}`);
