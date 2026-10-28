import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useKept } from './kept';
import { useStore, nextId, YIELD_COLORS, type YieldCurveCfg, type YieldSettings } from '../store/store';
import {
  fetchYields, yieldAt, formatYield, countryName, flagUrl, periodLabel,
  MATURITIES, YIELD_PERIODS, type YieldPeriod, type YieldSnapshot,
} from '../data/yields';
import YieldMap, { type MapPalette } from './YieldMap';
import { GearIcon } from './GearIcon';
import { downloadSvgAsPng } from './worldMap';
import PanelControls from './PanelControls';
import { LANG, LOCALE } from '../i18n/lang';

const REFRESH_MS = 60_000;

// last snapshot, shared so reopening the panel shows data at once
let cache: YieldSnapshot | null = null;

function useYields() {
  const [snap, setSnap] = useState<YieldSnapshot | null>(cache);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    const run = () => fetchYields(ctrl.signal)
      .then((s) => { cache = s; setSnap(s); setError(null); })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    if (!cache || Date.now() - cache.at > REFRESH_MS / 2 || tick > 0) void run();
    const id = setInterval(run, REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [tick]);
  return { snap, error, reload: () => setTick((t) => t + 1) };
}

type Palette = MapPalette & { bg: string; grid: string; cross: string };
const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { bg: '#131722', text: '#d1d4dc', faint: '#787b86', grid: '#434651', cross: '#9598a1', empty: '#2a2e39', stroke: '#131722' },
  light: { bg: '#ffffff', text: '#131722', faint: '#787b86', grid: '#c9cdd6', cross: '#6a6d78', empty: '#e0e3eb', stroke: '#ffffff' },
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

type CurveValues = { cfg: YieldCurveCfg; values: (number | null)[] };

function curveValues(snap: YieldSnapshot | null, curves: YieldCurveCfg[]): CurveValues[] {
  return curves.map((cfg) => ({
    cfg,
    values: MATURITIES.map((m) => (snap ? yieldAt(snap.countries.get(cfg.country), m.key, cfg.period) : null)),
  }));
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

// ---------------------------------------------------------------- chart

type ChartProps = { curves: CurveValues[]; settings: YieldSettings; palette: Palette; snap: YieldSnapshot | null };

const YieldChart = forwardRef<SVGSVGElement, ChartProps>(function YieldChart({ curves, settings, palette, snap }, svgRef) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [legendOpen, setLegendOpen] = useState(true);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = curves.filter((c) => c.cfg.visible);
  const all = shown.flatMap((c) => c.values.filter((v): v is number => v != null));
  const { w, h } = size;
  const L = 46, R = 14, T = 14, B = 26;
  const plotW = Math.max(10, w - L - R), plotH = Math.max(10, h - T - B);
  const lastYears = MATURITIES[MATURITIES.length - 1].years;
  const xOf = (i: number) => L + 8 + (plotW - 16) * (settings.scale === 'even'
    ? i / (MATURITIES.length - 1)
    : MATURITIES[i].years / lastYears);

  let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 5;
  const pad = Math.max(0.05, (hi - lo) * 0.08);
  lo -= pad; hi += pad;
  const step = niceStep(hi - lo, Math.max(3, Math.min(8, Math.floor(plotH / 55))));
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
  const decimals = step >= 1 ? 0 : step >= 0.1 && Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2;
  const yOf = (v: number) => T + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  // TradingView only labels a few maturities when they are spaced by duration
  const labelled = settings.scale === 'even'
    ? MATURITIES.map((_, i) => i).filter((i) => plotW / MATURITIES.length >= 26 || i % 2 === 0)
    : MATURITIES.map((m, i) => (['1M', '5Y', '10Y', '20Y', '30Y'].includes(m.label) ? i : -1)).filter((i) => i >= 0);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0, dist = Infinity;
    MATURITIES.forEach((_, i) => { const d = Math.abs(xOf(i) - x); if (d < dist) { dist = d; best = i; } });
    setHover(best);
  }

  const legendH = legendOpen ? shown.length * 18 : 0;

  return (
    <div className="yc-chart" ref={wrapRef}>
      {w > 0 && h > 0 && (
        <svg
          ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={w} height={h}
          fontFamily={FONT} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        >
          <rect x={0} y={0} width={w} height={h} fill={palette.bg} />
          {MATURITIES.map((m, i) => (
            <line key={m.key} x1={xOf(i)} x2={xOf(i)} y1={T} y2={T + plotH} stroke={palette.grid} strokeDasharray="1 3" />
          ))}
          {ticks.map((v) => (
            <text key={v} x={L - 8} y={yOf(v)} fill={palette.faint} fontSize={11} textAnchor="end" dominantBaseline="middle">
              {v.toFixed(decimals)}%
            </text>
          ))}
          {labelled.map((i) => (
            <text key={i} x={xOf(i)} y={T + plotH + 17} fill={palette.faint} fontSize={11} textAnchor="middle">{MATURITIES[i].label}</text>
          ))}
          {hover != null && (
            <line x1={xOf(hover)} x2={xOf(hover)} y1={T} y2={T + plotH} stroke={palette.cross} strokeDasharray="4 3" />
          )}
          {shown.map(({ cfg, values }) => {
            const pts = values.map((v, i) => (v == null ? null : [xOf(i), yOf(v)] as const)).filter((p) => p != null);
            return (
              <g key={cfg.id}>
                <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={cfg.color} strokeWidth={2} strokeLinejoin="round" />
                {settings.showPoints && pts.map(([x, y]) => <circle key={x} cx={x} cy={y} r={4} fill={cfg.color} />)}
                {hover != null && values[hover] != null && (
                  <circle cx={xOf(hover)} cy={yOf(values[hover]!)} r={6} fill={cfg.color} stroke={palette.bg} strokeWidth={2} />
                )}
              </g>
            );
          })}
          {legendOpen && shown.map(({ cfg, values }, i) => {
            const v = hover != null ? values[hover] : null;
            return (
              <text key={cfg.id} x={L + 12} y={T + 12 + i * 18} fontSize={12} fill={palette.text} dominantBaseline="middle">
                <tspan fill={cfg.color}>● </tspan>
                {countryName(cfg.country, snap)} · {periodLabel(cfg.period)}
                {v != null && <tspan fill={cfg.color} fontWeight={600}>{`  ${formatYield(v)}`}</tspan>}
              </text>
            );
          })}
          {hover != null && (
            <g>
              <rect x={xOf(hover) - 26} y={T + plotH + 4} width={52} height={18} rx={3} fill={palette.text} />
              <text x={xOf(hover)} y={T + plotH + 17} fontSize={11} fill={palette.bg} textAnchor="middle">{MATURITIES[hover].long}</text>
            </g>
          )}
          {!all.length && (
            <text x={w / 2} y={h / 2} fontSize={12} fill={palette.faint} textAnchor="middle">
              {snap ? 'Aucune courbe affichée' : 'Chargement des taux…'}
            </text>
          )}
        </svg>
      )}
      {shown.length > 0 && (
        <button
          className="yc-legend-toggle" style={{ left: L + 10, top: T + legendH + 2 }}
          title={legendOpen ? 'Masquer la légende' : 'Afficher la légende'} onClick={() => setLegendOpen(!legendOpen)}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d={legendOpen ? 'M2 6.5L5 3.5L8 6.5' : 'M2 3.5L5 6.5L8 3.5'} />
          </svg>
        </button>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- country / period picker

function CurvePicker({ snap, title, initial, onPick, onClose }: {
  snap: YieldSnapshot | null;
  title: string;
  initial: { country?: string; period: YieldPeriod };
  onPick: (country: string, period: YieldPeriod) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState<YieldPeriod>(initial.period);
  const countries = useMemo(() => [...(snap?.countries.values() ?? [])]
    .map((c) => ({ code: c.code, name: countryName(c.code, snap), ten: yieldAt(c, '10Y', 'current') }))
    .sort((a, b) => a.name.localeCompare(b.name, LANG)), [snap]);
  const q = query.trim().toLowerCase();
  const list = countries.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="yc-picker">
      <div className="yc-picker-head">
        <span>{title}</span>
        <button className="remove-btn" onClick={onClose}>✕</button>
      </div>
      <div className="yc-picker-periods">
        {YIELD_PERIODS.map((p) => (
          <button key={p.id} className={`ss-chip ${period === p.id ? 'active' : ''}`} onClick={() => setPeriod(p.id)}>{p.label}</button>
        ))}
      </div>
      <input className="yc-picker-search" autoFocus placeholder="Rechercher un pays" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="yc-picker-list">
        {!snap && <div className="side-empty">Chargement des taux…</div>}
        {list.map((c) => (
          <button key={c.code} className={`yc-picker-row ${initial.country === c.code ? 'active' : ''}`} onClick={() => onPick(c.code, period)}>
            <img className="yc-flag" src={flagUrl(c.code)} alt="" />
            <span className="yc-picker-name">{c.name}</span>
            <span className="yc-picker-val">{c.ten != null ? `10 ans ${formatYield(c.ten)}` : ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- panel

const nextColor = (curves: YieldCurveCfg[]) =>
  YIELD_COLORS.find((c) => !curves.some((x) => x.color === c)) ?? YIELD_COLORS[curves.length % YIELD_COLORS.length];

// TradingView's "Courbes de rendement" widget: government yield curves by
// country (now and in the past), their comparison table, and a world map
export default function YieldCurves() {
  const curves = useStore((s) => s.yieldCurves);
  const setCurves = useStore((s) => s.setYieldCurves);
  const settings = useStore((s) => s.yieldSettings);
  const setSettings = useStore((s) => s.setYieldSettings);
  const uiTheme = useStore((s) => s.uiTheme);
  const { snap, error, reload } = useYields();
  const [view, setView] = useKept<'chart' | 'map'>('yields.view', 'chart');
  const [picker, setPicker] = useState<{ edit?: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const chartSvg = useRef<SVGSVGElement>(null);
  const mapSvg = useRef<SVGSVGElement>(null);
  const palette = PALETTES[uiTheme];

  const values = useMemo(() => curveValues(snap, curves), [snap, curves]);

  // per column, the tint of a cell grows with the yield (among the curves shown)
  const tint = (col: number, v: number | null, color: string, visible: boolean) => {
    if (v == null || !visible) return undefined;
    const colValues = values.filter((c) => c.cfg.visible).map((c) => c.values[col]).filter((x): x is number => x != null);
    const min = Math.min(...colValues), max = Math.max(...colValues);
    const t = max > min ? (v - min) / (max - min) : 0.6;
    const alpha = Math.round((0.16 + 0.38 * t) * 255).toString(16).padStart(2, '0');
    return color.slice(0, 7) + alpha;
  };

  const patch = (id: string, p: Partial<YieldCurveCfg>) => setCurves(curves.map((c) => (c.id === id ? { ...c, ...p } : c)));

  function pickFromMap(code: string) {
    const countries = new Set(curves.map((c) => c.country));
    // one country compared with its past: switch it; several countries: add this one
    if (countries.size <= 1 && curves.length) setCurves(curves.map((c) => ({ ...c, country: code })));
    else if (!curves.some((c) => c.country === code && c.period === 'current')) {
      setCurves([...curves, { id: nextId(), country: code, period: 'current', color: nextColor(curves), visible: true }]);
    }
    setView('chart');
  }

  const editing = picker?.edit ? curves.find((c) => c.id === picker.edit) : undefined;
  const updated = snap ? new Date(snap.at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="side-panel yc-panel">
      <div className="yc-title">Courbes de rendement<PanelControls /></div>
      <div className="yc-toolbar">
        <div className="yc-tabs">
          <button className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>Graphique</button>
          <button className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>Carte</button>
        </div>
        <div className="yc-tools">
          <button className="yc-icon-btn" title="Paramètres" onClick={() => setMenuOpen(!menuOpen)}><GearIcon size={16} /></button>
          <button
            className="yc-icon-btn" title="Enregistrer une image"
            onClick={() => {
              const svg = view === 'chart' ? chartSvg.current : mapSvg.current;
              if (svg) downloadSvgAsPng(svg, palette.bg, view === 'chart' ? 'courbes-de-rendement.png' : 'carte-des-taux.png');
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
            </svg>
          </button>
          {menuOpen && (
            <div className="yc-menu" onMouseLeave={() => setMenuOpen(false)}>
              <div className="yc-menu-sub">Espacement des échéances</div>
              <label className="yc-menu-row">
                <input type="radio" checked={settings.scale === 'years'} onChange={() => setSettings({ scale: 'years' })} /> Proportionnel à la durée
              </label>
              <label className="yc-menu-row">
                <input type="radio" checked={settings.scale === 'even'} onChange={() => setSettings({ scale: 'even' })} /> Régulier
              </label>
              <label className="yc-menu-row">
                <input type="checkbox" checked={settings.showPoints} onChange={(e) => setSettings({ showPoints: e.target.checked })} /> Afficher les points
              </label>
              <button className="pill-btn" onClick={() => { reload(); setMenuOpen(false); }}>Actualiser</button>
              <div className="yc-menu-note">
                Taux TradingView (TVC){updated ? `, mis à jour à ${updated}` : ''}. Les courbes passées sont
                déduites de la variation de chaque taux sur la période.
              </div>
            </div>
          )}
        </div>
      </div>
      {error && <div className="yc-error">Taux indisponibles : {error}. <button className="si-more" onClick={reload}>Réessayer</button></div>}

      {view === 'chart' ? (
        <>
          <YieldChart ref={chartSvg} curves={values} settings={settings} palette={palette} snap={snap} />
          <div className={`yc-compare ${settings.tableOpen ? '' : 'closed'}`}>
            <div className="yc-compare-head">
              <span>Comparer les rendements</span>
              <button
                className="yc-icon-btn yc-chevron" title={settings.tableOpen ? 'Réduire' : 'Déplier'}
                onClick={() => setSettings({ tableOpen: !settings.tableOpen })}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d={settings.tableOpen ? 'M3 5.5l4 4 4-4' : 'M3 8.5l4-4 4 4'} />
                </svg>
              </button>
            </div>
            {settings.tableOpen && (
              <>
                <div className="yc-table-wrap">
                  <table className="yc-table">
                    <thead>
                      <tr>
                        <th className="yc-sticky">Pays</th>
                        {MATURITIES.map((m) => <th key={m.key}>{m.label}</th>)}
                        <th className="yc-sticky-r" />
                      </tr>
                    </thead>
                    <tbody>
                      {values.map(({ cfg, values: vals }) => (
                        <tr key={cfg.id} className={cfg.visible ? '' : 'muted'}>
                          <td className="yc-sticky">
                            <div className="yc-country">
                              <button
                                className="yc-check" title={cfg.visible ? 'Masquer' : 'Afficher'}
                                style={{ background: cfg.visible ? cfg.color : 'transparent', borderColor: cfg.color }}
                                onClick={() => patch(cfg.id, { visible: !cfg.visible })}
                              >
                                {cfg.visible && '✓'}
                              </button>
                              <label className="yc-color" title="Couleur" style={{ background: cfg.color }}>
                                <input type="color" value={cfg.color.slice(0, 7)} onChange={(e) => patch(cfg.id, { color: e.target.value })} />
                              </label>
                              <img className="yc-flag" src={flagUrl(cfg.country)} alt="" />
                              <button className="yc-country-name" title="Changer de pays / période" onClick={() => setPicker({ edit: cfg.id })}>
                                {countryName(cfg.country, snap)}
                                <small>{periodLabel(cfg.period)}</small>
                              </button>
                            </div>
                          </td>
                          {vals.map((v, i) => (
                            <td key={MATURITIES[i].key} style={{ background: tint(i, v, cfg.color, cfg.visible) }}>
                              {v != null ? formatYield(v) : '—'}
                            </td>
                          ))}
                          <td className="yc-sticky-r">
                            <button
                              className="pl-btn" title="Dupliquer"
                              onClick={() => setCurves([...curves, { ...cfg, id: nextId(), color: nextColor(curves) }])}
                            >
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
                                <rect x="4.5" y="4.5" width="7" height="7" rx="1" /><path d="M9.5 2.5h-6a1 1 0 00-1 1v6" />
                              </svg>
                            </button>
                            <button className="pl-btn danger" title="Supprimer" onClick={() => setCurves(curves.filter((c) => c.id !== cfg.id))}>✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button className="yc-add" onClick={() => setPicker({})}>
                  <span>＋</span> Ajouter
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <YieldMap ref={mapSvg} snap={snap} palette={palette} onPick={pickFromMap} />
      )}

      {picker && (
        <CurvePicker
          snap={snap}
          title={editing ? 'Modifier la courbe' : 'Ajouter une courbe'}
          initial={editing ? { country: editing.country, period: editing.period } : { period: 'current' }}
          onClose={() => setPicker(null)}
          onPick={(country, period) => {
            if (editing) patch(editing.id, { country, period });
            else setCurves([...curves, { id: nextId(), country, period, color: nextColor(curves), visible: true }]);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}
