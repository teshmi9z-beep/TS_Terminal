import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { COLS, ZONES, mergeRows, parseFiles, resampleRows, STEPS, tfOfStep, detectStep, toUtc, type ParsedFile, type Zone } from '../../../data/import/csvImport';
import { importFeed, saveRows } from '../../../data/offline/db';
import { LAB_MARKETS, MARKET_LABEL, MARKET_OF, TF_LABEL, platformSymbol, platformTf, platformTicker, type LabMarket } from '../../../data/labSymbols';
import { SYMBOLS } from '../../../data/symbols';
import { tfSeconds } from '../../../data/timeframes';
import { day, n0, span } from './format';
import { LOCALE } from '../../../i18n/lang';

// "Importer des fichiers": price history found elsewhere (MetaTrader, Dukascopy,
// HistData, Binance, TradingView...) into the robot lab's folder and / or the
// browser's store (charts, replay and backtests offline).

type FileJob = { id: number; file: File; status: 'wait' | 'reading' | 'ok' | 'error'; progress: number; parsed: ParsedFile[]; error?: string };

// one market in one bar size, from one or more files (months / years of the same series)
type Group = { key: string; hint: string; step: number; tf: string | null; parts: ParsedFile[]; from: number; to: number; n: number; hasZone: boolean; format: string };

type Settings = {
  ticker: string; market: LabMarket; zone: Zone;
  toLab: boolean; toBrowser: boolean; labTfs: string[]; browserTfs: string[];
};

type RunState = { busy: boolean; step: string; done?: string; error?: string };

// the lab's intraday searches skip 1 and 5 minutes (the costs eat the gains) and they are slow
const LAB_DEFAULT_MIN = 900;

function groupsOf(jobs: FileJob[]): Group[] {
  const map = new Map<string, Group>();
  for (const j of jobs) {
    for (const p of j.parsed) {
      const step = detectStep(p.rows);
      const key = `${p.symbolHint || '?'}|${step}`;
      const g = map.get(key) ?? { key, hint: p.symbolHint, step, tf: tfOfStep(step), parts: [], from: Infinity, to: -Infinity, n: 0, hasZone: false, format: p.format };
      g.parts.push(p);
      g.from = Math.min(g.from, p.rows[0]);
      g.to = Math.max(g.to, p.rows[p.rows.length - COLS]);
      g.n += p.n;
      g.hasZone ||= p.hasZone;
      map.set(key, g);
    }
  }
  return [...map.values()];
}

function defaults(g: Group): Settings {
  const ticker = platformTicker(g.hint || '');
  const market = MARKET_OF[platformSymbol(ticker).category];
  const zone: Zone = g.hasZone || g.step >= 86400 ? 'utc' : g.format === 'HistData' ? 'histdata' : /MetaTrader/.test(g.format) ? 'broker' : 'utc';
  const up = STEPS.filter(([tf, s]) => tf !== '1w' && s >= g.step && s % g.step === 0);
  return {
    ticker, market, zone, toLab: true, toBrowser: true,
    labTfs: up.filter(([, s]) => s >= LAB_DEFAULT_MIN).map(([tf]) => tf),
    browserTfs: up.map(([tf]) => tf),
  };
}

async function postLab(ticker: string, market: string, tf: string, rows: Float64Array) {
  const q = new URLSearchParams({ symbol: ticker, market, tf });
  const r = await fetch(`/api/data/lab/import?${q}`, { method: 'POST', body: rows.slice().buffer, headers: { 'content-type': 'application/octet-stream' } });
  const j = await r.json().catch(() => ({})) as { error?: string; bars?: number };
  if (!r.ok) throw new Error(j.error ?? `serveur ${r.status}`);
  return j;
}

function GroupCard({ g, s, set, onRun, run }: { g: Group; s: Settings; set: (p: Partial<Settings>) => void; onRun: () => void; run?: RunState }) {
  const up = STEPS.filter(([tf, st]) => tf !== '1w' && st >= g.step && st % g.step === 0);
  const toggle = (list: string[], tf: string) => (list.includes(tf) ? list.filter((x) => x !== tf) : [...list, tf]);
  const known = SYMBOLS.find((x) => x.ticker === s.ticker);
  const intraday = g.step < 86400;
  const nothing = (!s.toLab || !s.labTfs.length) && (!s.toBrowser || !s.browserTfs.length);
  return (
    <div className="dt-group">
      <div className="dt-group-head">
        <b>{s.ticker || '—'}</b>
        <span>{known?.name ?? 'symbole non listé dans la plateforme'}</span>
        <span className="dt-tag">{g.tf ? TF_LABEL[g.tf] ?? g.tf : `unité inconnue (${g.step} s)`}</span>
        <span className="dt-tag">{g.format}</span>
      </div>
      <div className="dt-group-meta">
        {g.parts.length} fichier{g.parts.length > 1 ? 's' : ''} · {n0(g.n)} barres · {day(g.from)} → {day(g.to)} ({span(g.to - g.from)})
        {g.parts.some((p) => p.skipped > 1) && <> · {n0(g.parts.reduce((a, p) => a + p.skipped, 0))} lignes ignorées</>}
      </div>
      <div className="dt-form">
        <label>Actif
          <input list="dt-tickers" value={s.ticker} onChange={(e) => {
            const ticker = e.target.value.toUpperCase().trim();
            const k = SYMBOLS.find((x) => x.ticker === ticker);
            set(k ? { ticker, market: MARKET_OF[k.category] } : { ticker });
          }} />
        </label>
        <label>Classe
          <select value={s.market} onChange={(e) => set({ market: e.target.value as LabMarket })}>
            {LAB_MARKETS.map((m) => <option key={m} value={m}>{MARKET_LABEL[m]}</option>)}
          </select>
        </label>
        <label title={g.hasZone ? 'Le fichier indique son fuseau horaire' : 'Heure dans laquelle le fichier est écrit : les barres sont ramenées en UTC'}>Heure du fichier
          <select value={g.hasZone ? 'utc' : s.zone} disabled={g.hasZone || !intraday} onChange={(e) => set({ zone: e.target.value as Zone })}>
            {g.hasZone ? <option value="utc">écrite dans le fichier</option> : !intraday ? <option value="utc">sans objet (jours)</option> : ZONES.map(([z, l]) => <option key={z} value={z}>{l}</option>)}
          </select>
        </label>
      </div>
      <div className="dt-dest">
        <label className="dt-check"><input type="checkbox" checked={s.toLab} onChange={(e) => set({ toLab: e.target.checked })} /> Labo robots (disque, <code>robots/data</code>)</label>
        {s.toLab && (
          <div className="dt-tfs">
            {up.map(([tf, st]) => (
              <label key={tf} className={`dt-tf ${s.labTfs.includes(tf) ? 'on' : ''}`} title={st < LAB_DEFAULT_MIN ? 'Les frais rendent ces unités perdantes, et leur recherche est très longue' : undefined}>
                <input type="checkbox" checked={s.labTfs.includes(tf)} onChange={() => set({ labTfs: toggle(s.labTfs, tf) })} />{TF_LABEL[tf] ?? tf}
              </label>
            ))}
          </div>
        )}
        <label className="dt-check"><input type="checkbox" checked={s.toBrowser} onChange={(e) => set({ toBrowser: e.target.checked })} /> Graphiques de ce navigateur (hors ligne, replay, historique plus long)</label>
        {s.toBrowser && (
          <div className="dt-tfs">
            {up.map(([tf]) => (
              <label key={tf} className={`dt-tf ${s.browserTfs.includes(tf) ? 'on' : ''}`}>
                <input type="checkbox" checked={s.browserTfs.includes(tf)} onChange={() => set({ browserTfs: toggle(s.browserTfs, tf) })} />{TF_LABEL[tf] ?? tf}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="dt-group-foot">
        <button className="pill-btn primary" disabled={!g.tf || !s.ticker || run?.busy || nothing} onClick={onRun}>
          {run?.busy ? 'Import en cours…' : 'Importer'}
        </button>
        {run?.busy && <span className="dt-muted">{run.step}</span>}
        {run?.done && <span className="up">✓ {run.done}</span>}
        {run?.error && <span className="down">{run.error}</span>}
      </div>
    </div>
  );
}

export type ImportHandle = { add: (files: File[]) => void };

export default function DataImport({ ref, onImported }: { ref: Ref<ImportHandle>; onImported: () => void }) {
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [settings, setSettings] = useState<Record<string, Settings>>({});
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const add = (files: File[]) => {
    const fresh = files.filter((f) => /\.(csv|txt|zip)$/i.test(f.name)).map((file) => ({ id: ++seq.current, file, status: 'wait' as const, progress: 0, parsed: [] }));
    if (!fresh.length) return;
    setJobs((j) => [...j, ...fresh]);
    const patch = (id: number, p: Partial<FileJob>) => setJobs((all) => all.map((x) => (x.id === id ? { ...x, ...p } : x)));
    // one file at a time: big files take memory
    for (const job of fresh) {
      queue.current = queue.current.then(async () => {
        patch(job.id, { status: 'reading' });
        try {
          const parsed = await parseFiles(job.file, (p) => patch(job.id, { progress: p }));
          patch(job.id, { status: 'ok', parsed, progress: 1 });
        } catch (e) {
          patch(job.id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      });
    }
  };

  // files dropped anywhere on the page
  useImperativeHandle(ref, () => ({ add }));

  const groups = useMemo(() => groupsOf(jobs), [jobs]);
  const settingsOf = (g: Group) => settings[g.key] ?? defaults(g);
  const setFor = (g: Group) => (p: Partial<Settings>) => setSettings((all) => ({ ...all, [g.key]: { ...(all[g.key] ?? defaults(g)), ...p } }));

  const runGroup = async (g: Group) => {
    const s = settingsOf(g);
    const say = (p: RunState) => setRuns((all) => ({ ...all, [g.key]: p }));
    try {
      say({ busy: true, step: 'Assemblage des fichiers…' });
      await new Promise((r) => setTimeout(r, 20));
      let rows = mergeRows(g.parts.map((p) => p.rows));
      if (!g.hasZone && g.step < 86400) rows = toUtc(rows, s.zone);
      const sunday = s.market !== 'Crypto';
      const byTf = (tf: string) => { const sec = tfSeconds(platformTf(tf))!; return sec === g.step ? rows : resampleRows(rows, sec, sunday); };
      const done: string[] = [];
      if (s.toLab && s.labTfs.length) {
        for (const tf of s.labTfs) {
          say({ busy: true, step: `Labo : ${TF_LABEL[tf] ?? tf}…` });
          await postLab(s.ticker, s.market, tf, byTf(tf));
        }
        done.push(`labo (${s.labTfs.map((t) => TF_LABEL[t] ?? t).join(', ')})`);
      }
      if (s.toBrowser && s.browserTfs.length) {
        const symbol = platformSymbol(s.ticker, s.market);
        for (const tf of s.browserTfs) {
          const ptf = platformTf(tf);
          const feed = importFeed(symbol.ticker);
          await saveRows({ key: `${symbol.ticker}|${ptf}|${feed}`, ticker: symbol.ticker, tf: ptf, feed, label: `Import · ${symbol.ticker}`, symbol }, byTf(tf),
            (p) => say({ busy: true, step: `Navigateur : ${TF_LABEL[tf] ?? tf} ${Math.round(p * 100)} %` }));
        }
        done.push(`navigateur (${s.browserTfs.map((t) => TF_LABEL[t] ?? t).join(', ')})`);
      }
      say({ busy: false, step: '', done: `${n0(rows.length / COLS)} barres importées : ${done.join(' et ')}` });
      onImported();
    } catch (e) {
      say({ busy: false, step: '', error: e instanceof Error ? e.message : String(e) });
    }
  };

  const reading = jobs.some((j) => j.status === 'wait' || j.status === 'reading');
  return (
    <div className="dt-import">
      <datalist id="dt-tickers">{SYMBOLS.map((s) => <option key={s.ticker} value={s.ticker}>{s.name}</option>)}</datalist>
      <div className="dt-drop" onClick={() => inputRef.current?.click()}>
        <b>Déposez vos fichiers ici</b> ou cliquez pour les choisir
        <small>CSV, TXT ou ZIP · plusieurs fichiers d’un même marché (mois, années) sont assemblés</small>
        <input ref={inputRef} type="file" multiple accept=".csv,.txt,.zip" hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>

      {jobs.length > 0 && (
        <div className="dt-files">
          {jobs.map((j) => (
            <div key={j.id} className={`dt-file ${j.status}`}>
              <span className="dt-file-name">{j.file.name}</span>
              <span className="dt-muted">{(j.file.size / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} Mo</span>
              {j.status === 'reading' && <span className="dt-bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></span>}
              {j.status === 'wait' && <span className="dt-muted">en attente</span>}
              {j.status === 'ok' && <span className="up">{j.parsed.map((p) => `${p.format} · ${n0(p.n)} barres`).join(' · ')}</span>}
              {j.status === 'error' && <span className="down">{j.error}</span>}
            </div>
          ))}
          <button className="off-link" disabled={reading} onClick={() => { setJobs([]); setSettings({}); setRuns({}); }}>Vider la liste</button>
        </div>
      )}

      {groups.map((g) => <GroupCard key={g.key} g={g} s={settingsOf(g)} set={setFor(g)} run={runs[g.key]} onRun={() => void runGroup(g)} />)}

      <div className="dt-help">
        <b>Formats reconnus</b>
        <ul>
          <li><b>MetaTrader 5</b> : fenêtre Symboles › onglet Barres › unité M1 › dates › Demander › Exporter les barres. <b>MetaTrader 4</b> : Outils › Centre d’historique › Exporter.</li>
          <li><b>Dukascopy</b> (CSV « Gmt time »), <b>HistData</b> (Generic ASCII, heure UTC−5 fixe), <b>Binance</b> (fichiers ZIP de data.binance.vision tels quels).</li>
          <li><b>TradingView</b> (Exporter les données du graphique), <b>Yahoo</b> (Download), et tout CSV avec une date et les colonnes open, high, low, close.</li>
        </ul>
        <span className="dt-muted">L’unité de temps est lue dans les données. Les unités plus grandes (15 min, 1 h, 4 h, jour…) sont construites à partir de la plus fine. Déjà importé : les barres s’ajoutent, les mêmes dates sont remplacées.</span>
      </div>
    </div>
  );
}

