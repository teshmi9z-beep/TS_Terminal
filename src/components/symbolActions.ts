import { useStore, nextId } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { mainChart } from './mainChart';

// last displayed price (the replayed bar during a replay)
export function currentPrice(): { price: number; precision: number; time: number } | null {
  const e = mainChart.engine;
  const last = e?.candles[e.candles.length - 1];
  return e && last ? { price: last.close, precision: e.precision, time: last.time } : null;
}

// Alt+A
export function addAlertAtPrice() {
  const cur = currentPrice();
  if (!cur) return;
  const st = useStore.getState();
  const price = +cur.price.toFixed(cur.precision);
  st.addAlert(st.symbol.ticker, price);
  useChartUi.getState().showToast(`🔔 Alerte créée sur ${st.symbol.ticker} à ${price.toFixed(cur.precision)}`);
}

// Alt+N: a text note anchored on the last bar
export function addTextNote() {
  const cur = currentPrice();
  const st = useStore.getState();
  if (!cur) return;
  // typed in place on the chart, at the last bar
  const id = nextId();
  st.addDrawing({
    id, tool: 'text', points: [{ time: cur.time, price: cur.price }], text: '',
    color: '#f0b90b', lineWidth: 1, fontSize: 14, done: true, ticker: st.symbol.ticker,
  });
  useChartUi.getState().setEditTextId(id);
}
