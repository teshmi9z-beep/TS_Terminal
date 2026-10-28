import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Logical } from 'lightweight-charts';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { useQuotes } from '../data/feeds/quotes';
import { currencySign, eurPerUnit, quoteCurrency } from '../data/fx';
import { barCloseTime, formatPrice, indexAtOrBefore, type ChartEngine } from './chartUtils';
import { useTradingAccount } from './tradingAccount';
import { zoneOffsetSec } from '../data/timeZone';
import { LOCALE } from '../i18n/lang';

// The trades of the account on the chart, like ProRealTime: on each bar an arrow
// for the positions opened there (up and green for a buy, down and red for a
// sell) and a cross for those closed (green when bought back, red when sold), with
// their number when there are several. Hovering one lists them: quantity @ price,
// time, the position before => after and, for a close, what it made.
// During a replay: the replay account's trades.

// one execution: a position opened or closed
type Exec = {
  key: string; t: number; buy: boolean; open: boolean; qty: number; price: number;
  // closes: the trade's result (replay: in €, live: in the symbol's currency)
  pnl?: number;
  // the symbol's net position before and after it (long > 0, short < 0)
  before: number; after: number;
};
// the executions of one kind on one bar
type Mark = { key: string; idx: number; buy: boolean; open: boolean; price: number; list: Exec[] };

const round8 = (v: number) => Number(v.toFixed(8));
const qtyFr = (v: number) => round8(v).toLocaleString(LOCALE, { maximumFractionDigits: 8 });
const money = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (n: number) => String(n).padStart(2, '0');

function Icon({ open, buy }: { open: boolean; buy: boolean }) {
  if (!open) {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 0.5 6 4.5 10 0.5 11.5 2 7.5 6 11.5 10 10 11.5 6 7.5 2 11.5 0.5 10 4.5 6 0.5 2Z" />
      </svg>
    );
  }
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path d={buy ? 'M6 0.5 11.5 7H8V13.5H4V7H0.5Z' : 'M6 13.5 11.5 7H8V0.5H4V7H0.5Z'} />
    </svg>
  );
}

export default function TradeMarks({ engine }: { engine: RefObject<ChartEngine> }) {
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const timeZone = useStore((s) => s.timeZone);
  const replayMode = useChartUi((s) => s.replay.mode);
  useChartUi((s) => s.dataVersion);
  const quotes = useQuotes((s) => s.quotes);
  const { paper, replay } = useTradingAccount();
  // "Trades sur le graphique" (bottom tabs Trading virtuel / Trading virtuel replay)
  const shownOn = useStore((s) => s.showTradeMarks);
  const [hover, setHover] = useState<string | null>(null);
  const [, setFrame] = useState(0);

  // the marks follow the chart's scrolling and zooming
  useEffect(() => {
    let raf = 0;
    let prev = '';
    const loop = () => {
      const eng = engine.current;
      const s = eng.mainSeries;
      const chart = eng.chart;
      if (s && chart) {
        const r = chart.timeScale().getVisibleLogicalRange();
        const sig = `${r?.from}|${r?.to}|${s.coordinateToPrice(0)}|${s.coordinateToPrice(100)}|${chart.paneSize(0).width}|${chart.panes()[0]?.getHeight()}|${eng.candles.length}`;
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
  const ticker = symbol.ticker;

  const marks = useMemo(() => {
    const execs: Exec[] = [];
    const add = (x: Omit<Exec, 'before' | 'after'>) => execs.push({ ...x, before: 0, after: 0 });
    for (const p of paper.positions) {
      if (p.symbol.ticker === ticker) add({ key: `o:${p.id}`, t: p.openedAt, buy: p.side === 'long', open: true, qty: p.qty, price: p.entry });
    }
    for (const h of paper.history) {
      if (h.ticker !== ticker) continue;
      add({ key: `o:${h.id}:${h.closedAt}`, t: h.openedAt, buy: h.side === 'long', open: true, qty: h.qty, price: h.entry });
      add({ key: `c:${h.id}:${h.closedAt}`, t: h.closedAt, buy: h.side === 'short', open: false, qty: h.qty, price: h.exit, pnl: h.pnl });
    }
    // the net position, walked back from the one open now (newest first; at the
    // same time a close comes after an open)
    execs.sort((a, b) => b.t - a.t || (a.open === b.open ? 0 : a.open ? 1 : -1));
    let net = paper.positions.reduce((s, p) => (p.symbol.ticker === ticker ? s + (p.side === 'long' ? p.qty : -p.qty) : s), 0);
    for (const x of execs) {
      x.after = round8(net);
      x.before = round8(net - (x.buy ? x.qty : -x.qty));
      net = x.before;
    }
    execs.reverse();
    // on the bar they happened in; none past the last bar (a chart without real time)
    const lastT = candles[candles.length - 1]?.time;
    const end = lastT == null ? null : (barCloseTime(timeframe, lastT) ?? Infinity);
    const byKey = new Map<string, Mark>();
    for (const x of execs) {
      const t = Math.floor(x.t / 1000);
      if (end == null || t >= end) continue;
      const idx = indexAtOrBefore(candles, t);
      if (idx < 0) continue;
      const key = `${idx}:${x.open ? 'o' : 'c'}:${x.buy ? 'b' : 's'}`;
      const m = byKey.get(key) ?? { key, idx, buy: x.buy, open: x.open, price: 0, list: [] };
      m.list.push(x);
      byKey.set(key, m);
    }
    const out = [...byKey.values()];
    for (const m of out) {
      const q = m.list.reduce((s, x) => s + x.qty, 0);
      m.price = m.list.reduce((s, x) => s + x.price * x.qty, 0) / (q || 1);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.positions, paper.history, ticker, timeframe, barsKey]);

  const series = e.mainSeries;
  const chart = e.chart;
  if (!shownOn || !series || !chart || replayMode === 'select' || !marks.length) return null;
  const plotW = chart.paneSize(0).width;
  const paneH = chart.panes()[0]?.getHeight() ?? 0;
  const ts = chart.timeScale();

  // marks of one bar side by side: opens, then closes
  const perBar = new Map<number, Mark[]>();
  for (const m of marks) perBar.set(m.idx, [...(perBar.get(m.idx) ?? []), m]);
  const placed: { m: Mark; x: number; y: number }[] = [];
  for (const [idx, list] of perBar) {
    const x0 = ts.logicalToCoordinate(idx as Logical);
    if (x0 == null || x0 < -20 || x0 > plotW + 20) continue;
    list.sort((a, b) => (a.open === b.open ? (a.buy ? -1 : 1) : a.open ? -1 : 1));
    list.forEach((m, i) => {
      const y = series.priceToCoordinate(m.price);
      if (y == null || y < 0 || y > paneH) return;
      placed.push({ m, x: x0 + (i - (list.length - 1) / 2) * 15, y });
    });
  }

  // replay: the replayed bar's date; live: the time (with the day when not today)
  const when = (ms: number) => {
    const d = new Date(ms + zoneOffsetSec(timeZone, ms / 1000) * 1000);
    const day = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
    const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    if (replay) return `${day}/${String(d.getUTCFullYear()).slice(2)} ${hm}`;
    const now = new Date(Date.now() + zoneOffsetSec(timeZone, Date.now() / 1000) * 1000);
    const today = now.getUTCFullYear() === d.getUTCFullYear() && now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() === d.getUTCDate();
    return `${today ? '' : `${day} `}${hm}:${pad(d.getUTCSeconds())}`;
  };
  const cur = quoteCurrency(symbol, quotes);
  const rate = replay ? 1 : eurPerUnit(cur, quotes);
  const result = (v: number) => (rate != null ? `${money(v * rate)} €` : `${money(v)} ${currencySign(cur)}`);
  const prec = e.precision;

  const shown = placed.find((p) => p.m.key === hover);
  // the list is laid over the order and position labels, the marks under them
  // (the list is placed in the chart's box: left of the mark near the right edge,
  // above it in the lower half)
  return (
    <>
      <div className="trade-marks" style={{ width: plotW, height: paneH }}>
        {placed.map(({ m, x, y }) => (
          <div
            key={m.key}
            className={`tm-mark chart-ui ${m.buy ? 'buy' : 'sell'} ${m.open ? 'open' : 'close'}`}
            style={{ left: x, top: y }}
            onMouseEnter={() => setHover(m.key)}
            onMouseLeave={() => setHover((h) => (h === m.key ? null : h))}
          >
            <Icon open={m.open} buy={m.buy} />
            {m.list.length > 1 && <span className="tm-count">{m.list.length}</span>}
          </div>
        ))}
      </div>
      {shown && (() => {
        const { m, x, y } = shown;
        const toLeft = x + 14 + 250 > plotW;
        const up = y > paneH / 2;
        const style = {
          left: toLeft ? x - 14 : x + 14, top: up ? y + 12 : y - 12,
          transform: `translate(${toLeft ? '-100%' : '0'}, ${up ? '-100%' : '0'})`,
        };
        return (
          <div className="tm-pop" style={style}>
            {m.list.map((x) => (
              <div key={x.key} className={`tm-row ${x.buy ? 'buy' : 'sell'}`}>
                <span className="tm-ic"><Icon open={x.open} buy={x.buy} /></span>
                <span className="tm-what">
                  <b>{qtyFr(x.qty)}@{formatPrice(x.price, prec)}</b>
                  <small>{when(x.t)}</small>
                </span>
                <span className="tm-pos">
                  <span>{qtyFr(x.before)} =&gt; {qtyFr(x.after)}</span>
                  {x.pnl != null && <em className={x.pnl >= 0 ? 'up' : 'down'}>{result(x.pnl)}</em>}
                </span>
              </div>
            ))}
          </div>
        );
      })()}
    </>
  );
}
