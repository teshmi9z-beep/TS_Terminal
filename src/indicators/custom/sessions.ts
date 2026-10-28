import type { Candle } from '../../types';
import type { IndicatorDef, InputDef, PlotBox, PlotLabel } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';

const MAX_DRAWINGS = 500;
// the script evaluates its sessions in GMT+1 (fixed, no daylight saving)
const TZ_OFFSET = 3600;
// box.new's default border color (color.blue)
const BOX_BORDER = '#2196F3';

const SESSIONS = [
  { id: 'a', group: 'Session A', name: 'New York', session: '1300-2200', color: '#ff5d00' },
  { id: 'b', group: 'Session B', name: 'London', session: '0700-1600', color: '#2157f3' },
  { id: 'c', group: 'Session C', name: 'Tokyo', session: '0000-0900', color: '#e91e63' },
];

type Span = { start: number; end: number; days: Set<number> | null };

// Pine session string: "HHMM-HHMM[,HHMM-HHMM][:1234567]" (days: 1 = Sunday)
function parseSession(s: string): Span[] {
  const [spans, days] = s.trim().split(':');
  const daySet = days ? new Set([...days].map(Number)) : null;
  const out: Span[] = [];
  for (const part of spans.split(',')) {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(part.trim());
    if (m) out.push({ start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4], days: daySet });
  }
  return out;
}

// Pine's time(tf, session, "GMT+1") is na outside the session; sessions may wrap past midnight
function inSession(t: number, spans: Span[]): boolean {
  const local = t + TZ_OFFSET;
  const minute = Math.floor((((local % 86400) + 86400) % 86400) / 60);
  const day = new Date(local * 1000).getUTCDay() + 1;
  return spans.some((s) => (!s.days || s.days.has(day)) && (
    s.start < s.end ? minute >= s.start && minute < s.end : s.start === s.end || minute >= s.start || minute < s.end
  ));
}

// session ranges only make sense below the daily timeframe
function isIntraday(candles: Candle[]): boolean {
  const n = candles.length;
  if (n < 2) return false;
  const deltas: number[] = [];
  for (let i = Math.max(1, n - 50); i < n; i++) deltas.push(candles[i].time - candles[i - 1].time);
  deltas.sort((a, b) => a - b);
  return deltas[deltas.length >> 1] < 86400;
}

// one line per session, as in the script (inline = 'sesa'...)
const sessionInputs: InputDef[] = SESSIONS.flatMap((s) => {
  const at = { group: s.group, inline: `ses${s.id}` };
  return [
    { key: `show_${s.id}`, label: '', default: true, kind: 'bool' as const, ...at },
    { key: `txt_${s.id}`, label: '', default: s.name, kind: 'string' as const, ...at },
    { key: `ses_${s.id}`, label: '', default: s.session, kind: 'session' as const, tooltip: 'Horaires en GMT+1', ...at },
    { key: `css_${s.id}`, label: '', default: s.color, kind: 'color' as const, ...at },
  ];
});

// Port of the Pine Script v5 indicator "Sessions": one dotted box per trading
// session (high / low range), with the session name above it.
export const SESSIONS_IND: IndicatorDef = {
  type: 'SESSIONS',
  label: 'Sessions (New York / Londres / Tokyo)',
  short: 'Sessions',
  category: 'Personnalises',
  overlay: true,
  description: 'Boîtes des séances de trading avec leur plus haut / plus bas (unités intraday)',
  defaults: { period: 0, color: '#ff5d00' },
  inputs: [
    ...sessionInputs,
    { key: 'bgTransp', label: 'Range Area Transparency', default: 90, min: 0, max: 100, group: 'Ranges Settings' },
    { key: 'showTxt', label: 'Range Label', default: true, kind: 'bool', group: 'Ranges Settings' },
  ],
  styles: [],
  params: () => '',
  compute(candles, cfg) {
    const boxes: PlotBox[] = [];
    const labels: PlotLabel[] = [];
    if (isIntraday(candles)) {
      const transp = inputOf(cfg, SESSIONS_IND, 'bgTransp');
      const showTxt = boolInput(cfg, SESSIONS_IND, 'showTxt');
      for (const s of SESSIONS) {
        if (!boolInput(cfg, SESSIONS_IND, `show_${s.id}`)) continue;
        const spans = parseSession(stringInput(cfg, SESSIONS_IND, `ses_${s.id}`));
        const name = stringInput(cfg, SESSIONS_IND, `txt_${s.id}`);
        const color = stringInput(cfg, SESSIONS_IND, `css_${s.id}`);
        let box: PlotBox | null = null;
        let label: PlotLabel | null = null;
        let start = 0;
        let prevIn = false;
        for (const c of candles) {
          const isIn = spans.length > 0 && inSession(c.time, spans);
          if (isIn && !prevIn) {
            // session start: new box (and label) on this bar
            start = c.time;
            box = {
              left: c.time, right: c.time, top: c.high, bottom: c.low,
              fill: withTransparency(color, transp), border: BOX_BORDER, borderWidth: 1, borderStyle: 'dotted',
            };
            boxes.push(box);
            label = showTxt ? { time: c.time, price: c.high, text: name, color, style: 'down' } : null;
            if (label) labels.push(label);
          } else if (isIn && box) {
            box.top = Math.max(box.top, c.high);
            box.bottom = Math.min(box.bottom, c.low);
            box.right = c.time;
            if (label) { label.time = Math.floor((start + c.time) / 2); label.price = box.top; }
          }
          prevIn = isIn;
        }
      }
    }
    // max_boxes_count / max_labels_count: the oldest drawings are removed first
    boxes.sort((a, b) => a.left - b.left);
    labels.sort((a, b) => a.time - b.time);
    return [
      { key: 'boxes', name: 'Sessions', color: BOX_BORDER, kind: 'boxes', data: [], boxes: boxes.slice(-MAX_DRAWINGS) },
      { key: 'labels', name: 'Noms', color: BOX_BORDER, kind: 'labels', data: [], labels: labels.slice(-MAX_DRAWINGS) },
    ];
  },
};
