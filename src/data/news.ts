// TradingView's news flow (Reuters, TradingView, Zonebourse... in French), relayed
// as /tvnews (list) and /tvstory (text of a story). In English, the English flow.

import { LANG } from '../i18n/lang';

export type NewsItem = {
  id: string;
  title: string;
  published: number;
  urgency: number;
  provider: { id: string; name: string; logo: string | null };
  symbols: { symbol: string; logoid: string | null }[];
  link: string | null;
};

type RawItem = {
  id: string; title: string; published: number; urgency?: number; storyPath?: string; link?: string;
  provider?: { id: string; name: string; logo_id?: string };
  relatedSymbols?: { symbol: string; logoid?: string }[];
};

// market: stock, crypto, forex, futures, index, bond, etf, economic; symbol: "NASDAQ:AAPL"
export async function fetchNews(opts: { market?: string; symbol?: string }, signal?: AbortSignal): Promise<NewsItem[]> {
  const f = [`lang:${LANG}`];
  if (opts.market) f.push(`market:${opts.market}`);
  if (opts.symbol) f.push(`symbol:${opts.symbol}`);
  const qs = f.map((x) => `filter=${encodeURIComponent(x)}`).join('&');
  const res = await fetch(`/tvnews/news-flow/v2/news?${qs}&client=web&streaming=true`, { signal });
  if (!res.ok) throw new Error(`actualités indisponibles (${res.status})`);
  const json = (await res.json()) as { items?: RawItem[] };
  return (json.items ?? []).map((i) => ({
    id: i.id, title: i.title, published: i.published, urgency: i.urgency ?? 2,
    provider: { id: i.provider?.id ?? '', name: i.provider?.name ?? '', logo: i.provider?.logo_id ?? null },
    symbols: (i.relatedSymbols ?? []).map((s) => ({ symbol: s.symbol, logoid: s.logoid ?? null })),
    link: i.link ?? (i.storyPath ? `https://fr.tradingview.com${i.storyPath}` : null),
  }));
}

// the body of a story: a small tree of paragraphs, links, symbols...
export type StoryNode = string | { type: string; children?: StoryNode[]; params?: Record<string, string> };
export type Story = { short: string; body: StoryNode | null };

export async function fetchStory(id: string, signal?: AbortSignal): Promise<Story> {
  const res = await fetch(`/tvstory/v2/story?id=${encodeURIComponent(id)}&lang=${LANG}`, { signal });
  if (!res.ok) throw new Error(`article indisponible (${res.status})`);
  const json = (await res.json()) as { shortDescription?: string; astDescription?: StoryNode };
  return { short: json.shortDescription ?? '', body: json.astDescription ?? null };
}

export const providerLogo = (logo: string) => `https://s3-symbol-logo.tradingview.com/source/${logo}.svg`;
