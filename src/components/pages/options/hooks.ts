import { useEffect, useRef, useState } from 'react';
import { fetchChain, type Chain, type Expiration, type Underlying } from '../../../data/options';

// the chain of an expiration, loaded when it is shown
export function useChain(u: Underlying, e: Pick<Expiration, 'exp' | 'root'> | null) {
  const key = e ? `${u.id}|${e.exp}|${e.root}` : '';
  const [state, setState] = useState<{ key: string; chain: Chain | null; error: string | null }>({ key: '', chain: null, error: null });
  useEffect(() => {
    if (!e) return;
    let alive = true;
    fetchChain(u, e).then(
      (chain) => { if (alive) setState({ key, chain, error: null }); },
      (err: unknown) => { if (alive) setState({ key, chain: null, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : { key, chain: null, error: null };
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

