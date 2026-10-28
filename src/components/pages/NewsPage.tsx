import { useEffect, useState, type ReactNode } from 'react';
import { useKept } from '../kept';
import { fetchNews, fetchStory, providerLogo, type NewsItem, type Story, type StoryNode } from '../../data/news';
import { resolveTv, tvToSymbol } from '../../data/tv';
import { ago } from '../../data/format';
import { showOnChart } from '../tabs/tabActions';
import { Chips, Loading, PageHeader, TvLogo } from './common';
import { LOCALE } from '../../i18n/lang';

type Market = '' | 'stock' | 'crypto' | 'forex' | 'index' | 'futures' | 'bond' | 'etf' | 'economic';

const MARKETS: [Market, string][] = [
  ['', 'Tout'], ['stock', 'Actions'], ['crypto', 'Crypto'], ['forex', 'Forex'], ['index', 'Indices'],
  ['futures', 'Contrats à terme'], ['bond', 'Obligations'], ['etf', 'ETF'], ['economic', 'Économie'],
];

const tickerOf = (sym: string) => sym.split(':')[1] ?? sym;

// the story's tree as React elements (paragraphs, bold, links, symbols...)
function renderNode(n: StoryNode, key: number): ReactNode {
  if (typeof n === 'string') return n;
  const kids = (n.children ?? []).map((c, i) => renderNode(c, i));
  switch (n.type) {
    case 'root': return <div key={key}>{kids}</div>;
    case 'p': return <p key={key}>{kids}</p>;
    case 'b': case 'strong': return <strong key={key}>{kids}</strong>;
    case 'i': case 'em': return <em key={key}>{kids}</em>;
    case 'ul': return <ul key={key}>{kids}</ul>;
    case 'ol': return <ol key={key}>{kids}</ol>;
    case 'li': return <li key={key}>{kids}</li>;
    case 'h1': case 'h2': case 'h3': case 'h4': return <h3 key={key}>{kids}</h3>;
    case 'table': return <table key={key} className="nw-table"><tbody>{kids}</tbody></table>;
    case 'tr': return <tr key={key}>{kids}</tr>;
    case 'td': case 'th': return <td key={key}>{kids}</td>;
    case 'symbol': {
      const sym = n.params?.symbol ?? '';
      return <button key={key} className="nw-sym" onClick={() => showOnChart(tvToSymbol(sym))}>{n.params?.text ?? tickerOf(sym)}</button>;
    }
    case 'url': return <a key={key} href={n.params?.url} target="_blank" rel="noreferrer">{n.params?.linkText ?? kids}</a>;
    case 'quote': return <blockquote key={key}>{kids}</blockquote>;
    case 'news-image': {
      const img = (n.params as unknown as { image?: { id?: string; alt?: string } })?.image;
      return img?.id ? <img key={key} className="nw-img" src={`https://s3.tradingview.com/news/image/${img.id}-resized.jpeg`} alt={img.alt ?? ''} /> : null;
    }
    default: return <span key={key}>{kids}</span>;
  }
}

function Reader({ item }: { item: NewsItem }) {
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchStory(item.id, ctrl.signal).then(setStory, (e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => ctrl.abort();
  }, [item.id]);
  return (
    <div className="nw-reader">
      <div className="nw-reader-meta">
        {item.provider.logo && <img className="nw-prov" src={providerLogo(item.provider.logo)} alt="" />}
        <span>{item.provider.name}</span> · <span>{new Date(item.published * 1000).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
      <h2>{item.title}</h2>
      {item.symbols.length > 0 && (
        <div className="nw-syms">
          {item.symbols.map((s) => (
            <button key={s.symbol} className="nw-chip" onClick={() => showOnChart(tvToSymbol(s.symbol))} title="Ouvrir sur le graphique">
              <TvLogo logoid={s.logoid} text={tickerOf(s.symbol)} size={18} />{tickerOf(s.symbol)}
            </button>
          ))}
        </div>
      )}
      {error && <div className="pg-error">{error}</div>}
      {!story && !error && <Loading text="Chargement de l’article…" />}
      {story && <div className="nw-body">{story.body ? renderNode(story.body, 0) : <p>{story.short}</p>}</div>}
      {item.link && <a className="nw-link" href={item.link} target="_blank" rel="noreferrer">Voir sur TradingView ↗</a>}
    </div>
  );
}

// TradingView's news flow: latest stories by market or symbol, with a reader
export default function NewsPage() {
  const [market, setMarket] = useKept<Market>('news.market', '');
  const [symbolText, setSymbolText] = useKept('news.symbolText', '');
  const [symbol, setSymbol] = useKept<string | null>('news.symbol', null);
  const [items, setItems] = useKept<NewsItem[] | null>('news.items', null, true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useKept<NewsItem | null>('news.selected', null, true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchNews({ market: market || undefined, symbol: symbol ?? undefined }, ctrl.signal)
      .then((list) => { setItems(list); setError(null); })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    const id = setTimeout(() => setTick((t) => t + 1), 60_000);
    return () => { ctrl.abort(); clearTimeout(id); };
  }, [market, symbol, tick, setItems]);

  async function applySymbol() {
    if (!symbolText.trim()) { setSymbol(null); return; }
    const r = await resolveTv(symbolText).catch(() => null);
    setSymbol(r?.id ?? symbolText.trim().toUpperCase());
    setItems(null);
  }

  return (
    <div className="pg">
      <PageHeader title="Flux d’actualités">
        <div className="nw-search">
          <input placeholder="Symbole (ex : AAPL, OR, BTCUSD)" value={symbolText} onChange={(e) => setSymbolText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void applySymbol(); }} />
          {symbol ? <button className="pill-btn" onClick={() => { setSymbol(null); setSymbolText(''); setItems(null); }}>{symbol} ✕</button>
            : <button className="pill-btn" onClick={() => void applySymbol()}>Filtrer</button>}
        </div>
      </PageHeader>
      <div className="pg-toolbar"><Chips value={market} onChange={(m) => { setMarket(m); setItems(null); }} options={MARKETS} /></div>
      {error && <div className="pg-error">{error}</div>}
      <div className="nw-layout">
        <div className="nw-list">
          {!items && !error && <Loading />}
          {items?.map((n) => (
            <button key={n.id} className={`nw-item ${selected?.id === n.id ? 'active' : ''} ${n.urgency === 1 ? 'urgent' : ''}`} onClick={() => setSelected(n)}>
              <div className="nw-item-meta">
                <span>{ago(n.published)}</span>
                {n.provider.logo && <img className="nw-prov" src={providerLogo(n.provider.logo)} alt="" />}
                <span>{n.provider.name}</span>
                <span className="nw-item-syms">
                  {n.symbols.slice(0, 4).map((s) => <TvLogo key={s.symbol} logoid={s.logoid} text={tickerOf(s.symbol)} size={16} />)}
                </span>
              </div>
              <div className="nw-item-title">{n.title}</div>
            </button>
          ))}
          {items && !items.length && <div className="pg-empty">Aucune actualité.</div>}
        </div>
        {selected ? <Reader key={selected.id} item={selected} /> : <div className="nw-reader nw-placeholder">Sélectionnez une actualité pour la lire.</div>}
      </div>
    </div>
  );
}
