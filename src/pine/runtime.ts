import type { Candle } from '../types';
import { PineError, type Expr, type Program, type Stmt } from './parser';

// Bar-by-bar Pine interpreter. Like Pine, every expression is a series: `x[n]`
// reads its value n bars ago, and every ta.* call site keeps its own state.

export type Value = number | boolean | string | null | Value[];

export type PlotOut = {
  key: string; title: string; step: boolean; histogram: boolean; linewidth: number;
  values: number[]; colors: (string | null)[];
};
export type ShapeOut = {
  key: string; title: string; shape: string; location: string;
  hits: { i: number; color: string; text: string }[];
};
export type HlineOut = { key: string; title: string; price: number; color: string; dashed: boolean };

export type RunResult = { plots: PlotOut[]; shapes: ShapeOut[]; hlines: HlineOut[] };

// input values by input key; `inputKeyOf` maps an input call node to its key
export type RunOptions = {
  inputs: Record<string, number | boolean | string>;
  inputKeyOf: Map<number, string>;
  plotKeyOf: Map<number, string>;
  timeframe: string;
  ticker: string;
  // strategy scripts: orders go to a simulated broker (see src/strategy/pineStrategy.ts)
  strategy?: StrategyHooks;
  mintick?: number;
};

export interface StrategyHooks {
  beginBar(i: number): void;
  endBar(i: number): void;
  call(fn: string, pos: Value[], named: Record<string, Value>, line: number): Value;
  // strategy.position_size, strategy.equity... `off` bars ago; undefined if unknown
  value(name: string, off: number): Value | undefined;
}

type Slot = { hist: Value[]; cur: Value; isVar: boolean; declared: boolean };

class Frame {
  prefix: string;
  vars = new Map<string, Slot>();
  parent: Frame | null;
  constructor(prefix: string, parent: Frame | null) {
    this.prefix = prefix;
    this.parent = parent;
  }
  find(name: string): Slot | undefined {
    return this.vars.get(name) ?? this.parent?.find(name);
  }
}

class LoopSignal { kind: 'break' | 'continue'; constructor(k: 'break' | 'continue') { this.kind = k; } }

export const PINE_COLORS: Record<string, string> = {
  'color.red': '#ff5252', 'color.green': '#4caf50', 'color.lime': '#00e676', 'color.blue': '#2196f3',
  'color.orange': '#ff9800', 'color.yellow': '#ffeb3b', 'color.purple': '#9c27b0', 'color.fuchsia': '#e040fb',
  'color.aqua': '#00bcd4', 'color.teal': '#00897b', 'color.navy': '#311b92', 'color.maroon': '#880e4f',
  'color.olive': '#808000', 'color.gray': '#787b86', 'color.silver': '#b2b5be', 'color.white': '#ffffff', 'color.black': '#363a45',
};

const num = (v: Value): number => (v === null ? NaN : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : NaN);
const isNa = (v: Value) => v === null || (typeof v === 'number' && isNaN(v));
const truthy = (v: Value) => (typeof v === 'boolean' ? v : typeof v === 'number' ? !isNaN(v) && v !== 0 : v !== null && v !== '');

function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}
function parseColor(c: string): [number, number, number, number] | null {
  if (c.startsWith('#')) return hexToRgba(c);
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0], p[1], p[2], p[3] ?? 1];
}
function toColor(r: number, g: number, b: number, a: number) {
  const x = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}${x(a * 255)}`;
}

// functions a script may call that have no visual equivalent here: ignored
export const IGNORED_FUNCTIONS = new Set([
  'bgcolor', 'fill', 'barcolor', 'alertcondition', 'alert', 'plotcandle', 'plotbar', 'plotarrow',
  'label.new', 'label.delete', 'label.set_xy', 'label.set_text', 'label.set_color', 'line.new', 'line.delete', 'line.set_xy1', 'line.set_xy2',
  'box.new', 'box.delete', 'table.new', 'table.cell', 'strategy.entry', 'strategy.exit', 'strategy.close', 'strategy.close_all',
  'strategy.order', 'strategy.cancel', 'strategy.cancel_all', 'runtime.error', 'log.info', 'log.warning', 'log.error',
]);
const DECLARATIONS = new Set(['indicator', 'study', 'strategy', 'library']);

// Pine v2-v4 names (no namespace), for the community scripts written before v5
const V4_FUNCTIONS: Record<string, string> = Object.fromEntries([
  ...['atr', 'barssince', 'bb', 'bbw', 'cci', 'change', 'cross', 'crossover', 'crossunder', 'cum', 'dev', 'dmi', 'ema', 'falling',
    'highest', 'highestbars', 'hma', 'kc', 'linreg', 'lowest', 'lowestbars', 'macd', 'median', 'mom', 'pivothigh', 'pivotlow', 'rising',
    'rma', 'roc', 'rsi', 'sma', 'stdev', 'stoch', 'supertrend', 'tr', 'valuewhen', 'variance', 'vwma', 'wma', 'wpr'].map((f) => [f, `ta.${f}`]),
  ...['abs', 'atan', 'avg', 'ceil', 'cos', 'exp', 'floor', 'log', 'log10', 'max', 'min', 'pow', 'round', 'sign', 'sin', 'sqrt', 'sum',
    'tan', 'todegrees', 'toradians'].map((f) => [f, `math.${f}`]),
  ['tostring', 'str.tostring'], ['color', 'color.new'],
]);
const V4_VARIABLES: Record<string, string> = { tr: 'ta.tr', obv: 'ta.obv', vwap: 'ta.vwap', n: 'bar_index' };

export class PineRuntime {
  private prog: Program;
  private k: Candle[] = [];
  private i = 0;
  private opts: RunOptions;
  private frames = new Map<string, Frame>();
  private global = new Frame('', null);
  private fns = new Map<string, Extract<Stmt, { k: 'fn' }>>();
  private state = new Map<string, any>();
  private exprHist = new Map<string, Value[]>();
  private plots = new Map<string, PlotOut>();
  private shapes = new Map<string, ShapeOut>();
  private hlines = new Map<string, HlineOut>();
  private curLine = 0;

  constructor(prog: Program, opts: RunOptions) {
    this.prog = prog;
    this.opts = opts;
    for (const s of prog.body) if (s.k === 'fn') this.fns.set(s.name, s);
  }

  run(candles: Candle[]): RunResult {
    this.k = candles;
    const n = candles.length;
    for (const p of this.plots.values()) { p.values = new Array(n).fill(NaN); p.colors = new Array(n).fill(null); }
    for (this.i = 0; this.i < n; this.i++) {
      this.opts.strategy?.beginBar(this.i);
      this.block(this.prog.body, this.global);
      this.opts.strategy?.endBar(this.i);
      for (const f of [this.global, ...this.frames.values()]) {
        for (const s of f.vars.values()) if (s.isVar) s.hist[this.i] = s.cur;
      }
    }
    return { plots: [...this.plots.values()], shapes: [...this.shapes.values()], hlines: [...this.hlines.values()] };
  }

  // ---------------- statements ----------------
  private block(body: Stmt[], f: Frame): Value {
    let last: Value = null;
    for (const s of body) last = this.stmt(s, f);
    return last;
  }

  private stmt(s: Stmt, f: Frame): Value {
    this.curLine = s.line;
    switch (s.k) {
      case 'fn': return null;
      case 'expr': return this.ev(s.e, f);
      case 'decl': {
        let slot = f.vars.get(s.name);
        if (!slot) { slot = { hist: [], cur: null, isVar: s.isVar, declared: false }; f.vars.set(s.name, slot); }
        if (s.isVar) {
          if (!slot.declared) { slot.cur = this.ev(s.e, f); slot.declared = true; }
          slot.hist[this.i] = slot.cur;
          return slot.cur;
        }
        const v = this.ev(s.e, f);
        slot.cur = v;
        slot.hist[this.i] = v;
        return v;
      }
      case 'tupdecl': {
        const v = this.ev(s.e, f);
        const arr = Array.isArray(v) ? v : [v];
        s.names.forEach((name, j) => {
          if (name === '_') return;
          let slot = f.vars.get(name);
          if (!slot) { slot = { hist: [], cur: null, isVar: false, declared: true }; f.vars.set(name, slot); }
          slot.cur = arr[j] ?? null;
          slot.hist[this.i] = slot.cur;
        });
        return v;
      }
      case 'assign': {
        const slot = f.find(s.name);
        if (!slot) throw new PineError(`variable « ${s.name} » non déclarée (utilisez « = » la première fois)`, s.line);
        let v = this.ev(s.e, f);
        if (s.op !== ':=') {
          const a = num(slot.hist[this.i] !== undefined ? slot.hist[this.i] : slot.cur), b = num(v);
          v = s.op === '+=' ? a + b : s.op === '-=' ? a - b : s.op === '*=' ? a * b : s.op === '/=' ? a / b : a % b;
        }
        slot.cur = v;
        slot.hist[this.i] = v;
        return v;
      }
      case 'if': return this.ifChain(s.branches, f);
      case 'for': {
        const from = num(this.ev(s.from, f)), to = num(this.ev(s.to, f));
        const step = s.by ? Math.abs(num(this.ev(s.by, f))) || 1 : 1;
        const dir = to >= from ? 1 : -1;
        let slot = f.vars.get(s.v);
        if (!slot) { slot = { hist: [], cur: null, isVar: false, declared: true }; f.vars.set(s.v, slot); }
        let last: Value = null;
        let guard = 0;
        for (let x = from; dir > 0 ? x <= to : x >= to; x += step * dir) {
          if (++guard > 100000) throw new PineError('boucle trop longue', s.line);
          slot.cur = x;
          slot.hist[this.i] = x;
          try { last = this.block(s.body, f); } catch (e) {
            if (e instanceof LoopSignal) { if (e.kind === 'break') break; continue; }
            throw e;
          }
        }
        return last;
      }
      case 'while': {
        let last: Value = null, guard = 0;
        while (truthy(this.ev(s.cond, f))) {
          if (++guard > 100000) throw new PineError('boucle while infinie ?', s.line);
          try { last = this.block(s.body, f); } catch (e) {
            if (e instanceof LoopSignal) { if (e.kind === 'break') break; continue; }
            throw e;
          }
        }
        return last;
      }
      case 'break': case 'continue': throw new LoopSignal(s.k);
    }
  }

  private ifChain(branches: { cond: Expr | null; body: Stmt[] }[], f: Frame): Value {
    for (const b of branches) if (b.cond === null || truthy(this.ev(b.cond, f))) return this.block(b.body, f);
    return null;
  }

  // ---------------- expressions ----------------
  private key(f: Frame, id: number) { return `${f.prefix}${id}`; }

  private ev(e: Expr, f: Frame): Value {
    switch (e.k) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 'bool': return e.v;
      case 'na': return NaN;
      case 'color': return e.v;
      case 'id': return this.ident(e.name, f, 0, e.line);
      case 'tuple': return e.items.map((x) => this.ev(x, f));
      case 'ifx': return this.ifChain(e.branches, f);
      case 'un': {
        const v = this.ev(e.e, f);
        return e.op === 'not' ? !truthy(v) : e.op === '-' ? -num(v) : num(v);
      }
      case 'tern': return truthy(this.ev(e.c, f)) ? this.ev(e.a, f) : this.ev(e.b, f);
      case 'bin': {
        const a = this.ev(e.a, f), b = this.ev(e.b, f);
        switch (e.op) {
          case 'and': return truthy(a) && truthy(b);
          case 'or': return truthy(a) || truthy(b);
          case '==': return typeof a === 'string' || typeof b === 'string' ? a === b : num(a) === num(b);
          case '!=': return typeof a === 'string' || typeof b === 'string' ? a !== b : num(a) !== num(b);
          case '<': return num(a) < num(b);
          case '>': return num(a) > num(b);
          case '<=': return num(a) <= num(b);
          case '>=': return num(a) >= num(b);
          case '+': return typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': return num(b) === 0 ? NaN : num(a) / num(b);
          case '%': return num(a) % num(b);
        }
        return NaN;
      }
      case 'hist': {
        const off = Math.round(num(this.ev(e.off, f)));
        if (isNaN(off) || off < 0) return NaN;
        if (e.e.k === 'id') return this.ident(e.e.name, f, off, e.e.line);
        const key = this.key(f, e.e.id);
        let h = this.exprHist.get(key);
        if (!h) { h = []; this.exprHist.set(key, h); }
        h[this.i] = this.ev(e.e, f);
        const v = h[this.i - off];
        return v === undefined ? NaN : v;
      }
      case 'call': return this.call(e, f);
    }
  }

  private bar(off: number): Candle | undefined { return this.k[this.i - off]; }

  private ident(name: string, f: Frame, off: number, line: number): Value {
    const slot = f.find(name);
    if (slot) {
      if (off === 0) return slot.hist[this.i] !== undefined ? slot.hist[this.i] : slot.isVar ? slot.cur : NaN;
      const v = slot.hist[this.i - off];
      return v === undefined ? NaN : v;
    }
    const c = this.bar(off);
    switch (name) {
      case 'open': return c ? c.open : NaN;
      case 'high': return c ? c.high : NaN;
      case 'low': return c ? c.low : NaN;
      case 'close': return c ? c.close : NaN;
      case 'volume': return c ? c.volume : NaN;
      case 'time': case 'time_close': return c ? c.time * 1000 : NaN;
      case 'hl2': return c ? (c.high + c.low) / 2 : NaN;
      case 'hlc3': return c ? (c.high + c.low + c.close) / 3 : NaN;
      case 'ohlc4': return c ? (c.open + c.high + c.low + c.close) / 4 : NaN;
      case 'hlcc4': return c ? (c.high + c.low + 2 * c.close) / 4 : NaN;
      case 'bar_index': return this.i - off;
      case 'last_bar_index': return this.k.length - 1;
      case 'na': return NaN;
      case 'hour': return c ? new Date(c.time * 1000).getUTCHours() : NaN;
      case 'minute': return c ? new Date(c.time * 1000).getUTCMinutes() : NaN;
      case 'dayofweek': return c ? new Date(c.time * 1000).getUTCDay() + 1 : NaN;
      case 'dayofmonth': return c ? new Date(c.time * 1000).getUTCDate() : NaN;
      case 'month': return c ? new Date(c.time * 1000).getUTCMonth() + 1 : NaN;
      case 'year': return c ? new Date(c.time * 1000).getUTCFullYear() : NaN;
      case 'barstate.islast': case 'barstate.isrealtime': return this.i === this.k.length - 1;
      case 'barstate.isfirst': return this.i === 0;
      case 'barstate.isconfirmed': case 'barstate.ishistory': return this.i < this.k.length - 1;
      case 'barstate.isnew': return true;
      case 'math.pi': return Math.PI;
      case 'math.e': return Math.E;
      case 'syminfo.ticker': case 'syminfo.tickerid': return this.opts.ticker;
      case 'syminfo.mintick': return this.opts.mintick ?? 0.01;
      case 'timeframe.period': return this.opts.timeframe;
      case 'timeframe.isintraday': return /[smhT]$/.test(this.opts.timeframe);
      case 'timeframe.isdaily': return /D$/.test(this.opts.timeframe);
      case 'timeframe.isweekly': return /W$/.test(this.opts.timeframe);
      case 'timeframe.ismonthly': return /M$/.test(this.opts.timeframe);
      case 'ta.tr': return this.tr(off);
      case 'ta.obv': {
        const s = this.st(`__obv`, () => ({ v: 0, h: [] as number[], at: -1 }));
        if (s.at !== this.i) {
          const p = this.bar(1);
          if (c && p) s.v += c.close > p.close ? c.volume : c.close < p.close ? -c.volume : 0;
          s.h[this.i] = s.v; s.at = this.i;
        }
        return s.h[this.i - off] ?? NaN;
      }
      case 'ta.vwap': return this.vwapAt(`__vwap`, c ? (c.high + c.low + c.close) / 3 : NaN, off);
    }
    if (name.startsWith('strategy.')) {
      if (this.opts.strategy) {
        const v = this.opts.strategy.value(name, off);
        if (v !== undefined) return v;
      } else {
        // a strategy drawn as an indicator (its plots only): no orders, no position
        if (name === 'strategy.long' || name === 'strategy.short') return name.slice(9);
        if (/^strategy\.(fixed|cash|percent_of_equity|commission\.|direction\.|oca\.)/.test(name)) return name;
        if (name === 'strategy.position_avg_price') return NaN;
        return 0;
      }
    }
    if (PINE_COLORS[name]) return PINE_COLORS[name];
    // v2-v4: tr, obv, vwap, n, and colors without "color."
    if (V4_VARIABLES[name]) return this.ident(V4_VARIABLES[name], f, off, line);
    if (PINE_COLORS[`color.${name}`]) return PINE_COLORS[`color.${name}`];
    // enum-like constants (plot.style_line, shape.triangleup, location.abovebar...)
    if (/^(plot|shape|location|size|hline|display|text|extend|position|format|scale|xloc|yloc|order|currency|dayofweek|adjustment|barmerge|font|alert|label|line|input|session)\./.test(name)) return name;
    throw new PineError(`« ${name} » inconnu`, line);
  }

  private tr(off = 0): number {
    const c = this.bar(off), p = this.bar(off + 1);
    if (!c) return NaN;
    if (!p) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }

  private st<T>(key: string, init: () => T): T {
    let s = this.state.get(key);
    if (s === undefined) { s = init(); this.state.set(key, s); }
    return s;
  }

  // ---------------- windowed helpers (one state per call site) ----------------
  private win(key: string, v: number, len: number): number[] {
    const s = this.st(key, () => ({ buf: [] as number[], at: -1 }));
    if (s.at !== this.i) { s.buf.push(v); s.at = this.i; } else s.buf[s.buf.length - 1] = v;
    if (s.buf.length > len) s.buf.splice(0, s.buf.length - len);
    return s.buf;
  }
  private sma(key: string, v: number, len: number): number {
    const b = this.win(key, v, len);
    if (b.length < len) return NaN;
    let sum = 0;
    for (const x of b) { if (isNaN(x)) return NaN; sum += x; }
    return sum / len;
  }
  // Pine's ema / rma: seeded with the SMA of the first `len` values
  private smoothed(key: string, v: number, len: number, alpha: number): number {
    const s = this.st(key, () => ({ prev: NaN, prevBar: NaN, at: -1, out: NaN }));
    if (s.at === this.i) s.prev = s.prevBar; else { s.prevBar = s.out; s.prev = s.out; }
    s.at = this.i;
    s.out = isNaN(s.prev) ? this.sma(key + 's', v, len) : alpha * v + (1 - alpha) * s.prev;
    return s.out;
  }
  private ema(key: string, v: number, len: number) { return this.smoothed(key, v, len, 2 / (len + 1)); }
  private rma(key: string, v: number, len: number) { return this.smoothed(key, v, len, 1 / len); }
  private wma(key: string, v: number, len: number): number {
    const b = this.win(key, v, len);
    if (b.length < len) return NaN;
    let sum = 0, norm = 0;
    b.forEach((x, j) => { const w = j + 1; sum += x * w; norm += w; });
    return sum / norm;
  }
  private stdev(key: string, v: number, len: number): number {
    const b = this.win(key, v, len);
    if (b.length < len || b.some(isNaN)) return NaN;
    const m = b.reduce((a, x) => a + x, 0) / len;
    return Math.sqrt(b.reduce((a, x) => a + (x - m) ** 2, 0) / len);
  }
  private extreme(key: string, v: number, len: number, max: boolean): number {
    const b = this.win(key, v, len);
    if (b.length < len) return NaN;
    return max ? Math.max(...b) : Math.min(...b);
  }
  private prevOf(key: string, v: number, back: number): number {
    const b = this.win(key, v, back + 1);
    return b.length <= back ? NaN : b[b.length - 1 - back];
  }
  private vwapAt(key: string, src: number, off = 0): number {
    const s = this.st(key, () => ({ day: -1, pv: 0, vol: 0, h: [] as number[], at: -1 }));
    const c = this.bar(0);
    if (c && s.at !== this.i) {
      const d = Math.floor(c.time / 86400);
      if (d !== s.day) { s.day = d; s.pv = 0; s.vol = 0; }
      s.pv += src * c.volume; s.vol += c.volume;
      s.h[this.i] = s.vol > 0 ? s.pv / s.vol : src;
      s.at = this.i;
    }
    return s.h[this.i - off] ?? NaN;
  }

  // ---------------- calls ----------------
  private call(e: Extract<Expr, { k: 'call' }>, f: Frame): Value {
    // a v4 name ("sma") unless the script defines a function of that name
    const fn = this.fns.has(e.fn) ? e.fn : V4_FUNCTIONS[e.fn] ?? e.fn;
    const key = this.key(f, e.id);
    this.curLine = e.line;

    if (fn.startsWith('strategy.') && this.opts.strategy) {
      const pos = e.args.map((a) => this.ev(a, f));
      const named: Record<string, Value> = {};
      for (const [n, a] of Object.entries(e.named)) named[n] = this.ev(a, f);
      return this.opts.strategy.call(fn, pos, named, e.line);
    }
    if (DECLARATIONS.has(fn) || IGNORED_FUNCTIONS.has(fn) || fn.startsWith('strategy.')) return null;

    const user = this.fns.get(fn);
    if (user) {
      const prefix = `${key}>`;
      let frame = this.frames.get(prefix);
      if (!frame) { frame = new Frame(prefix, this.global); this.frames.set(prefix, frame); }
      user.params.forEach((p, j) => {
        const argE = e.args[j] ?? e.named[p.name] ?? p.def;
        const v = argE ? this.ev(argE, f) : NaN;
        let slot = frame!.vars.get(p.name);
        if (!slot) { slot = { hist: [], cur: null, isVar: false, declared: true }; frame!.vars.set(p.name, slot); }
        slot.cur = v;
        slot.hist[this.i] = v;
      });
      return this.block(user.body, frame);
    }

    // evaluated arguments, positional + named
    const pos = e.args.map((a) => this.ev(a, f));
    const named: Record<string, Value> = {};
    for (const [n, a] of Object.entries(e.named)) named[n] = this.ev(a, f);
    const arg = (idx: number, name: string, def: Value = NaN): Value => (named[name] !== undefined ? named[name] : pos[idx] !== undefined ? pos[idx] : def);
    const n = (idx: number, name: string, def = NaN) => num(arg(idx, name, def));
    const len = (idx: number, name = 'length', def = NaN) => Math.max(1, Math.round(n(idx, name, def)));
    const src = (idx: number) => n(idx, 'source', num(this.ident('close', f, 0, e.line)));

    if (fn.startsWith('input')) return this.input(e, fn, pos, named);

    switch (fn) {
      // ----- math / utilities
      case 'na': return isNa(arg(0, 'x'));
      case 'nz': { const v = arg(0, 'source'); return isNa(v) ? arg(1, 'replacement', 0) : v; }
      case 'fixnan': { const s = this.st(key, () => ({ last: NaN })); const v = n(0, 'source'); if (!isNaN(v)) s.last = v; return s.last; }
      case 'math.abs': return Math.abs(n(0, 'number'));
      case 'math.max': return Math.max(...pos.map(num));
      case 'math.min': return Math.min(...pos.map(num));
      case 'math.avg': return pos.map(num).reduce((a, b) => a + b, 0) / pos.length;
      case 'math.round': { const p = n(1, 'precision', 0); const m = 10 ** (isNaN(p) ? 0 : p); return Math.round(n(0, 'number') * m) / m; }
      case 'math.round_to_mintick': return Math.round(n(0, 'number') * 100) / 100;
      case 'math.floor': return Math.floor(n(0, 'number'));
      case 'math.ceil': return Math.ceil(n(0, 'number'));
      case 'math.sqrt': return Math.sqrt(n(0, 'number'));
      case 'math.pow': return Math.pow(n(0, 'base'), n(1, 'exponent'));
      case 'math.log': return Math.log(n(0, 'number'));
      case 'math.log10': return Math.log10(n(0, 'number'));
      case 'math.exp': return Math.exp(n(0, 'number'));
      case 'math.sign': return Math.sign(n(0, 'number'));
      case 'math.sum': { const b = this.win(key, n(0, 'source'), len(1)); return b.length < len(1) ? NaN : b.reduce((a, x) => a + x, 0); }
      case 'math.todegrees': return n(0, 'radians') * 180 / Math.PI;
      case 'math.toradians': return n(0, 'degrees') * Math.PI / 180;
      case 'math.sin': return Math.sin(n(0, 'angle'));
      case 'math.cos': return Math.cos(n(0, 'angle'));
      case 'math.tan': return Math.tan(n(0, 'angle'));
      case 'math.atan': return Math.atan(n(0, 'angle'));
      case 'int': return Math.trunc(n(0, 'x'));
      case 'float': return n(0, 'x');
      case 'bool': return truthy(arg(0, 'x'));
      case 'str.tostring': { const v = arg(0, 'value'); return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v); }
      case 'nz_': return null;
      // v2-v4 inline if
      case 'iff': return truthy(arg(0, 'condition')) ? arg(1, 'then') : arg(2, '_else');
      case 'timestamp': return NaN;

      // ----- colors
      case 'color.new': {
        const c = arg(0, 'color');
        const t = n(1, 'transp', 0);
        if (typeof c !== 'string') return null;
        const rgba = parseColor(c);
        return rgba ? toColor(rgba[0], rgba[1], rgba[2], 1 - (isNaN(t) ? 0 : t) / 100) : c;
      }
      case 'color.rgb': return toColor(n(0, 'red'), n(1, 'green'), n(2, 'blue'), 1 - (isNaN(n(3, 'transp', 0)) ? 0 : n(3, 'transp', 0)) / 100);
      case 'color.from_gradient': {
        const v = n(0, 'value'), lo = n(1, 'bottom_value'), hi = n(2, 'top_value');
        const c1 = parseColor(String(arg(3, 'bottom_color'))), c2 = parseColor(String(arg(4, 'top_color')));
        if (!c1 || !c2 || isNaN(v)) return null;
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
        return toColor(c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t, c1[3] + (c2[3] - c1[3]) * t);
      }

      // ----- ta
      case 'ta.sma': return this.sma(key, src(0), len(1));
      case 'ta.ema': return this.ema(key, src(0), len(1));
      case 'ta.rma': return this.rma(key, src(0), len(1));
      case 'ta.wma': return this.wma(key, src(0), len(1));
      case 'ta.vwma': {
        const c = this.bar(0);
        const vol = c ? c.volume : NaN;
        return this.sma(key + 'a', src(0) * vol, len(1)) / this.sma(key + 'b', vol, len(1));
      }
      case 'ta.hma': {
        const L = len(1), s = src(0);
        const raw = 2 * this.wma(key + 'a', s, Math.max(1, Math.floor(L / 2))) - this.wma(key + 'b', s, L);
        return this.wma(key + 'c', raw, Math.max(1, Math.round(Math.sqrt(L))));
      }
      case 'ta.rsi': {
        const s = src(0), L = len(1);
        const prev = this.prevOf(key + 'p', s, 1);
        const ch = s - prev;
        const up = this.rma(key + 'u', isNaN(ch) ? NaN : Math.max(ch, 0), L);
        const dn = this.rma(key + 'd', isNaN(ch) ? NaN : Math.max(-ch, 0), L);
        if (isNaN(up) || isNaN(dn)) return NaN;
        return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
      }
      case 'ta.stoch': {
        const L = len(3);
        const hh = this.extreme(key + 'h', n(1, 'high'), L, true), ll = this.extreme(key + 'l', n(2, 'low'), L, false);
        return hh === ll ? NaN : (100 * (src(0) - ll)) / (hh - ll);
      }
      case 'ta.highest': case 'ta.lowest': {
        const one = pos.length === 1 && named.source === undefined;
        const s = one ? num(this.ident(fn === 'ta.highest' ? 'high' : 'low', f, 0, e.line)) : src(0);
        return this.extreme(key, s, one ? len(0) : len(1), fn === 'ta.highest');
      }
      case 'ta.highestbars': case 'ta.lowestbars': {
        const one = pos.length === 1;
        const s = one ? num(this.ident(fn === 'ta.highestbars' ? 'high' : 'low', f, 0, e.line)) : src(0);
        const L = one ? len(0) : len(1);
        const b = this.win(key, s, L);
        if (b.length < L) return NaN;
        const target = fn === 'ta.highestbars' ? Math.max(...b) : Math.min(...b);
        return b.lastIndexOf(target) - (b.length - 1);
      }
      case 'ta.atr': return this.rma(key, this.tr(), len(0));
      case 'ta.tr': return this.tr();
      case 'ta.stdev': return this.stdev(key, src(0), len(1));
      case 'ta.variance': { const sd = this.stdev(key, src(0), len(1)); return sd * sd; }
      case 'ta.dev': {
        const b = this.win(key, src(0), len(1));
        if (b.length < len(1)) return NaN;
        const m = b.reduce((a, x) => a + x, 0) / b.length;
        return b.reduce((a, x) => a + Math.abs(x - m), 0) / b.length;
      }
      case 'ta.change': case 'ta.mom': {
        const s = src(0), L = fn === 'ta.mom' ? len(1) : Math.round(n(1, 'length', 1));
        const prev = this.prevOf(key, s, L);
        if (typeof arg(0, 'source') === 'boolean') return truthy(arg(0, 'source')) !== truthy(prev);
        return s - prev;
      }
      case 'ta.roc': { const s = src(0); const prev = this.prevOf(key, s, len(1)); return (100 * (s - prev)) / prev; }
      case 'ta.cum': { const s = this.st(key, () => ({ sum: 0, at: -1, base: 0 })); if (s.at !== this.i) { s.base = s.sum; s.at = this.i; } const v = n(0, 'source'); s.sum = s.base + (isNaN(v) ? 0 : v); return s.sum; }
      case 'ta.crossover': case 'ta.crossunder': case 'ta.cross': {
        const a = n(0, 'source1'), b = n(1, 'source2');
        const pa = this.prevOf(key + 'a', a, 1), pb = this.prevOf(key + 'b', b, 1);
        const over = a > b && pa <= pb, under = a < b && pa >= pb;
        return fn === 'ta.crossover' ? over : fn === 'ta.crossunder' ? under : over || under;
      }
      case 'ta.rising': case 'ta.falling': {
        const L = len(1);
        const b = this.win(key, src(0), L + 1);
        if (b.length <= L) return false;
        const last = b[b.length - 1];
        return b.slice(0, -1).every((x) => (fn === 'ta.rising' ? last > x : last < x));
      }
      case 'ta.cci': {
        const s = src(0), L = len(1);
        const b = this.win(key, s, L);
        if (b.length < L) return NaN;
        const m = b.reduce((a, x) => a + x, 0) / L;
        const dev = b.reduce((a, x) => a + Math.abs(x - m), 0) / L;
        return dev === 0 ? 0 : (s - m) / (0.015 * dev);
      }
      case 'ta.wpr': {
        const L = len(0);
        const c = this.bar(0);
        const hh = this.extreme(key + 'h', c ? c.high : NaN, L, true), ll = this.extreme(key + 'l', c ? c.low : NaN, L, false);
        return hh === ll ? NaN : ((hh - (c?.close ?? NaN)) / (hh - ll)) * -100;
      }
      case 'ta.macd': {
        const s = src(0);
        const fast = this.ema(key + 'f', s, len(1, 'fastlen', 12)), slow = this.ema(key + 's', s, len(2, 'slowlen', 26));
        const m = fast - slow;
        const sig = this.ema(key + 'g', m, len(3, 'siglen', 9));
        return [m, sig, m - sig];
      }
      case 'ta.bb': {
        const s = src(0), L = len(1), mult = n(2, 'mult', 2);
        const basis = this.sma(key + 'm', s, L), dev = mult * this.stdev(key + 'd', s, L);
        return [basis, basis + dev, basis - dev];
      }
      case 'ta.bbw': {
        const s = src(0), L = len(1), mult = n(2, 'mult', 2);
        const basis = this.sma(key + 'm', s, L), dev = mult * this.stdev(key + 'd', s, L);
        return ((basis + dev - (basis - dev)) / basis) * 100;
      }
      case 'ta.kc': {
        const s = src(0), L = len(1), mult = n(2, 'mult', 2);
        const basis = this.ema(key + 'm', s, L), range = this.ema(key + 'r', this.tr(), L);
        return [basis, basis + mult * range, basis - mult * range];
      }
      case 'ta.vwap': return this.vwapAt(key, src(0));
      case 'ta.barssince': {
        const s = this.st(key, () => ({ last: -1 }));
        if (truthy(arg(0, 'condition'))) s.last = this.i;
        return s.last < 0 ? NaN : this.i - s.last;
      }
      case 'ta.valuewhen': {
        const s = this.st(key, () => ({ vals: [] as number[], at: -1 }));
        if (s.at !== this.i && truthy(arg(0, 'condition'))) { s.vals.push(n(1, 'source')); s.at = this.i; }
        const occ = Math.round(n(2, 'occurrence', 0));
        return s.vals[s.vals.length - 1 - occ] ?? NaN;
      }
      case 'ta.pivothigh': case 'ta.pivotlow': {
        const hi = fn === 'ta.pivothigh';
        const three = pos.length >= 3 || named.source !== undefined;
        const s = three ? src(0) : num(this.ident(hi ? 'high' : 'low', f, 0, e.line));
        const left = Math.round(three ? n(1, 'leftbars') : n(0, 'leftbars'));
        const right = Math.round(three ? n(2, 'rightbars') : n(1, 'rightbars'));
        const b = this.win(key, s, left + right + 1);
        if (b.length < left + right + 1) return NaN;
        const c = b[left];
        for (let j = 0; j < b.length; j++) {
          if (j === left) continue;
          if (hi ? (j < left ? b[j] > c : b[j] >= c) : (j < left ? b[j] < c : b[j] <= c)) return NaN;
        }
        return c;
      }
      case 'ta.dmi': {
        const di = len(0, 'diLength'), adxLen = len(1, 'adxSmoothing');
        const c = this.bar(0), p = this.bar(1);
        const up = c && p ? c.high - p.high : NaN, dn = c && p ? p.low - c.low : NaN;
        const plusDM = isNaN(up) ? NaN : up > dn && up > 0 ? up : 0;
        const minusDM = isNaN(dn) ? NaN : dn > up && dn > 0 ? dn : 0;
        const trur = this.rma(key + 't', this.tr(), di);
        const plus = (100 * this.rma(key + 'p', plusDM, di)) / trur;
        const minus = (100 * this.rma(key + 'm', minusDM, di)) / trur;
        const sum = plus + minus;
        const adx = 100 * this.rma(key + 'a', Math.abs(plus - minus) / (sum === 0 ? 1 : sum), adxLen);
        return [plus, minus, adx];
      }
      case 'ta.supertrend': {
        const factor = n(0, 'factor'), period = len(1, 'atrPeriod');
        const c = this.bar(0);
        if (!c) return [NaN, NaN];
        const atrV = this.rma(key + 'r', this.tr(), period);
        const s = this.st(key, () => ({ up: NaN, dn: NaN, dir: 1, st: NaN, at: -1, pUp: NaN, pDn: NaN, pDir: 1, pSt: NaN }));
        if (s.at !== this.i) { s.pUp = s.up; s.pDn = s.dn; s.pDir = s.dir; s.pSt = s.st; s.at = this.i; }
        const hl2 = (c.high + c.low) / 2;
        let upper = hl2 + factor * atrV, lower = hl2 - factor * atrV;
        const pc = this.bar(1)?.close ?? NaN;
        lower = lower > s.pDn || pc < s.pDn || isNaN(s.pDn) ? lower : s.pDn;
        upper = upper < s.pUp || pc > s.pUp || isNaN(s.pUp) ? upper : s.pUp;
        let dir: number;
        if (isNaN(atrV) || isNaN(s.pSt)) dir = 1;
        else if (s.pSt === s.pUp) dir = c.close > upper ? -1 : 1;
        else dir = c.close < lower ? 1 : -1;
        s.up = upper; s.dn = lower; s.dir = dir; s.st = dir === -1 ? lower : upper;
        return [s.st, dir];
      }
      case 'ta.linreg': {
        const L = len(1), off = n(2, 'offset', 0);
        const b = this.win(key, src(0), L);
        if (b.length < L) return NaN;
        let sx = 0, sy = 0, sxy = 0, sxx = 0;
        b.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
        const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx || 1);
        const intercept = (sy - slope * sx) / L;
        return intercept + slope * (L - 1 - off);
      }
      case 'ta.median': {
        const b = this.win(key, src(0), len(1));
        if (b.length < len(1)) return NaN;
        const s = [...b].sort((a, x) => a - x);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      }

      // ----- outputs
      case 'plot': {
        const pk = this.opts.plotKeyOf.get(e.id) ?? `plot${e.id}`;
        let out = this.plots.get(pk);
        if (!out) {
          const style = String(arg(4, 'style', 'plot.style_line'));
          out = {
            key: pk, title: String(arg(1, 'title', '') ?? ''),
            step: style.includes('step'), histogram: /histogram|columns|area/.test(style) && !style.includes('areabr') ? /histogram|columns/.test(style) : false,
            linewidth: Math.max(1, Math.min(4, Math.round(n(3, 'linewidth', 1)) || 1)),
            values: new Array(this.k.length).fill(NaN), colors: new Array(this.k.length).fill(null),
          };
          this.plots.set(pk, out);
        }
        const disp = arg(9, 'display', null);
        if (typeof disp === 'string' && disp === 'display.none') return null;
        out.values[this.i] = num(arg(0, 'series'));
        const col = arg(2, 'color', null);
        out.colors[this.i] = typeof col === 'string' ? col : col === null ? '#2962ff' : null;
        if (typeof col === 'number' && isNaN(col)) out.colors[this.i] = null;
        return null;
      }
      case 'plotshape': case 'plotchar': {
        const pk = this.opts.plotKeyOf.get(e.id) ?? `shape${e.id}`;
        let out = this.shapes.get(pk);
        if (!out) {
          out = {
            key: pk, title: String(arg(1, 'title', '') ?? ''),
            shape: fn === 'plotchar' ? 'shape.circle' : String(arg(2, 'style', 'shape.xcross')),
            location: String(arg(fn === 'plotchar' ? 3 : 3, 'location', 'location.abovebar')),
            hits: [],
          };
          this.shapes.set(pk, out);
        }
        const v = arg(0, 'series');
        if (truthy(v) || (typeof v === 'number' && !isNaN(v) && v !== 0)) {
          const col = arg(4, 'color', '#2962ff');
          out.hits.push({ i: this.i, color: typeof col === 'string' ? col : '#2962ff', text: String(arg(6, 'text', '') ?? '') });
        }
        return null;
      }
      case 'hline': {
        const pk = this.opts.plotKeyOf.get(e.id) ?? `hline${e.id}`;
        if (!this.hlines.has(pk)) {
          const col = arg(2, 'color', '#787b86');
          const style = String(arg(3, 'linestyle', 'hline.style_dashed'));
          this.hlines.set(pk, {
            key: pk, title: String(arg(1, 'title', '') ?? ''), price: n(0, 'price'),
            color: typeof col === 'string' ? col : '#787b86', dashed: !style.includes('solid'),
          });
        }
        return null;
      }
    }
    if (fn.startsWith('request.')) throw new PineError(`${fn} (données d’un autre symbole / unité) n’est pas pris en charge`, e.line);
    if (fn.startsWith('array.') || fn.startsWith('matrix.') || fn.startsWith('map.')) throw new PineError(`les tableaux (${fn}) ne sont pas encore pris en charge`, e.line);
    throw new PineError(`fonction « ${fn} » non prise en charge`, e.line);
  }

  private input(e: Extract<Expr, { k: 'call' }>, fn: string, pos: Value[], named: Record<string, Value>): Value {
    const key = this.opts.inputKeyOf.get(e.id) ?? `in${e.id}`;
    const def = named.defval !== undefined ? named.defval : pos[0];
    const v = this.opts.inputs[key];
    const isSource = fn === 'input.source' || (e.args[0]?.k === 'id' && ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'].includes(e.args[0].name));
    if (isSource) {
      const name = typeof v === 'string' ? v : e.args[0]?.k === 'id' ? e.args[0].name : 'close';
      return this.ident(name, this.global, 0, e.line);
    }
    return v !== undefined ? v : def ?? NaN;
  }

  get line() { return this.curLine; }
}
