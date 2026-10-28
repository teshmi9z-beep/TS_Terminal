import type { IndicatorConfig } from '../types';
import { DOW_STRUCTURE, HTF, dowParams, parseHours } from '../indicators/custom/dowStructure';
import { stringInput } from '../indicators/helpers';
import { dowAllow, dowHigherTrend, dowRun, type DowBars, type DowResult, type DowTrade } from './dow';
import { nyOffset, parisOffset } from './features';

// A Dow structure robot of the study (public/robots/dow.json) over a whole history: the
// indicator's settings (inputs) run by the engine (src/robots/dow.ts) on the lab's bars since
// 2020, cleaned as the study loaded them. Shared by the report (scripts/robots/dow-robots.ts),
// the strategy tester and the automatic mode, so all three see the same trades.

export const DOW_FROM = Date.UTC(2020, 0, 1) / 1000;
const STEP: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900 };

// the lab's rows [time, o, h, l, c, v] as the study read them: since 2020, impossible bars out,
// and for HistData's forex and metals at 15 minutes or less, the rollover's bid-only dip
export function dowBars(rows: number[][], source: string, market: string, tf: string): DowBars {
  const skipRoll = source === 'HistData' && market !== 'Index' && tf in STEP;
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  for (const r of rows) {
    if (r[0] < DOW_FROM) continue;
    if (skipRoll) {
      const a = (((r[0] + nyOffset(r[0])) % 86400) + 86400) % 86400, e = a + STEP[tf];
      if (e > 60300 && a < 65700) continue;
    }
    if (!(r[2] >= r[3]) || !(r[4] > 0)) continue;
    t.push(r[0]); o.push(r[1]); h.push(r[2]); l.push(r[3]); c.push(r[4]);
  }
  return { n: t.length, t, o, h, l, c };
}

// the engine on bars with the indicator's settings: its active hours and higher-timeframe trend
export function dowRobotRun(b: DowBars, cfg: Pick<IndicatorConfig, 'inputs' | 'type'>, draw = false): DowResult {
  const c = cfg as IndicatorConfig;
  const hours = parseHours(stringInput(c, DOW_STRUCTURE, 'hours'));
  const inHours = hours ? Array.from({ length: b.n }, (_, i) => {
    const t = b.t[i];
    return hours.has(Math.floor(((((t + parisOffset(t)) % 86400) + 86400) % 86400) / 3600)) ? 1 : 0;
  }) : undefined;
  const htfSec = HTF.find(([lbl]) => lbl === stringInput(c, DOW_STRUCTURE, 'htf'))?.[1] ?? -1;
  return dowRun(b, dowParams(c), dowAllow(b.n, inHours, htfSec >= 0 ? dowHigherTrend(b, htfSec) : undefined), draw);
}

export const dowRobotTrades = (b: DowBars, cfg: Pick<IndicatorConfig, 'inputs' | 'type'>): DowTrade[] => dowRobotRun(b, cfg).trades;
