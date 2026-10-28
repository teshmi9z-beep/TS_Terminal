import type { Candle, Symbol, Timeframe } from '../../types';
import { feedChain, tradFiPerp } from './resolve';
import { BinanceKlineSession, BinanceTickSession } from './binance';
import { YahooSession } from './yahoo';
import { SimSession } from './sim';
import { AggregatedSession } from './aggregate';
import { binancePlan, ibPlan, yahooPlan } from './intervals';
import { IbSession } from './ib';
import { isDailyTf, isTickTf, parseTf, tfSeconds } from '../timeframes';
import { CachingSession, openLocal, seriesInfo } from './local';
import { LabBackedSession, LabSession, labSources, latestSource } from './lab';
import { autoSaveEnabled } from '../offline/db';
import { EstimatedSession, estimatorFor } from './futuresEstimate';
import type { FeedRef, FeedSession } from './types';
import { LOCALE } from '../../i18n/lang';

export type { FeedSession, FeedSource, MarketMeta } from './types';

// null when the source can't serve this timeframe (the next source in the chain is tried)
function createSession(ref: FeedRef, sym: Symbol, tf: Timeframe): FeedSession | null {
  switch (ref.source) {
    case 'binance': {
      if (isTickTf(tf)) return new BinanceTickSession(ref.id, parseTf(tf).n, ref.market);
      if (ref.market === 'futures') return null;
      const p = binancePlan(tf);
      if (!p) return null;
      const s = new BinanceKlineSession(ref.id, p.native);
      return p.aggregateTo ? new AggregatedSession(s, p.aggregateTo, false) : s;
    }
    case 'yahoo': {
      const p = yahooPlan(tf);
      if (!p) return null;
      const s = new YahooSession(ref.id, p.native);
      return p.aggregateTo ? new AggregatedSession(s, p.aggregateTo, true) : s;
    }
    case 'ib': {
      const p = ibPlan(tf);
      if (!p) return null;
      const s = new IbSession(ref.id, p.native);
      return p.aggregateTo ? new AggregatedSession(s, p.aggregateTo, false) : s;
    }
    case 'sim': return new SimSession(sym, tf);
    case 'local': return null;
  }
}

export type OpenedFeed = { session: FeedSession; candles: Candle[]; fallbackReason?: string };

export type OpenOptions = {
  // write the bars to the local store (default: the "save charts" setting)
  save?: boolean;
  // page back into saved bars once the source has none left (default: same as save)
  localHistory?: boolean;
  // the delayed index futures get their newest bars estimated in real time (charts only)
  estimate?: boolean;
};

const dateTime = (t: number) => new Date(t * 1000).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// walks the symbol's feed chain (Binance > Yahoo) until one returns data, its
// older pages continuing with the robot lab's history on disk; then that history
// or the bars saved on this computer; then the simulator
export async function openFeed(sym: Symbol, tf: Timeframe, opts: OpenOptions = {}): Promise<OpenedFeed> {
  let reason: string | undefined;
  const online = navigator.onLine !== false;
  const save = opts.save ?? autoSaveEnabled();
  const labs = await labSources(sym, tf).catch(() => []);
  // an up to date lab history (last month) makes the bars saved from charts useless
  const labRecent = labs.some((s) => s.file.to >= Date.now() / 1000 - 30 * 86400);
  if (online) {
    const chain = feedChain(sym).filter((r) => r.source !== 'sim');
    // no tick feed outside crypto, except the TradFi perpetuals of Binance Futures
    if (isTickTf(tf) && !chain.some((r) => r.source === 'binance')) {
      const perp = await tradFiPerp(sym);
      if (perp) chain.unshift({ source: 'binance', id: perp, market: 'futures' });
    }
    for (const ref of chain) {
      const created = createSession(ref, sym, tf);
      if (!created) {
        reason ??= isTickTf(tf)
          ? 'Les graphiques en ticks n’existent qu’en crypto, pour les métaux, le pétrole, le gaz et les actions américaines (transactions Binance) : ce marché n’a pas de flux de ticks gratuit.'
          : /s$/.test(tf)
            ? 'Les unités en secondes n’existent qu’en crypto (Binance).'
            : 'Cette unité de temps n’est pas fournie par la source de données.';
        continue;
      }
      // the lab's history is complete where the bars saved from charts have gaps: it comes first
      const cached = save ? new CachingSession(created, seriesInfo(sym, tf, ref, created.label), opts.localHistory ?? !labRecent) : created;
      let session: FeedSession = labs.length
        ? new LabBackedSession(cached, labs, (id) => ref.source === 'binance' && !ref.market && id.startsWith('binance_'))
        : cached;
      const est = opts.estimate && (ref.source === 'ib' || ref.source === 'yahoo') ? estimatorFor(sym.ticker) : null;
      const step = tfSeconds(tf);
      if (est && step && step >= 60) session = new EstimatedSession(session, est, step, isDailyTf(tf));
      try {
        const candles = await session.load();
        if (candles.length >= 2) return { session, candles };
        reason = `${session.label}: aucune donnee`;
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
        console.warn(`[feed] ${ref.source}:${ref.id} ${tf} ->`, reason);
      }
    }
  }
  const why = online ? 'Source injoignable' : 'Hors ligne';
  const local = await openLocal(sym, tf).catch(() => null);
  // whichever goes further: the lab's history or the bars saved from charts
  const lab = latestSource(labs);
  if (lab && (!local || lab.file.to >= local.newest)) {
    const session = new LabSession(lab);
    const candles = await session.load().catch(() => []);
    if (candles.length >= 2) return { session, candles, fallbackReason: `${why} : historique ${lab.file.source} enregistré sur cet ordinateur, jusqu’au ${dateTime(session.newest)}.` };
  }
  if (local) {
    const candles = await local.session.load();
    if (candles.length >= 2) {
      return { session: local.session, candles, fallbackReason: `${why} : données enregistrées sur cet ordinateur, jusqu’au ${dateTime(local.newest)}.` };
    }
  }
  const sim = new SimSession(sym, tf);
  return {
    session: sim, candles: await sim.load(),
    fallbackReason: online ? reason : 'Hors ligne, et aucune donnée enregistrée pour ce symbole dans cette unité de temps (menu ••• > Données hors ligne).',
  };
}
