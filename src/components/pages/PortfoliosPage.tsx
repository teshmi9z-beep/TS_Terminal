import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, AreaSeries, LineSeries, ColorType, type UTCTimestamp } from 'lightweight-charts';
import { useStore, nextId, type Portfolio, type PortfolioTx } from '../../store/store';
import { useQuotes } from '../../data/feeds/quotes';
import { holdingsOf, valueHistory, type ValuePoint } from '../../data/portfolio';
import { searchSymbols } from '../../data/feeds/searchSymbols';
import { fr, pct, signCls } from '../../data/format';
import { chartColors } from '../chartUtils';
import { SymbolLogo } from '../SymbolLogo';
import { showOnChart } from '../tabs/tabActions';
import { PageHeader } from './common';
import type { Symbol } from '../../types';
import { LOCALE } from '../../i18n/lang';

const DONUT = ['#2962ff', '#22ab94', '#ff9800', '#f23645', '#ab47bc', '#00bcd4', '#e91e63', '#8bc34a', '#ffeb3b', '#8d6e63'];

function ValueChart({ data }: { data: ValuePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const uiTheme = useStore((s) => s.uiTheme);
  const bg = useStore((s) => s.chartSettings.background);
  useEffect(() => {
    const el = ref.current;
    if (!el || !data.length) return;
    const c = chartColors(uiTheme);
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: c.text, attributionLogo: false, fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: c.border } },
      rightPriceScale: { borderColor: c.border }, timeScale: { borderColor: c.border },
      width: el.clientWidth, height: el.clientHeight, localization: { locale: LOCALE },
    });
    const area = chart.addSeries(AreaSeries, { lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.3)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2, title: 'Valeur' });
    area.setData(data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    const inv = chart.addSeries(LineSeries, { color: '#9598a1', lineWidth: 1, lineStyle: 2, title: 'Investi', priceLineVisible: false });
    inv.setData(data.map((p) => ({ time: p.time as UTCTimestamp, value: p.invested })));
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.resize(el.clientWidth, el.clientHeight));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); };
  }, [data, uiTheme, bg]);
  return <div className="pf2-chart" ref={ref}>{!data.length && <div className="pg-empty">Pas encore d’historique.</div>}</div>;
}

function Donut({ parts }: { parts: { label: string; value: number }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 60, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="pf2-donut">
      <svg viewBox="0 0 160 160">
        <circle cx="80" cy="80" r={r} fill="none" stroke="var(--bg-hover)" strokeWidth="22" />
        {total > 0 && parts.map((p, i) => {
          const f = p.value / total;
          const el = <circle key={p.label} cx="80" cy="80" r={r} fill="none" stroke={DONUT[i % DONUT.length]} strokeWidth="22" strokeDasharray={`${f * c} ${c}`} strokeDashoffset={-acc * c} transform="rotate(-90 80 80)" />;
          acc += f;
          return el;
        })}
      </svg>
      <div className="pf2-legend">
        {parts.map((p, i) => (
          <div key={p.label}><i style={{ background: DONUT[i % DONUT.length] }} />{p.label}<b>{total ? fr((p.value / total) * 100, 1) : '0'} %</b></div>
        ))}
      </div>
    </div>
  );
}

function TxForm({ onAdd, onClose }: { onAdd: (t: PortfolioTx) => void; onClose: () => void }) {
  const watch = useStore((s) => s.watchlists);
  const quotes = useQuotes((s) => s.quotes);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Symbol[]>([]);
  const [sym, setSym] = useState<Symbol | null>(null);
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [fee, setFee] = useState('0');
  useEffect(() => {
    if (sym || q.trim().length < 1) return;
    const id = setTimeout(() => {
      const extra = watch.flatMap((t) => t.items.flatMap((r) => (r.kind === 'asset' ? [r.data] : [])));
      void searchSymbols(q, extra).then(setHits);
    }, 250);
    return () => clearTimeout(id);
  }, [q, sym, watch]);
  const n = (s: string) => parseFloat(s.replace(',', '.'));
  const ok = sym && n(qty) > 0 && n(price) > 0 && date;
  return (
    <div className="pf2-form">
      <div className="pf2-form-row">
        <div className="pg-chips">
          <button className={`pg-chip ${side === 'buy' ? 'active buy' : ''}`} onClick={() => setSide('buy')}>Achat</button>
          <button className={`pg-chip ${side === 'sell' ? 'active sell' : ''}`} onClick={() => setSide('sell')}>Vente</button>
        </div>
        <div className="pf2-sym">
          {sym ? (
            <button className="pill-btn" onClick={() => { setSym(null); setQ(''); }}>{sym.ticker} ✕</button>
          ) : (
            <>
              <input autoFocus placeholder="Symbole (ex : AAPL, OR.PA, BTCUSD)" value={q} onChange={(e) => setQ(e.target.value)} />
              {hits.length > 0 && (
                <div className="pf2-hits">
                  {hits.map((h) => (
                    <button key={h.ticker} onClick={() => { setSym(h); setHits([]); const l = quotes[h.ticker]?.last; if (l) setPrice(String(l)); }}>
                      <SymbolLogo sym={h} size={16} /><b>{h.ticker}</b><span>{h.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <label>Quantité<input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="10" /></label>
        <label>Prix<input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" /></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Frais<input value={fee} onChange={(e) => setFee(e.target.value)} /></label>
      </div>
      <div className="pf2-form-row end">
        <button className="pill-btn" onClick={onClose}>Annuler</button>
        <button
          className="pill-btn primary" disabled={!ok}
          onClick={() => {
            if (!sym) return;
            onAdd({ id: nextId(), symbol: sym, side, qty: n(qty), price: n(price), date: new Date(`${date}T12:00:00`).getTime(), fee: n(fee) || 0 });
            onClose();
          }}
        >
          Ajouter la transaction
        </button>
      </div>
    </div>
  );
}

function PortfolioView({ p }: { p: Portfolio }) {
  const upsert = useStore((s) => s.upsertPortfolio);
  const remove = useStore((s) => s.removePortfolio);
  const quotes = useQuotes((s) => s.quotes);
  const [adding, setAdding] = useState(false);
  const [history, setHistory] = useState<ValuePoint[]>([]);
  const txKey = p.transactions.map((t) => t.id).join(',');
  useEffect(() => { void valueHistory(p).then(setHistory); }, [txKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const hs = holdingsOf(p);
  const open = hs.filter((h) => h.qty > 0);
  const rows = open.map((h) => {
    const q = quotes[h.symbol.ticker];
    const last = q?.last ?? h.avgCost;
    const value = h.qty * last;
    const day = q?.prevClose ? (last - q.prevClose) * h.qty : 0;
    return { h, last, value, pnl: value - h.cost, day };
  });
  const value = rows.reduce((s, r) => s + r.value, 0);
  const cost = rows.reduce((s, r) => s + r.h.cost, 0);
  const unreal = value - cost;
  const realized = hs.reduce((s, h) => s + h.realized, 0);
  const day = rows.reduce((s, r) => s + r.day, 0);

  return (
    <div className="pf2-main">
      <div className="pf2-title">
        <h2>{p.name}</h2>
        <button className="pl-btn" title="Renommer" onClick={() => { const n = window.prompt('Nom du portefeuille :', p.name); if (n) upsert({ ...p, name: n }); }}>✎</button>
        <button className="pl-btn danger" title="Supprimer" onClick={() => { if (window.confirm(`Supprimer « ${p.name} » ?`)) remove(p.id); }}>🗑</button>
        <span className="pf2-spacer" />
        <button className="pill-btn primary" onClick={() => setAdding(!adding)}>＋ Ajouter une transaction</button>
      </div>
      {adding && <TxForm onClose={() => setAdding(false)} onAdd={(t) => upsert({ ...p, transactions: [...p.transactions, t] })} />}
      <div className="pf2-cards">
        <div><span>Valeur actuelle</span><b>{fr(value)}</b></div>
        <div><span>Coût d’acquisition</span><b>{fr(cost)}</b></div>
        <div><span>P&L latent</span><b className={signCls(unreal)}>{unreal >= 0 ? '+' : ''}{fr(unreal)} <small>{pct(cost ? (unreal / cost) * 100 : 0)}</small></b></div>
        <div><span>P&L réalisé</span><b className={signCls(realized)}>{realized >= 0 ? '+' : ''}{fr(realized)}</b></div>
        <div><span>Variation du jour</span><b className={signCls(day)}>{day >= 0 ? '+' : ''}{fr(day)}</b></div>
      </div>
      <div className="pf2-row">
        <ValueChart data={history} />
        <Donut parts={rows.map((r) => ({ label: r.h.symbol.ticker, value: r.value }))} />
      </div>
      <div className="pf2-sub">Positions</div>
      <table className="pg-table">
        <thead><tr><th className="left">Symbole</th><th>Quantité</th><th>PRU</th><th>Cours</th><th>Valeur</th><th>P&L latent</th><th>Poids</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.h.symbol.ticker} className="click" onClick={() => showOnChart(r.h.symbol)}>
              <td className="left pg-sym"><SymbolLogo sym={r.h.symbol} size={20} /><b>{r.h.symbol.ticker}</b><span>{r.h.symbol.name}</span></td>
              <td>{fr(r.h.qty, r.h.qty % 1 ? 4 : 0)}</td>
              <td>{fr(r.h.avgCost)}</td>
              <td>{fr(r.last)}</td>
              <td>{fr(r.value)}</td>
              <td className={signCls(r.pnl)}>{r.pnl >= 0 ? '+' : ''}{fr(r.pnl)} ({pct(r.h.cost ? (r.pnl / r.h.cost) * 100 : 0)})</td>
              <td>{value ? fr((r.value / value) * 100, 1) : '0'} %</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="pg-empty">Aucune position : ajoutez une transaction d’achat.</div>}
      <div className="pf2-sub">Transactions</div>
      <table className="pg-table">
        <thead><tr><th className="left">Date</th><th className="left">Symbole</th><th>Type</th><th>Quantité</th><th>Prix</th><th>Frais</th><th>Montant</th><th /></tr></thead>
        <tbody>
          {[...p.transactions].sort((a, b) => b.date - a.date).map((t) => (
            <tr key={t.id}>
              <td className="left">{new Date(t.date).toLocaleDateString(LOCALE)}</td>
              <td className="left">{t.symbol.ticker}</td>
              <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side === 'buy' ? 'Achat' : 'Vente'}</td>
              <td>{fr(t.qty, t.qty % 1 ? 4 : 0)}</td>
              <td>{fr(t.price)}</td>
              <td>{fr(t.fee)}</td>
              <td>{fr(t.qty * t.price)}</td>
              <td><button className="pl-btn danger" title="Supprimer" onClick={() => upsert({ ...p, transactions: p.transactions.filter((x) => x.id !== t.id) })}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pg-note">Méthode du prix de revient moyen. Les montants de symboles en devises différentes sont additionnés tels quels.</div>
    </div>
  );
}

// TradingView's portfolios: holdings built from transactions, value over time, allocation
export default function PortfoliosPage() {
  const portfolios = useStore((s) => s.portfolios);
  const activeId = useStore((s) => s.activePortfolioId);
  const setActive = useStore((s) => s.setActivePortfolio);
  const upsert = useStore((s) => s.upsertPortfolio);
  const quotes = useQuotes((s) => s.quotes);
  const current = portfolios.find((p) => p.id === activeId) ?? portfolios[0];
  const create = () => {
    const name = window.prompt('Nom du portefeuille :', `Portefeuille ${portfolios.length + 1}`);
    if (!name) return;
    const p: Portfolio = { id: nextId(), name, createdAt: Date.now(), transactions: [] };
    upsert(p);
    setActive(p.id);
  };
  const valueOf = useMemo(() => (p: Portfolio) => holdingsOf(p).reduce((s, h) => s + h.qty * (quotes[h.symbol.ticker]?.last ?? h.avgCost), 0), [quotes]);

  return (
    <div className="pg">
      <PageHeader title="Portefeuilles" />
      <div className="pf2-layout">
        <div className="pf2-side">
          {portfolios.map((p) => (
            <button key={p.id} className={`pf2-item ${p.id === current?.id ? 'active' : ''}`} onClick={() => setActive(p.id)}>
              <span>{p.name}</span><b>{fr(valueOf(p))}</b>
            </button>
          ))}
          <button className="pf2-new" onClick={create}>＋ Nouveau portefeuille</button>
        </div>
        {current ? <PortfolioView key={current.id} p={current} /> : (
          <div className="pg-empty big">Aucun portefeuille. <button className="pill-btn primary" onClick={create}>Créer un portefeuille</button></div>
        )}
      </div>
    </div>
  );
}
