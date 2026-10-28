import { useEffect, useMemo, useState } from 'react';
import { activeJob, type DlJob } from './downloadJobs';
import { SYMBOLS } from '../../../data/symbols';
import { MARKET_OF, TF_LABEL } from '../../../data/labSymbols';
import { DL_TFS, barsEstimate, downloadPlans } from '../../../data/downloadPlan';
import { day, n0 } from './format';
import { DEC } from '../../../i18n/lang';

// The Data tab's downloads: pick a market, a timeframe and how far back, and the dev server
// (scripts/history-download.ts) brings the history into robots/data, where the charts and
// the robot lab read it.

const SPANS: [number, string][] = [[30, '1 mois'], [91, '3 mois'], [182, '6 mois'], [365, '1 an'], [730, '2 ans'], [1095, '3 ans'], [1826, '5 ans'], [3652, '10 ans'], [36500, 'Tout']];
// IBKR sends about 15 000 bars a minute (measured: 13 000 to 30 000, slower as it goes)
const IB_BARS_PER_MIN = 15000;
const minutes = (m: number) => (m < 1 ? 'moins d’une minute' : m < 90 ? `environ ${Math.round(m)} min` : `environ ${(m / 60).toFixed(1).replace('.', DEC)} h`);

export function DownloadJobs({ jobs }: { jobs: DlJob[] }) {
  const shown = jobs.slice(0, 8);
  if (!shown.length) return null;
  const cancel = (id: string) => { void fetch(`/api/data/download/cancel?id=${id}`, { method: 'POST' }); };
  return (
    <div className="dl-jobs">
      {shown.map((j) => (
        <div key={j.id} className={`dl-job ${j.state}`}>
          <div className="dl-job-head">
            <b>{j.ticker}</b> <span>{TF_LABEL[j.tf] ?? j.tf}</span> <span className="dt-muted">· {j.label} · depuis le {day(j.from)}</span>
            {activeJob(j) && <button className="off-link" onClick={() => cancel(j.id)}>Annuler</button>}
          </div>
          <div className="dl-bar"><span style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
          <div className="dt-muted">
            {j.state === 'queued' ? 'En attente : un téléchargement IBKR à la fois'
              : j.state === 'running' ? `${Math.round(j.progress * 100)} % · ${n0(j.bars)} barres${j.oldest ? `, jusqu’au ${day(j.oldest)}` : ''}${j.message ? ` · ${j.message}` : ''}`
              : j.state === 'done' ? `✓ ${n0(j.bars)} barres${j.oldest ? ` depuis le ${day(j.oldest)}` : ''}${j.files.length > 1 ? ` · ${j.files.length} fichiers (unités au-dessus construites)` : ''}${j.message ? ` · ${j.message}` : ''}`
              : j.state === 'cancelled' ? `Annulé · ${n0(j.bars)} barres gardées`
              : `Échec : ${j.message ?? 'erreur'}${j.bars ? ` · ${n0(j.bars)} barres gardées` : ''}`}
          </div>
        </div>
      ))}
    </div>
  );
}

// the window to start a download, opened from a cell (its market and timeframe) or the button
export function DownloadDialog({ ticker: initialTicker, tf: initialTf, onClose, onStarted }: { ticker?: string; tf?: string; onClose: () => void; onStarted: () => void }) {
  const [text, setText] = useState(initialTicker ?? '');
  const [tf, setTf] = useState(initialTf && (DL_TFS as readonly string[]).includes(initialTf) ? initialTf : '5m');
  const [days, setDays] = useState(1826);
  const [source, setSource] = useState<string | null>(null);
  const [coarser, setCoarser] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sym = useMemo(() => {
    const t = text.trim().toUpperCase();
    return SYMBOLS.find((s) => s.ticker === t) ?? SYMBOLS.find((s) => `${s.ticker} · ${s.name}`.toUpperCase() === t) ?? null;
  }, [text]);
  const plans = useMemo(() => (sym ? downloadPlans(sym) : []), [sym]);
  const plan = plans.find((p) => p.source === source) ?? plans[0] ?? null;
  const max = plan ? plan.maxDays(tf) : Infinity;
  const span = Math.min(days, max);
  const bars = sym && plan ? barsEstimate(sym, plan, tf, Math.min(span, 20 * 365)) : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const go = async () => {
    if (!sym || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/data/download/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker: sym.ticker, market: MARKET_OF[sym.category], tf, days: span, coarser, plan: { source: plan.source, id: plan.id, label: plan.label, align: plan.align } }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `serveur ${r.status}`);
      onStarted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal dl-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dl-modal-head">Télécharger un historique</div>

        <div className="modal-title">Actif</div>
        <input className="dt-search dl-input" list="dl-symbols" autoFocus={!initialTicker} placeholder="Ticker (ex : US100, DJI, BTCUSD)" value={text} onChange={(e) => { setText(e.target.value); setSource(null); }} />
        <datalist id="dl-symbols">{SYMBOLS.map((s) => <option key={s.ticker} value={s.ticker}>{s.name}</option>)}</datalist>
        {sym && <div className="dt-muted dl-name">{sym.name}</div>}
        {text && !sym && <div className="dt-muted dl-name">Actif inconnu de la plateforme.</div>}

        <div className="modal-title">Unité de temps</div>
        <div className="dt-seg">
          {DL_TFS.map((t) => <button key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)}>{TF_LABEL[t]}</button>)}
        </div>

        <div className="modal-title">Durée d’historique</div>
        <div className="dt-seg">
          {SPANS.map(([d, l]) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{l}</button>)}
        </div>

        {sym && (
          <>
            <div className="modal-title">Source</div>
            {!plans.length && <div className="dt-muted">Aucune source de téléchargement pour cet actif.</div>}
            <div className="dl-sources">
              {plans.map((p) => {
                const m = p.maxDays(tf);
                return (
                  <label key={p.source} className={`dl-source ${plan?.source === p.source ? 'on' : ''}`}>
                    <input type="radio" name="dl-src" checked={plan?.source === p.source} onChange={() => setSource(p.source)} />
                    <span>
                      <b>{p.label}</b>
                      <small>{p.note}{Number.isFinite(m) ? ` En ${TF_LABEL[tf]} : ${m >= 365 ? `${Math.round(m / 365)} an${m >= 730 ? 's' : ''}` : `${m} jours`} au plus.` : ''}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}

        <label className="dl-check"><input type="checkbox" checked={coarser} onChange={(e) => setCoarser(e.target.checked)} /> Construire aussi les unités au-dessus (jusqu’à 4 h) avec ces barres</label>

        {plan && (
          <div className="dl-estimate">
            {span < days && <div className="dt-old">{plan.label.split(' · ')[0]} ne remonte pas plus loin : {Number.isFinite(span) ? `${Math.round(span)} jours` : ''} au plus en {TF_LABEL[tf]}.</div>}
            ≈ {n0(bars)} barres{plan.source === 'ibkr' ? ` · ${minutes(bars / IB_BARS_PER_MIN)}` : ''}. Le téléchargement continue si vous quittez l’onglet ; ce qui arrive est enregistré au fur et à mesure.
          </div>
        )}
        {error && <div className="pg-error">{error}</div>}

        <div className="dl-actions">
          <button className="pill-btn" onClick={onClose}>Fermer</button>
          <button className="pill-btn active" disabled={!sym || !plan || busy} onClick={() => void go()}>{busy ? 'Lancement…' : 'Télécharger'}</button>
        </div>
      </div>
    </div>
  );
}
