import { useEffect, useMemo, useRef, useState } from 'react';
import { useKept } from './kept';
import { useStore, type ScreenerFilters, type ScreenerState } from '../store/store';
import {
  MARKETS, fetchStocks, logoUrl, ratingLabel, sectorFr, stockSymbol, SECTORS_FR,
  type MarketId, type StockRow,
} from '../data/stockScreener';
import PanelControls from './PanelControls';
import { squarify } from './treemap';
import { usePanelMode } from './panelMode';
import { showOnChart } from './tabs/tabActions';
import ListScreener from './ListScreener';
import { LOCALE } from '../i18n/lang';

// TradingView's "Screener d'actions": every stock of a market (largest first),
// as a table (several column sets) or a heatmap by sector, with filters and saved screens

const REFRESH_MS = 60_000;
const cache = new Map<string, { at: number; rows: StockRow[]; total: number }>();

// ---------------------------------------------------------------- formatting

const fr = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
function big(v: number | null, cur = ''): string {
  if (v == null) return '—';
  const a = Math.abs(v);
  const unit = a >= 1e12 ? ['T', 1e12] : a >= 1e9 ? ['B', 1e9] : a >= 1e6 ? ['M', 1e6] : a >= 1e3 ? ['K', 1e3] : ['', 1];
  return `${fr(v / (unit[1] as number))}${unit[0] ? ` ${unit[0]}` : ''}${cur ? ` ${cur}` : ''}`;
}
const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${fr(v)}%`);
const signCls = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

type Col = { key: string; label: string; value: (r: StockRow) => number | string | null; render: (r: StockRow) => React.ReactNode; cls?: (r: StockRow) => string };

const C = {
  price: { key: 'close', label: 'Prix', value: (r) => r.close, render: (r) => (r.close == null ? '—' : <>{fr(r.close)} <small>{r.currency}</small></>) },
  change: { key: 'change', label: 'Var %', value: (r) => r.change, render: (r) => pct(r.change), cls: (r) => signCls(r.change) },
  volume: { key: 'volume', label: 'Vol', value: (r) => r.volume, render: (r) => big(r.volume) },
  relVol: { key: 'relVolume', label: 'Vol Rel', value: (r) => r.relVolume, render: (r) => (r.relVolume == null ? '—' : fr(r.relVolume)) },
  cap: { key: 'marketCap', label: 'Capitalisation boursière', value: (r) => r.marketCap, render: (r) => big(r.marketCap, r.currency) },
  pe: { key: 'pe', label: 'P/E', value: (r) => r.pe, render: (r) => (r.pe == null ? '—' : fr(r.pe)) },
  eps: { key: 'eps', label: 'BPA dil. TTM', value: (r) => r.eps, render: (r) => (r.eps == null ? '—' : <>{fr(r.eps)} <small>{r.currency}</small></>) },
  div: { key: 'divYield', label: 'Rend. div %', value: (r) => r.divYield, render: (r) => (r.divYield == null ? '—' : `${fr(r.divYield)}%`) },
  sector: { key: 'sector', label: 'Secteur', value: (r) => sectorFr(r.sector), render: (r) => sectorFr(r.sector) },
  industry: { key: 'industry', label: 'Industrie', value: (r) => r.industry, render: (r) => r.industry || '—' },
  rating: {
    key: 'recommend', label: 'Note technique', value: (r) => r.recommend,
    render: (r) => ratingLabel(r.recommend)?.text ?? '—', cls: (r) => ratingLabel(r.recommend)?.cls ?? '',
  },
  rsi: { key: 'rsi', label: 'RSI (14)', value: (r) => r.rsi, render: (r) => (r.rsi == null ? '—' : fr(r.rsi)), cls: (r) => (r.rsi == null ? '' : r.rsi >= 70 ? 'down' : r.rsi <= 30 ? 'up' : '') },
  vola: { key: 'volatility', label: 'Volatilité', value: (r) => r.volatility, render: (r) => (r.volatility == null ? '—' : `${fr(r.volatility)}%`) },
  perfW: { key: 'perfW', label: 'Perf S %', value: (r) => r.perfW, render: (r) => pct(r.perfW), cls: (r) => signCls(r.perfW) },
  perf1M: { key: 'perf1M', label: 'Perf 1M %', value: (r) => r.perf1M, render: (r) => pct(r.perf1M), cls: (r) => signCls(r.perf1M) },
  perf3M: { key: 'perf3M', label: 'Perf 3M %', value: (r) => r.perf3M, render: (r) => pct(r.perf3M), cls: (r) => signCls(r.perf3M) },
  perf6M: { key: 'perf6M', label: 'Perf 6M %', value: (r) => r.perf6M, render: (r) => pct(r.perf6M), cls: (r) => signCls(r.perf6M) },
  perfYTD: { key: 'perfYTD', label: 'Perf YTD %', value: (r) => r.perfYTD, render: (r) => pct(r.perfYTD), cls: (r) => signCls(r.perfYTD) },
  perfY: { key: 'perfY', label: 'Perf 1A %', value: (r) => r.perfY, render: (r) => pct(r.perfY), cls: (r) => signCls(r.perfY) },
} satisfies Record<string, Col>;

const VIEWS: { id: ScreenerState['view']; label: string; cols: Col[] }[] = [
  { id: 'overview', label: 'Vue d’ensemble', cols: [C.price, C.change, C.volume, C.relVol, C.cap, C.pe, C.eps, C.div, C.sector, C.rating] },
  { id: 'performance', label: 'Performance', cols: [C.price, C.change, C.perfW, C.perf1M, C.perf3M, C.perf6M, C.perfYTD, C.perfY, C.vola] },
  { id: 'valuation', label: 'Valorisation', cols: [C.cap, C.pe, C.eps, C.div, C.sector, C.industry] },
  { id: 'technical', label: 'Technique', cols: [C.price, C.change, C.rating, C.rsi, C.vola, C.relVol, C.perfW] },
];

// ---------------------------------------------------------------- filters

function applyFilters(rows: StockRow[], f: ScreenerFilters, q: string): StockRow[] {
  const inRange = (v: number | null, lo?: number, hi?: number) => (lo == null || (v != null && v >= lo)) && (hi == null || (v != null && v <= hi));
  const text = q.trim().toLowerCase();
  return rows.filter((r) => (!f.sector || r.sector === f.sector)
    && (f.capMin == null || (r.marketCap != null && r.marketCap >= f.capMin * 1e9))
    && inRange(r.close, f.priceMin, f.priceMax)
    && inRange(r.change, f.chgMin, f.chgMax)
    && inRange(r.rsi, f.rsiMin, f.rsiMax)
    && (f.relVolMin == null || (r.relVolume != null && r.relVolume >= f.relVolMin))
    && (!text || r.ticker.toLowerCase().includes(text) || r.name.toLowerCase().includes(text)));
}
const filterCount = (f: ScreenerFilters) => Object.values(f).filter((v) => v != null && v !== '').length;

function FilterField({ label, lo, hi, onLo, onHi, unit }: { label: string; lo?: number; hi?: number; onLo: (v?: number) => void; onHi?: (v?: number) => void; unit?: string }) {
  const parse = (s: string) => (s.trim() === '' ? undefined : parseFloat(s.replace(',', '.')));
  return (
    <div className="sc-filter-row">
      <span>{label}</span>
      <input type="number" placeholder="min" value={lo ?? ''} onChange={(e) => onLo(parse(e.target.value))} />
      {onHi && <input type="number" placeholder="max" value={hi ?? ''} onChange={(e) => onHi(parse(e.target.value))} />}
      {unit && <small>{unit}</small>}
    </div>
  );
}

// ---------------------------------------------------------------- heatmap

// TradingView's heatmap scale: grey around 0, deeper red / green with the move
function heatColor(ch: number | null): string {
  if (ch == null) return '#363a45';
  if (ch <= -3) return '#f23645';
  if (ch <= -2) return '#b22833';
  if (ch <= -1) return '#801f27';
  if (ch <= -0.5) return '#5e2429';
  if (ch < 0.5) return '#3b3e48';
  if (ch < 1) return '#1c4a35';
  if (ch < 2) return '#1c6b43';
  if (ch < 3) return '#089950';
  return '#22c55e';
}

function Logo({ r, size }: { r: StockRow; size: number }) {
  const [failed, setFailed] = useState(false);
  if (!r.logoid || failed) {
    return <span className="sc-logo sc-logo-txt" style={{ width: size, height: size, fontSize: size * 0.4 }}>{r.ticker.slice(0, 2)}</span>;
  }
  return <img className="sc-logo" src={logoUrl(r.logoid)} alt="" width={size} height={size} onError={() => setFailed(true)} />;
}

const HEAT_MAX = 250;

function Heatmap({ rows, onPick }: { rows: StockRow[]; onPick: (r: StockRow) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ r: StockRow; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => {
    const top = rows.filter((r) => (r.marketCap ?? 0) > 0).sort((a, b) => b.marketCap! - a.marketCap!).slice(0, HEAT_MAX);
    const bySector = new Map<string, StockRow[]>();
    for (const r of top) { const k = r.sector || 'Autre'; bySector.set(k, [...(bySector.get(k) ?? []), r]); }
    const sectors = [...bySector.entries()].map(([name, list]) => ({ value: list.reduce((s, r) => s + r.marketCap!, 0), item: { name, list } }))
      .sort((a, b) => b.value - a.value);
    const HEAD = 18;
    return squarify(sectors, { x: 0, y: 0, w: size.w, h: size.h }).map((s) => ({
      ...s,
      tiles: squarify(s.item.list.map((r) => ({ value: r.marketCap!, item: r })), { x: s.x + 1, y: s.y + HEAD, w: s.w - 2, h: s.h - HEAD - 1 }),
    }));
  }, [rows, size]);

  return (
    <div className="sc-heat" ref={ref} onMouseLeave={() => setTip(null)}>
      {layout.map((s) => (
        <div key={s.item.name}>
          <div className="sc-heat-sector" style={{ left: s.x, top: s.y, width: s.w }}>{sectorFr(s.item.name)} ›</div>
          {s.tiles.map((t) => {
            const r = t.item;
            const small = t.w < 46 || t.h < 34;
            const logo = Math.min(48, Math.floor(Math.min(t.w, t.h) * 0.36));
            const font = Math.max(10, Math.min(20, Math.floor(Math.min(t.w / 4, t.h / 4))));
            return (
              <div
                key={r.id} className="sc-tile" style={{ left: t.x, top: t.y, width: Math.max(0, t.w - 1), height: Math.max(0, t.h - 1), background: heatColor(r.change) }}
                onClick={() => onPick(r)}
                onMouseMove={(e) => { const b = ref.current!.getBoundingClientRect(); setTip({ r, x: e.clientX - b.left, y: e.clientY - b.top }); }}
              >
                {!small && (
                  <>
                    {logo >= 22 && t.h > 90 && <Logo r={r} size={logo} />}
                    <b style={{ fontSize: font }}>{r.ticker}</b>
                    <span style={{ fontSize: Math.max(10, font - 3) }}>{pct(r.change)}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {tip && (
        <div className="sc-heat-tip" style={{ left: Math.min(tip.x + 12, size.w - 220), top: Math.min(tip.y + 14, size.h - 90) }}>
          <div className="sc-heat-tip-head"><Logo r={tip.r} size={22} /><b>{tip.r.ticker}</b><span>{tip.r.name}</span></div>
          <div>{tip.r.close != null ? `${fr(tip.r.close)} ${tip.r.currency}` : '—'} <span className={signCls(tip.r.change)}>{pct(tip.r.change)}</span></div>
          <div className="muted">Cap. {big(tip.r.marketCap, tip.r.currency)} · {sectorFr(tip.r.sector)}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- screener

const tableIcon = <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="2.5" width="13" height="13" rx="2" /><path d="M2.5 7h13M7 7v8.5" /></svg>;
const heatIcon = <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="2.5" width="6" height="8" rx="1" /><rect x="10" y="2.5" width="5.5" height="5" rx="1" /><rect x="10" y="9" width="5.5" height="6.5" rx="1" /><rect x="2.5" y="12" width="6" height="3.5" rx="1" /></svg>;

// `display`: opened as its own tab ("Screener" or "Carte thermique" tile), with its own display
export default function Screener({ display: pageDisplay }: { display?: 'table' | 'heatmap' }) {
  const st = useStore((s) => s.screener);
  const setSt = useStore((s) => s.setScreener);
  const [ownDisplay, setOwnDisplay] = useKept(`screener.display.${pageDisplay ?? 'panel'}`, pageDisplay);
  const display = ownDisplay ?? st.display;
  const setDisplay = (d: 'table' | 'heatmap') => (ownDisplay ? setOwnDisplay(d) : setSt({ display: d }));
  const screens = useStore((s) => s.screenerScreens);
  const setScreens = useStore((s) => s.setScreenerScreens);
  const setSymbol = useStore((s) => s.setSymbol);
  const addToWatchlist = useStore((s) => s.addToWatchlist);
  const current = useStore((s) => s.symbol.ticker);
  const market = (MARKETS.some((m) => m.id === st.market) ? st.market : 'france') as MarketId;
  // rows come from the module cache; `loaded` re-renders when a fetch fills it
  const [, setLoaded] = useState(0);
  const data = cache.get(market) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState<null | 'mode' | 'screens' | 'display' | 'view' | 'filters' | 'market'>(null);
  const [search, setSearch] = useKept(`screener.search.${pageDisplay ?? 'panel'}`, '');

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    const hit = cache.get(market);
    if (hit && Date.now() - hit.at < REFRESH_MS / 2) return () => clearInterval(id);
    const ctrl = new AbortController();
    fetchStocks(market, ctrl.signal)
      .then((d) => { cache.set(market, { at: Date.now(), ...d }); setLoaded((n) => n + 1); setError(null); })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!ctrl.signal.aborted) setRefreshing(false); });
    return () => { ctrl.abort(); clearInterval(id); };
  }, [market, tick]);

  const view = VIEWS.find((v) => v.id === st.view) ?? VIEWS[0];
  const rows = useMemo(() => {
    const list = applyFilters(data?.rows ?? [], st.filters, search);
    const col = [...Object.values(C)].find((c) => c.key === st.sort.key) as Col | undefined;
    if (!col) return list;
    return [...list].sort((a, b) => {
      const va = col.value(a), vb = col.value(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number)) * st.sort.dir;
    });
  }, [data, st.filters, st.sort, search]);

  const pageMode = usePanelMode() === 'page';
  // in its own tab, a row opens on the last chart used
  const pick = (r: StockRow) => (pageMode ? showOnChart(stockSymbol(r, market)) : setSymbol(stockSymbol(r, market)));
  const setFilter = (p: Partial<ScreenerFilters>) => setSt({ filters: { ...st.filters, ...p } });
  const nFilters = filterCount(st.filters);
  const mk = MARKETS.find((m) => m.id === market)!;
  const close = () => setMenu(null);

  function save(asNew: boolean) {
    const name = !asNew && st.screenName ? st.screenName : window.prompt('Nom de l’écran :', st.screenName ?? 'Mon screener');
    if (!name) return;
    const state = { ...st, screenName: name };
    setScreens([...screens.filter((s) => s.name !== name), { name, state }]);
    setSt({ screenName: name });
  }

  return (
    <div className="side-panel sc-panel">
      <div className="sc-top">
        <div className="sc-dd">
          <button className="sc-mode" onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>
            {st.mode === 'stocks' ? 'Screener d’actions' : 'Screener de listes'} <span>⌄</span>
          </button>
          {menu === 'mode' && (
            <div className="sc-menu" onMouseLeave={close}>
              <button className={st.mode === 'stocks' ? 'active' : ''} onClick={() => { setSt({ mode: 'stocks' }); close(); }}>Screener d’actions<small>toutes les actions d’un marché</small></button>
              <button className={st.mode === 'lists' ? 'active' : ''} onClick={() => { setSt({ mode: 'lists' }); close(); }}>Screener de listes<small>liste de surveillance, crypto, forex, indices</small></button>
            </div>
          )}
        </div>
        <PanelControls />
      </div>

      {st.mode === 'lists' ? <ListScreener /> : (
        <>
          <div className="sc-title-row">
            <div className="sc-dd">
              <button className="sc-title" onClick={() => setMenu(menu === 'screens' ? null : 'screens')}>{st.screenName ?? 'Toutes les actions'} <span>⌄</span></button>
              {menu === 'screens' && (
                <div className="sc-menu" onMouseLeave={close}>
                  <button onClick={() => { setSt({ filters: {}, screenName: null, sort: { key: 'marketCap', dir: -1 } }); close(); }}>Toutes les actions</button>
                  {screens.map((s) => (
                    <button key={s.name} className={st.screenName === s.name ? 'active' : ''} onClick={() => { setSt({ ...s.state, mode: 'stocks' }); close(); }}>{s.name}</button>
                  ))}
                  <div className="sc-menu-sep" />
                  <button onClick={() => { save(true); close(); }}>Enregistrer sous…</button>
                  {st.screenName && (
                    <button onClick={() => { setScreens(screens.filter((s) => s.name !== st.screenName)); setSt({ screenName: null }); close(); }}>Supprimer « {st.screenName} »</button>
                  )}
                </div>
              )}
            </div>
            <button className="sc-save" title="Enregistrer l’écran sous…" onClick={() => save(false)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 8a4 4 0 01-.5 10" /><path d="M12 12v8M9 15l3-3 3 3" /></svg>
              Sauvegarder
            </button>
            <div className="sc-dd sc-market">
              <button className="sc-btn" onClick={() => setMenu(menu === 'market' ? null : 'market')}>
                <img className="sc-flag" src={`https://flagcdn.com/w40/${mk.flag}.png`} alt="" />{mk.label} <span>⌄</span>
              </button>
              {menu === 'market' && (
                <div className="sc-menu right" onMouseLeave={close}>
                  {MARKETS.map((m) => (
                    <button key={m.id} className={`sc-menu-flag ${m.id === market ? 'active' : ''}`} onClick={() => { setSt({ market: m.id, filters: { ...st.filters, sector: undefined } }); close(); }}>
                      <img className="sc-flag" src={`https://flagcdn.com/w40/${m.flag}.png`} alt="" />{m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="sc-toolbar">
            <div className="sc-dd">
              <button className={`sc-btn ${nFilters ? 'on' : ''}`} onClick={() => setMenu(menu === 'filters' ? null : 'filters')}>
                <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4 2v14M9 2v14M14 2v14" /><circle cx="4" cy="6" r="1.8" fill="var(--bg-panel)" /><circle cx="9" cy="12" r="1.8" fill="var(--bg-panel)" /><circle cx="14" cy="7" r="1.8" fill="var(--bg-panel)" /></svg>
                Filtres{nFilters > 0 && <span className="sc-badge">{nFilters}</span>}
              </button>
              {menu === 'filters' && (
                <div className="sc-menu sc-filters">
                  <div className="sc-filter-row">
                    <span>Secteur</span>
                    <select value={st.filters.sector ?? ''} onChange={(e) => setFilter({ sector: e.target.value || undefined })}>
                      <option value="">Tous</option>
                      {Object.keys(SECTORS_FR).map((s) => <option key={s} value={s}>{sectorFr(s)}</option>)}
                    </select>
                  </div>
                  <FilterField label="Capitalisation" lo={st.filters.capMin} onLo={(v) => setFilter({ capMin: v })} unit="Md min" />
                  <FilterField label="Prix" lo={st.filters.priceMin} hi={st.filters.priceMax} onLo={(v) => setFilter({ priceMin: v })} onHi={(v) => setFilter({ priceMax: v })} />
                  <FilterField label="Var %" lo={st.filters.chgMin} hi={st.filters.chgMax} onLo={(v) => setFilter({ chgMin: v })} onHi={(v) => setFilter({ chgMax: v })} />
                  <FilterField label="RSI (14)" lo={st.filters.rsiMin} hi={st.filters.rsiMax} onLo={(v) => setFilter({ rsiMin: v })} onHi={(v) => setFilter({ rsiMax: v })} />
                  <FilterField label="Vol relatif" lo={st.filters.relVolMin} onLo={(v) => setFilter({ relVolMin: v })} unit="min" />
                  <div className="sc-filter-foot">
                    <button className="si-more" onClick={() => setSt({ filters: {} })}>Effacer les filtres</button>
                    <button className="pill-btn" onClick={close}>Fermer</button>
                  </div>
                </div>
              )}
            </div>
            <span className="sc-sep" />
            <div className="sc-dd">
              <button className="sc-icon" title="Type d’affichage" onClick={() => setMenu(menu === 'display' ? null : 'display')}>{display === 'table' ? tableIcon : heatIcon}</button>
              {menu === 'display' && (
                <div className="sc-menu" onMouseLeave={close}>
                  <div className="sc-menu-head">Type d’affichage</div>
                  <button className={display === 'table' ? 'active' : ''} onClick={() => { setDisplay('table'); close(); }}>{tableIcon} Tableau</button>
                  <button className={display === 'heatmap' ? 'active' : ''} onClick={() => { setDisplay('heatmap'); close(); }}>{heatIcon} Carte thermique</button>
                </div>
              )}
            </div>
            {display === 'table' && (
              <div className="sc-dd">
                <button className="sc-btn" onClick={() => setMenu(menu === 'view' ? null : 'view')}>{view.label} <span>⌄</span></button>
                {menu === 'view' && (
                  <div className="sc-menu" onMouseLeave={close}>
                    {VIEWS.map((v) => <button key={v.id} className={v.id === view.id ? 'active' : ''} onClick={() => { setSt({ view: v.id }); close(); }}>{v.label}</button>)}
                  </div>
                )}
              </div>
            )}
            <input className="sc-search" placeholder="Symbole ou nom" value={search} onChange={(e) => setSearch(e.target.value)} />
            <span className="sc-count">{rows.length}{rows.length !== (data?.rows.length ?? 0) ? ` / ${data?.rows.length ?? 0}` : ''} total</span>
            <button className={`sc-icon ${refreshing ? 'spin' : ''}`} title="Actualiser" onClick={() => { cache.delete(market); setRefreshing(true); setTick((t) => t + 1); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M20 12a8 8 0 11-2.34-5.66M20 4v5h-5" /></svg>
            </button>
          </div>
          {error && <div className="yc-error">Screener indisponible : {error}</div>}
          {!data && !error && <div className="side-empty"><span className="spinner" /> Chargement des actions…</div>}

          {data && display === 'heatmap' && <Heatmap rows={rows} onPick={pick} />}
          {data && display === 'table' && (
            <div className="sc-table-wrap">
              <table className="sc-table">
                <thead>
                  <tr>
                    <th className="sc-sym-h" onClick={() => setSt({ sort: { key: 'ticker', dir: st.sort.key === 'ticker' && st.sort.dir === 1 ? -1 : 1 } })}>Symbole <small>{rows.length}</small></th>
                    {view.cols.map((c) => (
                      <th key={c.key} onClick={() => setSt({ sort: { key: c.key, dir: st.sort.key === c.key && st.sort.dir === -1 ? 1 : -1 } })}>
                        {st.sort.key === c.key ? (st.sort.dir === -1 ? '↓ ' : '↑ ') : ''}{c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(st.sort.key === 'ticker' ? [...rows].sort((a, b) => a.ticker.localeCompare(b.ticker) * st.sort.dir) : rows).slice(0, 600).map((r) => (
                    <tr key={r.id} className={r.ticker === current ? 'active' : ''} onClick={() => pick(r)}>
                      <td className="sc-sym">
                        <Logo r={r} size={22} />
                        <span className="sc-ticker">{r.ticker}</span>
                        <span className="sc-name" title={r.name}>{r.name}</span>
                        <button className="sc-add" title="Ajouter à la liste de surveillance" onClick={(e) => { e.stopPropagation(); addToWatchlist(stockSymbol(r, market)); }}>＋</button>
                      </td>
                      {view.cols.map((c) => <td key={c.key} className={c.cls?.(r) ?? ''}>{c.render(r)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 600 && <div className="side-empty">600 premières lignes affichées : affinez avec les filtres ou la recherche.</div>}
            </div>
          )}
          <div className="sc-foot">Données TradingView · {mk.label} · {data?.total ?? 0} actions (les {data?.rows.length ?? 0} plus grosses capitalisations) · clic = ouvrir sur le graphique</div>
        </>
      )}
    </div>
  );
}
