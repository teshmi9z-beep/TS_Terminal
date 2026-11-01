import { useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { brokerCall, brokerLabel, brokerStatus, connectIg, disconnectBroker, isLive, useBroker, type BrokerId } from '../store/broker';

// TradingView's "Tradez avec votre courtier": the platform's virtual account, the brokers it can
// trade through, and those to come. A broker's tile opens its login (or trades it again when its
// relay is signed in already).

type Tile = { id: BrokerId | 'ibkr' | 'capital' | 'binance'; name: string; sub: string; logo: string; color: string; ink?: string; ready: boolean };
const TILES: Tile[] = [
  { id: 'paper', name: 'Paper Trading', sub: 'Compte virtuel de la plateforme', logo: '', color: 'var(--accent)', ready: true },
  { id: 'ig', name: 'IG', sub: 'Compte démo', logo: 'IG', color: '#e8412c', ready: true },
  { id: 'ig-live', name: 'IG', sub: 'Compte réel · argent réel', logo: 'IG', color: '#e8412c', ready: true },
  { id: 'ibkr', name: 'Interactive Brokers', sub: 'Compte paper · bientôt', logo: 'IB', color: '#c8102e', ready: false },
  { id: 'capital', name: 'Capital.com', sub: 'Compte démo · bientôt', logo: 'C', color: '#1c1c1e', ink: '#d9a95b', ready: false },
  { id: 'binance', name: 'Binance', sub: 'Demo Trading · bientôt', logo: 'B', color: '#f0b90b', ink: '#1e2026', ready: false },
];

export function BrokerLogo({ id, size = 40 }: { id: BrokerId | Tile['id']; size?: number }) {
  const t = TILES.find((x) => x.id === id) ?? TILES[0];
  return (
    <span className="bk-logo" style={{ width: size, height: size, background: t.color, color: t.ink ?? '#fff', fontSize: size * 0.4 }} translate="no">
      {t.logo || <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12l4-4 3 3 5-6" /><path d="M11 5h4v4" /></svg>}
    </span>
  );
}

export default function BrokerDialog({ onClose }: { onClose: () => void }) {
  const active = useBroker((s) => s.active);
  const account = useBroker((s) => s.account);
  const [login, setLogin] = useState<'ig' | 'ig-live' | null>(null);

  async function pick(t: Tile) {
    if (!t.ready) return;
    if (t.id === 'paper') { useBroker.getState().setActive('paper'); done(); return; }
    const b = t.id as 'ig' | 'ig-live';
    // signed in already (in this session, or the demo kept by "Rester connecté"): trade it again
    const s = await brokerCall<{ account: unknown }>('status', undefined, b).catch(() => null);
    if (s?.account) { useBroker.getState().setActive(b); await brokerStatus(); done(); return; }
    setLogin(b);
  }
  function done() {
    onClose();
    if (useStore.getState().rightPanel !== 'trading') useStore.getState().toggleTradingPanel();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal bk-modal ${login ? 'login' : ''}`} onClick={(e) => e.stopPropagation()}>
        {login ? <IgLogin key={login} broker={login} onBack={() => setLogin(null)} onDone={done} /> : (
          <>
            <div className="modal-title bk-title">Tradez avec votre courtier</div>
            <div className="bk-grid">
              {TILES.map((t) => (
                <button key={t.id} className={`bk-tile ${t.id === active ? 'on' : ''} ${t.id === 'ig-live' ? 'live' : ''}`} disabled={!t.ready} onClick={() => void pick(t)}>
                  <BrokerLogo id={t.id} />
                  <span className="bk-name">{t.name}</span>
                  <small>{t.id === active && account ? `Connecté · ${account.id}` : t.sub}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// IG's login, sent to this computer's relay only. Demo: the API key and the API's demo user name and
// password, kept on demand. Real: the live API key and the usual IG login, never kept, and a box to tick.
function IgLogin({ broker, onBack, onDone }: { broker: 'ig' | 'ig-live'; onBack: () => void; onDone: () => void }) {
  const live = isLive(broker);
  const [apiKey, setApiKey] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // the CFD account's number, needed when the login's default account is another kind (Turbo24...)
  const [accountId, setAccountId] = useState('');
  const [remember, setRemember] = useState(true);
  const [realMoney, setRealMoney] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectIg(broker, { apiKey, identifier, password, accountId: accountId.trim() || undefined }, remember, realMoney);
      useChartUi.getState().showToast(`${brokerLabel(broker)} connecté`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`bk-login ${live ? 'live' : ''}`} onSubmit={submit}>
      <div className="bk-login-head">
        <button type="button" className="bk-back" onClick={onBack} title="Retour aux courtiers">‹</button>
        <BrokerLogo id={broker} size={32} />
        <div><b>IG</b><small className={live ? 'down' : ''}>{live ? 'Compte réel · argent réel' : 'Compte démo'}</small></div>
      </div>
      <label className="tr-field">Clé API<input value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      <label className="tr-field">{live ? 'Identifiant IG' : 'Identifiant démo'}<input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" spellCheck={false} /></label>
      <label className="tr-field">{live ? 'Mot de passe IG' : 'Mot de passe démo'}<input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
      <label className="settings-checkbox"><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} /> Afficher le mot de passe</label>
      <label className="tr-field">{live ? 'N° du compte CFD' : 'N° du compte CFD démo'}<input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="facultatif, ex. Z12345" autoComplete="off" spellCheck={false} /></label>
      {live
        ? <label className="settings-checkbox bk-real"><input type="checkbox" checked={realMoney} onChange={(e) => setRealMoney(e.target.checked)} /> Je comprends que mes ordres engagent de l’argent réel</label>
        : <label className="settings-checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Rester connecté sur ce PC</label>}
      {error && <div className="bk-error">{error}</div>}
      <button className={`tr-submit ${live ? 'sell' : 'buy'}`} disabled={busy || !apiKey || !identifier || !password || (live && !realMoney)}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      <p className="bk-note">
        {live
          ? 'Compte réel : la clé de l’onglet « Compte réel » des clés API d’IG, avec ton identifiant et ton mot de passe IG habituels. Ils ne sont jamais enregistrés : à retaper à chaque démarrage. Les garde-fous sont actifs d’office (Trader ▾ › Garde-fous).'
          : 'Démo : la plateforme ne parle qu’au serveur démo d’IG. Sur ig.com, Paramètres › Clés API, onglet « Compte de démo » : la clé en haut, l’identifiant et le mot de passe démo de l’API en bas.'}
      </p>
    </form>
  );
}

// "Paramètres de trading…"
export function TradingSettingsDialog({ onClose }: { onClose: () => void }) {
  const active = useBroker((s) => s.active);
  const account = useBroker((s) => s.account);
  const openDialog = useChartUi((s) => s.openDialog);
  const showMarks = useStore((s) => s.showTradeMarks);
  const setShowMarks = useStore((s) => s.setShowTradeMarks);
  const tradeLabels = useStore((s) => s.tradeLabels);
  const setTradeLabels = useStore((s) => s.setTradeLabels);
  const axisPrices = useStore((s) => s.tradeAxisPrices);
  const setAxisPrices = useStore((s) => s.setTradeAxisPrices);
  const broker = active !== 'paper';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal bk-settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Paramètres de trading</div>
        <div className={`bk-current ${isLive(active) ? 'live' : ''}`}>
          <BrokerLogo id={active} size={28} />
          <div><b>{brokerLabel(active)}</b><small>{broker ? (account ? `Compte ${account.id} · ${account.currency}` : 'Non connecté') : 'Compte virtuel, aucun argent réel'}</small></div>
        </div>
        {broker && <button className="pill-btn bk-guards-btn" onClick={() => openDialog('guards')}>Garde-fous du compte…</button>}
        <label className="settings-checkbox"><input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} /> Trades sur le graphique</label>
        <div className="bk-labels">
          <span>Étiquettes des positions et ordres</span>
          <div className="tr-types">
            <button className={`ss-chip ${tradeLabels === 'right' ? 'active' : ''}`} onClick={() => setTradeLabels('right')}>À droite</button>
            <button className={`ss-chip ${tradeLabels === 'left' ? 'active' : ''}`} onClick={() => setTradeLabels('left')}>À gauche (ProRealTime)</button>
          </div>
        </div>
        <label className="settings-checkbox"><input type="checkbox" checked={axisPrices} onChange={(e) => setAxisPrices(e.target.checked)} /> Prix des positions et ordres sur l’axe</label>
        <div className="bk-actions">
          {broker && account && <button className="pill-btn" onClick={() => { void disconnectBroker(); onClose(); }}>Déconnexion</button>}
          <button className="pill-btn primary" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
