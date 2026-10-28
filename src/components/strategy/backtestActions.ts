import { useStore } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { loadHistory, runStrategy, type LoadedHistory } from '../../strategy/run';
import { loadLabBars, runDowRobot, runEmRobot, runRobot } from '../../robots/robotBacktest';
import { EM_LOAD_FROM } from '../../robots/emBacktest';
import { platformSymbol } from '../../data/labSymbols';
import type { IndicatorConfig, Symbol, Timeframe } from '../../types';
import { LOCALE } from '../../i18n/lang';

// recent histories, so edits and re-runs don't reload the bars each time
const cache = new Map<string, { at: number; data: LoadedHistory }>();
const CACHE_MS = 120_000;
// the lab's histories of the robots opened (a file on disk: kept while the app runs)
const labCache = new Map<string, number[][]>();
let runSeq = 0;

async function chartHistory(symbol: Symbol, timeframe: Timeframe, bars: number, run: number, prev: ReturnType<typeof useChartUi.getState>['backtest']['result']) {
  const key = `${symbol.ticker}|${timeframe}|${bars}`;
  let hist = cache.get(key);
  if (!hist || Date.now() - hist.at > CACHE_MS) {
    const data = await loadHistory(symbol, timeframe, bars, (n) => {
      if (run === runSeq) useChartUi.getState().setBacktest({ status: 'loading', progress: `Chargement de l’historique… ${n} barres`, result: prev });
    });
    hist = { at: Date.now(), data };
    cache.set(key, hist);
  }
  return hist.data;
}

const day = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

// a ROBOT indicator of the chart: from the report, on the lab's history of that robot;
// set up by hand, on the chart's own history
async function runRobotTest(cfg: IndicatorConfig, quiet: boolean) {
  const st = useStore.getState();
  const prev = useChartUi.getState().backtest.result;
  const run = ++runSeq;
  const o = cfg.robot;
  if (!quiet || !prev) useChartUi.getState().setBacktest({ status: 'loading', progress: o ? 'Chargement de l’historique du labo…' : 'Chargement de l’historique…', result: prev });
  try {
    let rows: number[][], source: string, symbol: Symbol, timeframe: string;
    if (o) {
      const key = `${o.dataset}|${o.from}|${o.to}`;
      rows = labCache.get(key) ?? await loadLabBars(o.dataset, o.from, o.to);
      labCache.set(key, rows);
      if (rows.length < 100) throw new Error(`Historique du labo introuvable pour ${o.dataset}.`);
      symbol = platformSymbol(o.ticker, o.market);
      timeframe = o.tf;
      source = `labo ${o.source}, ${day(o.from)} → ${day(o.to)}`;
    } else {
      const data = await chartHistory(st.symbol, st.timeframe, st.backtestBars, run, prev);
      rows = data.candles.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]);
      symbol = st.symbol;
      timeframe = st.timeframe;
      source = data.label;
    }
    if (run !== runSeq) return;
    useChartUi.getState().setBacktest({ status: 'loading', progress: `Calcul du robot sur ${rows.length.toLocaleString(LOCALE)} barres…`, result: prev });
    // the message shows before the computation holds the page
    await new Promise((r) => setTimeout(r, 30));
    if (run !== runSeq) return;
    const ctx = { symbol, timeframe, source, skipRollover: o?.source === 'HistData' };
    let result;
    if (cfg.type === 'EXPECTED_MOVE') {
      // the Expected Move robot: its regime reads the VIX's daily bars over the same years
      const vk = `yf_VIX_1d|${EM_LOAD_FROM}|${o?.to ?? 0}`;
      const vix = labCache.get(vk) ?? await loadLabBars('yf_VIX_1d', EM_LOAD_FROM - 30 * 86400, (o?.to ?? Date.now() / 1000) + 86400);
      labCache.set(vk, vix);
      if (run !== runSeq) return;
      result = runEmRobot(cfg, rows, vix, ctx);
    } else if (cfg.type === 'DOW_STRUCTURE') {
      // the Dow structure robot: the bars cleaned as its study read them (HistData's source name)
      result = runDowRobot(cfg, rows, { ...ctx, source: o?.source ?? '', market: o?.market ?? '' });
      result.source = source;
    } else result = runRobot(cfg, rows, ctx);
    if (run === runSeq) useChartUi.getState().setBacktest({ status: 'done', result });
  } catch (e) {
    if (run === runSeq) useChartUi.getState().setBacktest({ status: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

// the robot the tester follows on this chart, if any
// a lab robot, or the Expected Move / Dow structure indicator opened from its robot's report
export const isTesterRobot = (i: IndicatorConfig) => i.type === 'ROBOT' || ((i.type === 'EXPECTED_MOVE' || i.type === 'DOW_STRUCTURE') && !!i.robot);
export const testedRobot = (st = useStore.getState()) => st.indicators.find((i) => isTesterRobot(i) && i.id === st.testerRobot);

// loads the chart symbol's history and runs the active (or given) strategy on it, or the
// chart's robot the tester follows
export async function runBacktest(docId?: string, opts: { quiet?: boolean } = {}) {
  const st = useStore.getState();
  const robot = docId ? undefined : testedRobot(st);
  if (robot) return runRobotTest(robot, !!opts.quiet);
  const ui = useChartUi.getState();
  const doc = st.strategies.find((d) => d.id === (docId ?? st.activeStrategyId));
  if (!doc) return;
  const run = ++runSeq;
  const { symbol, timeframe, backtestBars } = st;
  const prev = ui.backtest.result;
  if (!opts.quiet || !prev) ui.setBacktest({ status: 'loading', progress: 'Chargement de l’historique…', result: prev });
  try {
    const hist = await chartHistory(symbol, timeframe, backtestBars, run, prev);
    if (run !== runSeq) return;
    const { result, error } = runStrategy(doc, hist.candles, { symbol, timeframe, source: hist.label });
    if (run !== runSeq) return;
    if (error || !result) { useChartUi.getState().setBacktest({ status: 'error', error: error ?? 'Erreur inconnue' }); return; }
    if (hist.simulated) result.warnings.unshift('Données réelles indisponibles pour ce symbole / cette unité : backtest sur des barres simulées.');
    useChartUi.getState().setBacktest({ status: 'done', result });
  } catch (e) {
    if (run === runSeq) useChartUi.getState().setBacktest({ status: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

// the chart scrolls to a trade (from the list of closed positions)
export { focusChartOn } from '../mainChart';
