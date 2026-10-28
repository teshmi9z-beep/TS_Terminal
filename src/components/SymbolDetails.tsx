import { useEffect, useState } from 'react';
import type { Symbol } from '../types';
import type { Quote } from '../data/feeds/quotes';
import type { FeedStatus } from '../store/chartUi';
import { assetNews, assetProfile, periodLabel, tvIdOf, type AssetProfile } from '../data/assetInfo';
import type { NewsItem } from '../data/news';
import { setFundamentalsTarget } from '../data/fundamentals';
import { big } from '../data/format';
import { openTool } from './tabs/tabActions';
import { SymbolLogo } from './SymbolLogo';
import { pricePrecision } from './chartUtils';
import { LOCALE } from '../i18n/lang';

// The details of the chart's symbol under the watchlist, like TradingView's: price and day,
// sector, 52-week range, the latest news, dividends, next earnings and the analysts' rating.

const DAY = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayFr = (t: number | null | undefined) => (t == null ? '—' : DAY.format(new Date(t * 1000)));
const shortDay = (t: number) => new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(t * 1000));
const numFr = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }));
const amount = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(LOCALE, { maximumFractionDigits: 4 }));

// the analysts' mean mark (1 strong buy .. 5 strong sell) in words
function ratingLabel(mark: number): string {
  return mark <= 1.5 ? 'Achat fort' : mark <= 2.5 ? 'Achat' : mark <= 3.5 ? 'Neutre' : mark <= 4.5 ? 'Vente' : 'Vente forte';
}

function Range({ low, high, last, label, precision }: { low: number; high: number; last: number | null; label: string; precision: number }) {
  const pos = last != null && high > low ? Math.min(100, Math.max(0, ((last - low) / (high - low)) * 100)) : null;
  return (
    <div className="wl-range">
      <div className="wl-range-labels"><span>{low.toFixed(precision)}</span><span>{label}</span><span>{high.toFixed(precision)}</span></div>
      <div className="wl-range-bar">{pos != null && <span style={{ left: `${pos}%` }} />}</div>
    </div>
  );
}

// the payout ratio as a ring
function Donut({ value }: { value: number | null }) {
  const r = 38, c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <svg className="sd-donut" width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
      <circle cx="52" cy="52" r={r} fill="none" stroke="var(--border)" strokeWidth="11" />
      {v > 0 && <circle cx="52" cy="52" r={r} fill="none" stroke="#2962ff" strokeWidth="11" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 52 52)" />}
      <text x="52" y="57" textAnchor="middle" className="sd-donut-text">{value == null ? '—' : `${numFr(value)} %`}</text>
    </svg>
  );
}

// TradingView's gauge: strong sell on the left, strong buy on the right
function Gauge({ mark }: { mark: number }) {
  const colors = ['#f57c00', '#ffa726', '#9598a1', '#26a69a', '#00897b'];
  const cx = 70, cy = 66, r = 52;
  const pt = (a: number, rr = r) => [cx + rr * Math.cos(a), cy - rr * Math.sin(a)];
  const seg = (i: number) => {
    const a0 = Math.PI - (i * Math.PI) / 5 - 0.05, a1 = Math.PI - ((i + 1) * Math.PI) / 5 + 0.05;
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const v = Math.max(0, Math.min(1, (5 - mark) / 4));
  const [nx, ny] = pt(Math.PI - v * Math.PI, r - 12);
  return (
    <svg width="140" height="78" viewBox="0 0 140 78" aria-hidden="true">
      {colors.map((col, i) => <path key={col} d={seg(i)} fill="none" stroke={col} strokeWidth="7" strokeLinecap="round" />)}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--text-bright)" strokeWidth="3" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="4" fill="var(--text-bright)" />
    </svg>
  );
}

export default function SymbolDetails({ symbol, quote, feedStatus }: { symbol: Symbol; quote: Quote | undefined; feedStatus: FeedStatus }) {
  const [profile, setProfile] = useState<AssetProfile | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);

  // (the watchlist gives each symbol its own instance: nothing to reset here)
  useEffect(() => {
    let cancelled = false;
    assetProfile(symbol).then((p) => { if (!cancelled) setProfile(p); });
    assetNews(symbol).then((n) => { if (!cancelled) setNews(n); });
    return () => { cancelled = true; };
  }, [symbol]);

  const last = quote?.last ?? null;
  const precision = last != null ? pricePrecision(symbol, last) : 2;
  const change = quote?.prevClose != null && last != null ? last - quote.prevClose : null;
  const changePct = change != null && quote?.prevClose ? (change / quote.prevClose) * 100 : null;
  const openFinancials = () => {
    void tvIdOf(symbol).then((id) => { if (id) setFundamentalsTarget(id); openTool('fundamentals'); });
  };
  const p = profile;
  const dv = p?.dividends;
  const next = p?.earnings?.next;
  const target = p?.target?.oneYear ?? null;

  return (
    <div className="wl-details">
      <div className="wl-details-head">
        <SymbolLogo sym={symbol} size={26} />
        <div className="wl-details-id">
          <div className="wl-details-ticker">{symbol.ticker}</div>
          <div className="wl-details-name">{p?.name || quote?.name || symbol.name}{(p?.exchange || quote?.exchange) ? ` · ${p?.exchange || quote?.exchange}` : ''}</div>
        </div>
      </div>
      {p?.sector && <div className="sd-sector"><span>{p.sector}</span>{p.industry && <> · {p.industry}</>}</div>}
      <div className="wl-details-price">
        <span className="wl-details-last">{last != null ? last.toFixed(precision) : '—'}</span>
        {(quote?.currency || p?.currency) && <span className="wl-details-ccy">{quote?.currency || p?.currency}</span>}
        {change != null && changePct != null && (
          <span className={`wl-details-chg ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '+' : ''}{change.toFixed(precision)} ({change >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
          </span>
        )}
      </div>
      <div className={`wl-details-status ${feedStatus.source === 'sim' ? 'sim' : feedStatus.estimated ? 'est' : feedStatus.realtime ? 'live' : 'delayed'}`}>
        <span className="dot" />
        {feedStatus.loading ? 'Connexion…' : feedStatus.source === 'sim' ? 'Données simulées' : feedStatus.source === 'local' ? 'Hors ligne · données enregistrées' : feedStatus.estimated ? `Estimé en temps réel · ${feedStatus.label}` : feedStatus.realtime ? `Temps réel · ${feedStatus.label}` : `${feedStatus.label} · peut être différé`}
      </div>
      {quote?.dayLow != null && quote?.dayHigh != null && <Range low={quote.dayLow} high={quote.dayHigh} last={last} label="Plage intra-jour" precision={precision} />}
      {p?.low52 != null && p?.high52 != null && <Range low={p.low52} high={p.high52} last={last} label="Intervalle de 52 semaines" precision={precision} />}

      {news[0] && (
        <div className="sd-news">
          <div className="sd-news-head">Actualités <span>· {shortDay(news[0].published)}</span></div>
          <a className="sd-news-title" href={news[0].link ?? undefined} target="_blank" rel="noreferrer">{news[0].title}</a>
          <button className="sd-link" onClick={() => openTool('news')}>Plus d’événements ›</button>
        </div>
      )}

      {next?.date != null && (
        <div className="sd-block">
          <div className="sd-title">Prochains résultats</div>
          <div className="sd-rows">
            <span>Date</span><b>{dayFr(next.date)}{next.when === 'before' ? ' ☀' : next.when === 'after' ? ' ☾' : ''}</b>
            {next.period && <><span>Période</span><b>{periodLabel(next.period)}</b></>}
            <span>BPA estimé</span><b>{numFr(next.epsEstimate, 3)}</b>
            <span>Revenu estimé</span><b>{big(next.revenueEstimate)}</b>
          </div>
        </div>
      )}

      {dv && (
        <div className="sd-block">
          <div className="sd-title">Dividendes</div>
          <div className="sd-donut-wrap">
            <Donut value={dv.payout} />
            <div className="sd-legend"><span className="sd-dot" />Ratio de paiement (TTM)</div>
          </div>
          <div className="sd-rows">
            <span>Rendement des dividendes TTM</span><b>{dv.yield != null ? `${numFr(dv.yield)} %` : '—'}</b>
            <span>Dernier paiement</span><b>{amount(dv.last.amount)}</b>
            <span>Dernière date d’ex-dividende</span><b>{dayFr(dv.last.exDate)}</b>
            <span>Dernière date de paiement</span><b>{dayFr(dv.last.payDate)}</b>
            {dv.next && <><span>Prochaine date d’ex-dividende</span><b>{dayFr(dv.next.exDate)}</b></>}
            {dv.next?.amount != null && <><span>Prochain paiement</span><b>{amount(dv.next.amount)}</b></>}
          </div>
        </div>
      )}

      {p && (p.earnings || p.dividends) && <button className="sd-btn" onClick={openFinancials}>Plus d’informations financières</button>}

      {p?.rating && (
        <div className="sd-block">
          <div className="sd-title">Note des analystes</div>
          <div className="sd-gauge">
            <Gauge mark={p.rating.mark} />
            <div className="sd-rating">{ratingLabel(p.rating.mark)}</div>
            <div className="sd-rating-sub">{p.rating.total} analystes · {p.rating.counts[0] + p.rating.counts[1]} à l’achat, {p.rating.counts[2]} neutres, {p.rating.counts[3] + p.rating.counts[4]} à la vente</div>
          </div>
          {target != null && (
            <div className="sd-rows">
              <span>Objectif de prix à 1 an</span>
              <b>{numFr(target)}{last != null && <em className={target >= last ? 'up' : 'down'}> ({target >= last ? '+' : ''}{numFr(((target - last) / last) * 100)} %)</em>}</b>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
