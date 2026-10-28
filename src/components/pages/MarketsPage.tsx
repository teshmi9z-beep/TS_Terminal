import { useEffect, useState, type ReactNode } from 'react';
import { useKept } from '../kept';
import { BONDS, COMMODITIES, INDICES, fetchCrypto, fetchForex, fetchList, fetchStocks, type MarketRow, type StockList } from '../../data/markets';
import { MARKETS, type MarketId } from '../../data/stockScreener';
import { tvToSymbol } from '../../data/tv';
import { big, fr, pct, price, signCls } from '../../data/format';
import { openTool, showOnChart } from '../tabs/tabActions';
import { Chips, Loading, PageHeader, TvLogo } from './common';

const YAHOO_BONDS = new Set(['TVC:US10Y', 'TVC:US30Y']);
const tickerOf = (id: string) => id.split(':')[1] ?? id;

// a quote list refreshed every minute
function useRows(key: string, load: (signal: AbortSignal) => Promise<MarketRow[]>) {
  const [state, setState] = useState<{ key: string; rows: MarketRow[] | null; error: string | null }>({ key, rows: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal).then(
      (rows) => setState({ key, rows, error: null }),
      (e: unknown) => { if (!ctrl.signal.aborted) setState((s) => ({ ...s, key, error: e instanceof Error ? e.message : String(e) })); },
    );
    const id = setTimeout(() => setTick((t) => t + 1), 60_000);
    return () => { ctrl.abort(); clearTimeout(id); };
  }, [key, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : { key, rows: null, error: null };
}

function Card({ title, tools, children, wide }: { title: string; tools?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`mk-card ${wide ? 'wide' : ''}`}>
      <div className="mk-card-head"><h2>{title}</h2>{tools}</div>
      {children}
    </section>
  );
}

function Rows({ state, extra, onPick, unit }: {
  state: { rows: MarketRow[] | null; error: string | null };
  extra?: string; unit?: string;
  onPick?: (r: MarketRow) => void;
}) {
  if (state.error) return <div className="pg-error">{state.error}</div>;
  if (!state.rows) return <Loading />;
  const pick = onPick ?? ((r: MarketRow) => showOnChart(tvToSymbol(r.id, r.name)));
  return (
    <table className="pg-table mk-table">
      <tbody>
        {state.rows.map((r) => (
          <tr key={r.id} className="click" onClick={() => pick(r)}>
            <td className="left pg-sym">
              <span className={`mk-logos n${Math.min(2, r.logos.length)}`}>
                {r.logos.length ? r.logos.map((l) => <TvLogo key={l} logoid={l} text={tickerOf(r.id)} size={22} />) : <TvLogo logoid={null} text={tickerOf(r.id)} size={22} />}
              </span>
              <b>{r.id.startsWith('CRYPTO:') ? tickerOf(r.id).replace(/USD$/, '') : tickerOf(r.id)}</b>
              <span>{r.name}</span>
            </td>
            {extra && <td className="muted">{big(r.extra)}</td>}
            <td>{r.id.startsWith('FX:') && r.last != null ? fr(r.last, /JPY/.test(r.id) ? 3 : 5) : price(r.last)}{unit && <small className="muted"> {unit}</small>}</td>
            <td className={`mk-chg ${signCls(r.change)}`}><span>{pct(r.change)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// TradingView's markets overview: indices, stocks, crypto, forex, commodities, bonds
export default function MarketsPage() {
  const [market, setMarket] = useKept<MarketId>('markets.market', 'america');
  const [list, setList] = useKept<StockList>('markets.list', 'gainers');
  const indices = useRows('indices', (s) => fetchList(INDICES, s));
  const stocks = useRows(`stocks-${market}-${list}`, (s) => fetchStocks(market, list, s));
  const crypto = useRows('crypto', fetchCrypto);
  const forex = useRows('forex', fetchForex);
  const commodities = useRows('commodities', (s) => fetchList(COMMODITIES, s));
  const bonds = useRows('bonds', (s) => fetchList(BONDS, s));

  return (
    <div className="pg">
      <PageHeader title="Marchés" />
      <div className="pg-scroll mk-grid">
        <Card title="Indices"><Rows state={indices} /></Card>
        <Card
          title="Actions"
          tools={(
            <select className="pg-select" value={market} onChange={(e) => setMarket(e.target.value as MarketId)}>
              {MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
        >
          <Chips<StockList> value={list} onChange={setList} options={[['gainers', 'Plus fortes hausses'], ['losers', 'Plus fortes baisses'], ['active', 'Plus actives'], ['largest', 'Plus grandes capitalisations']]} />
          <Rows state={stocks} extra={list === 'active' ? 'Valeur échangée' : 'Capitalisation'} />
        </Card>
        <Card title="Crypto"><Rows state={crypto} extra="Capitalisation" /></Card>
        <Card title="Forex"><Rows state={forex} /></Card>
        <Card title="Matières premières"><Rows state={commodities} /></Card>
        <Card title="Obligations (rendement)">
          <Rows state={bonds} unit="%" onPick={(r) => (YAHOO_BONDS.has(r.id) ? showOnChart(tvToSymbol(r.id, r.name)) : openTool('yields', true))} />
        </Card>
      </div>
      <div className="pg-note">Données TradingView en différé, actualisées toutes les minutes. Cliquez sur une ligne pour l’ouvrir sur le graphique.</div>
    </div>
  );
}
