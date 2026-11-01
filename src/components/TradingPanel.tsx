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
import type { Symbol } from '../types';
import { brokerLabel, guardsOf, isLive, loadIgMarket, today, useBroker, type IgSearchHit } from '../store/broker';
import { igCandidates, updateBridges } from './brokerAccount';
import { eurPerUnit } from '../data/fx';

const fmt = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
type OrderKind = 'market' | 'limit' | 'stop';

// order ticket of the virtual account, or of the broker picked in the "Trader" menu, opened by the
// "Trader" button of the top bar (the positions / orders / history are in the panel under the chart).
// In limit or stop mode a click on the chart draws the order there; while an
// order is drawn on the chart, the ticket shows it and its fields move its lines.
export default function TradingPanel() {
  // during a replay: the replay account (in euros), priced at the replay bar
  const { api: acct, paper, replay, broker } = useTradingAccount();
  useChartUi((s) => s.replay.at);
  const replayLast = useReplayTrading((s) => s.lastPrice);
  const symbol = useStore((s) => s.symbol);
  const bAccount = useBroker((s) => s.snap?.account);
  const active = useBroker((s) => s.active);
  const real = broker && isLive(active);
  // the guards on, in a few words (the window opens from the link)
  useBroker((s) => s.guards[active]);
  const g = guardsOf(active);
  const guardText = [
    g.lockedDay === today() && 'bloqué jusqu’à demain', g.stopRequired && 'stop obligatoire', g.maxSize.on && `${g.maxSize.value} contrat(s) max`,
    g.maxRisk.on && `risque ${g.maxRisk.value} %`, g.dailyLoss.on && `perte du jour ${g.dailyLoss.value} %`,
    g.maxOpen.on && `${g.maxOpen.value} positions max`, g.hours.on && `${g.hours.from}–${g.hours.to}`,
  ].filter(Boolean).join(' · ');
  const igEpic = useBroker((s) => s.markets[symbol.ticker]?.epic);
  const igInfo = useBroker((s) => (igEpic ? s.igMarkets[igEpic] : undefined));
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
  // IG's contracts come in several sizes (1 €, 1 $, 20 $... a point): a point of the one picked in
  // euros, and what its stop would lose with the contracts typed
  const igEur = igInfo ? (igInfo.currency === 'EUR' ? 1 : eurPerUnit(igInfo.currency, quotes)) : null;
  const slAt = num(sl);
  const entryAt = num(price) ?? last;
  const igRisk = igInfo && !igInfo.partial && igEur != null && slAt != null && entryAt != null
    ? Math.abs(entryAt - slAt) * qty * igInfo.contractSize * igEur : null;
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

  // with a broker, its own bid and offer (IG's price differs from the chart's)
  const igPx = (v: number | null | undefined) => (v == null || !igInfo ? null : v.toFixed(igInfo.decimals));
  const sellAt = broker ? igPx(igInfo?.bid) : last != null ? last.toFixed(prec) : null;
  const buyAt = broker ? igPx(igInfo?.offer) : last != null ? last.toFixed(prec) : null;

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
      if (!broker) showToast(`${replay ? 'Replay : ' : ''}Ordre ${t === 'limit' ? 'limite' : 'stop'} placé : ${draft.side === 'long' ? 'achat' : 'vente'} ${qty} ${symbol.ticker} à ${draft.entry}`);
      setDraft(null);
    } else {
      const slV = num(sl), tpV = num(tp);
      if (type === 'market') marketOrder(side, qty, slV, tpV);
      else {
        const p = num(price);
        if (p == null || isNaN(p)) { showToast('Indiquez le prix de l’ordre'); return; }
        acct.placeOrder({ symbol, side, qty, type, price: p, sl: slV, tp: tpV });
        if (!broker) showToast(`${replay ? 'Replay : ' : ''}Ordre ${type === 'limit' ? 'limite' : 'stop'} placé : ${side === 'long' ? 'achat' : 'vente'} ${qty} ${symbol.ticker} à ${p}`);
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
        {broker && <span className={`tr-replay bk-badge ${real ? 'live' : ''}`}>{real ? 'ARGENT RÉEL' : 'IG DÉMO'}</span>}
        <PanelControls panel="trading" />
      </div>
      <div className="tr-symbol">{symbol.ticker} <small>{symbol.name}</small></div>
      {broker ? (
        <>
          <IgMarketLine key={symbol.ticker} symbol={symbol} />
          {bAccount && (
            <div className="tr-account">
              <div><span>Capital IG</span><b>{fmt(bAccount.balance + bAccount.pnl)} {bAccount.currency}</b></div>
              <div><span>P&L latent</span><b className={bAccount.pnl >= 0 ? 'up' : 'down'}>{bAccount.pnl >= 0 ? '+' : ''}{fmt(bAccount.pnl)}</b></div>
            </div>
          )}
        </>
      ) : (
        <div className="tr-account">
          <div><span>{replay ? 'Capital replay' : 'Capital'}</span><b>{fmt(paper.balance + unrealized)}{replay && ' €'}</b></div>
          <div><span>P&L latent</span><b className={unrealized >= 0 ? 'up' : 'down'}>{unrealized >= 0 ? '+' : ''}{fmt(unrealized)}</b></div>
        </div>
      )}

      <div className="tr-ticket">
        <div className="tr-sides">
          <button className={`tr-side sell ${side === 'short' ? 'on' : ''}`} onClick={() => pickSide('short')}>Vendre<small>{sellAt ?? '—'}</small></button>
          <button className={`tr-side buy ${side === 'long' ? 'on' : ''}`} onClick={() => pickSide('long')}>Acheter<small>{buyAt ?? '—'}</small></button>
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
        <label className="tr-field">{broker ? 'Contrats' : 'Quantité'}<input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(parseFloat(e.target.value) || 0)} /></label>
        {type !== 'market' && field('Prix', price, setPrice, 'price')}
        {field('Stop loss', sl, setSl, 'sl', 'optionnel')}
        {field('Take profit', tp, setTp, 'tp', 'optionnel')}
        {broker ? (
          igInfo && !igInfo.partial && (
            <div className="tr-est">
              {igInfo.scale <= 1 && `1 contrat = ${igInfo.contractSize} ${igInfo.currency}/pt`}
              {igInfo.scale <= 1 && igEur != null && igInfo.currency !== 'EUR' && ` (≈ ${fmt(igInfo.contractSize * igEur)} €)`}
              {igInfo.minSize != null && `${igInfo.scale <= 1 ? ' · ' : ''}minimum ${igInfo.minSize}`}
              {/* what the stop loses with this contract's size, in euros (the size of the contract changes it) */}
              {igRisk != null && <> · <span className="down">risque au stop ≈ {fmt(igRisk)} €</span></>}
            </div>
          )
        ) : <div className="tr-est">Valeur ≈ {last != null ? fmt(qty * (num(price) ?? last)) : '—'}</div>}
        <button className={`tr-submit ${side === 'long' ? 'buy' : 'sell'}`} onClick={submit}>
          {side === 'long' ? 'Acheter' : 'Vendre'} {qty} {symbol.ticker} {type === 'market' ? 'au marché' : type === 'limit' ? 'à cours limité' : 'stop'}
        </button>
      </div>
      {broker && (
        <button className={`si-more bk-guard-line ${g.lockedDay === today() ? 'down' : ''}`} onClick={() => useChartUi.getState().openDialog('guards')} title="Ouvrir les garde-fous">
          Garde-fous : {guardText || 'aucun'}
        </button>
      )}
      <button className="si-more tr-reset" onClick={() => setBottomDock({ tab: replay ? 'replay' : 'trading' })}>
        Voir le portefeuille ({paper.positions.length} position{paper.positions.length > 1 ? 's' : ''}) sous le graphique
      </button>
      <div className="side-empty">
        {real ? 'Compte réel IG : ces ordres engagent de l’argent réel, au prix d’IG.'
          : broker ? 'Compte démo IG : aucun argent réel. Les ordres partent chez IG, au prix d’IG.'
            : 'Compte fictif : aucun argent réel. Les gains sont exprimés dans la devise de chaque symbole.'}
      </div>
    </div>
  );
}

const IG_STATUS: Record<string, string> = {
  CLOSED: 'marché fermé', OFFLINE: 'marché hors ligne', SUSPENDED: 'marché suspendu', EDITS_ONLY: 'ordres en attente seulement', ON_AUCTION: 'enchères',
};

// the IG market the charted symbol trades (changeable), IG's price and its gap with the chart's
function IgMarketLine({ symbol }: { symbol: Symbol }) {
  const connected = useBroker((s) => !!s.account);
  const active = useBroker((s) => s.active);
  const market = useBroker((s) => s.markets[symbol.ticker]);
  const info = useBroker((s) => (market ? s.igMarkets[market.epic] : undefined));
  const bridge = useBroker((s) => s.bridges[symbol.ticker]);
  // the chart's live price: until it comes, no gap to show (nor to complain about)
  const chartLast = useQuotes((s) => s.quotes[symbol.ticker]?.last);
  const [hits, setHits] = useState<IgSearchHit[] | null>(null);
  // the candidates are asked when the list is opened, or at once when none was found yet (a new
  // symbol mounts it afresh: see its key)
  const load = () => { if (!hits) void igCandidates(symbol).then(setHits).catch(() => setHits([])); };
  useEffect(() => {
    if (connected && !market && hits == null) void igCandidates(symbol).then(setHits).catch(() => setHits([]));
  }, [connected, market, hits, symbol]);

  if (!connected) {
    return (
      <div className="tr-hint">
        {brokerLabel(active)} n’est pas connecté
        <button className="pill-btn" onClick={() => useChartUi.getState().openDialog('brokers')}>Se connecter</button>
      </div>
    );
  }
  const options = hits ?? (market ? [{ epic: market.epic, name: market.name }] : []);
  function choose(epic: string) {
    const h = options.find((x) => x.epic === epic);
    if (!h) return;
    useBroker.getState().setMarket(symbol.ticker, { epic: h.epic, name: h.name });
    void loadIgMarket(h.epic).then(() => updateBridges([symbol.ticker])).catch(() => undefined);
  }
  const gap = bridge ? bridge.offset : null;
  const d = info?.decimals ?? 2;
  return (
    <div className="bk-market">
      <label>Marché IG
        <select value={market?.epic ?? ''} onFocus={load} onMouseDown={load} onChange={(e) => choose(e.target.value)} translate="no">
          {!market && <option value="">{hits && !hits.length ? 'Aucun marché IG trouvé' : 'Recherche…'}</option>}
          {options.map((h) => <option key={h.epic} value={h.epic}>{h.name}</option>)}
        </select>
      </label>
      {info && info.bid != null && info.offer != null && (
        <div className="bk-quote">
          IG {info.bid.toFixed(d)} / {info.offer.toFixed(d)}
          {gap != null && ` · écart ${gap >= 0 ? '+' : ''}${gap.toFixed(d)} avec le graphique`}
          {info.delay > 0 && ` · différé ${info.delay} min`}
          {IG_STATUS[info.status] && <b className="down"> · {IG_STATUS[info.status]}</b>}
        </div>
      )}
      {info && info.bid != null && !bridge && chartLast != null && <div className="bk-quote down">Prix du graphique trop loin de celui d’IG : vérifiez le marché choisi</div>}
    </div>
  );
}
