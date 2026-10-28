import { useEffect, useRef, useState } from 'react';
import { useStore, type PaperSide } from '../store/store';
import { marketOrder } from './paperActions';
import { useChartUi } from '../store/chartUi';
import { useQuotes } from '../data/feeds/quotes';
import { pricePrecision } from './chartUtils';
import { currentPrice } from './symbolActions';
import { moveEntry, orderType, relay, sideFor, sideSign, type OrderDraft } from './orderDraft';
import { useTradingAccount } from './tradingAccount';
import { tradePnlEur, useReplayTrading } from '../store/replayTrading';
import PanelControls from './PanelControls';
import { LOCALE } from '../i18n/lang';

const fmt = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
type OrderKind = 'market' | 'limit' | 'stop';

// order ticket of the virtual account, opened by the "Trader" button of the top
// bar (the positions / orders / history are in the panel under the chart).
// In limit or stop mode a click on the chart draws the order there; while an
// order is drawn on the chart, the ticket shows it and its fields move its lines.
export default function TradingPanel() {
  // during a replay: the replay account (in euros), priced at the replay bar
  const { api: acct, paper, replay } = useTradingAccount();
  useChartUi((s) => s.replay.at);
  const replayLast = useReplayTrading((s) => s.lastPrice);
  const symbol = useStore((s) => s.symbol);
  const setBottomDock = useStore((s) => s.setBottomDock);
  const qty = useChartUi((s) => s.paperQty);
  const setQty = useChartUi((s) => s.setPaperQty);
  const showToast = useChartUi((s) => s.showToast);
  const ticket = useChartUi((s) => s.orderTicket);
  const setTicket = useChartUi((s) => s.setOrderTicket);
  const draft = useChartUi((s) => s.orderDraft);
  const setDraft = useChartUi((s) => s.setOrderDraft);
  const aimOff = useChartUi((s) => s.orderAimOff);
  const setAimOff = useChartUi((s) => s.setOrderAimOff);
  const quotes = useQuotes((s) => s.quotes);
  const [price, setPrice] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const prevDraft = useRef<OrderDraft | null>(null);

  const last = replay ? (currentPrice()?.price ?? null) : (quotes[symbol.ticker]?.last ?? currentPrice()?.price ?? null);
  const prec = last != null ? pricePrecision(symbol, last) : 2;
  const round = (v: number) => Number(v.toFixed(prec));
  const num = (s: string) => (s.trim() ? parseFloat(s.replace(',', '.')) : undefined);
  const unrealized = paper.positions.reduce((sum, p) => {
    if (replay) {
      const q = p.symbol.ticker === symbol.ticker ? last : replayLast[p.symbol.ticker]?.price;
      return q == null ? sum : sum + tradePnlEur(p, q);
    }
    const q = quotes[p.symbol.ticker]?.last;
    return q == null ? sum : sum + (q - p.entry) * p.qty * (p.side === 'long' ? 1 : -1);
  }, 0);

  // opening the ticket offers the click on the chart again
  useEffect(() => { setAimOff(false); }, [setAimOff]);

  const side = draft ? draft.side : ticket.side;
  const type: OrderKind = draft ? orderType(draft.side, draft.entry, last) : ticket.type;

  // the fields follow the order drawn on the chart
  useEffect(() => {
    const prev = prevDraft.current;
    prevDraft.current = draft;
    if (!draft) {
      // sent or dropped: its stop and target leave the ticket
      if (prev) { setSl(''); setTp(''); }
      return;
    }
    // a new order on the chart takes the stop / target already typed, when on the right side
    if (!prev) {
      const s = sideSign(draft.side), slV = num(sl), tpV = num(tp);
      const okSl = slV != null && (slV - draft.entry) * s < 0;
      const okTp = tpV != null && (tpV - draft.entry) * s > 0;
      if (okSl || okTp) { setDraft({ ...draft, sl: okSl ? slV : draft.sl, tp: okTp ? tpV : draft.tp }); return; }
    }
    const put = (set: (f: (cur: string) => string) => void, v: number) => set((cur) => (num(cur) === v ? cur : String(v)));
    put(setPrice, draft.entry);
    put(setSl, draft.sl);
    put(setTp, draft.tp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  function pickSide(s: PaperSide) {
    if (draft && s !== draft.side) {
      // the entry stays where it is: a limit order becomes a stop order, or the other way round
      const t = orderType(s, draft.entry, last);
      setDraft({ ...relay(draft, s, draft.entry, round), rule: draft.rule ? t : undefined });
      setTicket({ side: s, type: t });
      return;
    }
    setTicket({ side: s });
  }
  function pickType(t: OrderKind) {
    if (t === 'market') { setTicket({ type: t }); if (draft) setDraft(null); return; }
    setAimOff(false);
    if (draft) {
      // the entry stays where it is and takes the side this type has there
      const s = sideFor(t, draft.entry, last, draft.side);
      setDraft({ ...relay(draft, s, draft.entry, round), rule: t });
      setTicket({ side: s, type: t });
      return;
    }
    setTicket({ type: t });
    if (last != null && !price) setPrice(last.toFixed(prec));
  }

  // typed values move the drawn order once the field is left (or on Entrée)
  function commit(field: 'price' | 'sl' | 'tp') {
    if (!draft) return;
    const v = num(field === 'price' ? price : field === 'sl' ? sl : tp);
    const s = sideSign(draft.side);
    if (v == null || !(v > 0)) return;
    if (field === 'price') setDraft(moveEntry(draft, v, last, round));
    else if (field === 'sl' && (v - draft.entry) * s < 0) setDraft({ ...draft, sl: v });
    else if (field === 'tp' && (v - draft.entry) * s > 0) setDraft({ ...draft, tp: v });
    else {
      // wrong side of the entry: the field goes back to the drawn value
      if (field === 'sl') setSl(String(draft.sl)); else setTp(String(draft.tp));
      showToast(field === 'sl' ? 'Le stop doit être du côté perdant de l’entrée' : 'L’objectif doit être du côté gagnant de l’entrée');
    }
  }
  const field = (label: string, value: string, set: (v: string) => void, name: 'price' | 'sl' | 'tp', placeholder?: string) => (
    <label className="tr-field">{label}
      <input
        placeholder={placeholder} value={value} onChange={(e) => set(e.target.value)} onBlur={() => commit(name)}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );

  function submit() {
    if (draft) {
      const t = orderType(draft.side, draft.entry, last);
      acct.placeOrder({ symbol, side: draft.side, qty, type: t, price: draft.entry, sl: draft.sl, tp: draft.tp });
      showToast(`${replay ? 'Replay : ' : ''}Ordre ${t === 'limit' ? 'limite' : 'stop'} placé : ${draft.side === 'long' ? 'achat' : 'vente'} ${qty} ${symbol.ticker} à ${draft.entry}`);
      setDraft(null);
    } else {
      const slV = num(sl), tpV = num(tp);
      if (type === 'market') marketOrder(side, qty, slV, tpV);
      else {
        const p = num(price);
        if (p == null || isNaN(p)) { showToast('Indiquez le prix de l’ordre'); return; }
        acct.placeOrder({ symbol, side, qty, type, price: p, sl: slV, tp: tpV });
        showToast(`${replay ? 'Replay : ' : ''}Ordre ${type === 'limit' ? 'limite' : 'stop'} placé : ${side === 'long' ? 'achat' : 'vente'} ${qty} ${symbol.ticker} à ${p}`);
      }
    }
    setSl(''); setTp('');
    // like TradingView, the account panel shows the result under the chart
    setBottomDock({ tab: replay ? 'replay' : 'trading' });
  }

  return (
    <div className="side-panel trading">
      <div className="side-title tr-title">
        Passer un ordre
        {replay && <span className="tr-replay">REPLAY</span>}
        <PanelControls panel="trading" />
      </div>
      <div className="tr-symbol">{symbol.ticker} <small>{symbol.name}</small></div>
      <div className="tr-account">
        <div><span>{replay ? 'Capital replay' : 'Capital'}</span><b>{fmt(paper.balance + unrealized)}{replay && ' €'}</b></div>
        <div><span>P&L latent</span><b className={unrealized >= 0 ? 'up' : 'down'}>{unrealized >= 0 ? '+' : ''}{fmt(unrealized)}</b></div>
      </div>

      <div className="tr-ticket">
        <div className="tr-sides">
          <button className={`tr-side sell ${side === 'short' ? 'on' : ''}`} onClick={() => pickSide('short')}>Vendre<small>{last != null ? last.toFixed(prec) : '—'}</small></button>
          <button className={`tr-side buy ${side === 'long' ? 'on' : ''}`} onClick={() => pickSide('long')}>Acheter<small>{last != null ? last.toFixed(prec) : '—'}</small></button>
        </div>
        <div className="tr-types">
          {(['market', 'limit', 'stop'] as const).map((t) => (
            <button key={t} className={`ss-chip ${type === t ? 'active' : ''}`} onClick={() => pickType(t)}>
              {t === 'market' ? 'Marché' : t === 'limit' ? 'Limite' : 'Stop'}
            </button>
          ))}
        </div>
        {type !== 'market' && !draft && !aimOff && (
          <div className="tr-hint">
            Ou cliquez sur le graphique : {type === 'limit' ? 'au-dessus du prix = vente, en dessous = achat' : 'au-dessus du prix = achat, en dessous = vente'}
          </div>
        )}
        {type !== 'market' && !draft && aimOff && (
          <div className="tr-hint">
            Placement sur le graphique arrêté
            <button className="pill-btn" onClick={() => setAimOff(false)}>Reprendre</button>
          </div>
        )}
        {draft && (
          <div className="tr-hint">
            Ordre sur le graphique : lignes déplaçables
            <button className="pill-btn" onClick={() => setDraft(null)}>Effacer</button>
          </div>
        )}
        <label className="tr-field">Quantité<input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(parseFloat(e.target.value) || 0)} /></label>
        {type !== 'market' && field('Prix', price, setPrice, 'price')}
        {field('Stop loss', sl, setSl, 'sl', 'optionnel')}
        {field('Take profit', tp, setTp, 'tp', 'optionnel')}
        <div className="tr-est">Valeur ≈ {last != null ? fmt(qty * (num(price) ?? last)) : '—'}</div>
        <button className={`tr-submit ${side === 'long' ? 'buy' : 'sell'}`} onClick={submit}>
          {side === 'long' ? 'Acheter' : 'Vendre'} {qty} {symbol.ticker} {type === 'market' ? 'au marché' : type === 'limit' ? 'à cours limité' : 'stop'}
        </button>
      </div>
      <button className="si-more tr-reset" onClick={() => setBottomDock({ tab: replay ? 'replay' : 'trading' })}>
        Voir le portefeuille ({paper.positions.length} position{paper.positions.length > 1 ? 's' : ''}) sous le graphique
      </button>
      <div className="side-empty">Compte fictif : aucun argent réel. Les gains sont exprimés dans la devise de chaque symbole.</div>
    </div>
  );
}
