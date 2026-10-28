import { useEffect, useMemo, useRef, useState } from 'react';
import { useKept } from './kept';
import { useStore } from '../store/store';
import {
  MACROS, GROUPS, macroDef, bucketOf, formatMacro, thresholdLabel, obsLabel, monthLabel,
  fetchMacroCurrent, fetchMacroHistory, obsAt,
  type MacroCurrent, type MacroHistory, type MacroId,
} from '../data/macro';
import { countryCode, downloadSvgAsPng, flagUrl, frenchCountryName, loadWorld, projectWorld, type Country } from './worldMap';
import { GearIcon } from './GearIcon';
import PanelControls from './PanelControls';

const GAP = 6;
const CURRENT_TTL = 5 * 60_000;
const currentCache = new Map<MacroId, { at: number; data: Map<string, MacroCurrent> }>();

const PALETTES = {
  dark: { bg: '#131722', empty: '#2a2e39', stroke: '#131722', hover: '#ffffff' },
  light: { bg: '#ffffff', empty: '#e0e3eb', stroke: '#ffffff', hover: '#131722' },
};

// first month of the slider before the history is loaded
const NOMINAL_START = { wb: Date.UTC(1960, 0, 1) / 1000, bis: Date.UTC(1950, 0, 1) / 1000 };

function monthsBetween(a: number, b: number) {
  const da = new Date(a * 1000), db = new Date(b * 1000);
  return (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + db.getUTCMonth() - da.getUTCMonth();
}
function addMonths(t: number, n: number) {
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 1000;
}

type Row = { code: string; name: string; symbol: string | null; value: number; label: string };

// TradingView's "Macro Maps": a macro indicator by country on a world map, a time
// slider to go back in history, and the ranking of a group of countries
export default function MacroMap() {
  const macro = useStore((s) => s.macroMap);
  const setMacro = useStore((s) => s.setMacroMap);
  const uiTheme = useStore((s) => s.uiTheme);
  const def = macroDef(macro.indicator);
  const pal = PALETTES[uiTheme];

  // bumped when a fetch fills the module caches
  const [, setLoaded] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hists, setHists] = useState<Partial<Record<MacroId, MacroHistory | 'loading' | 'error'>>>({});
  // selected month (UTC seconds); null = latest values
  const [at, setAt] = useKept<number | null>('macro.at', null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useKept<string | null>('macro.search', null);
  const [selected, setSelected] = useKept<string | null>('macro.selected', null);
  const [world, setWorld] = useState<Country[] | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ code: string | undefined; name: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useKept('macro.zoom', { k: 1, x: 0, y: 0 }, true);
  const [tick, setTick] = useState(0);
  const mapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; zx: number; zy: number; moved: boolean } | null>(null);
  // how many indicator buttons fit on the row (the others go in the ••• menu, like TradingView)
  const tabsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(MACROS.length);
  useEffect(() => {
    const el = tabsRef.current, m = measureRef.current;
    if (!el || !m) return;
    const ro = new ResizeObserver(() => {
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      const more = widths.pop() ?? 40;
      const lead = (el.firstElementChild as HTMLElement | null)?.offsetWidth ?? 34;
      const cs = getComputedStyle(el);
      const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - lead - 1 - 3 * GAP;
      if (widths.reduce((a, w) => a + w + GAP, 0) <= avail) { setFit(widths.length); return; }
      let used = 0, n = 0;
      for (const w of widths) { if (used + w + GAP + more > avail) break; used += w + GAP; n++; }
      setFit(Math.max(1, n));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { loadWorld().then(setWorld, () => setWorld([])); }, []);
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // latest values of the indicator
  const current: Map<string, MacroCurrent> | null = currentCache.get(def.id)?.data ?? null;
  useEffect(() => {
    const hit = currentCache.get(def.id);
    if (hit && Date.now() - hit.at < CURRENT_TTL) return;
    const ctrl = new AbortController();
    fetchMacroCurrent(def.id, ctrl.signal)
      .then((data) => { currentCache.set(def.id, { at: Date.now(), data }); setLoaded((n) => n + 1); setError(null); })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => ctrl.abort();
  }, [def.id, tick]);

  const histEntry = hists[def.id];
  const hist = typeof histEntry === 'object' ? histEntry : null;
  const histState = histEntry === 'loading' || histEntry === 'error' ? histEntry : 'idle';
  function ensureHistory() {
    if (histEntry) return;
    const id = def.id;
    setHists((h) => ({ ...h, [id]: 'loading' }));
    fetchMacroHistory(def).then((r) => setHists((h) => ({ ...h, [id]: r })), () => setHists((h) => ({ ...h, [id]: 'error' })));
  }
  const choose = (id: MacroId) => { setMacro({ indicator: id }); setAt(null); };

  // the slider runs from the first observation to the latest one
  const latest = useMemo(() => {
    let t = 0;
    for (const c of current?.values() ?? []) t = Math.max(t, c.obs.t);
    return t || Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) / 1000;
  }, [current]);
  const start = hist?.start ?? (def.bis ? NOMINAL_START.bis : NOMINAL_START.wb);
  const span = Math.max(1, monthsBetween(start, latest));
  const sliderValue = at == null ? span : Math.min(span, monthsBetween(start, at));

  const values = useMemo(() => {
    const out = new Map<string, Row>();
    if (at == null || !hist) {
      for (const c of current?.values() ?? []) {
        out.set(c.code, { code: c.code, name: frenchCountryName(c.code), symbol: c.symbol, value: c.obs.v, label: obsLabel(c.obs) });
      }
    } else {
      for (const code of hist.series.keys()) {
        const o = obsAt(hist, code, at);
        if (o) out.set(code, { code, name: frenchCountryName(code), symbol: current?.get(code)?.symbol ?? null, value: o.v, label: obsLabel(o) });
      }
    }
    return out;
  }, [current, hist, at]);

  // a full-screen panel is wide: the map keeps at most ~65 % of the window height
  const geo = useMemo(() => {
    if (!world || !world.length || width < 50) return null;
    const g = projectWorld(world, width);
    const maxH = window.innerHeight * 0.65;
    if (g.height <= maxH) return { ...g, w: width };
    const w = Math.max(50, Math.floor((width * maxH) / g.height));
    return { ...projectWorld(world, w), w };
  }, [world, width]);
  const colorOf = (code: string | undefined) => {
    const r = code ? values.get(code) : undefined;
    return r ? def.palette[bucketOf(def, r.value)] : pal.empty;
  };

  const group = GROUPS.find((g) => g.id === macro.group) ?? GROUPS[0];
  const q = (search ?? '').trim().toLowerCase();
  const rows = [...values.values()]
    .filter((r) => (!group.codes || group.codes.includes(r.code)) && (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase() === q || r.symbol?.toLowerCase().includes(q)))
    .sort((a, b) => b.value - a.value);

  function zoomBy(f: number, cx?: number, cy?: number) {
    setZoom((z) => {
      const k = Math.max(1, Math.min(12, z.k * f));
      const px = cx ?? (geo?.w ?? width) / 2, py = cy ?? (geo?.height ?? 0) / 2;
      // keep the point under the cursor in place
      const x = px - ((px - z.x) / z.k) * k, y = py - ((py - z.y) / z.k) * k;
      return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x, y };
    });
  }

  const hoverRow = hover?.code ? values.get(hover.code) : undefined;
  // the selected indicator always shows: it takes the last visible place when it is in the menu
  const visible = MACROS.slice(0, fit);
  if (fit < MACROS.length && !visible.some((m) => m.id === def.id)) visible[visible.length - 1] = def;
  const moreDefs = MACROS.filter((m) => !visible.includes(m));

  return (
    <div className="side-panel mm-panel">
      <div className="mm-head">
        <span className="mm-title">Macro Maps</span>
        <div className="mm-tools">
          <button className="yc-icon-btn" title="Paramètres" onClick={() => setMenuOpen(!menuOpen)}><GearIcon size={16} /></button>
          <button
            className="yc-icon-btn" title="Enregistrer la carte en image"
            onClick={() => { if (svgRef.current) downloadSvgAsPng(svgRef.current, pal.bg, `macro-${def.id.toLowerCase()}.png`); }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
          </button>
          <PanelControls />
          {menuOpen && (
            <div className="yc-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button className="pill-btn" onClick={() => { currentCache.delete(def.id); setTick((t) => t + 1); setMenuOpen(false); }}>Actualiser</button>
              <div className="yc-menu-note">
                Valeurs actuelles : TradingView (symboles ECONOMICS).<br />
                Historique : {def.bis ? 'BRI, taux directeurs mensuels' : 'Banque mondiale, données annuelles'}.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mm-tabs" ref={tabsRef}>
        <button className={`mm-search-btn ${search != null ? 'active' : ''}`} title="Rechercher un pays" onClick={() => setSearch(search == null ? '' : null)}>
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="5.5" /><path d="M12.2 12.2L16 16" /></svg>
        </button>
        <span className="mm-tab-sep" />
        {visible.map((m) => (
          <button key={m.id} className={`mm-tab ${def.id === m.id ? 'active' : ''}`} onClick={() => choose(m.id)}>{m.label}</button>
        ))}
        {moreDefs.length > 0 && (
          <div className="mm-more">
            <button className="mm-tab" title="Autres indicateurs" onClick={() => setMoreOpen(!moreOpen)}>•••</button>
            {moreOpen && (
              <>
                <div className="se-backdrop" onMouseDown={() => setMoreOpen(false)} />
                <div className="mm-menu">
                  {moreDefs.map((m) => (
                    <button key={m.id} className={def.id === m.id ? 'active' : ''} onClick={() => { choose(m.id); setMoreOpen(false); }}>{m.label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <div className="mm-measure" ref={measureRef} aria-hidden>
          {MACROS.map((m) => <span key={m.id} className="mm-tab">{m.label}</span>)}
          <span className="mm-tab">•••</span>
        </div>
      </div>
      {search != null && (
        <input className="mm-search" autoFocus placeholder="Pays ou symbole (ex : France, FRIRYY)" value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      {error && <div className="yc-error">Données indisponibles : {error}</div>}

      <div className="mm-body">
        <div className="mm-main">
          <div className="mm-map" ref={mapRef}>
            {!geo && <div className="side-empty"><span className="spinner" /> Chargement de la carte…</div>}
            {geo && (
              <svg
                ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={geo.w} height={geo.height}
                onMouseLeave={() => setHover(null)}
                onWheel={(e) => { const r = e.currentTarget.getBoundingClientRect(); zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top); }}
                onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y, moved: false }; }}
                onMouseMove={(e) => {
                  const d = drag.current;
                  if (d && (e.buttons & 1) && zoom.k > 1) {
                    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
                    setZoom((z) => ({ ...z, x: d.zx + e.clientX - d.x, y: d.zy + e.clientY - d.y }));
                  }
                }}
                onMouseUp={() => { setTimeout(() => { drag.current = null; }, 0); }}
                style={{ cursor: zoom.k > 1 ? 'grab' : 'default' }}
              >
                <rect width={geo.w} height={geo.height} fill={pal.bg} />
                <g transform={`translate(${zoom.x} ${zoom.y}) scale(${zoom.k})`}>
                  {geo.paths.map(({ f, d }, i) => {
                    const code = countryCode(f);
                    const on = hover?.name === f.properties.name || (selected != null && selected === code);
                    return (
                      <path
                        key={String(f.id ?? f.properties.name ?? i)} d={d} fill={colorOf(code)}
                        stroke={on ? pal.hover : pal.stroke} strokeWidth={(on ? 1.2 : 0.5) / zoom.k}
                        onMouseMove={(e) => {
                          const r = mapRef.current!.getBoundingClientRect();
                          setHover({ code, name: f.properties.name, x: e.clientX - r.left, y: e.clientY - r.top });
                        }}
                        onClick={() => { if (!drag.current?.moved && code) setSelected(selected === code ? null : code); }}
                      />
                    );
                  })}
                </g>
              </svg>
            )}
            <div className="mm-zoom">
              <button title="Zoomer" onClick={() => zoomBy(1.5)}>+</button>
              <button title="Dézoomer" onClick={() => zoomBy(1 / 1.5)}>−</button>
              <button title="Vue d’ensemble" onClick={() => setZoom({ k: 1, x: 0, y: 0 })}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 1.5v3.5H1.5M9 1.5v3.5h3.5M5 12.5V9H1.5M9 12.5V9h3.5" /></svg>
              </button>
            </div>
            {hover && (
              <div className="yc-map-tip" style={{ left: Math.min(hover.x + 14, Math.max(0, width - 200)), top: hover.y + 16 }}>
                <div className="yc-map-tip-name">
                  {hover.code && <img className="yc-flag" src={flagUrl(hover.code)} alt="" />}
                  {hover.code ? frenchCountryName(hover.code, hover.name) : hover.name}
                </div>
                {hoverRow ? (
                  <>
                    <div className="yc-map-tip-row"><span>{def.label}</span><b>{formatMacro(def, hoverRow.value)}</b></div>
                    <div className="yc-map-tip-row"><span>Observation</span><b>{hoverRow.label}</b></div>
                  </>
                ) : <div className="yc-map-tip-row"><span>Aucune donnée</span></div>}
              </div>
            )}
          </div>

          <div className="mm-legend">
            <div className="yc-map-scale">{def.palette.map((c) => <span key={c} style={{ background: c }} />)}</div>
            <div className="yc-map-ticks">
              {[0, 2, 4].map((i) => <span key={i} style={{ left: `${((i + 1) / 6) * 100}%` }}>{thresholdLabel(def, def.thresholds[i])}</span>)}
            </div>
          </div>

          <div className="mm-timeline">
            <input
              type="range" min={0} max={span} value={sliderValue}
              onPointerDown={ensureHistory}
              onChange={(e) => {
                ensureHistory();
                const n = parseInt(e.target.value);
                setAt(n >= span ? null : addMonths(start, n));
              }}
            />
            <div className="mm-timeline-labels">
              <span>{monthLabel(start)}</span>
              <span>{monthLabel(addMonths(start, Math.round(span / 2)))}</span>
              <b>{at == null ? monthLabel(latest) : monthLabel(at)}</b>
            </div>
            {histState === 'loading' && <div className="mm-hist-note"><span className="spinner" /> Chargement de l’historique…</div>}
            {histState === 'error' && <div className="mm-hist-note bad">Historique indisponible.</div>}
            {at != null && hist && <div className="mm-hist-note">{hist.source} · <button className="si-more" onClick={() => setAt(null)}>revenir à aujourd’hui</button></div>}
          </div>
        </div>

        <div className="mm-side">
          <div className="mm-group">
            <button className="mm-group-btn" onClick={() => setGroupOpen(!groupOpen)}>{group.label} <span>⌄</span></button>
            {groupOpen && (
              <>
                <div className="se-backdrop" onMouseDown={() => setGroupOpen(false)} />
                <div className="mm-menu">
                  {GROUPS.map((g) => <button key={g.id} className={g.id === group.id ? 'active' : ''} onClick={() => { setMacro({ group: g.id }); setGroupOpen(false); }}>{g.label}</button>)}
                </div>
              </>
            )}
          </div>
          <div className="mm-list-head"><span>PAYS</span><span>VALEUR / OBSERVATION</span></div>
          <div className="mm-list">
            {!current && !error && <div className="side-empty"><span className="spinner" /> Chargement…</div>}
            {rows.map((r) => (
              <div key={r.code} className={`mm-row ${selected === r.code ? 'active' : ''}`} onClick={() => setSelected(selected === r.code ? null : r.code)}>
                <img className="mm-flag" src={flagUrl(r.code)} alt="" />
                <div className="mm-country">
                  <span>{r.name}</span>
                  {r.symbol && <small>{r.symbol}</small>}
                </div>
                <div className="mm-value">
                  <b>{formatMacro(def, r.value)}</b>
                  <span>{r.label}</span>
                </div>
              </div>
            ))}
            {current && !rows.length && <div className="side-empty">Aucun pays{q ? ' ne correspond' : ' avec une donnée à cette date'}.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
