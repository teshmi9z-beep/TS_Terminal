import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWidth } from './hooks';

// a button that opens a menu under it, closed by a click elsewhere
export function Dropdown({ label, children, className = '', align = 'left', title }: {
  label: ReactNode; children: (close: () => void) => ReactNode; className?: string; align?: 'left' | 'right'; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className={`op-dd ${className}`} ref={ref}>
      <button className={`op-dd-btn ${open ? 'open' : ''}`} title={title} onClick={() => setOpen(!open)}>
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3.5l3 3 3-3" /></svg>
      </button>
      {open && <div className={`op-dd-menu ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export type Series = { label: string; color: string; points: [number, number][]; dashed?: boolean };

// a small line chart (x ascending), with a crosshair tooltip
export function LineChart({ series, height = 300, xFmt, yFmt, marker }: {
  series: Series[]; height?: number; xFmt: (x: number) => string; yFmt: (y: number) => string; marker?: { x: number; label: string };
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hx, setHx] = useState<number | null>(null);
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return <div className="pg-empty">Pas de données.</div>;
  const padL = 56, padR = 12, padT = 12, padB = 26;
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  if (x0 === x1) { x0 -= 1; x1 += 1; }
  const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.08;
  y0 -= pad; y1 += pad;
  const W = Math.max(w, 100);
  const x = (v: number) => padL + ((v - x0) / (x1 - x0)) * (W - padL - padR);
  const y = (v: number) => padT + ((y1 - v) / (y1 - y0)) * (height - padT - padB);
  const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b);
  const near = hx == null ? null : xs.reduce((b, v) => (Math.abs(x(v) - hx) < Math.abs(x(b) - hx) ? v : b), xs[0]);
  return (
    <div className="op-line" ref={ref}>
      <svg width={W} height={height} onMouseMove={(e) => setHx(e.clientX - e.currentTarget.getBoundingClientRect().left)} onMouseLeave={() => setHx(null)}>
        {Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4).map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="op-grid" />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="op-axis">{yFmt(t)}</text>
          </g>
        ))}
        {Array.from({ length: 6 }, (_, i) => x0 + ((x1 - x0) * i) / 5).map((t) => (
          <text key={t} x={x(t)} y={height - 8} textAnchor="middle" className="op-axis">{xFmt(t)}</text>
        ))}
        {marker && marker.x >= x0 && marker.x <= x1 && (
          <g>
            <line x1={x(marker.x)} x2={x(marker.x)} y1={padT} y2={height - padB} className="op-spot" />
            <text x={x(marker.x) + 4} y={padT + 10} className="op-axis">{marker.label}</text>
          </g>
        )}
        {series.map((s) => (
          <g key={s.label}>
            <polyline points={s.points.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '5 4' : undefined} />
            {s.points.length < 40 && s.points.map((p) => <circle key={p[0]} cx={x(p[0])} cy={y(p[1])} r="2.5" fill={s.color} />)}
          </g>
        ))}
        {near != null && <line x1={x(near)} x2={x(near)} y1={padT} y2={height - padB} className="op-cross" />}
      </svg>
      {near != null && (
        <div className="op-tip" style={{ left: Math.min(W - 190, x(near) + 10) }}>
          <div><b>{xFmt(near)}</b></div>
          {series.map((s) => {
            const p = s.points.find((q) => q[0] === near);
            return p ? <div key={s.label}><i className="fu-dot" style={{ background: s.color }} />{s.label} <b>{yFmt(p[1])}</b></div> : null;
          })}
        </div>
      )}
      <div className="op-legend">{series.map((s) => <span key={s.label}><i style={{ borderTopColor: s.color, borderTopStyle: s.dashed ? 'dashed' : 'solid' }} />{s.label}</span>)}</div>
    </div>
  );
}
