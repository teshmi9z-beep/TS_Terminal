import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { useQuotes } from '../data/feeds/quotes';
import { findSymbol } from './symbolDnd';
import { currentPrice } from './symbolActions';
import { alertStatus, onAlertStatus } from '../alerts/runner';
import { alertSummary } from '../alerts/evaluate';
import { tfShortLabel } from '../data/timeframes';
import type { TechAlert } from '../types';
import PanelControls from './PanelControls';
import { LOCALE } from '../i18n/lang';

const when = (ms: number) => new Date(ms).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// "Alertes" panel: price alerts (quick), alerts on indicators / several conditions / a watchlist,
// and the journal of the alerts that went off
export default function AlertsSidePanel() {
  const alerts = useStore((s) => s.alerts);
  const techAlerts = useStore((s) => s.techAlerts);
  const alertLog = useStore((s) => s.alertLog);
  const watchlists = useStore((s) => s.watchlists);
  const symbol = useStore((s) => s.symbol);
  const addAlert = useStore((s) => s.addAlert);
  const removeAlert = useStore((s) => s.removeAlert);
  const rearmAlert = useStore((s) => s.rearmAlert);
  const updateTechAlert = useStore((s) => s.updateTechAlert);
  const removeTechAlert = useStore((s) => s.removeTechAlert);
  const clearAlertLog = useStore((s) => s.clearAlertLog);
  const setSymbol = useStore((s) => s.setSymbol);
  const openAlert = useChartUi((s) => s.openAlert);
  const quotes = useQuotes((s) => s.quotes);
  const [price, setPrice] = useState('');
  const [, setTick] = useState(0);
  useEffect(() => onAlertStatus(() => setTick((n) => n + 1)), []);

  const active = alerts.filter((a) => !a.triggered);
  const done = alerts.filter((a) => a.triggered);
  const goTo = (ticker: string) => { const s = findSymbol(ticker); if (s) setSymbol(s); };

  function create() {
    const cur = currentPrice();
    const v = price.trim() ? parseFloat(price.replace(',', '.')) : cur?.price;
    if (v == null || isNaN(v)) return;
    addAlert(symbol.ticker, +v.toFixed(cur?.precision ?? 4), symbol);
    setPrice('');
  }

  const row = (a: (typeof alerts)[number]) => {
    const last = quotes[a.ticker]?.last;
    const dist = last ? ((a.price - last) / last) * 100 : null;
    return (
      <div key={a.id} className={`side-row ${a.triggered ? 'muted' : ''}`}>
        <button className="side-link" onClick={() => goTo(a.ticker)}>{a.ticker}</button>
        <span className="side-mid">{a.triggered ? 'déclenchée à' : 'franchit'} <b>{a.price}</b></span>
        {dist != null && !a.triggered && <span className={`side-dist ${dist >= 0 ? 'up' : 'down'}`}>{dist >= 0 ? '+' : ''}{dist.toFixed(2)}%</span>}
        {a.triggered && <button className="pl-btn" title="Réarmer" onClick={() => rearmAlert(a.id)}>↻</button>}
        <button className="remove-btn" title="Supprimer" onClick={() => removeAlert(a.id)}>✕</button>
      </div>
    );
  };

  const target = (a: TechAlert) => (a.target.kind === 'symbol'
    ? a.target.symbol.ticker
    : `Liste « ${watchlists.find((w) => w.id === (a.target as { watchlistId: string }).watchlistId)?.name ?? 'supprimée'} »`);

  const techRow = (a: TechAlert) => (
    <div key={a.id} className={`al-row ${a.active ? '' : 'muted'}`}>
      <div className="al-row-head">
        <button className="side-link al-name" title={alertSummary(a)} onClick={() => openAlert({ edit: a })}>{a.name}</button>
        <button
          className="pl-btn" title={a.active ? 'Arrêter' : 'Relancer'}
          onClick={() => updateTechAlert(a.id, a.active ? { active: false } : { active: true, ...(a.expires && a.expires <= Date.now() ? { expires: undefined } : {}) })}
        >{a.active ? '⏸' : '▶'}</button>
        <button className="pl-btn" title="Modifier" onClick={() => openAlert({ edit: a })}>✎</button>
        <button className="remove-btn" title="Supprimer" onClick={() => removeTechAlert(a.id)}>✕</button>
      </div>
      <div className="al-row-sub">
        {target(a)} · {tfShortLabel(a.tf)} · {alertStatus(a)}
        {a.fired > 0 && ` · ${a.fired} fois, la dernière le ${when(a.lastFired ?? 0)}`}
      </div>
    </div>
  );

  return (
    <div className="side-panel">
      <div className="side-title with-ctl">Alertes<PanelControls /></div>
      <div className="side-form">
        <input placeholder={`Prix pour ${symbol.ticker} (vide = cours actuel)`} value={price} onChange={(e) => setPrice(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button className="pill-btn" onClick={create}>🔔 Créer</button>
      </div>
      <button className="pill-btn al-new" onClick={() => openAlert({})}>＋ Alerte sur indicateur, plusieurs conditions ou liste…</button>

      <div className="side-sub">Prix · en cours ({active.length})</div>
      {active.length === 0 && <div className="side-empty">Aucune alerte de prix active. Alt+A crée une alerte au prix actuel.</div>}
      {active.map(row)}
      {done.length > 0 && (
        <>
          <div className="side-sub">Prix · déclenchées ({done.length})</div>
          {done.map(row)}
        </>
      )}

      <div className="side-sub">Indicateurs et conditions ({techAlerts.length})</div>
      {techAlerts.length === 0 && (
        <div className="side-empty">
          Aucune. Créez-en une avec le bouton ci-dessus, ou avec la cloche 🔔 dans la légende d’un indicateur du graphique.
        </div>
      )}
      {techAlerts.map(techRow)}

      <div className="side-sub with-ctl">
        Journal ({alertLog.length})
        {alertLog.length > 0 && <button className="off-link" onClick={clearAlertLog}>Effacer</button>}
      </div>
      {alertLog.length === 0 && <div className="side-empty">Les alertes déclenchées s’affichent ici.</div>}
      {alertLog.slice(0, 50).map((e) => (
        <div key={e.id} className="al-log">
          <span className="al-log-time">{when(e.time)}</span>
          {e.ticker && <button className="side-link" onClick={() => goTo(e.ticker)}>{e.ticker}</button>}
          <span className="al-log-text">{e.text}</span>
        </div>
      ))}
    </div>
  );
}
