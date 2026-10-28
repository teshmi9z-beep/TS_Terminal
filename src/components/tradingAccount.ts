import { useMemo } from 'react';
import { useStore, type PaperAccount, type PaperOrder, type PaperPosition, type PaperTrade } from '../store/store';
import { useChartUi, playAlertSound } from '../store/chartUi';
import { useReplayTrading } from '../store/replayTrading';
import { useOptionsReplay } from '../store/optionsReplay';
import { currentPrice } from './symbolActions';
import type { Candle } from '../types';
import { LOCALE } from '../i18n/lang';

// The account the chart, the order ticket and the quick buttons trade: the live
// virtual account, or during a bar replay the replay account (store/replayTrading).

export type TradingApi = {
  replay: boolean;
  paper: () => PaperAccount;
  open: (p: Omit<PaperPosition, 'id' | 'openedAt'>) => void;
  placeOrder: (o: Omit<PaperOrder, 'id' | 'createdAt'>) => void;
  cancelOrder: (id: string) => void;
  close: (id: string, price: number, reason?: PaperTrade['reason']) => void;
  modify: (id: string, patch: Partial<Pick<PaperPosition, 'sl' | 'tp'>>) => void;
  modifyOrder: (id: string, patch: Partial<Pick<PaperOrder, 'price' | 'sl' | 'tp' | 'qty' | 'type'>>) => void;
};

export const isReplaying = () => useChartUi.getState().replay.mode === 'on';

// the replay bar the chart stands on (s)
const replayNow = () => useChartUi.getState().replay.at ?? currentPrice()?.time ?? Math.floor(Date.now() / 1000);

export function tradingApi(replay = isReplaying()): TradingApi {
  if (replay) {
    const r = () => useReplayTrading.getState();
    return {
      replay,
      paper: () => r().account,
      open: (p) => r().open(p, replayNow()),
      placeOrder: (o) => r().placeOrder(o, replayNow()),
      cancelOrder: (id) => r().cancelOrder(id),
      close: (id, price, reason) => r().close(id, price, reason, replayNow()),
      modify: (id, patch) => r().modify(id, patch),
      modifyOrder: (id, patch) => r().modifyOrder(id, patch),
    };
  }
  const s = () => useStore.getState();
  return {
    replay,
    paper: () => s().paper,
    open: (p) => s().paperOpen(p),
    placeOrder: (o) => s().paperPlaceOrder(o),
    cancelOrder: (id) => s().paperCancelOrder(id),
    close: (id, price, reason) => s().paperClose(id, price, reason),
    modify: (id, patch) => s().paperModify(id, patch),
    modifyOrder: (id, patch) => s().paperModifyOrder(id, patch),
  };
}

// a new bar shown by the replay: the replay account's orders, stops and targets on it
export function replayBarShown(ticker: string, bar: Candle) {
  const events = useReplayTrading.getState().onBar(ticker, bar);
  // the options replay: what expired settles at its intrinsic value, on the price at the expiry
  // (the open of the first bar from it)
  for (const t of useOptionsReplay.getState().settle(ticker, bar.open, bar.time)) {
    const money = `${t.pnl >= 0 ? '+' : '−'}${Math.abs(t.pnl).toLocaleString(LOCALE, { maximumFractionDigits: 0 })} €`;
    events.push(`Option ${t.call ? 'call' : 'put'} ${t.strike} expirée ${t.exit > 0 ? `à ${t.exit.toFixed(2)} pts` : 'sans valeur'} (${money})`);
  }
  if (!events.length) return;
  useChartUi.getState().showToast(events.join(' · '));
  playAlertSound();
}

// the replay is left or restarted: the session is closed and filed
export function endReplaySession() {
  const s = useReplayTrading.getState().endSession();
  if (!s) return;
  const pnl = (s.final ?? s.initial) - s.initial;
  const money = `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  useChartUi.getState().showToast(`Session replay terminée : ${money} sur ${s.trades.length} trade${s.trades.length > 1 ? 's' : ''} (bilan dans « Trading virtuel replay »)`);
  useStore.getState().setBottomDock({ tab: 'replay' });
}

// the account shown and traded now, re-rendering when it changes
export function useTradingAccount(): { api: TradingApi; paper: PaperAccount; replay: boolean } {
  const replay = useChartUi((s) => s.replay.mode === 'on');
  const live = useStore((s) => s.paper);
  const rp = useReplayTrading((s) => s.account);
  const api = useMemo(() => tradingApi(replay), [replay]);
  return { api, paper: replay ? rp : live, replay };
}
