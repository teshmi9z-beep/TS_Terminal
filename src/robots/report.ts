import type { LegParams, MoneyMgmt, Stats } from './engine';
import type { DatasetSummary } from './search';

// public/robots/report.json, written by the lab and shown in the "Robots" tab

export type RobotStrategy = {
  id: string;
  rank?: number;
  // 'spe': the Stoch Price Envelope range / trend selection, 'hr': the hour range (each its
  // own ranking), else the main one
  // 'em': the Expected Move robots (scripts/robots/em-publish.ts, public/robots/em.json), not
  // proven, run by their own rule (src/robots/emRule.ts) rather than the lab's 3 entries
  // 'dow': the Dow structure robots of that study (scripts/robots/dow-robots.ts, public/robots/dow-robots.json)
  set?: 'spe' | 'hr' | 'em' | 'dow';
  kind?: 'em' | 'dow';
  // the Dow robot's indicator settings (its chart, the tester and the automatic mode read them)
  inputs?: Record<string, number | string | boolean>;
  // what stands for the robustness line when it isn't the lab's neighbouring settings
  robustText?: string;
  // the future the robot trades in automatic mode (its chart and history are the lab's index)
  future?: string;
  // the lab file it was measured on, when the id doesn't start with it
  dataset?: string;
  // from a general round: the same setting passes on several markets of its class
  general?: boolean;
  name: string;
  symbol: string; market: string; source: string; tf: string;
  signal: { id: string; label: string; family: string };
  filter: { id: string; label: string };
  stop: { id: string; label: string };
  dir: number; dirLabel: string;
  legs: LegParams;
  cost: number;
  // length of the history, and the yearly return with 0.3 % per entry (compounded)
  years: number;
  annualPct: number;
  // neighbouring settings (other stops / exits) of the same signal, filter and side that also pass
  robust: { passed: number; total: number };
  // other markets / timeframes where the exact same robot passes
  alsoOn: string[];
  period: { from: number; to: number; split: number };
  stats: { full: Stats; is: Stats; oos: Stats; legs: Stats[] };
  money: {
    mm: MoneyMgmt; label: string; netProfit: number; netPct: number; maxDDPct: number;
    winRate: number; ratio: number; profitFactor: number; trades: number; finalEquity: number;
  }[];
  bestMM: MoneyMgmt;
  // [time, equity] with 0.3 % per entry
  equity: [number, number][];
  // latest signals: R of each leg, euros with 0.3 % per entry
  recent: { time: number; side: number; entry: number; legs: number[]; eur: number }[];
};

export type RobotReport = {
  generatedAt: number;
  rounds: { round: string; ranAt: number; tested: number }[];
  tested: number;
  // from: the first day measured (the market since 2020), missing on older reports
  criteria: { winRate: number; ratio: number; minTradesIS: number; minTradesOOS: number; split: number; capital: number; riskPerEntryPct: number; from?: number };
  candidates: number;
  datasets: DatasetSummary[];
  families: Record<string, { tested: number; passed: number }>;
  strategies: RobotStrategy[];
  // settings that meet the criteria on many markets of a class and timeframe at once
  // (the "general" rounds): less likely to be luck than the best setting of one market
  general?: GeneralSetting[];
};

export type GeneralSetting = {
  // the selection it belongs to (the Stoch Price Envelope one when missing)
  set?: 'spe' | 'hr';
  market: string; tf: string;
  signal: { id: string; label: string }; filter: { id: string; label: string }; stop: { id: string; label: string };
  dir: number; dirLabel: string; legs: LegParams;
  // markets where it passes, out of the class's markets on that timeframe
  passed: number; markets: number;
  // share of the markets with a positive check period, and the average R a year (all markets)
  posOOS: number; fullRY: number;
  on: string[];
  // when its general round ran (ms): before REAL_COSTS_FROM it was measured with the old,
  // much lower costs
  ranAt?: number;
};

// the lab counts each venue's real costs from this date on (ms); searches run before it
// used far lower ones (0.01 % for gold or oil, 0.004 % for forex)
export const REAL_COSTS_FROM = Date.UTC(2026, 8, 25, 17, 0);

// The hour-range study (scripts/robots/hour-study.ts, public/robots/hours.json): per
// market, for each key `${H}_${length}_${close}` (the range of hour H, Paris time):
// trades in the tuning / check periods, the precision of the break's direction minus
// the day's plain one in points (tuning / check: above 0 the break "knows" where the day
// goes, below it comes back more often than chance), the average R following the break
// with the stop at the range's other side (tuning / check), and the average R taking it
// the other way, held to 23:00 (tuning / check); costs paid.
export type HourCell = [nIS: number, nOOS: number, edgeIS: number, edgeOOS: number, followIS: number, followOOS: number, fadeIS: number, fadeOOS: number];
export type HourStudy = {
  // tf: the bars read; from: the first day looked at (the market since 2020 by default)
  generatedAt: number; tf: string; from: number;
  markets: { symbol: string; market: string; from: number; to: number; split: number; cells: Record<string, HourCell> }[];
};
