import type { BuiltinIndicatorType, IndicatorConfig } from '../types';
import { INDICATORS } from '../indicators/registry';
import { SPE_TF_LABEL } from '../indicators/custom/stochPriceEnvelope';

// The indicators a lab robot reads, set as the robot uses them, to be drawn next to it on
// its chart: the entry signal's in full colours, the filter's paler. Robot settings with
// no indicator of the platform behind them (Choppiness, Kaufman efficiency, the higher
// unit's ZLEMA trend, waking volatility) add nothing.

// both: the entry's indicator is also the filter's (the same envelope)
export type RobotPart = { cfg: Omit<IndicatorConfig, 'id'>; role: 'entry' | 'filter' | 'both'; label: string };

const SR_D: Record<string, number> = { 14: 3, 50: 10, 200: 200 };
const FADED = { p99: '#FF525288', p01: '#00E67688', mid: '#FF980044', sig: '#FF9800AA' };
const THIN = { p99: 1, p01: 1, mid: 1, sig: 1 };

function base(type: BuiltinIndicatorType, over: Partial<IndicatorConfig> = {}): Omit<IndicatorConfig, 'id'> {
  const def = INDICATORS[type];
  return { type, period: def.defaults.period, color: def.defaults.color, overlay: def.overlay, visible: true, ...over };
}

// the Stoch Price Envelope k as the lab computes it (smoothing 3, signal over k bars), its
// outer lines at `edge` % (1 / 99 by default), on the chart's unit or a higher one
function envelope(k: number, role: RobotPart['role'], robot: string, tf?: string, edge = 1): RobotPart {
  const unit = tf ? SPE_TF_LABEL[tf] : undefined;
  return {
    role, label: `Stoch Price Envelope ${k}${unit ? ` en ${unit.toLowerCase()}` : ''}`,
    cfg: base('STOCH_ENV', {
      robotPart: robot,
      inputs: { k, smoothK: 3, d: k, high: 100 - edge, low: edge, ...(unit ? { tf: unit } : {}) },
      ...(role === 'filter' ? { plotColors: { ...FADED }, plotWidths: { ...THIN } } : {}),
    }),
  };
}

const zlema = (p: number, role: RobotPart['role'], robot: string, color?: string): RobotPart =>
  ({ role, label: `ZLEMA ${p}`, cfg: base('ZLEMA', { robotPart: robot, period: p, ...(color ? { color } : {}) }) });
const tsh = (maSrc: string, len: number, role: RobotPart['role'], robot: string): RobotPart =>
  ({ role, label: `Tsh_Arrow ${maSrc} ${len}`, cfg: base('TSH_ARROW', { robotPart: robot, inputs: { maSrc, len } }) });
const sessions = (robot: string): RobotPart => ({ role: 'filter', label: 'Sessions Londres / New York', cfg: base('SESSIONS', { robotPart: robot }) });

function signalParts(id: string, robot: string): RobotPart[] {
  let m: RegExpExecArray | null;
  if ((m = /^spe_(?:rev|sig|mid|break)_(\d+)/.exec(id))) return [envelope(Number(m[1]), 'entry', robot)];
  if ((m = /^env_rev(\d+)_(\d+)$/.exec(id))) return [envelope(Number(m[2]), 'entry', robot, undefined, Number(m[1]))];
  if ((m = /^env_rrv_(\d+)$/.exec(id))) return [envelope(Number(m[1]), 'entry', robot, undefined, 15)];
  if ((m = /^env_kx_(\d+)$/.exec(id))) {
    const k = Number(m[1]);
    return [envelope(k, 'entry', robot), {
      role: 'entry', label: `Stochastique ${k} (20 / 80)`,
      cfg: base('STO_RSI', { robotPart: robot, inputs: { lengthK: k, lengthD: k, smoothK: 3, voirRsi: false } }),
    }];
  }
  if ((m = /^env_\w+_(\d+)$/.exec(id))) return [envelope(Number(m[1]), 'entry', robot)];
  if ((m = /^zl_x_(\d+)_(\d+)$/.exec(id))) return [zlema(Number(m[1]), 'entry', robot, '#2962ff'), zlema(Number(m[2]), 'entry', robot, '#e040fb')];
  if ((m = /^zl_(?:cross|turn)_(\d+)$/.exec(id))) return [zlema(Number(m[1]), 'entry', robot)];
  if ((m = /^tsh_\w+?_(WMA|EMA)(\d+)$/.exec(id))) return [tsh(m[1], Number(m[2]), 'entry', robot)];
  if ((m = /^sr_(?:kd|ext)_(\d+)$/.exec(id))) {
    return [{ role: 'entry', label: `Sto+RSI ${m[1]}/${SR_D[m[1]]}`, cfg: base('STO_RSI', { robotPart: robot, inputs: { lengthK: Number(m[1]), lengthD: SR_D[m[1]], smoothK: 3, voirRsi: false } }) }];
  }
  if (id === 'sr_rsi') return [{ role: 'entry', label: 'RSI 14 (30 / 70)', cfg: base('RSI', { robotPart: robot }) }];
  if ((m = /^ha_lr_(\d+)$/.exec(id))) return [{ role: 'entry', label: `HA régression linéaire ${m[1]}`, cfg: base('HA_CANDLES', { robotPart: robot, inputs: { candleType: 'Linear Regression', lrcLength: Number(m[1]) } }) }];
  if (id === 'ha_ha') return [{ role: 'entry', label: 'Heikin Ashi', cfg: base('HA_CANDLES', { robotPart: robot, inputs: { candleType: 'Heikin Ashi' } }) }];
  if (id === 'fvg_retest') return [{ role: 'entry', label: 'Imbalance', cfg: base('IMBALANCE', { robotPart: robot }) }];
  if ((m = /^hr_(\d+)_1h_/.exec(id))) return [{ role: 'entry', label: `Range horaire de ${m[1]} h`, cfg: base('HOUR_RANGE', { robotPart: robot, inputs: { targetHour: Number(m[1]) } }) }];
  return [];
}

function filterParts(id: string, robot: string): RobotPart[] {
  let m: RegExpExecArray | null;
  if ((m = /^b_[a-z]+_(\d+)$/.exec(id))) return [envelope(Number(m[1]), 'filter', robot)];
  if ((m = /^(s_)?h(\d[hdw])_[a-z]+_(\d+)$/.exec(id))) {
    return [envelope(Number(m[3]), 'filter', robot, m[2]), ...(m[1] ? [sessions(robot)] : [])];
  }
  if ((m = /^stairs_(\d+)_\d+$/.exec(id))) return [envelope(Number(m[1]), 'filter', robot)];
  // the higher unit's ZLEMA trend has no indicator (htf4_zl200 keeps the chart's ZLEMA 200)
  if (/^htf\d_zl(20|50)$/.test(id)) return [];
  const out: RobotPart[] = [];
  if (/stairs/.test(id)) out.push(envelope(200, 'filter', robot));
  if ((m = /(?:^|_)zl(\d+)$/.exec(id))) out.push(zlema(Number(m[1]), 'filter', robot, '#9c27b0'));
  if ((m = /^adx(\d+)/.exec(id))) out.push({ role: 'filter', label: `ADX 14 (seuil ${m[1]})`, cfg: base('ADX', { robotPart: robot, levels: [Number(m[1])] }) });
  if (/(?:^|_)tsh(?:_|$)/.test(id)) out.push(tsh('WMA', 20, 'filter', robot));
  if (/^session/.test(id)) out.push(sessions(robot));
  return out;
}

// what a robot's chart shows beside the robot itself; an indicator the entry already
// draws (the same envelope, the same SuperTrend) isn't drawn twice
export function robotParts(r: { id: string; signal: string; filter: string }): RobotPart[] {
  const key = (p: RobotPart) => p.cfg.type === 'STOCH_ENV'
    ? `STOCH_ENV ${p.cfg.inputs?.k} ${p.cfg.inputs?.tf ?? ''}`
    : `${p.cfg.type} ${p.cfg.period} ${JSON.stringify(p.cfg.inputs ?? {})}`;
  const out = new Map<string, RobotPart>();
  for (const p of [...signalParts(r.signal, r.id), ...filterParts(r.filter, r.id)]) {
    const had = out.get(key(p));
    if (!had) out.set(key(p), p);
    else if (had.role !== p.role) had.role = 'both';
  }
  return [...out.values()];
}

export const ROLE_LABEL: Record<RobotPart['role'], string> = { entry: 'entrée', filter: 'filtre', both: 'entrée et filtre' };
