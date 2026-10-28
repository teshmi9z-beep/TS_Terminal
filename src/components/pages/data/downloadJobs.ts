import { useEffect, useRef, useState } from 'react';

// The dev server's history downloads (scripts/history-download.ts), as the Data tab shows them.

export type DlJob = {
  id: string; ticker: string; tf: string; source: string; label: string; from: number; started: number; finished?: number;
  state: 'running' | 'done' | 'error' | 'cancelled' | 'queued'; bars: number; oldest?: number; progress: number; message?: string; files: string[];
};

export const activeJob = (j: DlJob) => j.state === 'running' || j.state === 'queued';

// the downloads under way and those ended in the last 6 hours, read again every 2 s while
// one runs (every 15 s otherwise); `onDone` when one ends, to read the files again
export function useDownloadJobs(onDone: () => void): [DlJob[], () => void] {
  const [jobs, setJobs] = useState<DlJob[]>([]);
  const [poke, setPoke] = useState(0);
  const doneRef = useRef(onDone);
  useEffect(() => { doneRef.current = onDone; });
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      const r = await fetch('/api/data/download/jobs').then((x) => (x.ok ? x.json() as Promise<{ jobs: DlJob[] }> : null)).catch(() => null);
      if (!alive) return;
      const list = r?.jobs ?? [];
      let ended = false;
      for (const j of list) {
        const was = seen.current.get(j.id);
        if (was !== undefined && was !== j.state && !activeJob(j)) ended = true;
        seen.current.set(j.id, j.state);
      }
      if (ended) doneRef.current();
      const recent = Date.now() - 6 * 3600_000;
      setJobs(list.filter((j) => activeJob(j) || (j.finished ?? 0) > recent));
      timer = window.setTimeout(tick, list.some(activeJob) ? 2000 : 15000);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [poke]);
  return [jobs, () => setPoke((p) => p + 1)];
}
