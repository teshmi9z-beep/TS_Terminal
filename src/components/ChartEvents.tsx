import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Logical } from 'lightweight-charts';
import { useStore } from '../store/store';
import { assetEvents, assetNews, tvIdOf, type AssetEvent, type DividendEvent, type EarningsEvent, type NewsEvent } from '../data/assetInfo';
import { setFundamentalsTarget } from '../data/fundamentals';
import { openTool } from './tabs/tabActions';
import { big } from '../data/format';
import { indexAtOrBefore, timeToLogical, type ChartEngine } from './chartUtils';
import { LOCALE } from '../i18n/lang';

// The asset's events at the bottom of the chart, like TradingView: earnings (E), dividends (D)
// and news (⚡, one mark per bar with news), each with its card on hover. Upcoming ones stand in
// the empty area right of the last bar.

type Placed = { key: string; ev: AssetEvent; x: number };

const DAY_FMT = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
const SHORT_FMT = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (t: number) => DAY_FMT.format(new Date(t * 1000)).replace(/ (\d{2})$/, " '$1");
const shortDay = (t: number | null) => (t == null ? '—' : SHORT_FMT.format(new Date(t * 1000)));
const numFr = (v: number | null, d = 2) => (v == null ? '—' : v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} %`);

function Mark({ ev }: { ev: AssetEvent }) {
  if (ev.kind === 'news') return <span className="ce-mark news">⚡</span>;
  if (ev.kind === 'dividend') return <span className={`ce-mark div ${ev.upcoming ? 'upcoming' : ''}`}>D</span>;
  return <span className={`ce-mark earn ${ev.upcoming ? 'upcoming' : ''}`}>E</span>;
}

function EarningsCard({ ev, ticker, onFinancials }: { ev: EarningsEvent; ticker: string; onFinancials: () => void }) {
  return (
    <>
      <div className="ce-head"><span className="ce-badge earn">E</span>Bénéfices et revenus</div>
      <div className="ce-grid">
        <span>Date</span><b>{dayLabel(ev.time)}{ev.when && <span className="ce-when" title={ev.when === 'before' ? 'Avant l’ouverture' : 'Après la clôture'}>{ev.when === 'before' ? ' ☀' : ' ☾'}</span>}</b>
        {ev.period && <><span>{ev.period.startsWith('fin') ? 'Fin de période' : 'Période'}</span><b>{ev.period.replace(/^fin /, '')}</b></>}
      </div>
      <div className="ce-section">Bénéfices (BPA)</div>
      <div className="ce-grid">
        {ev.eps != null && <><span>Publié</span><b>{numFr(ev.eps, 3)}</b></>}
        <span>Estimation</span><b>{numFr(ev.epsEstimate, 3)}</b>
        {ev.surprisePct != null && <><span>Surprise</span><b className={ev.surprisePct >= 0 ? 'up' : 'down'}>{pct(ev.surprisePct)}</b></>}
      </div>
      {(ev.revenue != null || ev.revenueEstimate != null) && (
        <>
          <div className="ce-section">Revenu</div>
          <div className="ce-grid">
            {ev.revenue != null && <><span>Publié</span><b>{big(ev.revenue)}</b></>}
            <span>Estimation</span><b>{big(ev.revenueEstimate)}</b>
          </div>
        </>
      )}
      <button className="ce-more" onClick={onFinancials}>Voir tous les résultats de {ticker}</button>
    </>
  );
}

function DividendCard({ ev }: { ev: DividendEvent }) {
  return (
    <>
      <div className="ce-head"><span className="ce-badge div">D</span>Dividendes</div>
      <div className="ce-grid">
        <span>Date ex-dividende</span><b>{dayLabel(ev.time)}</b>
        <span>Date de paiement</span><b>{ev.payDate != null ? dayLabel(ev.payDate) : '—'}</b>
        <span>Montant</span><b>{numFr(ev.amount, 4).replace(/0{1,2}$/, '')}</b>
      </div>
    </>
  );
}

function NewsCard({ ev, onAll }: { ev: NewsEvent; onAll: () => void }) {
  return (
    <>
      <div className="ce-head"><span className="ce-badge news">⚡</span>Dernières mises à jour</div>
      {ev.items.slice(0, 4).map((n) => (
        <a key={n.id} className="ce-news" href={n.link ?? undefined} target="_blank" rel="noreferrer">
          <span className="ce-news-meta">{shortDay(n.published)} · {n.provider.name}</span>
          <span className="ce-news-title">{n.title}</span>
        </a>
      ))}
      <button className="ce-more link" onClick={onAll}>Voir tout ›</button>
    </>
  );
}

export default function ChartEvents({ engine }: { engine: RefObject<ChartEngine> }) {
  const symbol = useStore((s) => s.symbol);
  const settings = useStore((s) => s.chartSettings);
  const [events, setEvents] = useState<AssetEvent[]>([]);
  const [news, setNews] = useState<NewsEvent[]>([]);
  const [hover, setHoverNow] = useState<string | null>(null);
  const [, setFrame] = useState(0);
  // leaving a mark keeps its card a moment, to reach it with the mouse
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = (key: string) => { if (leaveTimer.current) clearTimeout(leaveTimer.current); setHoverNow(key); };
  const leave = () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); leaveTimer.current = setTimeout(() => setHoverNow(null), 250); };

  // the asset's events, loaded again when the symbol changes
  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    setNews([]);
    assetEvents(symbol).then((ev) => { if (!cancelled) setEvents(ev); });
    assetNews(symbol).then((items) => { if (!cancelled) setNews(items.map((n) => ({ kind: 'news', time: n.published, items: [n] }))); });
    return () => { cancelled = true; };
  }, [symbol]);

  // the marks follow the chart's scrolling and zooming
  useEffect(() => {
    let raf = 0;
    let prev = '';
    const loop = () => {
      const chart = engine.current.chart;
      if (chart) {
        const r = chart.timeScale().getVisibleLogicalRange();
        const sig = `${r?.from}|${r?.to}|${chart.paneSize(0).width}|${chart.panes()[0]?.getHeight()}|${engine.current.candles.length}`;
        if (sig !== prev) { prev = sig; setFrame((n) => n + 1); }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const e = engine.current;
  const candles = e.candles;
  const barsKey = `${candles.length}|${candles[0]?.time}|${candles[candles.length - 1]?.time}`;

  // news of one bar together (the newest first in the card)
  const newsMarks = useMemo(() => {
    const byBar = new Map<number, NewsEvent>();
    for (const n of news) {
      const i = indexAtOrBefore(candles, n.time);
      if (i < 0) continue;
      const cur = byBar.get(i);
      if (cur) cur.items.push(...n.items); else byBar.set(i, { kind: 'news', time: candles[i].time, items: [...n.items] });
    }
    for (const m of byBar.values()) m.items.sort((a, b) => b.published - a.published);
    return [...byBar.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news, barsKey]);

  const chart = e.chart;
  if (!chart || !candles.length) return null;
  const shown = [
    ...events.filter((ev) => (ev.kind === 'earnings' ? settings.showEarnings !== false : settings.showDividends !== false)),
    ...(settings.showNews !== false ? newsMarks : []),
  ];
  if (!shown.length) return null;
  const plotW = chart.paneSize(0).width;
  const paneH = chart.panes()[0]?.getHeight() ?? 0;
  const ts = chart.timeScale();

  // x of each mark; marks falling on the same spot sit side by side
  const placed: Placed[] = [];
  for (const ev of shown) {
    const l = timeToLogical(candles, ev.time);
    if (l == null) continue;
    const x0 = ts.logicalToCoordinate(Math.round(l) as Logical);
    if (x0 == null || x0 < 8 || x0 > plotW - 8) continue;
    let x: number = x0;
    while (placed.some((p) => Math.abs(p.x - x) < 18)) x += 18;
    placed.push({ key: `${ev.kind}:${ev.time}`, ev, x });
  }
  const hovered = placed.find((p) => p.key === hover);
  const openFinancials = () => {
    void tvIdOf(symbol).then((id) => { if (id) setFundamentalsTarget(id); openTool('fundamentals'); });
  };

  return (
    <div className="chart-events" style={{ width: plotW, height: paneH }}>
      {placed.map((p) => (
        <div
          key={p.key} className="ce-slot chart-ui" style={{ left: p.x }}
          onMouseEnter={() => enter(p.key)}
          onMouseLeave={leave}
        >
          <Mark ev={p.ev} />
        </div>
      ))}
      {hovered && (
        <div
          className={`ce-card chart-ui ${hovered.ev.kind}`}
          style={{ left: Math.max(4, Math.min(hovered.x - 20, plotW - 290)) }}
          onMouseEnter={() => enter(hovered.key)}
          onMouseLeave={leave}
        >
          {hovered.ev.kind === 'earnings' && <EarningsCard ev={hovered.ev} ticker={symbol.ticker} onFinancials={openFinancials} />}
          {hovered.ev.kind === 'dividend' && <DividendCard ev={hovered.ev} />}
          {hovered.ev.kind === 'news' && <NewsCard ev={hovered.ev} onAll={() => openTool('news')} />}
        </div>
      )}
    </div>
  );
}
