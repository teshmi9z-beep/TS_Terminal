import fs from 'node:fs';
import path from 'node:path';
import { hhmm, zoned, type IndexFamily } from '../../src/data/indexFamilies';
import { readDataset, COLS } from './dataset';

// The Expected Move study's data (scripts/robots/em-study.ts, em-check.ts): the markets, their
// cash sessions and the volatility indices.

export const GAPS = path.resolve('robots/gaps/data');
export const VOLS = path.resolve('robots/em/data');

export type Row = [number, number, number, number, number];
export type Sess = { day: string; t0: number; o: number[]; h: number[]; l: number[]; c: number[]; min: number[]; O: number; H: number; L: number; C: number; full: boolean };

// ---------------------------------------------------------------- the markets
// implied index: the index's own when Yahoo has it (VIX1D only since 2023: VIX for the S&P);
// none for the Russell (RVX gone from Yahoo), the DAX and the Nikkei
// prices: quotes that follow the future through the session's open where there are some (HistData's
// S&P and Nasdaq CFDs, IBKR's Dow CFD); the cash indices otherwise. The Russell's cash index opens
// stale (its first 15 minutes span 3 times an average bar's range, the small caps quoting late):
// its sessions start at 9:45, a CME future having no such opening print
// artifact: why a market's results can't stand for its CME future (shown, left out of the
// methods and the walk-forward). The Russell's cash index lags (its small caps quote late): its
// 15-minute returns follow each other (lag-1 autocorrelation 0.125, about 0 for the S&P, Nasdaq,
// Dow, DAX and Nikkei sources), so breakouts look like they pay on it and not on RTY
export const MARKETS: { id: string; name: string; fam: string; file: string; iv: string | null; us: boolean; skipFirst?: boolean; src: string; artifact?: string }[] = [
  { id: 'SPX500', name: 'S&P 500 (ES)', fam: 'spx', file: path.resolve('robots/data/histdata_SPX500_15m.bin'), iv: 'VIX', us: true, src: 'HistData SPX500 (CFD)' },
  { id: 'NDX100', name: 'Nasdaq 100 (NQ)', fam: 'ndx', file: path.resolve('robots/data/histdata_NDX100_15m.bin'), iv: 'VXN', us: true, src: 'HistData NDX100 (CFD)' },
  { id: 'DJI', name: 'Dow Jones (YM)', fam: 'dji', file: path.resolve('robots/data/dl_ibkr_DJI_15m.bin'), iv: 'VXD', us: true, src: 'IBKR CFD IBUS30' },
  { id: 'RUT2000', name: 'Russell 2000 (RTY)', fam: 'rut', file: path.join(GAPS, 'RUT2000_15m.json'), iv: null, us: true, skipFirst: true, src: 'IBKR indice cash, dès 9 h 45', artifact: 'indice cash en retard sur ses actions (autocorrélation 0,125) : ses cassures ne valent pas pour le future RTY' },
  { id: 'DAX40', name: 'DAX 40 (FDAX)', fam: 'dax', file: path.join(GAPS, 'DAX40_15m.json'), iv: null, us: false, src: 'IBKR indice cash' },
  { id: 'NIKKEI', name: 'Nikkei 225 (NKD)', fam: 'nikkei', file: path.join(GAPS, 'NIKKEI_15m.json'), iv: null, us: false, src: 'IBKR indice cash' },
];

export function readRows(file: string): Row[] {
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { rows } = readDataset(file);
  const out: Row[] = [];
  for (let i = 0; i < rows.length / COLS; i++) out.push([rows[i * COLS], rows[i * COLS + 1], rows[i * COLS + 2], rows[i * COLS + 3], rows[i * COLS + 4]]);
  return out;
}

// the cash sessions: bars inside the exchange's hours, grouped by its calendar day; a session
// counts only when its first bar starts at the open
export function sessionsOf(rows: Row[], f: IndexFamily, skipFirst = false): Sess[] {
  const open = hhmm(f.open) + (skipFirst ? 15 : 0), close = hhmm(f.close);
  const cache = new Map<number, { day: string; minutes: number }>();
  const local = (t: number) => {
    // the zone's offset once per UTC hour
    const hk = Math.floor(t / 3600);
    let z = cache.get(hk);
    if (!z) { z = zoned(hk * 3600, f.tz); cache.set(hk, z); }
    return { day: z.day, minutes: z.minutes + Math.floor((t % 3600) / 60) };
  };
  const out: Sess[] = [];
  for (const [t, o, h, l, c] of rows) {
    const z = local(t);
    if (z.minutes < open || z.minutes >= close) continue;
    let s = out[out.length - 1];
    if (!s || s.day !== z.day) {
      s = { day: z.day, t0: t, o: [], h: [], l: [], c: [], min: [], O: o, H: h, L: l, C: c, full: false };
      out.push(s);
      if (z.minutes !== open) s.O = NaN;
    }
    s.o.push(o); s.h.push(h); s.l.push(l); s.c.push(c); s.min.push(z.minutes - open);
    s.H = Math.max(s.H, h); s.L = Math.min(s.L, l); s.C = c;
  }
  for (const s of out) s.full = s.min[s.min.length - 1] + open >= close - 60 && s.o.length >= 8;
  return out.filter((s) => Number.isFinite(s.O));
}

// a daily volatility index: open and close by date
export function volIndex(name: string): Map<string, { o: number; c: number }> {
  const f = path.join(VOLS, `${name}_1d.json`);
  const m = new Map<string, { o: number; c: number }>();
  if (!fs.existsSync(f)) return m;
  for (const [t, o, , , c] of JSON.parse(fs.readFileSync(f, 'utf8')) as Row[]) m.set(new Date(t * 1000).toISOString().slice(0, 10), { o, c });
  return m;
}
export const VIX = volIndex('VIX');
export const VIX_DAYS = [...VIX.keys()].sort();
// the last close strictly before a date
export function closeBefore(m: Map<string, { o: number; c: number }>, days: string[], day: string): number {
  let lo = 0, hi = days.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] < day) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? m.get(days[best])!.c : NaN;
}
// what an index read at the session's open: the US ones at their own open (9:30, the cash
// open), the others at the last US close before (the European and Asian sessions open first)
export function volAtOpen(m: Map<string, { o: number; c: number }>, days: string[], day: string, us: boolean): number {
  if (us) { const q = m.get(day); if (q && q.o > 0) return q.o; }
  return closeBefore(m, days, day);
}

