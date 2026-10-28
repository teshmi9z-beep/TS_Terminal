import type { Candle, IndicatorConfig } from '../types';
import type { IndicatorDef, InputDef, Plot, StyleDef } from '../indicators/types';
import { parsePine, PineError, type Expr, type Program, type Stmt } from './parser';
import { PineRuntime, PINE_COLORS, IGNORED_FUNCTIONS } from './runtime';

export type PineScript = { id: string; name: string; source: string; updatedAt: number };

export type CompiledPine = {
  def: IndicatorDef | null;
  error: string | null;
  warnings: string[];
  meta: { title: string; overlay: boolean; inputs: number; plots: number };
};

const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'];

// runtime errors of the last computation, by script id (shown in the legend)
export const pineRuntimeErrors = new Map<string, string>();

// ---------- static walk ----------
function forEachCall(body: Stmt[], cb: (c: Extract<Expr, { k: 'call' }>) => void) {
  const ex = (e: Expr | null | undefined) => {
    if (!e) return;
    switch (e.k) {
      case 'call': cb(e); e.args.forEach(ex); Object.values(e.named).forEach(ex); break;
      case 'hist': ex(e.e); ex(e.off); break;
      case 'un': ex(e.e); break;
      case 'bin': ex(e.a); ex(e.b); break;
      case 'tern': ex(e.c); ex(e.a); ex(e.b); break;
      case 'tuple': e.items.forEach(ex); break;
      case 'ifx': e.branches.forEach((b) => { ex(b.cond); st(b.body); }); break;
      default: break;
    }
  };
  const st = (list: Stmt[]) => list.forEach((s) => {
    switch (s.k) {
      case 'decl': case 'assign': case 'tupdecl': case 'expr': ex(s.e); break;
      case 'if': s.branches.forEach((b) => { ex(b.cond); st(b.body); }); break;
      case 'for': ex(s.from); ex(s.to); ex(s.by); st(s.body); break;
      case 'while': ex(s.cond); st(s.body); break;
      case 'fn': s.params.forEach((p) => ex(p.def)); st(s.body); break;
      default: break;
    }
  });
  st(body);
}

// value of a literal argument (Pine requires constants for inputs / titles)
export function literal(e: Expr | undefined): number | boolean | string | null | undefined {
  if (!e) return undefined;
  switch (e.k) {
    case 'num': return e.v;
    case 'str': return e.v;
    case 'bool': return e.v;
    case 'color': return e.v;
    case 'na': return null;
    case 'un': { const v = literal(e.e); return e.op === '-' && typeof v === 'number' ? -v : v; }
    case 'id': return PINE_COLORS[e.name] ?? (SOURCES.includes(e.name) ? e.name : e.name);
    case 'call':
      if (e.fn === 'color.new') {
        const c = literal(e.args[0] ?? e.named.color);
        const t = literal(e.args[1] ?? e.named.transp);
        if (typeof c === 'string' && c.startsWith('#')) {
          const a = Math.round(255 * (1 - (typeof t === 'number' ? t : 0) / 100)).toString(16).padStart(2, '0');
          return c.slice(0, 7) + a;
        }
      }
      return undefined;
    default: return undefined;
  }
}

const argOf = (c: Extract<Expr, { k: 'call' }>, idx: number, name: string) => c.named[name] ?? c.args[idx];

export function analyze(prog: Program) {
  let title = 'Script Pine', shorttitle: string | null = null, overlay = false;
  // named arguments of strategy(...) (initial_capital, default_qty_type...), null for an indicator
  let strategyArgs: Record<string, number | boolean | string | null | undefined> | null = null;
  const inputs: InputDef[] = [];
  const styles: StyleDef[] = [];
  const inputKeyOf = new Map<number, string>();
  const plotKeyOf = new Map<number, string>();
  const warnings = new Set<string>();
  const used = new Set<string>();
  const unique = (base: string) => { let k = base, n = 2; while (used.has(k)) k = `${base} ${n++}`; used.add(k); return k; };
  let plotCount = 0;

  forEachCall(prog.body, (c) => {
    if (c.fn === 'indicator' || c.fn === 'study' || c.fn === 'strategy') {
      const t = literal(argOf(c, 0, 'title'));
      if (typeof t === 'string') title = t;
      const st = literal(c.named.shorttitle ?? c.args[1]);
      if (typeof st === 'string') shorttitle = st;
      overlay = literal(c.named.overlay) === true;
      if (c.fn === 'strategy') {
        strategyArgs = Object.fromEntries(Object.entries(c.named).map(([k, v]) => [k, literal(v)]));
        warnings.add('Script « strategy » : seuls les tracés sont affichés ici ; le backtest se fait dans le Testeur de stratégie.');
      }
      return;
    }
    if (c.fn === 'input' || c.fn.startsWith('input.')) {
      const def = literal(argOf(c, 0, 'defval'));
      const label = literal(argOf(c, 1, 'title'));
      const key = unique(typeof label === 'string' && label ? label : `Entrée ${inputs.length + 1}`);
      inputKeyOf.set(c.id, key);
      const firstIsSource = c.args[0]?.k === 'id' && SOURCES.includes(c.args[0].name);
      const kind: InputDef['kind'] = c.fn === 'input.source' || firstIsSource ? 'source'
        : c.fn === 'input.bool' || typeof def === 'boolean' ? 'bool'
        : c.fn === 'input.color' || (typeof def === 'string' && def.startsWith('#')) ? 'color'
        : c.fn === 'input.session' ? 'session'
        : c.fn === 'input.string' || c.fn === 'input.timeframe' || c.fn === 'input.symbol' || typeof def === 'string' ? 'string'
        : 'number';
      const opts = c.named.options;
      const options = opts?.k === 'tuple' ? opts.items.map((x) => String(literal(x))) : undefined;
      const numArg = (idx: number, name: string) => { const v = literal(argOf(c, idx, name)); return typeof v === 'number' ? v : undefined; };
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      inputs.push({
        key, label: typeof label === 'string' ? label : key, kind, options,
        group: str(literal(c.named.group)), inline: str(literal(c.named.inline)), tooltip: str(literal(c.named.tooltip)),
        default: kind === 'source' ? (firstIsSource && c.args[0].k === 'id' ? c.args[0].name : 'close') : def ?? (kind === 'number' ? 0 : ''),
        min: numArg(2, 'minval'), max: numArg(3, 'maxval'),
        step: numArg(4, 'step') ?? (c.fn === 'input.float' || (typeof def === 'number' && !Number.isInteger(def)) ? 0.1 : 1),
      });
      return;
    }
    if (c.fn === 'plot' || c.fn === 'plotshape' || c.fn === 'plotchar' || c.fn === 'hline') {
      const t = literal(argOf(c, 1, 'title'));
      const key = unique(typeof t === 'string' && t ? t : `${c.fn === 'hline' ? 'Niveau' : 'Tracé'} ${++plotCount}`);
      plotKeyOf.set(c.id, key);
      if (c.fn === 'plot') {
        const col = literal(argOf(c, 2, 'color'));
        styles.push({ key, name: key, color: typeof col === 'string' && col.startsWith('#') ? col : '#2962ff' });
      }
      return;
    }
    if (IGNORED_FUNCTIONS.has(c.fn)) warnings.add(`« ${c.fn} » est ignoré (ligne ${c.line}) : pas d’équivalent visuel ici.`);
  });

  // (assigned inside the walk callback, which TypeScript's narrowing doesn't see)
  const declared = strategyArgs as Record<string, number | boolean | string | null | undefined> | null;
  return { title, shorttitle, overlay, inputs, styles, inputKeyOf, plotKeyOf, strategyArgs: declared, warnings: [...warnings] };
}

function alphaOf(color: string): number {
  const h = color.replace('#', '');
  return h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
}

const SHAPES: Record<string, 'arrowUp' | 'arrowDown' | 'circle' | 'square'> = {
  'shape.triangleup': 'arrowUp', 'shape.arrowup': 'arrowUp', 'shape.labelup': 'arrowUp',
  'shape.triangledown': 'arrowDown', 'shape.arrowdown': 'arrowDown', 'shape.labeldown': 'arrowDown',
  'shape.circle': 'circle', 'shape.square': 'square', 'shape.diamond': 'square', 'shape.flag': 'square',
  'shape.cross': 'circle', 'shape.xcross': 'circle',
};

const cache = new Map<string, CompiledPine>();

export function compilePine(script: Pick<PineScript, 'id' | 'name' | 'source'>, context?: () => { timeframe: string; ticker: string }): CompiledPine {
  const cacheKey = `${script.id}\u0000${script.source}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  let prog: Program;
  let meta: ReturnType<typeof analyze>;
  try {
    prog = parsePine(script.source);
    meta = analyze(prog);
  } catch (e) {
    const out: CompiledPine = { def: null, error: e instanceof Error ? e.message : String(e), warnings: [], meta: { title: script.name, overlay: false, inputs: 0, plots: 0 } };
    return out;
  }

  const defaults: Record<string, number | boolean | string> = {};
  for (const inp of meta.inputs) defaults[inp.key] = inp.default;

  const def: IndicatorDef = {
    type: 'PINE',
    label: meta.title,
    short: meta.shorttitle ?? meta.title,
    category: 'Personnalises',
    overlay: meta.overlay,
    description: 'Script Pine importé',
    defaults: { period: 0, color: meta.styles[0]?.color ?? '#2962ff' },
    inputs: meta.inputs,
    styles: meta.styles,
    params: (cfg) => meta.inputs
      .filter((i) => i.kind === 'number' || i.kind === 'source')
      .map((i) => String(cfg.inputs?.[i.key] ?? i.default))
      .join(' '),
    compute: (candles: Candle[], cfg: IndicatorConfig): Plot[] => {
      const ctx = context?.() ?? { timeframe: '', ticker: '' };
      try {
        const rt = new PineRuntime(prog, {
          inputs: { ...defaults, ...(cfg.inputs ?? {}) }, inputKeyOf: meta.inputKeyOf, plotKeyOf: meta.plotKeyOf, ...ctx,
        });
        const res = rt.run(candles);
        pineRuntimeErrors.delete(script.id);
        const plots: Plot[] = [];
        for (const p of res.plots) {
          const override = cfg.plotColors?.[p.key];
          const data: Plot['data'] = [];
          const seen = new Set<string>();
          for (let i = 0; i < candles.length; i++) {
            const v = p.values[i];
            const c = override ?? p.colors[i];
            if (!Number.isFinite(v) || !c || alphaOf(c) === 0) continue;
            seen.add(c);
            data.push({ time: candles[i].time, value: v, color: c });
          }
          const single = seen.size <= 1;
          const color = [...seen][0] ?? override ?? '#2962ff';
          plots.push({
            key: p.key, name: p.title || p.key, color, kind: p.histogram ? 'histogram' : 'line', width: p.linewidth, step: p.step,
            data: single && !p.histogram ? data.map(({ time, value }) => ({ time, value })) : data,
          });
        }
        for (const h of res.hlines) {
          if (Number.isFinite(h.price)) plots.push({ key: h.key, name: h.title, color: h.color, kind: 'hline', price: h.price, dashed: h.dashed, data: [] });
        }
        for (const s of res.shapes) {
          const position = s.location.includes('belowbar') || s.location.includes('bottom') ? 'belowBar' : s.location.includes('abovebar') || s.location.includes('top') ? 'aboveBar' : 'inBar';
          plots.push({
            key: s.key, name: s.title, color: '#2962ff', kind: 'markers', data: [],
            markers: s.hits.map((h) => ({ time: candles[h.i].time, position, shape: SHAPES[s.shape] ?? 'circle', color: h.color, text: h.text })),
          });
        }
        return plots;
      } catch (e) {
        pineRuntimeErrors.set(script.id, e instanceof PineError ? e.message : String(e));
        return [];
      }
    },
  };

  const out: CompiledPine = {
    def, error: null, warnings: meta.warnings,
    meta: { title: meta.title, overlay: meta.overlay, inputs: meta.inputs.length, plots: meta.styles.length },
  };
  // the editor's draft changes on every keystroke: not worth keeping
  if (script.id !== 'draft') cache.set(cacheKey, out);
  return out;
}
