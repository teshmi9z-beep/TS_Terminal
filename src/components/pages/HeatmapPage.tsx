import { useEffect, useMemo, useRef, useState } from 'react';
import { useKept } from '../kept';
import { COLORS, SIZES, SOURCES, fetchHeat, heatColor, type ColorBy, type GroupBy, type HeatRow, type SizeBy } from '../../data/heatmap';
import { tvLogo, tvToSymbol } from '../../data/tv';
import { big, fr, pct, price } from '../../data/format';
import { useStore } from '../../store/store';
import { showOnChart } from '../tabs/tabActions';
import { squarify } from '../treemap';
import { Dropdown } from './options/ui';

const HEAD = 20;
const Flag = ({ code }: { code: string }) => (code ? <img className="hm-flag" src={`https://flagcdn.com/w40/${code}.png`} alt="" /> : <span className="hm-flag crypto">₿</span>);

function sizeOf(r: HeatRow, by: SizeBy): number {
  const v = by === 'cap' ? r.cap : by === 'value' ? r.value : by === 'employees' ? r.employees : 1;
  return v != null && v > 0 ? v : 0;
}

function Tile({ r, x, y, w, h, color, value, onHover }: { r: HeatRow; x: number; y: number; w: number; h: number; color: string; value: number | null | undefined; onHover: (e: React.MouseEvent | null) => void }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const m = Math.min(w, h);
  const font = Math.max(8, Math.min(30, Math.min(w / 4.2, h / 3.2)));
  const logo = Math.min(72, m * 0.34);
  const showLogo = r.logoid && !logoFailed && w > 34 && h > 44;
  const showText = w > 22 && h > 14;
  return (
    <div
      className="hm-tile" style={{ left: x, top: y, width: Math.max(0, w - 1), height: Math.max(0, h - 1), background: color }}
      onMouseMove={onHover} onMouseLeave={() => onHover(null)} onClick={() => showOnChart(tvToSymbol(r.id, r.name))}
    >
      {showText && (
        <div className="hm-in" style={{ fontSize: font }}>
          {showLogo && <img src={tvLogo(r.logoid!)} alt="" width={logo} height={logo} onError={() => setLogoFailed(true)} />}
          <b>{r.ticker}</b>
          {h > 30 && <span>{pct(value, 2)}</span>}
        </div>
      )}
    </div>
  );
}

// TradingView's stock / crypto heatmap
export default function HeatmapPage() {
  const dark = useStore((s) => s.uiTheme === 'dark');
  const [srcId, setSrcId] = useKept('heatmap.src', 'SPX');
  const [size, setSize] = useKept<SizeBy>('heatmap.size', 'cap');
  const [color, setColor] = useKept<ColorBy>('heatmap.color', 'change');
  const [group, setGroup] = useKept<GroupBy>('heatmap.group', 'sector');
  const [zoom, setZoom] = useKept<string | null>('heatmap.zoom', null);
  const [labels, setLabels] = useKept('heatmap.labels', true);
  const [data, setData] = useKept<{ id: string; rows: HeatRow[] } | null>('heatmap.data', null, true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ r: HeatRow; x: number; y: number } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const src = SOURCES.find((s) => s.id === srcId) ?? SOURCES[0];
  const colorDef = COLORS.find((c) => c[0] === color) ?? COLORS[0];

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    fetchHeat(src, ctrl.signal).then((rows) => { setData({ id: src.id, rows }); setError(null); }, (e: unknown) => {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    const t = setTimeout(() => setTick((n) => n + 1), 60_000);
    return () => { ctrl.abort(); clearTimeout(t); };
  }, [src, tick, setData]);

  const rows = useMemo(() => (data?.id === src.id ? data.rows : []), [data, src.id]);
  const layout = useMemo(() => {
    const items = rows.filter((r) => sizeOf(r, size) > 0 && (!zoom || (group === 'industry' ? r.industry : r.sector) === zoom));
    const W = box.w, H = box.h;
    if (!items.length || W < 20 || H < 20) return [];
    const byGroup = new Map<string, HeatRow[]>();
    for (const r of items) {
      const k = group === 'none' ? '' : group === 'industry' ? r.industry : r.sector;
      byGroup.set(k, [...(byGroup.get(k) ?? []), r]);
    }
    const groups = [...byGroup.entries()]
      .map(([name, list]) => ({ value: list.reduce((s, r) => s + sizeOf(r, size), 0), item: { name, list: list.sort((a, b) => sizeOf(b, size) - sizeOf(a, size)) } }))
      .sort((a, b) => b.value - a.value);
    return squarify(groups, { x: 0, y: 0, w: W, h: H }).map((g) => {
      const head = g.item.name && g.h > HEAD + 12 ? HEAD : 0;
      return {
        ...g, head,
        tiles: squarify(g.item.list.map((r) => ({ value: sizeOf(r, size), item: r })), { x: g.x + 1, y: g.y + head, w: g.w - 2, h: g.h - head - 1 }),
      };
    });
  }, [rows, size, group, zoom, box]);

  const steps = [-3, -2, -1, 0, 1, 2, 3].map((k) => (k * colorDef[2]) / 3);
  const title = src.kind === 'crypto' ? 'Carte thermique des cryptos' : 'Carte thermique des marchés boursiers';

  return (
    <div className="pg hm-page" ref={pageRef}>
      <div className="pg-head">
        <Dropdown className="hm-title" label={<h1>{title}</h1>}>
          {(close) => (
            <div className="op-dd-list">
              <button className={src.kind === 'stocks' ? 'active' : ''} onClick={() => { setSrcId('SPX'); setZoom(null); close(); }}>Carte thermique des marchés boursiers</button>
              <button className={src.kind === 'crypto' ? 'active' : ''} onClick={() => { setSrcId('crypto'); setGroup('none'); setZoom(null); close(); }}>Carte thermique des cryptos</button>
            </div>
          )}
        </Dropdown>
        <div className="pg-head-tools">
          <button className="hm-icon" title={labels ? 'Masquer les en-têtes de groupe' : 'Afficher les en-têtes de groupe'} onClick={() => setLabels(!labels)}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="2.5" width="13" height="13" rx="2" /><path d="M2.5 6.5h13" /></svg>
          </button>
          <button className="hm-icon" title="Plein écran" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void pageRef.current?.requestFullscreen(); }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 6.5v-4h4M15.5 6.5v-4h-4M2.5 11.5v4h4M15.5 11.5v4h-4" /></svg>
          </button>
        </div>
      </div>
      <div className="hm-toolbar">
        <Dropdown label={<><Flag code={src.flag} /><b>{src.label}</b></>}>
          {(close) => (
            <div className="op-dd-list hm-src-list">
              {(['Indices', 'Marchés', 'Crypto'] as const).map((g) => (
                <div key={g}>
                  <div className="op-dd-head">{g}</div>
                  {SOURCES.filter((s) => s.group === g).map((s) => (
                    <button key={s.id} className={s.id === src.id ? 'active' : ''} onClick={() => { setSrcId(s.id); setZoom(null); if (s.kind === 'crypto') setGroup('none'); else if (group === 'none') setGroup('sector'); close(); }}>
                      <Flag code={s.flag} />{s.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Dropdown>
        <span className="hm-sep" />
        <Dropdown label={<><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 6V2h4M14 10v4h-4M2 2l5 5M14 14l-5-5" /></svg>{SIZES.find((s) => s[0] === size)?.[1]}</>}>
          {(close) => <div className="op-dd-list">{SIZES.filter((s) => src.kind === 'stocks' || s[0] !== 'employees').map(([id, l]) => <button key={id} className={id === size ? 'active' : ''} onClick={() => { setSize(id); close(); }}>{l}</button>)}</div>}
        </Dropdown>
        <Dropdown label={<><span className="hm-swatch" />{colorDef[1]}</>}>
          {(close) => <div className="op-dd-list">{COLORS.filter((c) => src.kind === 'stocks' || !['premarket', 'gap'].includes(c[0])).map(([id, l]) => <button key={id} className={id === color ? 'active' : ''} onClick={() => { setColor(id); close(); }}>{l}</button>)}</div>}
        </Dropdown>
        <Dropdown label={<><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><path d="M8 2v6l4.5 3.5" /></svg>{group === 'sector' ? (src.kind === 'crypto' ? 'Catégorie' : 'Secteur') : group === 'industry' ? 'Industrie' : 'Aucun regroupement'}</>}>
          {(close) => (
            <div className="op-dd-list">
              <button className={group === 'sector' ? 'active' : ''} onClick={() => { setGroup('sector'); setZoom(null); close(); }}>{src.kind === 'crypto' ? 'Catégorie' : 'Secteur'}</button>
              {src.kind === 'stocks' && <button className={group === 'industry' ? 'active' : ''} onClick={() => { setGroup('industry'); setZoom(null); close(); }}>Industrie</button>}
              <button className={group === 'none' ? 'active' : ''} onClick={() => { setGroup('none'); setZoom(null); close(); }}>Aucun regroupement</button>
            </div>
          )}
        </Dropdown>
        {zoom && <button className="hm-crumb" onClick={() => setZoom(null)}>‹ Tous · <b>{zoom}</b></button>}
      </div>
      {error && <div className="pg-error">{error}</div>}
      <div className="hm-area" ref={areaRef} onMouseLeave={() => setTip(null)}>
        {!rows.length && !error && <div className="pg-empty"><span className="spinner" /> Chargement…</div>}
        {layout.map((g) => (
          <div key={g.item.name || 'all'}>
            {g.head > 0 && labels && (
              <button className="hm-group" style={{ left: g.x, top: g.y, width: g.w, height: g.head }} onClick={() => setZoom(zoom ? null : g.item.name)} title={zoom ? 'Revenir à tous' : 'Zoomer sur ce groupe'}>
                {g.item.name} ›
              </button>
            )}
            {g.tiles.map((t) => (
              <Tile
                key={t.item.id} r={t.item} x={t.x} y={t.y} w={t.w} h={t.h}
                color={heatColor(t.item.perf[color], colorDef[2], dark)} value={t.item.perf[color]}
                onHover={(e) => { if (!e) { setTip(null); return; } const b = areaRef.current!.getBoundingClientRect(); setTip({ r: t.item, x: e.clientX - b.left, y: e.clientY - b.top }); }}
              />
            ))}
          </div>
        ))}
        {tip && (
          <div className="hm-tip" style={{ left: Math.min(tip.x + 14, box.w - 250), top: Math.min(tip.y + 14, box.h - 170) }}>
            <div className="hm-tip-head">
              {tip.r.logoid && <img src={tvLogo(tip.r.logoid)} alt="" width={22} height={22} />}
              <b>{tip.r.ticker}</b><span>{tip.r.name}</span>
            </div>
            <div className="hm-tip-row"><span>Cours</span><b>{price(tip.r.close)} {tip.r.currency}</b></div>
            {COLORS.filter((c) => tip.r.perf[c[0]] != null).slice(0, 7).map(([id, l]) => (
              <div key={id} className={`hm-tip-row ${id === color ? 'on' : ''}`}><span>{l.replace(', %', '')}</span><b className={(tip.r.perf[id] ?? 0) >= 0 ? 'up' : 'down'}>{pct(tip.r.perf[id])}</b></div>
            ))}
            <div className="hm-tip-row"><span>Capitalisation</span><b>{big(tip.r.cap)}</b></div>
            {src.kind === 'stocks' && <div className="hm-tip-row"><span>Secteur</span><b>{tip.r.sector}</b></div>}
          </div>
        )}
      </div>
      <div className="hm-scale">
        {steps.map((v) => <span key={v} style={{ background: heatColor(v, colorDef[2], dark) }}>{`${fr(v, v % 1 ? 1 : 0)}%`}</span>)}
      </div>
    </div>
  );
}
