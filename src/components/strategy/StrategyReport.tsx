import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createChart, ColorType, LineSeries, AreaSeries, HistogramSeries, LineStyle,
  type IChartApi, type UTCTimestamp,
} from 'lightweight-charts';
import { useStore } from '../../store/store';
import { useChartUi } from '../../store/chartUi';
import { calendar, computeStats, pnlByPeriod, type Period, type Stats, type TradeFilter } from '../../strategy/stats';
import type { BacktestResult, Trade } from '../../strategy/types';
import { chartColors, isDailyTf, timeFormatters } from '../chartUtils';
import { runBacktest, focusChartOn, isTesterRobot } from './backtestActions';
import { ROBOT } from '../../robots/robotIndicator';
import type { Timeframe } from '../../types';
import { zoneOffsetSec } from '../../data/timeZone';
import { LOCALE, LANG } from '../../i18n/lang';

type View = 'dashboard' | 'trades' | 'calendar' | 'equity';

const VIEWS: { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Tableau de bord' },
  { id: 'trades', label: 'Liste des positions clôturées' },
  { id: 'calendar', label: 'Performance calendaire' },
  { id: 'equity', label: 'Courbe de capital' },
];
const FILTERS: { id: TradeFilter; label: string }[] = [
  { id: 'all', label: 'Tous les trades' },
  { id: 'long', label: 'Positions acheteuses' },
  { id: 'short', label: 'Positions vendeuses' },
];
const BARS = [1000, 2000, 5000, 10000, 20000];
const MONTHS = LANG === 'en' ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] : ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const GREEN = '#3cb043';
const RED = '#e03c3c';

const num = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v: number, cur: string) => `${num(v)}${cur ? ` ${cur}` : ''}`;
const pct = (v: number, d = 2) => `${v > 0 ? '+' : ''}${num(v, d)} %`;

function useDateFmt(tf: string) {
  const timeZone = useStore((s) => s.timeZone);
  const daily = isDailyTf(tf as Timeframe);
  return (t: number, long = false) => {
    const d = new Date((t + (daily ? 0 : zoneOffsetSec(timeZone, t))) * 1000);
    const date = d.toLocaleDateString(LOCALE, { day: 'numeric', month: long ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' });
    return daily || long ? date : `${date} ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}`;
  };
}

// ---------------------------------------------------------------- dashboard widgets

function Card({ title, area, className = '', children }: { title: string; area: string; className?: string; children: ReactNode }) {
  return (
    <div className={`rp-card ${className}`} style={{ gridArea: area }}>
      <div className="rp-card-title">{title}</div>
      <div className="rp-card-body">{children}</div>
    </div>
  );
}

function Donut({ part, total, text, color }: { part: number; total: number; text: string; color: string }) {
  const r = 44, c = 2 * Math.PI * r;
  const f = total > 0 ? Math.max(0, Math.min(1, part / total)) : 0;
  return (
    <svg viewBox="0 0 120 120" className="rp-donut">
      <circle cx="60" cy="60" r={r} fill="none" stroke={RED} strokeWidth="18" />
      <circle
        cx="60" cy="60" r={r} fill="none" stroke={GREEN} strokeWidth="18"
        strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 60 60)"
      />
      <text x="60" y="60" textAnchor="middle" dominantBaseline="central" fontSize="17" fill={color}>{text}</text>
    </svg>
  );
}

function AvgBars({ s, cur }: { s: Stats; cur: string }) {
  const H = 300, top = 22, bottom = 22;
  const maxW = Math.max(0, s.maxWin), maxL = Math.abs(Math.min(0, s.maxLoss));
  const span = maxW + maxL || 1;
  const h = H - top - bottom;
  const y0 = top + (maxW / span) * h;
  const y = (v: number) => y0 - (v / span) * h;
  return (
    <svg viewBox={`0 0 220 ${H}`} className="rp-avgbars" preserveAspectRatio="xMidYMid meet">
      <text x="80" y="14" textAnchor="middle" fontSize="10" fill={GREEN}>Gain max : {money(s.maxWin, cur)}</text>
      <rect x="60" y={y(maxW)} width="40" height={y0 - y(maxW)} fill="#8fd694" stroke={GREEN} />
      <rect x="60" y={y(s.avgWin)} width="40" height={Math.max(2, y0 - y(s.avgWin))} fill={GREEN} />
      {/* kept clear of the "Gain max" label */}
      <text x="54" y={Math.max(top + 22, y(s.avgWin)) - 12} textAnchor="end" fontSize="10" fill={GREEN}>Moyen</text>
      <text x="54" y={Math.max(top + 22, y(s.avgWin))} textAnchor="end" fontSize="10" fill={GREEN}>{money(s.avgWin, cur)}</text>
      <rect x="120" y={y0} width="40" height={y(s.maxLoss) - y0} fill="#ef9a9a" stroke={RED} />
      <rect x="120" y={y0} width="40" height={Math.max(2, y(s.avgLoss) - y0)} fill={RED} />
      <text x="166" y={Math.min(H - bottom - 14, y(s.avgLoss)) - 2} fontSize="10" fill={RED}>Moyenne</text>
      <text x="166" y={Math.min(H - bottom - 14, y(s.avgLoss)) + 10} fontSize="10" fill={RED}>{money(s.avgLoss, cur)}</text>
      <text x="140" y={H - 6} textAnchor="middle" fontSize="10" fill={RED}>Perte max : {money(s.maxLoss, cur)}</text>
    </svg>
  );
}

function HalfGauge({ value }: { value: number }) {
  const f = Math.max(0, Math.min(1, value / 100));
  const r = 70, cx = 90, cy = 88;
  const end = Math.PI * (1 - f);
  const arc = (a0: number, a1: number) => `M ${cx + r * Math.cos(a0)} ${cy - r * Math.sin(a0)} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(a1)} ${cy - r * Math.sin(a1)}`;
  return (
    <svg viewBox="0 0 180 100" className="rp-gauge">
      <path d={arc(Math.PI, 0)} fill="none" stroke="var(--bg-hover2)" strokeWidth="26" />
      {f > 0 && <path d={arc(Math.PI, end)} fill="none" stroke="#6ea8fe" strokeWidth="26" />}
      <text x={cx} y={cy - 4} textAnchor="middle" fontSize="20" fill="var(--text-bright)">{num(value)} %</text>
    </svg>
  );
}

function ClockGauge({ value }: { value: number }) {
  return (
    <svg viewBox="0 0 120 120" className="rp-clock">
      <circle cx="60" cy="60" r="52" fill="none" stroke="#2f7fd1" strokeWidth="8" />
      <circle cx="60" cy="60" r="44" fill="var(--bg-hover)" />
      <text x="60" y="36" textAnchor="middle" fontSize="15" fill="var(--text-faint)">24</text>
      <path d="M60 60 L60 42 M60 60 L74 52" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" />
      <text x="60" y="86" textAnchor="middle" fontSize="20" fill={GREEN}>{num(value)}</text>
    </svg>
  );
}

// the period a bar of "Performance brute" covers (periods are cut in UTC)
const WEEKDAYS = LANG === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
function periodLabel(t: number, p: Period): string {
  const d = new Date(t * 1000);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (p === 'month') return `${cap(MONTHS[d.getUTCMonth()])} ${d.getUTCFullYear()}`;
  if (p === 'week') return `Semaine du ${date}`;
  return `${cap(WEEKDAYS[d.getUTCDay()])} ${date}`;
}

function PerfChart({ trades, cur }: { trades: Trade[]; cur: string }) {
  const [period, setPeriod] = useState<Period>('day');
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // the bar under the mouse and where the mouse is
  const [hover, setHover] = useState<{ i: number; mx: number; my: number } | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const data = useMemo(() => pnlByPeriod(trades, period), [trades, period]);
  useEffect(() => setHover(null), [data]);
  const { w, h } = size;
  const L = 6, R = 52, T = 10, B = 18;
  const pw = Math.max(10, w - L - R), ph = Math.max(10, h - T - B);
  const t0 = data[0]?.time ?? 0, t1 = data[data.length - 1]?.time ?? 1;
  const vals = data.map((d) => d.value);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const y = (v: number) => T + ((hi - v) / span) * ph;
  const x = (t: number) => L + (t1 > t0 ? ((t - t0) / (t1 - t0)) * (pw - 6) : pw / 2);
  const bw = Math.max(1, Math.min(8, (pw / Math.max(1, data.length)) * 0.7));
  const ticks = [hi, 0, lo].filter((v, i, a) => a.indexOf(v) === i);
  const last = data[data.length - 1];
  // the nearest bar to the mouse, within a few pixels of the thin bars
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, dist = Infinity;
    for (let i = 0; i < data.length; i++) { const d = Math.abs(x(data[i].time) - mx); if (d < dist) { dist = d; best = i; } }
    setHover(best >= 0 && dist <= Math.max(6, bw) && mx <= L + pw ? { i: best, mx, my } : null);
  };
  const bar = hover ? data[hover.i] : null;
  // to the cent: a break-even exit's few fees show as 0,00, not -0,00
  const signed = (v: number) => { const c = Math.round(v * 100) / 100 || 0; return `${c > 0 ? '+' : ''}${money(c, cur)}`; };
  const tone = (v: number) => (Math.round(v * 100) >= 0 ? 'pos' : 'neg');
  return (
    <div className="rp-perf">
      <select className="rp-perf-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
        <option value="day">jour</option><option value="week">semaine</option><option value="month">mois</option>
      </select>
      <div className="rp-perf-chart" ref={wrap}>
        {w > 0 && (
          <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} stroke="var(--border)" />
                <text x={L + pw + 4} y={y(v)} dominantBaseline="middle" fontSize="10" fill="var(--text-muted)">{num(v, 0)}</text>
              </g>
            ))}
            <line x1={L} x2={L + pw} y1={y(0)} y2={y(0)} stroke="var(--text-faint)" />
            {bar && <rect x={x(bar.time) - Math.max(4, bw)} width={2 * Math.max(4, bw)} y={T} height={ph} fill="var(--bg-hover)" />}
            {data.map((d, i) => (
              <rect key={d.time} x={x(d.time) - bw / 2} width={bw} y={Math.min(y(d.value), y(0))} height={Math.max(1, Math.abs(y(d.value) - y(0)))}
                fill={d.value >= 0 ? GREEN : RED} opacity={hover && hover.i !== i ? 0.45 : 1} />
            ))}
            {last && (
              <g>
                <rect x={L + pw + 1} y={y(last.value) - 8} width={R - 2} height={16} fill="#f0b90b" rx={2} />
                <text x={L + pw + 4} y={y(last.value)} dominantBaseline="middle" fontSize="10" fill="#131722">{num(last.value, 1)}</text>
              </g>
            )}
            {!data.length && <text x={w / 2} y={h / 2} textAnchor="middle" fontSize="12" fill="var(--text-faint)">Aucun trade clôturé</text>}
          </svg>
        )}
        {bar && hover && (
          <div className="rp-perf-tip" style={{
            left: hover.mx > w / 2 ? undefined : hover.mx + 14, right: hover.mx > w / 2 ? w - hover.mx + 14 : undefined,
            top: Math.min(Math.max(4, hover.my - 20), Math.max(4, h - 150)),
          }}>
            <div className="rp-perf-tip-head">{periodLabel(bar.time, period)}</div>
            <div className="rp-perf-tip-row"><span>Résultat</span><b className={tone(bar.value)}>{signed(bar.value)}</b></div>
            <div className="rp-perf-tip-row"><span>Trades clôturés</span><b>{bar.trades}</b></div>
            <div className="rp-perf-tip-row"><span>Gagnants / perdants</span><b>{bar.wins} / {bar.losses}</b></div>
            <div className="rp-perf-tip-row"><span>Meilleur trade</span><b className={tone(bar.best)}>{signed(bar.best)}</b></div>
            <div className="rp-perf-tip-row"><span>Pire trade</span><b className={tone(bar.worst)}>{signed(bar.worst)}</b></div>
            <div className="rp-perf-tip-row total"><span>Cumul depuis le début</span><b className={tone(bar.total)}>{signed(bar.total)}</b></div>
          </div>
        )}
      </div>
      <div className="rp-perf-unit">Gains : {cur || 'devise'}</div>
    </div>
  );
}

// also the replay sessions' statistics (ReplayTradingPanel)
export function Dashboard({ s, cur }: { s: Stats; cur: string }) {
  const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  return (
    <div className="rp-dash">
      <Card title="Gain" area="gain" className={`rp-tint ${sign(s.netProfit)}`}>
        <div className={`rp-big ${sign(s.netProfit)}`}>{money(s.netProfit, cur)} <small>({pct(s.netPct)})</small></div>
      </Card>
      <Card title="% Trades gagnants" area="win">
        <Donut part={s.wins} total={s.wins + s.losses} text={`${num(s.winRate)} %`} color={s.winRate >= 50 ? GREEN : RED} />
      </Card>
      <Card title="Ratio Gains/Pertes" area="ratio">
        <Donut part={s.grossProfit} total={s.grossProfit - s.grossLoss} text={Number.isFinite(s.profitFactor) ? num(s.profitFactor) : '∞'} color={s.profitFactor >= 1 ? GREEN : RED} />
      </Card>
      <Card title="Gain moyen" area="avg">
        <div className={`rp-avg ${sign(s.avgTrade)}`}>{money(s.avgTrade, cur)} <span>par trade</span></div>
        <AvgBars s={s} cur={cur} />
      </Card>
      <Card title="Répartition des trades" area="rep">
        <div className="rp-rep">
          <div><span>Total :</span><b>{s.total}</b></div>
          <div className="pos"><span>Gagnantes :</span><b>{s.wins}</b></div>
          <div><span>Neutre :</span><b>{s.neutral}</b></div>
          <div className="neg"><span>Perdantes :</span><b>{s.losses}</b></div>
        </div>
      </Card>
      <div className="rp-stack" style={{ gridArea: 'brut' }}>
        <Card title="Gain brut" area="auto" className="rp-tint pos"><div className="rp-mid pos">{money(s.grossProfit, cur)}</div></Card>
        <Card title="Perte brute" area="auto" className="rp-tint neg"><div className="rp-mid neg">{money(s.grossLoss, cur)}</div></Card>
      </div>
      <Card title="Drawdown max" area="dd"><div className="rp-mid neg">{money(s.maxDrawdown, cur)}</div></Card>
      <Card title="Runup max" area="ru"><div className="rp-mid pos">{money(s.maxRunup, cur)}</div></Card>
      <Card title="Temps dans le marché" area="time"><HalfGauge value={s.timeInMarket} /></Card>
      <Card title="Moy ordres exec/jour" area="orders"><ClockGauge value={s.ordersPerDay} /></Card>
      <Card title="Performance brute" area="perf"><PerfChart trades={s.trades} cur={cur} /></Card>
    </div>
  );
}

// ---------------------------------------------------------------- closed positions

type SortKey = 'entryTime' | 'exitTime' | 'side' | 'bars' | 'pnl' | 'pricePct' | 'mfe' | 'mae' | 'unitGain';

function TradesList({ res, trades, cur, precision }: { res: BacktestResult; trades: Trade[]; cur: string; precision: number }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'entryTime', dir: -1 });
  const fmt = useDateFmt(res.timeframe);
  const symbol = useStore((s) => s.symbol.ticker);
  const tf = useStore((s) => s.timeframe);
  const rows = useMemo(() => [...trades].sort((a, b) => {
    const va = a[sort.key], vb = b[sort.key];
    return (typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number)) * sort.dir;
  }), [trades, sort]);
  const head = (key: SortKey, label: string) => (
    <th onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : -1 })}>
      {sort.key === key ? (sort.dir === -1 ? '▼ ' : '▲ ') : ''}{label}
    </th>
  );
  const cls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const onChart = res.ticker === symbol && res.timeframe === tf;
  return (
    <div className="rp-table-wrap">
      <table className="rp-table">
        <thead>
          <tr>
            {head('entryTime', 'Date d’entrée')}{head('exitTime', 'Date de sortie')}{head('side', 'Type')}<th>Signal</th>{head('bars', 'Nb barres')}
            {head('pnl', 'Perf abs')}{head('pricePct', 'Perf relat (%)')}{head('mfe', 'MFE')}{head('mae', 'MAE')}{head('unitGain', 'Gain unitaire')}
            <th>Entrée → sortie</th><th>Qté</th><th>Sortie</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={onChart ? 'clickable' : ''} title={onChart ? 'Afficher ce trade sur le graphique' : undefined} onClick={() => { if (onChart) void focusChartOn(t.entryTime, t.exitTime); }}>
              <td>{fmt(t.entryTime)}</td>
              <td>{fmt(t.exitTime)}</td>
              <td className={t.side === 'long' ? 'rp-long' : 'rp-short'}>{t.side === 'long' ? 'Long' : 'Court'}</td>
              <td className="muted">{t.entryLabel}</td>
              <td className="num">{t.bars}</td>
              <td className={`num tint ${cls(t.pnl)}`}>{money(t.pnl, cur)}</td>
              <td className={`num ${cls(t.pricePct)}`}>{pct(t.pricePct)}</td>
              <td className="num">{money(t.mfe, cur)}</td>
              <td className="num">{money(t.mae, cur)}</td>
              <td className={`num tint ${cls(t.unitGain)}`}>{t.unitGain > 0 ? '+' : ''}{num(t.unitGain, precision)}</td>
              <td className="num muted">{num(t.entryPrice, precision)} → {num(t.exitPrice, precision)}</td>
              <td className="num muted">{num(t.qty, t.qty >= 100 ? 0 : 4)}</td>
              <td className="muted">{t.exitReason === 'stop' ? 'Stop' : t.exitReason === 'target' ? 'Objectif' : t.exitReason === 'reverse' ? 'Retournement' : t.exitLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="side-empty">Aucune position clôturée.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- calendar

function CalendarView({ res, trades }: { res: BacktestResult; trades: Trade[] }) {
  const rows = useMemo(() => calendar(res, trades), [res, trades]);
  const bg = (v: number | null) => {
    if (v == null) return undefined;
    const a = Math.min(0.75, 0.18 + Math.abs(v) * 0.6);
    return v >= 0 ? `rgba(60, 176, 67, ${a})` : `rgba(224, 60, 60, ${a})`;
  };
  return (
    <div className="rp-table-wrap">
      <table className="rp-cal">
        <thead>
          <tr><th>année</th>{MONTHS.map((m) => <th key={m}>{m}</th>)}<th>Total</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.year}>
              <th>{r.year}</th>
              {r.months.map((v, i) => <td key={i} style={{ background: bg(v) }} className={v == null ? '' : v >= 0 ? 'pos' : 'neg'}>{v == null ? '' : pct(v)}</td>)}
              <td className={r.total >= 0 ? 'pos' : 'neg'} style={{ background: bg(r.months.some((v) => v != null) ? r.total : null) }}>
                {r.months.some((v) => v != null) ? pct(r.total) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- equity curve + positions

function EquityView({ res }: { res: BacktestResult }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const uiTheme = useStore((s) => s.uiTheme);
  const bg = useStore((s) => s.chartSettings.background);
  const grid = useStore((s) => s.chartSettings.gridColor);
  const timeZone = useStore((s) => s.timeZone);

  useEffect(() => {
    const el = ref.current!;
    const colors = chartColors(uiTheme);
    const f = timeFormatters(timeZone, res.timeframe as Timeframe);
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: colors.text, fontSize: 11, panes: { separatorColor: colors.separator }, attributionLogo: false },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: colors.border },
      // the whole backtest fits in the panel
      timeScale: { borderColor: colors.border, timeVisible: !isDailyTf(res.timeframe as Timeframe), tickMarkFormatter: f.tickMarkFormatter, minBarSpacing: 0.02 },
      localization: { locale: LOCALE, timeFormatter: f.timeFormatter },
      width: el.clientWidth, height: el.clientHeight,
    });
    chartRef.current = chart;
    const t = (i: number) => res.candles[i].time as UTCTimestamp;
    const area = chart.addSeries(AreaSeries, {
      lineVisible: false, topColor: 'rgba(41, 98, 255, 0.28)', bottomColor: 'rgba(41, 98, 255, 0.04)',
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    }, 0);
    area.setData(res.equity.map((v, i) => ({ time: t(i), value: v })));
    const line = chart.addSeries(LineSeries, { lineWidth: 2, priceLineVisible: false, title: res.strategyName }, 0);
    line.setData(res.equity.map((v, i) => ({ time: t(i), value: v, color: res.position[i] > 0 ? '#2962ff' : res.position[i] < 0 ? '#ff9800' : '#787b86' })));
    line.createPriceLine({ price: res.initialCapital, color: colors.text, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' });
    const pos = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, title: 'Positions', base: 0 }, 1);
    pos.setData(res.position.map((p, i) => ({ time: t(i), value: Math.sign(p), color: p > 0 ? '#2962ff' : '#ff9800' })));
    pos.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
    chart.panes()[1]?.setStretchFactor(0.45);
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.resize(el.clientWidth, el.clientHeight));
    ro.observe(el);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; };
  }, [res, uiTheme, bg, grid, timeZone]);

  return <div className="rp-equity" ref={ref} />;
}

// ---------------------------------------------------------------- report

export default function StrategyReport() {
  const bt = useChartUi((s) => s.backtest);
  const strategies = useStore((s) => s.strategies);
  const activeId = useStore((s) => s.activeStrategyId);
  const setActive = useStore((s) => s.setActiveStrategy);
  const setDock = useStore((s) => s.setBottomDock);
  const symbol = useStore((s) => s.symbol);
  const timeframe = useStore((s) => s.timeframe);
  const bars = useStore((s) => s.backtestBars);
  const setBars = useStore((s) => s.setBacktestBars);
  const showOnChart = useStore((s) => s.indicators.some((i) => i.type === 'STRATEGY' && i.strategyId === s.activeStrategyId));
  const setStrategyOnChart = useStore((s) => s.setStrategyOnChart);
  // the chart's robots (the lab's engine) can be tested in place of a strategy
  const indicators = useStore((s) => s.indicators);
  const testerRobot = useStore((s) => s.testerRobot);
  const setTesterRobot = useStore((s) => s.setTesterRobot);
  const robots = useMemo(() => indicators.filter(isTesterRobot), [indicators]);
  const robot = robots.find((r) => r.id === testerRobot);
  const [view, setView] = useState<View>('dashboard');
  const [filter, setFilter] = useState<TradeFilter>('all');
  const [showWarnings, setShowWarnings] = useState(false);
  const doc = strategies.find((d) => d.id === activeId);

  // like TradingView: the report follows the strategy, the symbol and the timeframe (a
  // robot: its settings; from the report, its own market and history)
  const runKey = robot
    ? `robot|${JSON.stringify([robot.inputs, robot.robot])}|${robot.robot ? '' : `${symbol.ticker}|${timeframe}|${bars}`}`
    : `${activeId}|${doc?.updatedAt}|${symbol.ticker}|${timeframe}|${bars}`;
  const robotName = (r: typeof robots[number]) => r.robot?.name ?? `Robot · ${ROBOT.params(r)}`;
  const day = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  useEffect(() => {
    const id = setTimeout(() => { void runBacktest(undefined, { quiet: true }); }, 250);
    return () => clearTimeout(id);
  }, [runKey]);

  const res = bt.result;
  const stats = useMemo(() => (res ? computeStats(res, filter) : null), [res, filter]);
  const fmtDate = useDateFmt(res?.timeframe ?? timeframe);
  const precision = res?.precision ?? 2;

  return (
    <div className="strategy-report">
      <div className="rp-head">
        <select className="rp-view" value={view} onChange={(e) => setView(e.target.value as View)}>
          {VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </select>
        <div className="rp-strategy">
          <div className="rp-name">
            <select
              value={robot ? `robot:${robot.id}` : activeId}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('robot:')) setTesterRobot(v.slice(6));
                else { setTesterRobot(null); setActive(v); }
              }}
            >
              {robots.length > 0 && (
                <optgroup label="Robots du graphique">
                  {robots.map((r) => <option key={r.id} value={`robot:${r.id}`}>{robotName(r)}</option>)}
                </optgroup>
              )}
              <optgroup label="Stratégies">
                {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            </select>
            {!robot && <button className="pl-btn" title="Modifier la stratégie" onClick={() => setDock({ tab: 'editor' })}>✎</button>}
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value as TradeFilter)}>
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        {res && stats && (
          <div className="rp-period">
            <div><span>Début :</span> {fmtDate(stats.startTime, true)} <b>[{money(stats.startEquity, res.currency)}]</b></div>
            <div><span>Actuel :</span> {fmtDate(stats.endTime, true)} <b>[{money(stats.endEquity, res.currency)}]</b></div>
          </div>
        )}
        <div className="rp-spacer" />
        <div className="rp-opts">
          <span className="rp-src">{res ? `${res.ticker} · ${res.timeframe} · ${res.candles.length} barres · ${res.source}` : `${symbol.ticker} · ${timeframe}`}</span>
          {!robot?.robot && (
            <label title="Historique chargé pour le backtest">
              Barres
              <select value={bars} onChange={(e) => setBars(parseInt(e.target.value))}>
                {BARS.map((b) => <option key={b} value={b}>{b.toLocaleString(LOCALE)}</option>)}
              </select>
            </label>
          )}
          {!robot && <label className="se-check"><input type="checkbox" checked={showOnChart} onChange={(e) => setStrategyOnChart(e.target.checked ? activeId : null)} /> sur le graphique</label>}
          <button className="pill-btn" onClick={() => { void runBacktest(); }}>↻ Relancer</button>
        </div>
      </div>

      {robot && (
        <div className="rp-open">
          {robot.type === 'DOW_STRUCTURE'
            ? 'Robot Structure Dow : 1 entrée par configuration, 0,3 % du capital risqué, stop au-delà de la boîte ou de la mèche, sortie au retournement de structure ; capital de départ 10 000 €, frais compris.'
            : robot.type === 'EXPECTED_MOVE'
            ? 'Robot Expected Move (non prouvé) : 1 entrée par signal, 0,3 % du capital risqué, stop 20 % de l’EM, objectif 3 R ou sortie à la clôture cash, seulement quand le VIX est à 20 ou plus ; capital de départ 10 000 €, frais d’un future CME compris.'
            : 'Robot du labo : 3 entrées par signal (fixe, suiveur, paliers 1-2-3 R), 0,3 % du capital risqué par entrée, capital de départ 10 000 €, frais compris.'}
          {robot.robot
            ? ` Même historique que son rapport : réglage jusqu’au ${day(robot.robot.split)}, validation ensuite (jamais utilisée pour le choisir).`
            : ' Sur l’historique du graphique.'}
        </div>
      )}
      {bt.status === 'loading' && <div className="rp-status"><span className="spinner" /> {bt.progress}</div>}
      {bt.status === 'error' && <div className="rp-status bad">✗ {bt.error}</div>}
      {res && res.warnings.length > 0 && (
        <div className="rp-warn">
          <button className="si-more" onClick={() => setShowWarnings(!showWarnings)}>⚠ {res.warnings.length} avertissement(s)</button>
          {showWarnings && res.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      {res && res.openTrade && (
        <div className="rp-open">
          Position ouverte : {res.openTrade.side === 'long' ? 'achat' : 'vente'} depuis le {fmtDate(res.openTrade.entryTime)} à {num(res.openTrade.entryPrice, precision)},
          P&L latent <b className={res.openTrade.pnl >= 0 ? 'pos' : 'neg'}>{money(res.openTrade.pnl, res.currency)}</b>
        </div>
      )}

      {res && stats ? (
        <div className="rp-body">
          {view === 'dashboard' && <Dashboard s={stats} cur={res.currency} />}
          {view === 'trades' && <TradesList res={res} trades={stats.trades} cur={res.currency} precision={precision} />}
          {view === 'calendar' && <CalendarView res={res} trades={stats.trades} />}
          {view === 'equity' && <EquityView res={res} />}
        </div>
      ) : bt.status !== 'loading' && bt.status !== 'error' ? (
        <div className="rp-status">
          Aucun résultat. <button className="pill-btn primary" onClick={() => { void runBacktest(); }}>▶ Lancer le backtest</button>
        </div>
      ) : null}
    </div>
  );
}
