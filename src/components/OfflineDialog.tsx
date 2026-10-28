import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getActiveWatchlist, useStore } from '../store/store';
import { openFeed } from '../data/feeds';
import { autoSaveEnabled, clearAll, deleteSeries, listSeries, setAutoSave, type SeriesMeta } from '../data/offline/db';
import { isDailyTf, tfSeconds, tfShortLabel } from '../data/timeframes';
import type { Symbol, Timeframe } from '../types';
import { LOCALE } from '../i18n/lang';

// "Données hors ligne": what is saved on this computer, and downloading deep
// history ahead of time to chart, replay and backtest without a connection.

const TFS: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W'];
const DEPTHS: [number, string][] = [[10_000, '10 000 barres'], [50_000, '50 000 barres'], [200_000, '200 000 barres']];
const BYTES_PER_BAR = 48;

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} Go`
  : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} Mo` : `${Math.max(1, Math.round(bytes / 1e3))} Ko`);
const n0 = (v: number) => Math.round(v).toLocaleString(LOCALE);
function dateOf(t: number, tf: Timeframe) {
  return new Date(t * 1000).toLocaleString(LOCALE, isDailyTf(tf)
    ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const sourceOf = (feed: string) => {
  const [src, id] = feed.split(':');
  return `${src === 'binance' ? 'Binance' : src === 'binance-futures' ? 'Binance Futures' : src === 'yahoo' ? 'Yahoo' : src} ${id}`;
};

async function loadSaved() {
  const list = await listSeries();
  list.sort((a, b) => a.ticker.localeCompare(b.ticker) || (tfSeconds(a.tf) ?? 0) - (tfSeconds(b.tf) ?? 0));
  const e = await navigator.storage?.estimate?.().catch(() => null);
  return { list, usage: e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null };
}

export default function OfflineDialog({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.symbol);
  const watchlist = useStore(getActiveWatchlist);
  const symbols = useMemo(() => {
    const all: Symbol[] = [current, ...watchlist.items.flatMap((r) => (r.kind === 'asset' ? [r.data] : []))];
    return all.filter((s, i) => all.findIndex((x) => x.ticker === s.ticker) === i);
  }, [current, watchlist]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set([current.ticker]));
  const [tfs, setTfs] = useState<Set<Timeframe>>(() => new Set<Timeframe>(['5m', '1h', '1D']));
  const [depth, setDepth] = useState(50_000);
  const [auto, setAuto] = useState(autoSaveEnabled);
  const [series, setSeries] = useState<SeriesMeta[] | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [job, setJob] = useState<{ text: string; done: number; total: number } | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const stop = useRef(false);

  const refresh = useCallback(() => loadSaved().then((r) => { setSeries(r.list); setUsage(r.usage); }), []);
  useEffect(() => {
    let alive = true;
    void loadSaved().then((r) => { if (alive) { setSeries(r.list); setUsage(r.usage); } });
    return () => { alive = false; };
  }, []);

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };

  async function download() {
    const list = symbols.filter((s) => picked.has(s.ticker));
    const units = TFS.filter((t) => tfs.has(t));
    if (!list.length || !units.length) return;
    stop.current = false;
    setReport(null);
    // ask the browser not to clear this data when disk space runs low
    await navigator.storage?.persist?.().catch(() => false);
    const total = list.length * units.length;
    const failed: string[] = [];
    let done = 0, bars = 0;
    for (const sym of list) {
      for (const tf of units) {
        if (stop.current) break;
        const what = `${sym.ticker} · ${tfShortLabel(tf)}`;
        setJob({ text: `${what} : connexion…`, done, total });
        try {
          const { session, candles } = await openFeed(sym, tf, { save: true, localHistory: false });
          if (session.source === 'sim' || session.source === 'local') {
            failed.push(what);
          } else {
            let n = candles.length;
            for (let i = 0; i < 400 && n < depth && session.hasMore && !stop.current; i++) {
              const older = await session.loadOlder();
              if (!older.length) break;
              n += older.length;
              setJob({ text: `${what} : ${n0(n)} barres`, done, total });
            }
            bars += n;
          }
        } catch {
          failed.push(what);
        }
        done++;
      }
    }
    setJob(null);
    setReport(`${n0(bars)} barres enregistrées${failed.length ? ` · sans données : ${failed.join(', ')}` : ''}${stop.current ? ' · arrêté' : ''}`);
    // the last writes finish in the background
    setTimeout(() => void refresh(), 800);
  }

  const totalBars = series?.reduce((a, m) => a + m.count, 0) ?? 0;
  const open = (m: SeriesMeta) => {
    const st = useStore.getState();
    st.setSymbol(m.symbol);
    st.setTimeframe(m.tf);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal off-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Données hors ligne</div>
        <p className="off-note">
          Les barres des graphiques sont enregistrées sur cet ordinateur (historique et temps réel). Sans connexion,
          les graphiques, le replay et le testeur de stratégie utilisent ces données ; une unité absente est
          reconstruite à partir d’une plus fine (5m depuis 1m, 4H depuis 1H…).
        </p>
        <label className="settings-checkbox off-auto">
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoSave(e.target.checked); }} />
          Enregistrer automatiquement chaque graphique ouvert
        </label>
        <div className="off-usage">
          {series ? `${series.length} séries · ${n0(totalBars)} barres · ${mb(totalBars * BYTES_PER_BAR)}` : 'Lecture…'}
          {usage && usage.quota > 0 && <span> · espace du navigateur : {mb(usage.used)} utilisés sur {mb(usage.quota)}</span>}
        </div>

        <div className="modal-title">Télécharger l’historique</div>
        <div className="off-row">
          <span className="off-label">Symboles</span>
          <div className="off-syms">
            {symbols.map((s) => (
              <button key={s.ticker} className={`pill-btn ${picked.has(s.ticker) ? 'active' : ''}`} onClick={() => setPicked(toggle(picked, s.ticker))} title={s.name}>
                {s.ticker}
              </button>
            ))}
          </div>
        </div>
        <div className="off-row">
          <span className="off-label" />
          <div className="off-syms">
            <button className="off-link" onClick={() => setPicked(new Set(symbols.map((s) => s.ticker)))}>Toute la liste</button>
            <button className="off-link" onClick={() => setPicked(new Set())}>Aucun</button>
          </div>
        </div>
        <div className="off-row">
          <span className="off-label">Unités</span>
          <div className="off-syms">
            {TFS.map((t) => (
              <button key={t} className={`pill-btn ${tfs.has(t) ? 'active' : ''}`} onClick={() => setTfs(toggle(tfs, t))}>{tfShortLabel(t)}</button>
            ))}
          </div>
        </div>
        <div className="off-row">
          <span className="off-label">Profondeur</span>
          <select value={depth} onChange={(e) => setDepth(parseInt(e.target.value))}>
            {DEPTHS.map(([v, l]) => <option key={v} value={v}>{l} au plus par série</option>)}
          </select>
        </div>
        <div className="off-row">
          <span className="off-label" />
          {job ? (
            <div className="off-job">
              <div className="off-bar"><i style={{ width: `${(job.done / job.total) * 100}%` }} /></div>
              <span>{job.done + 1}/{job.total} · {job.text}</span>
              <button className="pill-btn" onClick={() => { stop.current = true; }}>Arrêter</button>
            </div>
          ) : (
            <button className="pill-btn active" disabled={!picked.size || !tfs.size} onClick={() => void download()}>
              Télécharger {picked.size * tfs.size > 0 ? `(${picked.size * tfs.size} séries)` : ''}
            </button>
          )}
        </div>
        {report && <div className="off-report">{report}</div>}
        <div className="off-hint">Yahoo limite l’historique intraday (1 min : 30 jours, 5–30 min : 60 jours) ; le journalier et la crypto (Binance) remontent beaucoup plus loin.</div>

        <div className="modal-title off-saved-title">
          Données enregistrées
          {!!series?.length && (
            <button className="off-link" onClick={() => { if (window.confirm('Supprimer toutes les données enregistrées sur cet ordinateur ?')) void clearAll().then(refresh); }}>Tout supprimer</button>
          )}
        </div>
        {series && !series.length && <div className="off-empty">Rien pour l’instant : ouvrez un graphique ou téléchargez un historique.</div>}
        {!!series?.length && (
          <div className="off-table-wrap">
            <table className="off-table">
              <thead><tr><th>Symbole</th><th>Unité</th><th>Source</th><th>Barres</th><th>Période</th><th>Taille</th><th /></tr></thead>
              <tbody>
                {series.map((m) => (
                  <tr key={m.key}>
                    <td><button className="off-link" title="Ouvrir le graphique" onClick={() => open(m)}>{m.ticker}</button></td>
                    <td>{tfShortLabel(m.tf)}</td>
                    <td className="off-src">{sourceOf(m.feed)}</td>
                    <td>{n0(m.count)}</td>
                    <td className="off-period">{dateOf(m.first, m.tf)} → {dateOf(m.last, m.tf)}</td>
                    <td>{mb(m.count * BYTES_PER_BAR)}</td>
                    <td><button className="tf-menu-icon" title="Supprimer" onClick={() => void deleteSeries(m.key).then(refresh)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <button className="pill-btn close-btn" onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
