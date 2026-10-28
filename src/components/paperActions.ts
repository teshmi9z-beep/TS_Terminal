import { useStore, type PaperSide } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { useQuotes } from '../data/feeds/quotes';
import { currentPrice } from './symbolActions';
import { tradingApi } from './tradingAccount';

// last price of a ticker: live quote, else the chart's last bar for the charted symbol
export function lastPriceOf(ticker: string): number | null {
  const q = useQuotes.getState().quotes[ticker]?.last;
  if (q != null) return q;
  return useStore.getState().symbol.ticker === ticker ? currentPrice()?.price ?? null : null;
}

// market order at the current price (used by the panel and the chart's buy / sell buttons);
// during a replay, on the replay account at the close of the replay bar
export function marketOrder(side: PaperSide, qty: number, sl?: number, tp?: number) {
  const st = useStore.getState();
  const ui = useChartUi.getState();
  if (ui.replay.mode === 'on') {
    const cur = currentPrice();
    if (!cur) { ui.showToast('Pas de barre de replay'); return; }
    if (!(qty > 0)) { ui.showToast('Quantité invalide'); return; }
    tradingApi(true).open({ symbol: st.symbol, side, qty, entry: cur.price, sl, tp });
    ui.showToast(`Replay : ${side === 'long' ? 'achat' : 'vente'} ${qty} ${st.symbol.ticker} à ${cur.price}`);
    st.setBottomDock({ tab: 'replay' });
    return;
  }
  const price = lastPriceOf(st.symbol.ticker);
  if (price == null) { ui.showToast('Pas de cours disponible pour ce symbole'); return; }
  if (!(qty > 0)) { ui.showToast('Quantité invalide'); return; }
  st.paperOpen({ symbol: st.symbol, side, qty, entry: price, sl, tp });
  ui.showToast(`${side === 'long' ? 'Achat' : 'Vente'} ${qty} ${st.symbol.ticker} à ${price}`);
}
