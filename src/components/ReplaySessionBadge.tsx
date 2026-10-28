import { useStore } from '../store/store';
import { useReplayTrading } from '../store/replayTrading';
import { LOCALE } from '../i18n/lang';

const eur = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// in the replay bar: where the replay session stands (closed trades), a click opens its tab
export default function ReplaySessionBadge() {
  const account = useReplayTrading((s) => s.account);
  const setDock = useStore((s) => s.setBottomDock);
  const done = account.history.length;
  const open = account.positions.length + account.orders.length;
  if (!done && !open) return null;
  const pnl = account.balance - account.initial;
  return (
    <button className="rp-btn rp-session" title="Suivi dans l’onglet « Trading virtuel replay »" onClick={() => setDock({ tab: 'replay' })}>
      Session <b className={pnl >= 0 ? 'up' : 'down'}>{eur(pnl)}</b>
      <span>· {done} trade{done > 1 ? 's' : ''}{open ? ` · ${open} en cours` : ''}</span>
    </button>
  );
}
