import { useEffect, useRef, useState } from 'react';
import { remember, useKept } from '../kept';
import { cachedFundamentals, loadFundamentals, METRICS, takeFundamentalsTarget, type Fundamentals, type MetricId } from '../../data/fundamentals';
import { resolveTv, tvToSymbol } from '../../data/tv';
import { big, fr } from '../../data/format';
import { showOnChart } from '../tabs/tabActions';
import { Chips, Loading, PageHeader, TvLogo } from './common';

const COLORS = ['#2962ff', '#ff9800', '#22ab94', '#f23645', '#ab47bc', '#00bcd4'];
type Period = 'fy' | 'fq';
type Kind = 'bars' | 'line';

const fmt = (v: number | null | undefined, kind: string) =>
  v == null ? '—' : kind === 'pct' ? `${fr(v, 1)} %` : kind === 'per_share' ? fr(v) : big(v);

// label order: years ascending, quarters "T1 2025" < "T2 2025"
const order = (l: string) => { const m = /^T(\d) (\d{4})$/.exec(l); return m ? +m[2] * 10 + +m[1] : +l * 10; };

function Chart({ data, labels, kind, metricKind }: { data: { f: Fundamentals; color: string; values: (number | null)[] }[]; labels: string[]; kind: Kind; metricKind: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const h = 340, padL = 70, padB = 26, padT = 12;
  const all = data.flatMap((d) => d.values).filter((v): v is number => v != null);
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  if (lo === hi) hi = lo + 1;
  const pad = (hi - lo) * 0.06;
  hi += pad; if (lo < 0) lo -= pad;
  const plotW = w - padL - 10;
  const band = plotW / Math.max(1, labels.length);
  const x = (i: number) => padL + band * (i + 0.5);
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
  const ticks = Array.from({ length: 6 }, (_, i) => lo + ((hi - lo) * i) / 5);
  const bw = Math.min(28, (band * 0.75) / Math.max(1, data.length));
  return (
    <div className="fu-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={h} onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.floor((e.clientX - r.left - padL) / band);
        setHover(i >= 0 && i < labels.length ? i : null);
      }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - 10} y1={y(t)} y2={y(t)} className="op-grid" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="op-axis">{fmt(t, metricKind)}</text>
          </g>
        ))}
        {hover != null && <rect x={padL + band * hover} y={padT} width={band} height={h - padT - padB} className="fu-hover" />}
        <line x1={padL} x2={w - 10} y1={y(0)} y2={y(0)} className="op-zero" />
        {labels.map((l, i) => (labels.length <= 16 || i % Math.ceil(labels.length / 16) === 0) && (
          <text key={l} x={x(i)} y={h - 8} textAnchor="middle" className="op-axis">{l}</text>
        ))}
        {kind === 'bars'
          ? data.map((d, k) => d.values.map((v, i) => v == null ? null : (
            <rect key={`${k}-${i}`} x={x(i) - (bw * data.length) / 2 + bw * k} width={bw - 2} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(v) - y(0)))} fill={d.color} rx="2" />
          )))
          : data.map((d, k) => {
            const pts = d.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
            return (
              <g key={k}>
                <polyline points={pts.join(' ')} fill="none" stroke={d.color} strokeWidth="2" />
                {d.values.map((v, i) => v != null && <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={d.color} />)}
              </g>
            );
          })}
      </svg>
      {hover != null && (
        <div className="op-tip" style={{ left: Math.min(w - 220, x(hover) + band / 2 + 6) }}>
          <div><b>{labels[hover]}</b></div>
          {data.map((d) => (
            <div key={d.f.id}><i className="fu-dot" style={{ background: d.color }} />{d.f.id.split(':')[1]} <b>{fmt(d.values[hover], metricKind)}</b></div>
          ))}
        </div>
      )}
    </div>
  );
}

// TradingView's fundamental graphs: one metric over time for several companies
export default function FundamentalsPage() {
  // opened from a chart's earnings card: that company's EPS (kept like any other choice)
  useState(() => {
    const t = takeFundamentalsTarget();
    if (t) { remember('fund.ids', [t]); remember('fund.metric', 'earnings_per_share_diluted'); }
  });
  const [ids, setIds] = useKept<string[]>('fund.ids', ['NASDAQ:AAPL', 'NASDAQ:MSFT']);
  const [metric, setMetric] = useKept<MetricId>('fund.metric', 'total_revenue');
  const [period, setPeriod] = useKept<Period>('fund.period', 'fy');
  const [kind, setKind] = useKept<Kind>('fund.kind', 'bars');
  const [count, setCount] = useKept('fund.count', '10');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    let alive = true;
    for (const id of ids) {
      if (cachedFundamentals(id) !== undefined) continue;
      loadFundamentals(id).then(() => { if (alive) bump((n) => n + 1); }, (e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    }
    return () => { alive = false; };
  }, [ids]);

  async function add() {
    const t = text.trim();
    if (!t) return;
    const r = await resolveTv(t).catch(() => null);
    if (!r) { setError(`Symbole introuvable : ${t}`); return; }
    setError(null);
    setText('');
    if (!ids.includes(r.id)) setIds([...ids, r.id].slice(-6));
  }

  const m = METRICS.find((x) => x.id === metric)!;
  const loaded = ids.map((id) => cachedFundamentals(id)).filter((f): f is Fundamentals => !!f);
  const pending = ids.some((id) => cachedFundamentals(id) === undefined);
  const labelsAll = [...new Set(loaded.flatMap((f) => (f[period].values[metric] ? f[period].labels : [])))].sort((a, b) => order(a) - order(b));
  const labels = labelsAll.slice(-+count);
  const data = loaded.map((f, k) => {
    const s = f[period];
    const vals = s.values[metric];
    return { f, color: COLORS[ids.indexOf(f.id) % COLORS.length], k, values: labels.map((l) => { const i = s.labels.indexOf(l); return i >= 0 && vals ? vals[i] ?? null : null; }) };
  });
  const missing = loaded.filter((f) => !f[period].values[metric]?.some((v) => v != null));

  return (
    <div className="pg">
      <PageHeader title="Graphiques fondamentaux">
        <div className="nw-search">
          <input placeholder="Ajouter une société (ex : NVDA, MC, OR)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
          <button className="pill-btn" onClick={() => void add()}>Comparer</button>
        </div>
      </PageHeader>
      <div className="fu-syms">
        {ids.map((id) => {
          const f = cachedFundamentals(id);
          return (
            <span key={id} className="fu-sym" style={{ borderColor: COLORS[ids.indexOf(id) % COLORS.length] }}>
              <i className="fu-dot" style={{ background: COLORS[ids.indexOf(id) % COLORS.length] }} />
              <TvLogo logoid={f?.logoid} text={id.split(':')[1]} size={18} />
              <button className="fu-sym-name" onClick={() => showOnChart(tvToSymbol(id, f?.name))} title={f?.name}>{id.split(':')[1]}</button>
              {ids.length > 1 && <button className="fu-x" onClick={() => setIds(ids.filter((x) => x !== id))}>✕</button>}
            </span>
          );
        })}
      </div>
      <div className="fu-layout">
        <div className="fu-metrics">
          {METRICS.map((x) => (
            <button key={x.id} className={`fu-metric ${x.id === metric ? 'active' : ''}`} onClick={() => { setMetric(x.id); if (x.fyOnly) setPeriod('fy'); }}>{x.label}</button>
          ))}
        </div>
        <div className="fu-main">
          <div className="pg-toolbar">
            <Chips<Period> value={period} onChange={setPeriod} options={m.fyOnly ? [['fy', 'Annuel']] : [['fy', 'Annuel'], ['fq', 'Trimestriel']]} />
            <Chips value={count} onChange={setCount} options={[['5', '5'], ['10', '10'], ['20', '20']]} />
            <Chips<Kind> value={kind} onChange={setKind} options={[['bars', 'Barres'], ['line', 'Lignes']]} />
          </div>
          {error && <div className="pg-error">{error}</div>}
          <h2 className="fu-title">{m.label} <span className="muted">· {period === 'fy' ? 'exercices annuels' : 'trimestres'}</span></h2>
          {pending && !loaded.length ? <Loading /> : labels.length ? <Chart data={data} labels={labels} kind={kind} metricKind={m.kind} /> : <div className="pg-empty">Pas de données.</div>}
          {missing.length > 0 && (
            <div className="pg-note">
              Non disponible pour {missing.map((f) => f.id.split(':')[1]).join(', ')}
              {period === 'fq' && missing.some((f) => /H\d$/.test(f.current)) ? ' (publication semestrielle, pas de trimestres).' : '.'}
            </div>
          )}
          {labels.length > 0 && (
            <div className="pg-scroll fu-table">
              <table className="pg-table">
                <thead><tr><th className="left">Société</th>{labels.map((l) => <th key={l}>{l}</th>)}</tr></thead>
                <tbody>
                  {data.map((d) => (
                    <tr key={d.f.id}>
                      <td className="left pg-sym"><i className="fu-dot" style={{ background: d.color }} /><b>{d.f.id.split(':')[1]}</b><span>{d.f.name}</span></td>
                      {d.values.map((v, i) => <td key={labels[i]} className={v != null && v < 0 ? 'down' : ''}>{fmt(v, m.kind)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="pg-note">Montants dans la devise de publication de chaque société.</div>
        </div>
      </div>
    </div>
  );
}
