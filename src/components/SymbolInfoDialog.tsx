import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { fetchSymbolInfo, type SymbolInfo } from '../data/feeds/symbolInfo';
import { SymbolLogo } from './SymbolLogo';
import { LOCALE, LANG, DEC } from '../i18n/lang';

const DAYS = LANG === 'en' ? ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] : ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM'];
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (secOfDay: number) => `${pad(Math.floor(secOfDay / 3600) % 24)}:${pad(Math.floor((secOfDay % 3600) / 60))}`;

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="si-copy" title="Copier"
      onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}
    >
      {done ? '✓' : <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="6" y="6" width="9" height="9" rx="1.5" /><path d="M3 12V4.5A1.5 1.5 0 014.5 3H12" /></svg>}
    </button>
  );
}

function Field({ label, value, copy, href }: { label: string; value?: string | number; copy?: boolean; href?: string }) {
  if (value == null || value === '') return null;
  const text = String(value);
  return (
    <div className="si-field">
      <div className="si-label">{label}</div>
      <div className="si-value">
        {href ? <a href={href} target="_blank" rel="noopener noreferrer">{text.replace(/^https?:\/\/(www\.)?/, '')} ↗</a> : text}
        {copy && <CopyButton text={text} />}
      </div>
    </div>
  );
}

// 24h strip of the exchange's day: closed / pre-market / regular / post-market
function SessionBar({ info }: { info: SymbolInfo }) {
  const [now] = useState(() => Date.now() / 1000);
  const off = info.gmtoffset ?? 0;
  const local = (t: number) => (((t + off) % 86400) + 86400) % 86400;
  const pct = (s: number) => `${(s / 86400) * 100}%`;
  const day = DAYS[new Date((now + off) * 1000).getUTCDay()];
  const city = info.timezoneName?.split('/').pop()?.replace(/_/g, ' ') ?? 'UTC';
  const utc = `UTC${off >= 0 ? '+' : ''}${off / 3600}`;

  if (info.sessions === '24x7') {
    return (
      <div className="si-session">
        <div className="si-session-row">
          <span className="si-day">{day}</span>
          <div className="si-track"><span className="seg regular" style={{ left: 0, width: '100%' }} /><span className="si-now" style={{ left: pct(local(now)) }} /></div>
        </div>
        <div className="si-tz">Marché ouvert 24 h/24, 7 j/7 · heure {utc}</div>
      </div>
    );
  }
  const s = info.sessions;
  if (!s?.regular) return <div className="si-tz">Horaires de séance indisponibles</div>;
  const segs: { cls: string; from: number; to: number }[] = [];
  const add = (cls: string, p?: { start: number; end: number }) => {
    if (!p || p.end <= p.start) return;
    const from = local(p.start);
    const len = Math.min(86400, p.end - p.start);
    if (from + len <= 86400) segs.push({ cls, from, to: from + len });
    else { segs.push({ cls, from, to: 86400 }); segs.push({ cls, from: 0, to: from + len - 86400 }); }
  };
  add('pre', s.pre);
  add('regular', s.regular);
  add('post', s.post);
  return (
    <div className="si-session">
      <div className="si-session-row">
        <span className="si-day">{day}</span>
        <div className="si-track">
          <span className="seg closed" style={{ left: 0, width: '100%' }} />
          {segs.map((g, i) => <span key={i} className={`seg ${g.cls}`} style={{ left: pct(g.from), width: pct(g.to - g.from) }} />)}
          <span className="si-now" style={{ left: pct(local(now)) }} />
        </div>
      </div>
      <div className="si-ticks">
        <span style={{ left: pct(local(s.regular.start)) }}>{hhmm(local(s.regular.start))}</span>
        <span style={{ left: pct(local(s.regular.end)) }}>{hhmm(local(s.regular.end))}</span>
      </div>
      <div className="si-legend">
        <span><i className="pre" />Pré-marché</span><span><i className="regular" />Séance</span>
        <span><i className="post" />Post-marché</span><span><i className="closed" />Fermé</span>
      </div>
      <div className="si-tz">Fuseau horaire de la bourse : {city} ({utc})</div>
    </div>
  );
}

export default function SymbolInfoDialog() {
  const mainSymbol = useStore((s) => s.symbol);
  const symbolFor = useChartUi((s) => s.symbolInfoFor);
  const symbol = symbolFor ?? mainSymbol;
  const closeDialog = useChartUi((s) => s.closeDialog);
  const [info, setInfo] = useState<SymbolInfo | null>(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSymbolInfo(symbol).then((i) => { if (!cancelled) setInfo(i); }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [symbol]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDialog]);

  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <div className="symbol-info" onMouseDown={(e) => e.stopPropagation()}>
        <div className="si-head">
          <span className="si-title">Info du symbole</span>
          <button className="remove-btn si-close" onClick={closeDialog}>✕</button>
        </div>
        {!info && !error && <div className="si-loading"><span className="spinner" /> Chargement…</div>}
        {error && <div className="si-loading">Informations indisponibles.</div>}
        {info && (
          <div className="si-body">
            <div className="si-hero">
              <SymbolLogo sym={symbol} size={34} />
              <div>
                <div className="si-hero-name">{info.name}</div>
                <div className="si-hero-sub">{info.fullSymbol}</div>
              </div>
            </div>
            <div className="si-grid">
              <Field label="Symbole" value={info.fullSymbol} />
              <Field label="Nom" value={info.name} />
              <Field label="Secteur" value={info.sector} />
              <Field label="Industrie" value={info.industry} />
              <Field label="FIGI" value={info.figi} copy />
              <Field label="FIGI composite" value={info.compositeFigi} copy />
              <Field label="Pays" value={info.country} />
              <Field label="Employés" value={info.employees?.toLocaleString(LOCALE)} />
              <Field label="Site Web" value={info.website} href={info.website} />
            </div>
            <div className="si-sep" />
            <div className="si-grid">
              <Field label="Type" value={info.type} />
              <Field label="Valeur du point" value={info.pointValue ?? '—'} />
              <Field label="Bourse" value={info.exchange} />
              <Field label="Source des données" value={info.dataSource} />
              <Field label="Devise" value={info.currency} />
              <Field label="Taille du tick" value={info.tickSize != null ? String(+info.tickSize.toPrecision(6)).replace('.', DEC) : undefined} />
            </div>
            <div className="si-sep" />
            <div className="si-label si-section-title">Séance</div>
            <SessionBar info={info} />
            {info.description && (
              <>
                <div className="si-sep" />
                <div className="si-label si-section-title">Description</div>
                <p className={`si-desc ${more ? 'open' : ''}`}>{info.description}</p>
                <button className="si-more" onClick={() => setMore((v) => !v)}>{more ? 'Moins' : 'Plus'}</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
