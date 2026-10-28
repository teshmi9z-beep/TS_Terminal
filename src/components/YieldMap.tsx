import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { countryCode, loadWorld, projectWorld, type Country } from './worldMap';
import { countryName, flagUrl, formatYield, yieldAt, type YieldSnapshot } from '../data/yields';

// 10-year yield buckets: < 1 %, 1–2.5, 2.5–5, 5–10, 10–20, ≥ 20 %
const THRESHOLDS = [1, 2.5, 5, 10, 20];
const MAP_COLORS = ['#1a3a2a', '#0d5b36', '#0a7a45', '#069a52', '#3dbd83', '#7ad8ad'];
const bucket = (v: number) => THRESHOLDS.filter((t) => v >= t).length;

export type MapPalette = { empty: string; stroke: string; text: string; faint: string };

type Props = {
  snap: YieldSnapshot | null;
  palette: MapPalette;
  onPick: (code: string) => void;
};

// world map of the 10-year government yields; a click opens the country's curve
const YieldMap = forwardRef<SVGSVGElement, Props>(function YieldMap({ snap, palette, onPick }, svgRef) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [world, setWorld] = useState<Country[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [hover, setHover] = useState<{ f: Country; x: number; y: number } | null>(null);

  useEffect(() => {
    loadWorld().then(setWorld, () => setFailed(true));
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => (world && width >= 50 ? projectWorld(world, width) : null), [world, width]);

  // Greenland takes Denmark's rates, like on TradingView's map
  const codeOf = (f: Country) => { const c = countryCode(f); return c === 'GL' ? 'DK' : c; };
  const tenYear = (code: string | undefined) => (code && snap ? yieldAt(snap.countries.get(code), '10Y', 'current') : null);

  const hoverCode = hover ? codeOf(hover.f) : undefined;
  const hoverValue = tenYear(hoverCode);
  const twoYear = hoverCode && snap ? yieldAt(snap.countries.get(hoverCode), '02Y', 'current') : null;

  return (
    <div className="yc-map" ref={wrapRef}>
      <div className="yc-map-caption">Taux souverains à 10 ans</div>
      {failed && <div className="side-empty">Carte indisponible.</div>}
      {!geo && !failed && <div className="side-empty"><span className="spinner" /> Chargement de la carte…</div>}
      {geo && (
        <svg
          ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={width} height={geo.height} className="yc-map-svg"
          onMouseLeave={() => setHover(null)}
        >
          {geo.paths.map(({ f, d }, i) => {
            const code = codeOf(f);
            const v = tenYear(code);
            const fill = v == null ? palette.empty : MAP_COLORS[bucket(v)];
            const active = hover?.f === f;
            return (
              <path
                key={String(f.id ?? i)} d={d} fill={fill} stroke={active ? palette.text : palette.stroke}
                strokeWidth={active ? 1 : 0.5} style={{ cursor: v != null ? 'pointer' : 'default' }}
                onMouseMove={(e) => {
                  const r = wrapRef.current!.getBoundingClientRect();
                  setHover({ f, x: e.clientX - r.left, y: e.clientY - r.top });
                }}
                onClick={() => { if (code && v != null) onPick(code); }}
              />
            );
          })}
        </svg>
      )}
      {hover && (
        <div className="yc-map-tip" style={{ left: Math.min(hover.x + 14, Math.max(0, width - 190)), top: hover.y + 16 }}>
          <div className="yc-map-tip-name">
            {hoverCode && <img className="yc-flag" src={flagUrl(hoverCode)} alt="" />}
            {hoverCode ? countryName(hoverCode, snap) : hover.f.properties.name}
          </div>
          {hoverValue != null ? (
            <>
              <div className="yc-map-tip-row"><span>10 ans</span><b>{formatYield(hoverValue)}</b></div>
              {twoYear != null && <div className="yc-map-tip-row"><span>2 ans</span><b>{formatYield(twoYear)}</b></div>}
              <div className="yc-map-tip-hint">Cliquer pour voir la courbe</div>
            </>
          ) : <div className="yc-map-tip-row"><span>Aucune donnée</span></div>}
        </div>
      )}
      <div className="yc-map-legend">
        <div className="yc-map-scale">
          {MAP_COLORS.map((c) => <span key={c} style={{ background: c }} />)}
        </div>
        <div className="yc-map-ticks">
          {/* 1 %, 5 % and 20 % sit on the 1st, 3rd and 5th boundaries of the 6 buckets */}
          <span style={{ left: `${(1 / 6) * 100}%` }}>1%</span>
          <span style={{ left: `${(3 / 6) * 100}%` }}>5%</span>
          <span style={{ left: `${(5 / 6) * 100}%` }}>20%</span>
        </div>
      </div>
    </div>
  );
});

export default YieldMap;
