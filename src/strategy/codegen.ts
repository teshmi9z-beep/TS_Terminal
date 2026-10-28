import type { IndicatorConfig } from '../types';
import { indicatorTitle } from '../indicators/registry';
import type { Condition, ConditionGroup, Operand, RulesStrategy } from './rules';

// Pine Script v5 equivalent of an assisted strategy, like ProRealTime showing the
// code behind its "création assistée". Built-in indicators are translated to ta.*;
// ported / Pine indicators have no ta.* equivalent and are reported.

type Ctx = { lines: string[]; names: Map<string, string>; used: Set<string>; missing: Set<string> };

const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : String(+v.toFixed(8)));

function uniqueName(ctx: Ctx, base: string) {
  let name = base.replace(/[^A-Za-z0-9_]/g, '');
  if (!/^[A-Za-z_]/.test(name)) name = `v${name}`;
  let n = name, i = 2;
  while (ctx.used.has(n)) n = `${name}_${i++}`;
  ctx.used.add(n);
  return n;
}

// declares the indicator's series once and returns the variable of the wanted plot
function indicatorExpr(ctx: Ctx, cfg: IndicatorConfig, plot: string): string | null {
  const p = cfg.period;
  const key = JSON.stringify({ ...cfg, id: '' });
  const decl = (base: string, expr: string) => {
    const k = `${key}|${base}`;
    let v = ctx.names.get(k);
    if (!v) { v = uniqueName(ctx, base); ctx.names.set(k, v); ctx.lines.push(`${v} = ${expr}`); }
    return v;
  };
  const tuple = (bases: string[], expr: string) => {
    const k = `${key}|tuple`;
    if (!ctx.names.has(k)) {
      const vars = bases.map((b) => uniqueName(ctx, b));
      bases.forEach((b, i) => ctx.names.set(`${key}|${b}`, vars[i]));
      ctx.names.set(k, '1');
      ctx.lines.push(`[${vars.join(', ')}] = ${expr}`);
    }
    return (b: string) => ctx.names.get(`${key}|${b}`)!;
  };
  switch (cfg.type) {
    case 'SMA': return decl(`sma${p}`, `ta.sma(close, ${p})`);
    case 'EMA': return decl(`ema${p}`, `ta.ema(close, ${p})`);
    case 'WMA': return decl(`wma${p}`, `ta.wma(close, ${p})`);
    case 'ZLEMA': return decl(`zlema${p}`, `ta.ema(2 * close - close[${Math.floor((p - 1) / 2)}], ${p})`);
    case 'VWAP': return decl('vwap', 'ta.vwap(hlc3)');
    case 'RSI': return decl(`rsi${p}`, `ta.rsi(close, ${p})`);
    case 'ATR': return decl(`atr${p}`, `ta.atr(${p})`);
    case 'CCI': return decl(`cci${p}`, `ta.cci(hlc3, ${p})`);
    case 'MOMENTUM': return decl(`mom${p}`, `ta.mom(close, ${p})`);
    case 'WILLR': return decl(`wpr${p}`, `ta.wpr(${p})`);
    case 'OBV': return decl('obv', 'ta.obv');
    case 'VOLUME': return 'volume';
    case 'STOCH': {
      const k = decl(`stochK${p}`, `ta.stoch(close, high, low, ${p})`);
      return plot === 'd' ? decl(`stochD${p}`, `ta.sma(${k}, ${cfg.dPeriod ?? 3})`) : k;
    }
    case 'BOLLINGER': {
      const mid = decl(`bbBase${p}`, `ta.sma(close, ${p})`);
      if (plot === 'mid') return mid;
      const dev = decl(`bbDev${p}`, `${fmtNum(cfg.stdDev ?? 2)} * ta.stdev(close, ${p})`);
      return plot === 'up' ? decl(`bbHaut${p}`, `${mid} + ${dev}`) : decl(`bbBas${p}`, `${mid} - ${dev}`);
    }
    case 'DONCHIAN': {
      const up = decl(`dcHaut${p}`, `ta.highest(high, ${p})`);
      const low = decl(`dcBas${p}`, `ta.lowest(low, ${p})`);
      return plot === 'up' ? up : plot === 'low' ? low : decl(`dcBase${p}`, `math.avg(${up}, ${low})`);
    }
    case 'MACD': {
      const v = tuple(['macdLigne', 'macdSignal', 'macdHisto'], `ta.macd(close, ${p}, ${cfg.slowPeriod ?? 26}, ${cfg.signalPeriod ?? 9})`);
      return v(plot === 's' ? 'macdSignal' : plot === 'h' ? 'macdHisto' : 'macdLigne');
    }
    case 'ADX': {
      const v = tuple(['diPlus', 'diMoins', 'adx'], `ta.dmi(${p}, ${p})`);
      return v(plot === 'p' ? 'diPlus' : plot === 'm' ? 'diMoins' : 'adx');
    }
    default:
      return null;
  }
}

function operandExpr(ctx: Ctx, o: Operand): string {
  if (o.kind === 'price') return o.field;
  if (o.kind === 'value') return fmtNum(o.value);
  const e = indicatorExpr(ctx, o.cfg, o.plot);
  if (e) return e;
  ctx.missing.add(indicatorTitle(o.cfg));
  return 'na';
}

function conditionExpr(ctx: Ctx, c: Condition): string {
  const a = operandExpr(ctx, c.left);
  switch (c.op) {
    case 'crosses_above': return `ta.crossover(${a}, ${operandExpr(ctx, c.right)})`;
    case 'crosses_below': return `ta.crossunder(${a}, ${operandExpr(ctx, c.right)})`;
    case 'greater': return `${a} > ${operandExpr(ctx, c.right)}`;
    case 'less': return `${a} < ${operandExpr(ctx, c.right)}`;
    case 'rising': return `${a} > ${a}[1]`;
    case 'falling': return `${a} < ${a}[1]`;
  }
}

function groupExpr(ctx: Ctx, g: ConditionGroup): string {
  if (!g.conditions.length) return 'false';
  return g.conditions.map((c) => conditionExpr(ctx, c)).join(g.join === 'and' ? ' and ' : ' or ');
}

export type GeneratedCode = { code: string; missing: string[] };

export function rulesToPine(name: string, r: RulesStrategy): GeneratedCode {
  const ctx: Ctx = { lines: [], names: new Map(), used: new Set(), missing: new Set() };
  const conds: string[] = [];
  const cond = (varName: string, g: ConditionGroup, comment: string) => {
    const v = uniqueName(ctx, varName);
    conds.push(`// ${comment}`, `${v} = ${groupExpr(ctx, g)}`);
    return v;
  };
  const longIn = r.longEnabled ? cond('achat', r.longEntry, 'Acheter') : null;
  const longOut = r.longEnabled && r.longExit.conditions.length ? cond('sortieAchat', r.longExit, 'Vendre (sortie de l’achat)') : null;
  const shortIn = r.shortEnabled ? cond('venteDecouvert', r.shortEntry, 'Vendre à découvert') : null;
  const shortOut = r.shortEnabled && r.shortExit.conditions.length ? cond('rachat', r.shortExit, 'Racheter (sortie de la vente)') : null;

  const out: string[] = [
    '//@version=5',
    `strategy("${name.replace(/"/g, "'")}", overlay=true, initial_capital=${fmtNum(r.initialCapital)}, commission_type=strategy.commission.percent, commission_value=${fmtNum(r.commissionPct)}${r.fillOnClose ? ', process_orders_on_close=true' : ''})`,
    '',
    '// ---------- Indicateurs',
    ...ctx.lines,
    '',
    '// ---------- Conditions',
    ...conds,
    '',
    '// ---------- Stop et objectif (fixés à la clôture du signal)',
  ];
  const s = r.stop, t = r.target;
  if (s.kind === 'swing') {
    out.push(`nbBougiesStop = input.int(${s.bars}, "Stop : plus bas / plus haut des N dernières bougies", minval=1)`);
    out.push('stopAchat = ta.lowest(low, nbBougiesStop)', 'stopVente = ta.highest(high, nbBougiesStop)');
  } else if (s.kind === 'percent') {
    out.push(`stopPct = input.float(${fmtNum(s.value)}, "Stop (%)")`, 'stopAchat = close * (1 - stopPct / 100)', 'stopVente = close * (1 + stopPct / 100)');
  } else if (s.kind === 'points') {
    out.push(`stopPoints = input.float(${fmtNum(s.value)}, "Stop (points)")`, 'stopAchat = close - stopPoints', 'stopVente = close + stopPoints');
  } else if (s.kind === 'atr') {
    out.push(`stopAtr = ta.atr(${s.length}) * ${fmtNum(s.mult)}`, 'stopAchat = close - stopAtr', 'stopVente = close + stopAtr');
  } else {
    out.push('stopAchat = float(na)', 'stopVente = float(na)');
  }
  if (t.kind === 'rr') {
    out.push(`rr = input.float(${fmtNum(t.ratio)}, "Ratio risque / rendement", options=[1.0, 2.0, 3.0${[1, 2, 3].includes(t.ratio) ? '' : `, ${fmtNum(t.ratio)}`}])`);
    out.push('objectifAchat = close + rr * (close - stopAchat)', 'objectifVente = close - rr * (stopVente - close)');
  } else if (t.kind === 'percent') {
    out.push(`objectifPct = input.float(${fmtNum(t.value)}, "Objectif (%)")`, 'objectifAchat = close * (1 + objectifPct / 100)', 'objectifVente = close * (1 - objectifPct / 100)');
  } else if (t.kind === 'points') {
    out.push(`objectifPoints = input.float(${fmtNum(t.value)}, "Objectif (points)")`, 'objectifAchat = close + objectifPoints', 'objectifVente = close - objectifPoints');
  } else {
    out.push('objectifAchat = float(na)', 'objectifVente = float(na)');
  }

  out.push('', '// ---------- Money management');
  const z = r.sizing;
  if (z.mode === 'risk') {
    out.push(`risque = input.float(${fmtNum(z.value)}, "Risque par trade (% du capital)")`);
    // without a usable stop distance: 1 unit
    out.push('qteAchat = close - stopAchat > 0 ? strategy.equity * risque / 100 / (close - stopAchat) : 1');
    out.push('qteVente = stopVente - close > 0 ? strategy.equity * risque / 100 / (stopVente - close) : 1');
  } else if (z.mode === 'percent') {
    out.push(`partCapital = input.float(${fmtNum(z.value)}, "Taille (% du capital)")`, 'qteAchat = strategy.equity * partCapital / 100 / close', 'qteVente = qteAchat');
  } else if (z.mode === 'cash') {
    out.push(`montant = input.float(${fmtNum(z.value)}, "Montant par trade")`, 'qteAchat = montant / close', 'qteVente = qteAchat');
  } else {
    out.push(`qteAchat = input.float(${fmtNum(z.value)}, "Quantité")`, 'qteVente = qteAchat');
  }

  out.push('', '// ---------- Ordres');
  const guard = (side: 'long' | 'short') => (r.reverse
    ? (side === 'long' ? ' and strategy.position_size <= 0' : ' and strategy.position_size >= 0')
    : ' and strategy.position_size == 0');
  if (longOut) out.push(`if ${longOut} and strategy.position_size > 0`, '    strategy.close("Achat", comment="Vente")');
  if (shortOut) out.push(`if ${shortOut} and strategy.position_size < 0`, '    strategy.close("Vente", comment="Rachat")');
  const both = longIn && shortIn ? (side: 'long' | 'short') => (side === 'long' ? ` and not ${shortIn}` : ` and not ${longIn}`) : () => '';
  if (longIn) {
    out.push(`if ${longIn}${both('long')}${guard('long')}`);
    out.push('    strategy.entry("Achat", strategy.long, qty=qteAchat)');
    out.push('    strategy.exit("Sortie achat", "Achat", stop=stopAchat, limit=objectifAchat)');
  }
  if (shortIn) {
    out.push(`if ${shortIn}${both('short')}${guard('short')}`);
    out.push('    strategy.entry("Vente", strategy.short, qty=qteVente)');
    out.push('    strategy.exit("Sortie vente", "Vente", stop=stopVente, limit=objectifVente)');
  }
  const missing = [...ctx.missing];
  if (missing.length) out.unshift(`// ⚠ Sans équivalent ta.* (remplacé par na) : ${missing.join(', ')}`);
  return { code: out.join('\n') + '\n', missing };
}
