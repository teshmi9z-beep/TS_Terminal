import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useKept } from '../kept';
import { deleteSeries, importFeed, listSeries, saveRows, type SeriesMeta } from '../../data/offline/db';
import { MARKET_LABEL, MARKET_OF, TF_LABEL, labTf, platformSymbol, platformTf, platformTicker, type LabMarket } from '../../data/labSymbols';
import { SYMBOLS } from '../../data/symbols';
import { parseTf, tfSeconds } from '../../data/timeframes';
import { resampleRows } from '../../data/import/csvImport';
import { useStore } from '../../store/store';
import { showOnChart } from '../tabs/tabActions';
import DataImport, { type ImportHandle } from './data/DataImport';
import { DownloadDialog, DownloadJobs } from './data/Downloads';
import { useDownloadJobs, type DlJob } from './data/downloadJobs';
import { day, mb, n0, span } from './data/format';
import { LOCALE } from '../../i18n/lang';

// "Développeur · Data": every price history the platform has, market by market
// and timeframe by timeframe (from when, up to when), wherever it is kept: the
// robot lab's folder on disk (robots/data) and this browser's store (charts,
// offline, replay). Also: importing files, and what the lab still lacks.

type LabEntry = { id: string; file: string; market: string; source: string; symbol: string; platform?: string; tf: string; bars: number; from: number; to: number; size: number; derived?: boolean };

type Series = {
  key: string;
  where: 'lab' | 'browser';
  ticker: string;
  market: LabMarket;
  // lab names: 1m ... 4h, 1d, 1w, plus the platform's others (5s, 100T, 2h, 1M...)
  tf: string;
  source: string;
  from: number; to: number; bars: number; size: number;
  labId?: string; derived?: boolean; meta?: SeriesMeta; tested?: boolean;
};

type Loaded = { lab: LabEntry[]; labApi: boolean; browser: SeriesMeta[]; tested: Set<string>; usage: number | null };

const YEAR = 365.25 * 86400;
// years of history for a fair robot test (several market phases)
const TARGET: Record<string, number> = { '1m': 1, '5m': 1, '15m': 3, '30m': 3, '1h': 5, '4h': 5, '1d': 10 };
const BASE_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const MARKETS: LabMarket[] = ['Forex', 'Commodity', 'Index', 'Stock', 'Crypto'];

function tfName(tf: string): string {
  if (TF_LABEL[tf]) return TF_LABEL[tf];
  if (tf === '1w') return 'Semaine';
  const { n, unit } = parseTf(platformTf(tf));
  return unit === 'T' ? `${n} ticks` : unit === 's' ? `${n} s` : unit === 'm' ? `${n} min` : unit === 'h' ? `${n} h` : unit === 'M' ? `${n} mois` : unit === 'D' ? `${n} jours` : tf;
}
const tfOrder = (tf: string) => { const p = platformTf(tf); return parseTf(p).unit === 'T' ? -1e6 + parseTf(p).n : tfSeconds(p) ?? 0; };
const monthYear = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { month: 'short', year: '2-digit', timeZone: 'UTC' });
const sourceOf = (feed: string) => {
  const src = feed.split(':')[0];
  return src === 'binance' ? 'Binance' : src === 'binance-futures' ? 'Binance Futures' : src === 'yahoo' ? 'Yahoo' : src === 'import' ? 'Import' : src;
};
const recent = (t: number) => Date.now() / 1000 - t < 3 * 86400;

async function load(): Promise<Loaded> {
  const [labRes, browser, report, est] = await Promise.all([
    fetch('/api/data/lab').then((r) => (r.ok ? r.json() as Promise<{ entries: LabEntry[] }> : null)).catch(() => null),
    listSeries().catch(() => [] as SeriesMeta[]),
    fetch('/robots/report.json').then((r) => (r.ok ? r.json() as Promise<{ datasets: LabEntry[] }> : null)).catch(() => null),
    navigator.storage?.estimate?.().catch(() => null) ?? Promise.resolve(null),
  ]);
  const tested = new Set((report?.datasets ?? []).map((d) => d.id));
  // without the dev server (built app): the lab's list as of the last robot report
  const lab = labRes?.entries ?? (report?.datasets ?? []).map((d) => ({ ...d, file: `${d.id}.json`, size: 0, derived: /^yahoo_.*_4h$/.test(d.id) }));
  return { lab, labApi: !!labRes, browser, tested, usage: est?.usage ?? null };
}

function toSeries(d: Loaded): Series[] {
  const out: Series[] = [];
  for (const e of d.lab) {
    out.push({
      key: `lab:${e.id}`, where: 'lab', ticker: e.platform ?? platformTicker(e.symbol), market: (e.market as LabMarket) ?? 'Stock', tf: e.tf,
      source: e.derived ? `${e.source} (4 h calculé depuis 1 h)` : e.source, from: e.from, to: e.to, bars: e.bars, size: e.derived ? 0 : e.size,
      labId: e.id, derived: e.derived, tested: d.tested.has(e.id),
    });
  }
  for (const m of d.browser) {
    out.push({
      key: `nav:${m.key}`, where: 'browser', ticker: m.ticker, market: MARKET_OF[m.symbol.category] ?? 'Stock', tf: labTf(m.tf),
      source: sourceOf(m.feed), from: m.first, to: m.last, bars: m.count, size: m.count * 48, meta: m,
    });
  }
  return out;
}

// depth against what a robot test needs: ok / mid / low
function level(s: Series): string {
  const years = (s.to - s.from) / YEAR;
  const r = years / (TARGET[s.tf] ?? 1);
  return r >= 1 ? 'ok' : r >= 0.35 ? 'mid' : 'low';
}
const best = (list: Series[]) => list.reduce<Series | null>((a, s) => (!a || s.to - s.from > a.to - a.from ? s : a), null);

// assets down, timeframes across; the selected asset opens its detail under its row, a
// cell opens the download of that market and timeframe (a download under way shows in it)
function Matrix({ series, selected, onSelect, detail, onCell, jobs }: {
  series: Series[]; selected: string | null; onSelect: (t: string) => void; detail: (ticker: string) => ReactNode;
  onCell: (ticker: string, tf: string) => void; jobs: DlJob[];
}) {
  const running = new Map(jobs.filter((j) => j.state === 'running' || j.state === 'queued').map((j) => [`${j.ticker}|${j.tf}`, j]));
  const tfs = [...new Set([...BASE_TFS, ...series.map((s) => s.tf)])].sort((a, b) => tfOrder(a) - tfOrder(b));
  const byAsset = new Map<string, Series[]>();
  for (const s of series) byAsset.set(s.ticker, [...(byAsset.get(s.ticker) ?? []), s]);
  const assets = [...byAsset.entries()].sort((a, b) => MARKETS.indexOf(a[1][0].market) - MARKETS.indexOf(b[1][0].market) || a[0].localeCompare(b[0]));
  if (!assets.length) return <div className="rb-empty">Aucune donnée avec ces filtres.</div>;
  const body: ReactNode[] = [];
  let lastMarket = '';
  for (const [ticker, list] of assets) {
    const market = list[0].market;
    if (market !== lastMarket) {
      lastMarket = market;
      body.push(<tr key={`g-${market}`} className="dt-sep"><td colSpan={tfs.length + 1}>{MARKET_LABEL[market] ?? market}</td></tr>);
    }
    const name = SYMBOLS.find((s) => s.ticker === ticker)?.name;
    body.push(
      <tr key={ticker} className={selected === ticker ? 'on' : ''} onClick={() => onSelect(ticker)}>
        <td className="dt-asset"><b>{ticker}</b>{name && <small>{name}</small>}</td>
        {tfs.map((tf) => {
          const cell = list.filter((s) => s.tf === tf);
          const b = best(cell);
          const job = running.get(`${ticker}|${tf}`);
          const click = (e: React.MouseEvent) => { e.stopPropagation(); onCell(ticker, tf); };
          const run = job && <i className="dl-cell-run" title={`Téléchargement en cours : ${job.label}`}>⬇ {job.state === 'queued' ? 'attente' : `${Math.round(job.progress * 100)} %`}</i>;
          if (!b) return <td key={tf} className="dt-cell empty" title="Clic : télécharger" onClick={click}>{run ?? '·'}</td>;
          const tip = cell.map((s) => `${s.where === 'lab' ? 'Labo' : 'Navigateur'} · ${s.source} : ${day(s.from)} → ${day(s.to)} · ${n0(s.bars)} barres`).join('\n');
          return (
            <td key={tf} className={`dt-cell lvl-${level(b)}`} title={`${tip}\nClic : télécharger plus d’historique`} onClick={click}>
              <b>{span(b.to - b.from)}</b>
              <small>{monthYear(b.from)} → {recent(b.to) ? 'auj.' : monthYear(b.to)}</small>
              {cell.length > 1 && <em>×{cell.length}</em>}
              {run}
            </td>
          );
        })}
      </tr>,
    );
    if (selected === ticker) body.push(<tr key={`d-${ticker}`} className="dt-expand"><td colSpan={tfs.length + 1}>{detail(ticker)}</td></tr>);
  }
  return (
    <div className="dt-matrix-wrap">
      <table className="dt-matrix">
        <thead><tr><th>Actif</th>{tfs.map((tf) => <th key={tf}>{tfName(tf)}</th>)}</tr></thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

function Detail({ ticker, series, labApi, onChanged }: { ticker: string; series: Series[]; labApi: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<Record<string, string>>({});
  const list = [...series].sort((a, b) => tfOrder(a.tf) - tfOrder(b.tf) || a.where.localeCompare(b.where));
  const sym = platformSymbol(ticker, list[0]?.market);
  const mark = (k: string, v: string) => setBusy((b) => ({ ...b, [k]: v }));

  const openChart = (tf: string) => {
    showOnChart(sym);
    useStore.getState().setTimeframe(platformTf(tf));
  };
  // a lab file into this browser's store: the charts (offline, replay) page back into it
  const copy = async (s: Series) => {
    // years of 1-minute bars: hundreds of MB in the browser
    if (s.bars > 1_000_000 && !window.confirm(`Copier ${n0(s.bars)} barres (${mb(s.bars * 48)}) dans ce navigateur ? Ça peut prendre quelques minutes.`)) return;
    mark(s.key, 'Copie…');
    try {
      const id = s.derived ? s.labId!.replace(/_4h$/, '_1h') : s.labId!;
      const r = await fetch(`/api/data/lab/bars?id=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`serveur ${r.status}`);
      let rows: Float64Array = new Float64Array(await r.arrayBuffer());
      if (s.derived) rows = resampleRows(rows, 14400, false);
      const tf = platformTf(s.tf), feed = importFeed(sym.ticker);
      await saveRows({ key: `${sym.ticker}|${tf}|${feed}`, ticker: sym.ticker, tf, feed, label: `Import · ${sym.ticker}`, symbol: sym }, rows,
        (p) => mark(s.key, `Copie ${Math.round(p * 100)} %`));
      mark(s.key, '✓ copié');
      onChanged();
    } catch (e) {
      mark(s.key, `Échec : ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const remove = async (s: Series) => {
    const what = `${s.ticker} ${tfName(s.tf)} (${s.where === 'lab' ? 'labo' : 'navigateur'}, ${s.source})`;
    if (!window.confirm(`Supprimer définitivement ${what} ?`)) return;
    try {
      if (s.where === 'browser' && s.meta) await deleteSeries(s.meta.key);
      else {
        const r = await fetch(`/api/data/lab?id=${encodeURIComponent(s.labId!)}`, { method: 'DELETE' });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `serveur ${r.status}`);
      }
      onChanged();
    } catch (e) {
      mark(s.key, `Échec : ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="dt-detail" onClick={(e) => e.stopPropagation()}>
      <div className="rb-card-title">{ticker}<small>{sym.name !== ticker ? sym.name : ''} · {MARKET_LABEL[list[0]?.market] ?? ''} · {list.length} série{list.length > 1 ? 's' : ''}</small></div>
      <table className="rb-table">
        <thead><tr><th>Unité</th><th>Où</th><th>Source</th><th>Depuis</th><th>Jusqu’au</th><th>Durée</th><th>Barres</th><th>Taille</th><th>Labo</th><th /></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.key}>
              <td>{tfName(s.tf)}</td>
              <td>{s.where === 'lab' ? 'Labo (disque)' : 'Navigateur'}</td>
              <td>{s.source}</td>
              <td>{day(s.from)}</td>
              <td className={recent(s.to) ? '' : 'dt-old'}>{day(s.to)}</td>
              <td className={`dt-lvl-${level(s)}`}>{span(s.to - s.from)}</td>
              <td>{n0(s.bars)}</td>
              <td>{s.size ? mb(s.size) : '—'}</td>
              <td>{s.where === 'lab' ? (s.tested ? <span className="up" title="Recherche de robots faite sur ces données">testé</span> : <span className="dt-muted" title="Pas encore dans une recherche de robots">à tester</span>) : ''}</td>
              <td className="dt-actions">
                <button className="off-link" onClick={() => openChart(s.tf)}>Graphique</button>
                {s.where === 'lab' && labApi && <button className="off-link" title="Copier dans ce navigateur : utile seulement pour l’application compilée, sans le serveur de développement (les graphiques lisent déjà le labo)" onClick={() => void copy(s)}>→ Navigateur</button>}
                {(s.where === 'browser' || (labApi && s.labId?.startsWith('import_'))) && <button className="tf-menu-icon" title="Supprimer" onClick={() => void remove(s)}>✕</button>}
                {busy[s.key] && <span className="dt-muted">{busy[s.key]}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// the lab's gaps: the timeframes the robots trade, with less than a fair test's history
function Missing({ series }: { series: Series[] }) {
  const lab = series.filter((s) => s.where === 'lab');
  const byAsset = new Map<string, Series[]>();
  for (const s of lab) byAsset.set(s.ticker, [...(byAsset.get(s.ticker) ?? []), s]);
  const rows = [...byAsset.entries()]
    .map(([ticker, list]) => ({
      ticker, market: list[0].market,
      gaps: ['15m', '30m', '1h', '4h', '1d'].map((tf) => {
        const b = best(list.filter((s) => s.tf === tf));
        return { tf, have: b ? (b.to - b.from) / YEAR : 0, target: TARGET[tf] };
      }).filter((g) => g.have < g.target),
    }))
    .filter((r) => r.gaps.length)
    .sort((a, b) => MARKETS.indexOf(a.market) - MARKETS.indexOf(b.market) || a.ticker.localeCompare(b.ticker));
  return (
    <div className="dt-missing">
      <div className="rb-card">
        <div className="rb-card-title">Ce qu’il manque au labo<small>unités tradées par les robots · objectif : 3 ans en 15 et 30 min, 5 ans en 1 h et 4 h, 10 ans en jour</small></div>
        <p className="dt-lead">
          Priorité : <b>forex, or, argent, pétrole et indices en 15 min à 4 h</b>. Les robots y marchent le mieux, mais Yahoo ne donne que 2 ans en 1 h et 60 jours en 15 et 30 min.
          Un export <b>M1</b> sur 5 à 10 ans suffit : les autres unités sont construites à l’import.
        </p>
        <table className="rb-table dt-gaps">
          <thead><tr><th>Actif</th><th>Classe</th><th>Manque</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td><b>{r.ticker}</b></td>
                <td>{MARKET_LABEL[r.market]}</td>
                <td className="dt-gap-list">
                  {r.gaps.map((g) => (
                    <span key={g.tf} className={g.have === 0 ? 'none' : g.have / g.target < 0.35 ? 'low' : 'mid'}>
                      {tfName(g.tf)} : {g.have ? span(g.have * YEAR) : 'rien'} / {g.target} ans
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Où trouver ces historiques</div>
        <ul className="dt-where">
          <li><b>Depuis la plateforme : Inventaire › « Télécharger un historique », ou clic sur une case du tableau.</b> Binance pour la crypto (tout), Interactive Brokers avec IB Gateway ouvert pour les indices, futures, CFD et actions américaines (plusieurs années, un peu plus d’un an pour les futures), Yahoo pour le reste (court).</li>
          <li><b>Forex, or, argent, pétrole, indices : MetaTrader 5 de ton courtier.</b> Affichage › Symboles › onglet Barres › unité M1 et dates › Demander › Exporter les barres. La profondeur dépend du courtier. À l’import, choisir l’heure « Courtier MetaTrader ».</li>
          <li><b>Dukascopy</b> (page « Historical Data Feed », gratuit avec inscription) : forex, métaux, indices et pétrole en M1 sur de nombreuses années, en CSV.</li>
          <li><b>HistData.com</b> (gratuit) : déjà téléchargé en M1 pour 41 paires forex (depuis 2000 à 2010 selon la paire), l’or et l’argent (2009), le pétrole et 9 indices (S&P 500, Nasdaq 100, DAX, CAC 40, FTSE 100, Nikkei, Hang Seng, ASX 200, Dollar Index depuis 2010 ; Euro Stoxx 50 de 2010 à 2019). Les indices ajoutés sont rangés léger : 15 min et plus sur tout l’historique, 1 et 5 min sur les 3 derniers mois. Mise à jour : <code>relancer-robots.bat</code>. Pour une autre paire, ses ZIP « Generic ASCII » s’importent tels quels (heure UTC−5 réglée toute seule).</li>
          <li><b>Autres indices</b> (S&P 400 / 600, MDAX, SDAX, SBF 120, FTSE 250, Euronext, Japon, Chine…) : aucune source gratuite en 15 min sur plusieurs années. <code>relancer-robots.bat</code> garde ce que donne Yahoo (15 min sur 60 jours, 1 h sur 2 ans, jour depuis le début) et l’ajoute à chaque passage : l’historique 15 min s’allonge avec le temps.</li>
          <li><b>Actions américaines</b> : export MetaTrader 5 d’un courtier CFD actions, sinon fournisseurs payants (FirstRate Data, Kibot…).</li>
          <li><b>Crypto</b> : tout l’historique Binance de chaque crypto de la plateforme (depuis sa cotation) est téléchargé et mis à jour par <code>relancer-robots.bat</code>. Les ZIP de data.binance.vision d’autres paires s’importent tels quels.</li>
        </ul>
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Ce que les sources gratuites donnent en direct<small>sans rien importer</small></div>
        <table className="rb-table">
          <thead><tr><th>Marchés</th><th>1 min</th><th>5 à 30 min</th><th>1 h</th><th>4 h</th><th>Jour et plus</th><th>Ticks</th></tr></thead>
          <tbody>
            <tr><td>Crypto (Binance)</td><td>tout</td><td>tout</td><td>tout</td><td>tout</td><td>tout</td><td>tout (lent)</td></tr>
            <tr><td>Or, argent, pétrole, SPY, QQQ, actions US (perpétuels Binance)</td><td colSpan={5}>depuis leur cotation (2025)</td><td>oui</td></tr>
            <tr><td>Forex, indices, matières premières, actions (Yahoo)</td><td>30 jours</td><td>60 jours</td><td>2 ans</td><td>2 ans (calculé)</td><td>tout</td><td>non</td></tr>
          </tbody>
        </table>
        <p className="dt-muted">Au-delà, en remontant le passé, les graphiques continuent tout seuls dans l’historique du labo (fichiers « Labo (disque) ») : forex en 1 min depuis 2000, crypto depuis la cotation. Ils enregistrent aussi ce qu’ils affichent dans le navigateur, et un import remonte plus loin dans le passé.</p>
      </div>
    </div>
  );
}

type View = 'inventory' | 'missing' | 'import';

export default function DataPage() {
  // the filters, the open asset and the last list read come back with the tab
  const [data, setData] = useKept<Loaded | null>('data.loaded', null, true);
  const [gen, setGen] = useState(0);
  const [view, setView] = useKept<View>('data.view', 'inventory');
  const [where, setWhere] = useKept<'all' | 'lab' | 'browser'>('data.where', 'all');
  const [market, setMarket] = useKept<'all' | LabMarket>('data.market', 'all');
  const [q, setQ] = useKept('data.q', '');
  const [selected, setSelected] = useKept<string | null>('data.selected', null);
  const [dragging, setDragging] = useState(false);
  const importRef = useRef<ImportHandle>(null);

  useEffect(() => {
    let alive = true;
    void load().then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [gen, setData]);
  const refresh = () => setGen((g) => g + 1);
  // downloads: the window (market and timeframe of the cell clicked), those under way
  const [dl, setDl] = useState<{ ticker?: string; tf?: string } | null>(null);
  const [jobs, pokeJobs] = useDownloadJobs(refresh);

  const series = useMemo(() => (data ? toSeries(data) : []), [data]);
  const shown = series.filter((s) => (where === 'all' || s.where === where) && (market === 'all' || s.market === market)
    && (!q || s.ticker.includes(q.toUpperCase()) || (SYMBOLS.find((x) => x.ticker === s.ticker)?.name ?? '').toLowerCase().includes(q.toLowerCase())));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    setView('import');
    importRef.current?.add(files);
  };

  const labBytes = data?.lab.reduce((a, e) => a + (e.derived ? 0 : e.size), 0) ?? 0;
  const assets = new Set(series.map((s) => s.ticker)).size;
  const bars = series.reduce((a, s) => a + (s.derived ? 0 : s.bars), 0);

  return (
    <div className={`rb-page dt-page ${dragging ? 'dt-dragging' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}>
      <div className="rb-top">
        <h1>Développeur · Data</h1>
        <div className="rb-summary">
          Toutes les données de prix (OHLC) de la plateforme : par actif et par unité de temps, depuis quand et jusqu’à quand.
          Le labo, ce sont les fichiers de <code>robots/data</code> utilisés par la recherche de robots. Le navigateur, c’est ce que les graphiques ont enregistré pour le hors ligne et le replay.
        </div>
        <div className="rb-criteria">
          <span>{assets} actifs</span>
          <span>{series.length} séries</span>
          <span>{n0(bars)} barres</span>
          <span>Labo : {data?.lab.filter((e) => !e.derived).length ?? 0} fichiers · {mb(labBytes)}</span>
          <span>Navigateur : {data?.browser.length ?? 0} séries{data?.usage != null ? ` · ${mb(data.usage)}` : ''}</span>
          <button className="off-link" onClick={refresh}>Actualiser</button>
        </div>
        <div className="dt-views">
          {([['inventory', 'Inventaire'], ['missing', 'Ce qu’il manque'], ['import', 'Importer des fichiers']] as [View, string][]).map(([v, l]) => (
            <button key={v} className={`pill-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="dt-body">
        {data && !data.labApi && (
          <div className="dt-note">Liste du labo lue dans le dernier rapport des robots : lancez la plateforme avec <code>lancer.bat</code> pour la liste à jour, l’import vers le labo et la copie vers le navigateur.</div>
        )}
        {!data && <div className="rb-empty">Lecture des données…</div>}
        <DownloadJobs jobs={jobs} />

        {data && view === 'inventory' && (
          <>
            <div className="dt-filters">
              <div className="dt-seg">
                {([['all', 'Tout'], ['lab', 'Labo (disque)'], ['browser', 'Navigateur']] as ['all' | 'lab' | 'browser', string][]).map(([v, l]) => (
                  <button key={v} className={where === v ? 'on' : ''} onClick={() => setWhere(v)}>{l}</button>
                ))}
              </div>
              <div className="dt-seg">
                <button className={market === 'all' ? 'on' : ''} onClick={() => setMarket('all')}>Toutes classes</button>
                {MARKETS.map((m) => <button key={m} className={market === m ? 'on' : ''} onClick={() => setMarket(m)}>{MARKET_LABEL[m]}</button>)}
              </div>
              <input className="dt-search" placeholder="Rechercher un actif" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="pill-btn active" title="Choisir un actif, une unité de temps et une durée : la plateforme télécharge l’historique" onClick={() => setDl({})}>⬇ Télécharger un historique</button>
              <div className="dt-legend">
                <span className="lvl-ok">assez pour un test</span><span className="lvl-mid">court</span><span className="lvl-low">très court</span>
              </div>
            </div>
            <Matrix series={shown} selected={selected} onSelect={(t) => setSelected(t === selected ? null : t)} jobs={jobs} onCell={(ticker, tf) => setDl({ ticker, tf })}
              detail={(t) => <Detail ticker={t} series={series.filter((s) => s.ticker === t)} labApi={data.labApi} onChanged={refresh} />} />
          </>
        )}

        {data && view === 'missing' && <Missing series={series} />}

        <div hidden={view !== 'import'}>
          <DataImport ref={importRef} onImported={refresh} />
        </div>
      </div>
      {dragging && <div className="dt-drop-overlay">Déposez les fichiers pour les importer</div>}
      {dl && <DownloadDialog ticker={dl.ticker} tf={dl.tf} onClose={() => setDl(null)} onStarted={pokeJobs} />}
    </div>
  );
}
