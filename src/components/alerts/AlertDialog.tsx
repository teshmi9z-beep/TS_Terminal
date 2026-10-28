import { useEffect, useMemo, useState } from 'react';
import { useStore, nextId } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { getIndicatorDef, sourcePlots } from '../../indicators/registry';
import { sourceRef } from '../../indicators/derived';
import { OPS, alertSummary, indicatorLabel } from '../../alerts/evaluate';
import { WATCHLIST_MAX, alertSymbols } from '../../alerts/runner';
import { SYMBOLS } from '../../data/symbols';
import { tfShortLabel } from '../../data/timeframes';
import { findSymbol } from '../symbolDnd';
import { currentPrice } from '../symbolActions';
import { mainChart } from '../mainChart';
import type { AlertCondition, AlertOp, AlertOperand, AlertTrigger, IndicatorConfig, TechAlert, Timeframe } from '../../types';

// TradingView's "Créer une alerte": conditions on the price and the chart's indicators (several,
// all or any of them), on one symbol or every symbol of a watchlist, with how often it goes off
// and until when. The indicators are copied into the alert with their settings.

const TFS: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W'];
const TRIGGERS: [AlertTrigger, string, string][] = [
  ['once', 'Une seule fois', 'La première fois, puis l’alerte s’arrête.'],
  ['bar', 'Une fois par barre', 'Au plus une fois par barre, dès que la condition est vraie (barre en cours).'],
  ['close', 'À la clôture de la barre', 'Vérifiée quand la barre se termine : pas de fausse alerte en cours de barre.'],
];
const MAX_CONDITIONS = 5;

// operands as <select> values: 'price', 'value', 'plot:<indicator id>:<plot key>'
const encode = (o: AlertOperand) => (o.kind === 'plot' ? `plot:${o.id}:${o.plot}` : o.kind);
function decode(v: string, keepValue: number): AlertOperand {
  if (v === 'price') return { kind: 'price' };
  if (v === 'value') return { kind: 'value', value: keepValue };
  const [, id, ...plot] = v.split(':');
  return { kind: 'plot', id, plot: plot.join(':') };
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const round = (v: number) => (Math.abs(v) >= 100 ? +v.toFixed(2) : +v.toPrecision(5));

// the last value of a plot on the main chart (a sensible default level)
function lastValue(id: string, plot: string): number | null {
  const p = mainChart.engine?.indicators.find((r) => r.cfg.id === id)?.plots.find((x) => x.key === plot);
  for (let i = (p?.data.length ?? 0) - 1; i >= 0; i--) if (Number.isFinite(p!.data[i].value)) return round(p!.data[i].value);
  return null;
}

function firstCondition(pool: IndicatorConfig[], indicatorId?: string, plot?: string): AlertCondition {
  const price = currentPrice();
  const cfg = indicatorId ? pool.find((i) => i.id === indicatorId) : undefined;
  const def = cfg && getIndicatorDef(cfg);
  if (cfg && def) {
    const plots = sourcePlots(cfg, def);
    const key = plot ?? plots.find((x) => x.kind === 'line')?.key ?? plots[0]?.key ?? 'v';
    const operand: AlertOperand = { kind: 'plot', id: cfg.id, plot: key };
    // a moving average is crossed by the price; an oscillator crosses a level
    if (def.overlay && !sourceRef(cfg)) return { left: { kind: 'price' }, op: 'cross', right: operand };
    const level = (cfg.levels ?? def.levels)?.[0] ?? lastValue(cfg.id, key) ?? 0;
    return { left: operand, op: 'cross', right: { kind: 'value', value: level } };
  }
  return { left: { kind: 'price' }, op: 'cross', right: { kind: 'value', value: price ? +price.price.toFixed(price.precision) : 0 } };
}

function OperandPick({ value, onChange, options, allowValue, allowPrice = true }: {
  value: AlertOperand; onChange: (o: AlertOperand) => void; options: { v: string; label: string }[]; allowValue: boolean; allowPrice?: boolean;
}) {
  const keep = value.kind === 'value' ? value.value : 0;
  return (
    <span className="al-operand">
      <select className="idg-select" value={encode(value)} onChange={(e) => onChange(decode(e.target.value, keep))}>
        {allowValue && <option value="value">Valeur</option>}
        {allowPrice && <option value="price">Prix (clôture)</option>}
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
      {value.kind === 'value' && (
        <input
          className="idg-text al-num" type="number" step="any" value={Number.isFinite(value.value) ? value.value : ''}
          onChange={(e) => onChange({ kind: 'value', value: e.target.value === '' ? NaN : parseFloat(e.target.value) })}
        />
      )}
    </span>
  );
}

export default function AlertDialog() {
  const draft = useChartUi((s) => s.alertDraft);
  const openAlert = useChartUi((s) => s.openAlert);
  const showToast = useChartUi((s) => s.showToast);
  const chartIndicators = useStore((s) => s.indicators);
  const chartSymbol = useStore((s) => s.symbol);
  const chartTf = useStore((s) => s.timeframe);
  const watchlists = useStore((s) => s.watchlists);
  const activeWatchlistId = useStore((s) => s.activeWatchlistId);
  const saveTechAlert = useStore((s) => s.saveTechAlert);
  const edit = draft?.edit;

  // the alert's own copies first (editing), then the chart's indicators
  const pool = useMemo(() => {
    const own = edit?.indicators ?? [];
    return [...own, ...chartIndicators.filter((c) => c.type !== 'STRATEGY' && !own.some((o) => o.id === c.id))];
  }, [edit, chartIndicators]);
  const plotOptions = useMemo(() => pool.flatMap((cfg) => {
    const def = getIndicatorDef(cfg);
    return def ? sourcePlots(cfg, def).map((p) => ({ v: `plot:${cfg.id}:${p.key}`, label: indicatorLabel(cfg.id, p.key, pool) })) : [];
  }), [pool]);

  const [targetKind, setTargetKind] = useState<'symbol' | 'watchlist'>(edit?.target.kind ?? 'symbol');
  const [ticker, setTicker] = useState(edit?.target.kind === 'symbol' ? edit.target.symbol.ticker : chartSymbol.ticker);
  const [watchlistId, setWatchlistId] = useState(edit?.target.kind === 'watchlist' ? edit.target.watchlistId : activeWatchlistId);
  const [tf, setTf] = useState<Timeframe>(edit?.tf ?? chartTf);
  const [conditions, setConditions] = useState<AlertCondition[]>(() => edit?.conditions ?? [firstCondition(pool, draft?.indicatorId, draft?.plot)]);
  const [match, setMatch] = useState<'all' | 'any'>(edit?.match ?? 'all');
  const [trigger, setTrigger] = useState<AlertTrigger>(edit?.trigger ?? 'once');
  const [noExpiry, setNoExpiry] = useState(!edit?.expires);
  const [expires, setExpires] = useState(() => localInput(edit?.expires ?? Date.now() + 30 * 86400_000));
  const [name, setName] = useState(edit?.name ?? '');
  const [message, setMessage] = useState(edit?.message ?? '');
  const [desktop, setDesktop] = useState(edit?.desktop ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openAlert(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openAlert]);

  const symbol = targetKind === 'symbol' ? (findSymbol(ticker.trim().toUpperCase()) ?? SYMBOLS.find((s) => s.ticker === ticker.trim().toUpperCase()) ?? null) : null;
  const listSymbols = targetKind === 'watchlist' ? alertSymbols({ target: { kind: 'watchlist', watchlistId } }, watchlists) : [];
  const listSize = watchlists.find((w) => w.id === watchlistId)?.items.filter((r) => r.kind === 'asset').length ?? 0;
  const autoName = alertSummary({ conditions, match, indicators: pool });
  const tfs = TFS.includes(tf) ? TFS : [...TFS, tf];

  const setCond = (i: number, patch: Partial<AlertCondition>) => setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  function setOp(i: number, op: AlertOp) {
    const meta = OPS.find((o) => o.id === op)!;
    setConditions((cs) => cs.map((c, j) => {
      if (j !== i) return c;
      if (meta.pct) return { ...c, op, right: { kind: 'value', value: c.right.kind === 'value' && c.op.endsWith('pct') ? c.right.value : 1 }, right2: undefined, bars: c.bars ?? 1 };
      if (meta.channel) return { ...c, op, right2: c.right2 ?? { kind: 'value', value: c.right.kind === 'value' ? c.right.value : 0 } };
      return { ...c, op, right2: undefined };
    }));
  }

  function save() {
    setError(null);
    if (!conditions.length) return setError('Ajoutez au moins une condition.');
    const values = conditions.flatMap((c) => [c.right, c.right2]).flatMap((o) => (o?.kind === 'value' ? [o.value] : []));
    if (values.some((n) => !Number.isFinite(n))) return setError('Une valeur est vide.');
    if (targetKind === 'symbol' && !symbol) return setError('Actif inconnu de la plateforme.');
    if (targetKind === 'watchlist' && !listSymbols.length) return setError('Cette liste de suivi est vide.');
    const until = noExpiry ? undefined : new Date(expires).getTime();
    if (until != null && !(until > Date.now())) return setError('La date d’expiration est passée.');
    // the indicators read, and those they are computed on
    const used = new Set<string>();
    const addUsed = (id: string) => {
      if (used.has(id)) return;
      used.add(id);
      const ref = sourceRef(pool.find((c) => c.id === id) ?? {});
      if (ref) addUsed(ref.id);
    };
    for (const c of conditions) for (const o of [c.left, c.right, c.right2]) if (o?.kind === 'plot') addUsed(o.id);
    const alert: TechAlert = {
      id: edit?.id ?? nextId(),
      name: name.trim() || autoName,
      message: message.trim() || undefined,
      target: targetKind === 'symbol' ? { kind: 'symbol', symbol: symbol! } : { kind: 'watchlist', watchlistId },
      tf,
      indicators: structuredClone(pool.filter((c) => used.has(c.id))),
      conditions,
      match,
      trigger,
      expires: until,
      desktop,
      active: true,
      createdAt: edit?.createdAt ?? Date.now(),
      fired: edit?.fired ?? 0,
      lastFired: edit?.lastFired,
    };
    saveTechAlert(alert);
    showToast(edit ? '🔔 Alerte modifiée' : `🔔 Alerte créée : ${alert.name}`);
    openAlert(null);
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => openAlert(null)}>
      <div className="modal dl-modal al-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dl-modal-head">{edit ? 'Modifier l’alerte' : 'Créer une alerte'}</div>

        <div className="modal-title">Sur</div>
        <div className="al-target">
          <div className="dt-seg">
            <button className={targetKind === 'symbol' ? 'on' : ''} onClick={() => setTargetKind('symbol')}>Un actif</button>
            <button
              className={targetKind === 'watchlist' ? 'on' : ''}
              onClick={() => { setTargetKind('watchlist'); if (trigger === 'once') setTrigger('close'); }}
            >Une liste de suivi</button>
          </div>
          {targetKind === 'symbol' ? (
            <>
              <input className="dt-search al-ticker" list="al-symbols" value={ticker} onChange={(e) => setTicker(e.target.value)} />
              <datalist id="al-symbols">{SYMBOLS.map((s) => <option key={s.ticker} value={s.ticker}>{s.name}</option>)}</datalist>
            </>
          ) : (
            <select className="idg-select" value={watchlistId} onChange={(e) => setWatchlistId(e.target.value)}>
              {watchlists.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <select className="idg-select al-tf" value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} title="Unité de temps des barres et des indicateurs">
            {tfs.map((t) => <option key={t} value={t}>{tfShortLabel(t)}</option>)}
          </select>
        </div>
        {targetKind === 'symbol' && symbol && <div className="dt-muted">{symbol.name}</div>}
        {targetKind === 'symbol' && !symbol && ticker.trim() && <div className="dt-muted">Actif inconnu de la plateforme.</div>}
        {targetKind === 'watchlist' && (
          <div className="dt-muted">
            Chaque actif de la liste est surveillé à part ({listSymbols.length} actif{listSymbols.length > 1 ? 's' : ''}
            {listSize > WATCHLIST_MAX ? `, les ${WATCHLIST_MAX} premiers sur ${listSize}` : ''}).
          </div>
        )}

        <div className="modal-title">Conditions</div>
        {conditions.map((c, i) => {
          const meta = OPS.find((o) => o.id === c.op)!;
          return (
            <div key={i} className="al-cond">
              {i > 0 && <span className="al-join">{match === 'all' ? 'ET' : 'OU'}</span>}
              <OperandPick value={c.left} onChange={(o) => setCond(i, { left: o })} options={plotOptions} allowValue={false} />
              <select className="idg-select al-op" value={c.op} onChange={(e) => setOp(i, e.target.value as AlertOp)}>
                {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {meta.pct ? (
                <span className="al-operand">
                  <input
                    className="idg-text al-num" type="number" step="any" min={0} value={c.right.kind === 'value' && Number.isFinite(c.right.value) ? c.right.value : ''}
                    onChange={(e) => setCond(i, { right: { kind: 'value', value: e.target.value === '' ? NaN : parseFloat(e.target.value) } })}
                  />
                  <span className="dt-muted">% en</span>
                  <input className="idg-text al-num" type="number" min={1} max={500} step={1} value={c.bars ?? 1} onChange={(e) => setCond(i, { bars: Math.max(1, Math.round(+e.target.value || 1)) })} />
                  <span className="dt-muted">barre(s)</span>
                </span>
              ) : (
                <OperandPick value={c.right} onChange={(o) => setCond(i, { right: o })} options={plotOptions} allowValue />
              )}
              {meta.channel && (
                <>
                  <span className="dt-muted">et</span>
                  <OperandPick value={c.right2 ?? c.right} onChange={(o) => setCond(i, { right2: o })} options={plotOptions} allowValue />
                </>
              )}
              {conditions.length > 1 && <button className="remove-btn al-del" title="Retirer cette condition" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}>✕</button>}
            </div>
          );
        })}
        <div className="al-cond-actions">
          {conditions.length < MAX_CONDITIONS && (
            <button className="pill-btn" onClick={() => setConditions((cs) => [...cs, firstCondition(pool)])}>＋ Ajouter une condition</button>
          )}
          {conditions.length > 1 && (
            <div className="dt-seg">
              <button className={match === 'all' ? 'on' : ''} onClick={() => setMatch('all')}>Toutes, sur la même barre</button>
              <button className={match === 'any' ? 'on' : ''} onClick={() => setMatch('any')}>Au moins une</button>
            </div>
          )}
        </div>
        {!plotOptions.length && <div className="dt-muted">Ajoutez un indicateur au graphique pour poser une condition dessus.</div>}

        <div className="modal-title">Déclenchement</div>
        <div className="dt-seg">
          {TRIGGERS.map(([id, label, tip]) => <button key={id} className={trigger === id ? 'on' : ''} title={tip} onClick={() => setTrigger(id)}>{label}</button>)}
        </div>
        <div className="dt-muted">{TRIGGERS.find((t) => t[0] === trigger)![2]}{trigger === 'once' && targetKind === 'watchlist' ? ' (pour toute la liste)' : ''}</div>

        <div className="modal-title">Expiration</div>
        <div className="al-expiry">
          <label className="dl-check"><input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} /> Sans expiration</label>
          {!noExpiry && <input className="idg-text" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />}
        </div>

        <div className="modal-title">Nom et message</div>
        <input className="dt-search dl-input" placeholder={autoName} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="dt-search dl-input" placeholder="Message (facultatif) : affiché dans le journal et la notification" value={message} onChange={(e) => setMessage(e.target.value)} />
        <label className="dl-check">
          <input
            type="checkbox" checked={desktop}
            onChange={(e) => {
              const on = e.target.checked;
              setDesktop(on);
              if (on && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
            }}
          />
          Notification Windows aussi (en plus du son et du message à l’écran)
        </label>
        {desktop && 'Notification' in window && Notification.permission === 'denied' && (
          <div className="pg-error">Les notifications sont bloquées pour ce site dans le navigateur.</div>
        )}

        <div className="dl-estimate">
          Les alertes tournent tant que la plateforme est ouverte (onglet ou fenêtre, même en arrière-plan). PC éteint ou plateforme fermée : pas d’alerte.
        </div>
        {error && <div className="pg-error">{error}</div>}

        <div className="dl-actions">
          <button className="pill-btn" onClick={() => openAlert(null)}>Annuler</button>
          <button className="pill-btn active" onClick={save}>{edit ? 'Enregistrer' : 'Créer'}</button>
        </div>
      </div>
    </div>
  );
}
