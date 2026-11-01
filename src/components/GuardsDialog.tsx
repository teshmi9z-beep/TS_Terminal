import { useEffect, useState } from 'react';
import { brokerLabel, defaultGuards, isLive, today, useBroker, type Guards } from '../store/broker';
import { dayStats, inHours } from './brokerAccount';
import { BrokerLogo } from './BrokerDialog';
import { LOCALE } from '../i18n/lang';

// "Garde-fous", like FTMO's Mentor app: the rules a broker account's new orders must respect, each one
// switched on or off, with where the account stands today. Closing a position, cancelling an order and
// bringing a stop closer always go.

const money = (v: number, cur: string) => `${v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

export default function GuardsDialog({ onClose }: { onClose: () => void }) {
  const active = useBroker((s) => s.active);
  const stored = useBroker((s) => s.guards[active]);
  const g: Guards = stored ?? defaultGuards(active);
  const snap = useBroker((s) => s.snap);
  const set = (patch: Partial<Guards>) => useBroker.getState().setGuards(active, patch);
  // the hours guard says "open" / "closed" as the clock goes
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(id); }, []);

  if (active === 'paper') {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal bk-settings" onClick={(e) => e.stopPropagation()}>
          <div className="modal-title">Garde-fous</div>
          <p className="bk-note">Les garde-fous protègent les comptes des courtiers (IG démo, IG réel). Choisissez un courtier dans Trader ▾ › Connecter un autre courtier.</p>
          <div className="bk-actions"><button className="pill-btn primary" onClick={onClose}>Fermer</button></div>
        </div>
      </div>
    );
  }

  const acct = snap?.account;
  const cur = acct?.currency ?? 'EUR';
  const capital = acct ? acct.balance + acct.pnl : null;
  const day = dayStats();
  const locked = g.lockedDay === today();
  const open = (snap?.positions.length ?? 0) + (snap?.orders.length ?? 0);
  const dayLimit = day ? day.start * g.dailyLoss.value / 100 : null;
  const num = (v: string, min: number) => { const n = parseFloat(v.replace(',', '.')); return Number.isFinite(n) && n >= min ? n : min; };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal bk-guards ${isLive(active) ? 'live' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title bk-guards-title">
          <BrokerLogo id={active} size={22} /> Garde-fous · {brokerLabel(active)}
          {isLive(active) && <span className="bk-real-tag">ARGENT RÉEL</span>}
        </div>

        <div className="bk-day">
          <div><span>Capital</span><b>{capital != null ? money(capital, cur) : '—'}</b></div>
          <div><span>Aujourd’hui</span><b className={day ? (day.result >= 0 ? 'up' : 'down') : ''}>{day ? `${day.result >= 0 ? '+' : ''}${money(day.result, cur)}` : '—'}</b></div>
          <div><span>Positions et ordres</span><b>{open}</b></div>
          <div><span>État</span><b className={locked ? 'down' : 'up'}>{locked ? 'Bloqué jusqu’à demain' : 'Ordres permis'}</b></div>
        </div>

        <Row on={g.confirm} onToggle={(v) => set({ confirm: v })} title="Confirmer chaque ordre" hint="Une question avant chaque ordre et chaque clôture" />
        <Row on={g.stopRequired} onToggle={(v) => set({ stopRequired: v })} title="Stop loss obligatoire" hint="Aucun ordre sans stop, et un stop ne peut pas être retiré" />
        <Row on={g.maxSize.on} onToggle={(v) => set({ maxSize: { ...g.maxSize, on: v } })} title="Taille maximale par ordre">
          <input type="number" min={0.01} step="any" value={g.maxSize.value} onChange={(e) => set({ maxSize: { ...g.maxSize, value: num(e.target.value, 0.01) } })} /> contrat(s)
        </Row>
        <Row on={g.maxRisk.on} onToggle={(v) => set({ maxRisk: { ...g.maxRisk, on: v } })} title="Risque maximal par ordre" hint="Ce que l’ordre perd s’il touche son stop">
          <input type="number" min={0.1} step="0.1" value={g.maxRisk.value} onChange={(e) => set({ maxRisk: { ...g.maxRisk, value: num(e.target.value, 0.1) } })} /> % du capital
          {capital != null && <small> ≈ {money(capital * g.maxRisk.value / 100, cur)}</small>}
        </Row>
        <Row on={g.dailyLoss.on} onToggle={(v) => set({ dailyLoss: { ...g.dailyLoss, on: v } })} title="Perte maximale du jour" hint="Atteinte, plus aucun nouvel ordre jusqu’au lendemain">
          <input type="number" min={0.1} step="0.1" value={g.dailyLoss.value} onChange={(e) => set({ dailyLoss: { ...g.dailyLoss, value: num(e.target.value, 0.1) } })} /> % du capital du matin
          {dayLimit != null && <small> ≈ {money(dayLimit, cur)}</small>}
          {g.dailyLoss.on && day && dayLimit != null && (
            <div className="bk-meter" title={`${money(day.lost, cur)} perdus sur ${money(dayLimit, cur)} permis`}>
              <i style={{ width: `${Math.min(100, (day.lost / Math.max(dayLimit, 1e-9)) * 100)}%` }} />
            </div>
          )}
          {g.dailyLoss.on && !day && <small> · historique du jour en cours de lecture</small>}
        </Row>
        <Row on={g.maxOpen.on} onToggle={(v) => set({ maxOpen: { ...g.maxOpen, on: v } })} title="Positions et ordres ouverts au maximum">
          <input type="number" min={1} step={1} value={g.maxOpen.value} onChange={(e) => set({ maxOpen: { ...g.maxOpen, value: Math.round(num(e.target.value, 1)) } })} />
          <small> · {open} maintenant</small>
        </Row>
        <Row on={g.hours.on} onToggle={(v) => set({ hours: { ...g.hours, on: v } })} title="Heures de trading" hint="Heure de ce PC">
          <input type="time" value={g.hours.from} onChange={(e) => set({ hours: { ...g.hours, from: e.target.value || '00:00' } })} /> à
          <input type="time" value={g.hours.to} onChange={(e) => set({ hours: { ...g.hours, to: e.target.value || '23:59' } })} />
          {g.hours.on && <small className={inHours(g.hours.from, g.hours.to) ? 'up' : 'down'}> · {inHours(g.hours.from, g.hours.to) ? 'ouvert' : 'fermé'}</small>}
        </Row>

        <div className="bk-actions">
          {locked
            ? <button className="pill-btn" onClick={() => { if (window.confirm('Débloquer les ordres pour aujourd’hui ?')) set({ lockedDay: null }); }}>Débloquer</button>
            : <button className="pill-btn bk-lock" onClick={() => set({ lockedDay: today() })}>Bloquer les ordres jusqu’à demain</button>}
          <button className="pill-btn" onClick={() => { if (window.confirm('Remettre les garde-fous par défaut de ce compte ?')) useBroker.getState().setGuards(active, defaultGuards(active)); }}>Par défaut</button>
          <button className="pill-btn primary" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

function Row({ on, onToggle, title, hint, children }: { on: boolean; onToggle: (v: boolean) => void; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className={`bk-guard ${on ? 'on' : ''}`}>
      <label className="bk-switch" title={on ? 'Activé' : 'Désactivé'}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span />
      </label>
      <div className="bk-guard-body">
        <b>{title}</b>
        {hint && <small>{hint}</small>}
        {children && <div className="bk-guard-value">{children}</div>}
      </div>
    </div>
  );
}
