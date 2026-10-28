// Community scripts published on TradingView: search (/tvweb) and open source code (/tvpine).

export type CommunityScript = {
  id: string; // PUB;2187
  name: string;
  author: string;
  likes: number;
  image: string | null;
  access: 1 | 2 | 3; // open, protected, invite-only
  kind: 'study' | 'strategy' | 'library';
  recommended: boolean;
  version: string | null;
  source: string | null;
};

type Raw = {
  scriptIdPart: string; scriptName: string; title?: string; imageUrl?: string; access?: number; agreeCount?: number;
  isRecommended?: boolean; scriptSource?: string; author?: { username?: string }; extra?: { kind?: string };
};

const versionOf = (src: string | null) => (src ? (/\/\/\s*@version\s*=\s*(\d+)/.exec(src)?.[1] ?? '1') : null);

export async function searchScripts(q: string, offset = 0, signal?: AbortSignal): Promise<{ items: CommunityScript[]; more: boolean }> {
  const res = await fetch(`/tvweb/pubscripts-suggest-json/?search=${encodeURIComponent(q)}${offset ? `&offset=${offset}` : ''}`, { signal });
  if (!res.ok) throw new Error(`recherche indisponible (${res.status})`);
  const json = (await res.json()) as { results?: Raw[]; next?: string | null };
  return {
    more: !!json.next,
    items: (json.results ?? []).map((r) => {
      const source = r.scriptSource || null;
      return {
        id: r.scriptIdPart, name: r.scriptName || r.title || '', author: r.author?.username ?? '', likes: r.agreeCount ?? 0,
        image: r.imageUrl ?? null, access: (r.access === 2 || r.access === 3 ? r.access : 1) as 1 | 2 | 3,
        kind: r.extra?.kind === 'strategy' ? 'strategy' : r.extra?.kind === 'library' ? 'library' : 'study',
        recommended: !!r.isRecommended, source, version: versionOf(source),
      };
    }),
  };
}

// open source code of a published script (null when it's protected)
export async function fetchSource(id: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(`/tvpine/pine-facade/get/${encodeURIComponent(id)}/last?no_4xx=true`, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as { source?: string; scriptAccess?: string };
  return json.source || null;
}

export const scriptImage = (img: string) => `https://s3.tradingview.com/${img[0].toLowerCase()}/${img}_mid.png`;
export const scriptPage = (s: CommunityScript) => `https://fr.tradingview.com/script/${s.image ?? ''}/`;
export { versionOf };
