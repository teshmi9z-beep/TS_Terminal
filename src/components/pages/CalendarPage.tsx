import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useKept } from '../kept';
import {
  COUNTRIES, ECO_CATEGORIES, G20, countryName, fetchDividends, fetchEarnings, fetchEconomic, fetchIpos, flagUrl,
  type DividendRow, type EarningsRow, type EcoCategory, type EcoEvent, type IpoRow,
} from '../../data/calendar';
import { tvToSymbol } from '../../data/tv';
import { big, fr, pct, price } from '../../data/format';
import { showOnChart } from '../tabs/tabActions';
import { TvLogo } from './common';
import { Dropdown } from './options/ui';
import { LOCALE } from '../../i18n/lang';

type Kind = 'economic' | 'earnings' | 'dividends' | 'ipo';
const KINDS: [Kind, string][] = [['economic', 'Economie'], ['earnings', 'Bénéfices'], ['dividends', 'Dividendes'], ['ipo', 'IPO (Introduction en bourse)']];
const DAY = 86400;
const IPO_STATUS: Record<string, string> = { closed: 'Clôturée', expected: 'Attendue', priced: 'Prix fixé', pending: 'En attente', withdrawn: 'Retirée', postponed: 'Reportée', filed: 'Déposée' };

// ---------------------------------------------------------------- time zones

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONES: [string, string][] = [
  ['Pacific/Honolulu', 'Honolulu'], ['America/Los_Angeles', 'Los Angeles'], ['America/Chicago', 'Chicago'], ['America/New_York', 'New York'],
  ['America/Sao_Paulo', 'São Paulo'], ['UTC', 'UTC'], ['Europe/London', 'Londres'], ['Europe/Paris', 'Paris'], ['Europe/Berlin', 'Berlin'],
  ['Europe/Moscow', 'Moscou'], ['Asia/Dubai', 'Dubaï'], ['Asia/Kolkata', 'Calcutta'], ['Asia/Shanghai', 'Shanghai'],
  ['Asia/Hong_Kong', 'Hong Kong'], ['Asia/Tokyo', 'Tokyo'], ['Australia/Sydney', 'Sydney'],
];
const partsCache = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
    partsCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t * 1000))) if (x.type !== 'literal') p[x.type] = +x.value;
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}
const offsetMin = (t: number, tz: string) => { const p = parts(t, tz); return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - t) / 60); };
const utcLabel = (t: number, tz: string) => { const o = offsetMin(t, tz); return `UTC${o >= 0 ? '+' : '−'}${Math.floor(Math.abs(o) / 60)}${Math.abs(o) % 60 ? `:${String(Math.abs(o) % 60).padStart(2, '0')}` : ''}`; };
function dayStart(t: number, tz: string) { const p = parts(t, tz); const u = Date.UTC(p.year, p.month - 1, p.day) / 1000; return u - offsetMin(u, tz) * 60; }
function weekStart(t: number, tz: string) { const d = dayStart(t, tz); const p = parts(d + 3600 * 12, tz); const wd = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7; return dayStart(d - wd * DAY + 3600 * 12, tz); }
const hhmm = (t: number, tz: string) => { const p = parts(t, tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
const fmt = (t: number, tz: string, o: Intl.DateTimeFormatOptions) => new Date(t * 1000).toLocaleDateString(LOCALE, { timeZone: tz, ...o });

// ---------------------------------------------------------------- stored preferences

const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function Importance({ level }: { level: EcoEvent['impact'] }) {
  const n = level === 'High' ? 3 : level === 'Medium' ? 2 : level === 'Low' ? 1 : 0;
  return (
    <svg className="cal-imp" width="14" height="14" viewBox="0 0 14 14" aria-label={`Importance ${n}/3`}>
      {[0, 1, 2].map((i) => <rect key={i} x={1 + i * 4.5} y={9 - i * 3.5} width="3" height={4 + i * 3.5} rx="0.5" className={i < n ? 'on' : ''} />)}
    </svg>
  );
}

function Countdown({ to, now }: { to: number; now: number }) {
  const s = Math.max(0, Math.round(to - now));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return <span className="cal-soon">A venir dans {h ? `${h}:${String(m).padStart(2, '0')}` : m}:{String(sec).padStart(2, '0')}</span>;
}

type Week = { eco: EcoEvent[] | null; earnings: EarningsRow[] | null; dividends: DividendRow[] | null; ipo: IpoRow[] | null; errors: Partial<Record<Kind, string>> };
function groupByDay<T>(list: T[] | null, time: (r: T) => number, dayOf: (t: number) => number): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of list ?? []) {
    const k = dayOf(time(r));
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}
const EMPTY_WEEK: Week = { eco: null, earnings: null, dividends: null, ipo: null, errors: {} };
const NONE_E: EarningsRow[] = [], NONE_D: DividendRow[] = [], NONE_I: IpoRow[] = [];

// TradingView's calendar: a week of economic events, earnings, dividends and IPOs
export default function CalendarPage() {
  const [tz, setTzState] = useState<string>(() => read('tesh.cal.tz', LOCAL_TZ));
  const [now, setNow] = useState(() => Date.now() / 1000);
  // the week and day shown come back with the tab (until the app closes), the filters always
  const [week, setWeek] = useKept('cal.week', () => weekStart(Date.now() / 1000, read('tesh.cal.tz', LOCAL_TZ)), true);
  const [day, setDay] = useKept('cal.day', () => dayStart(Date.now() / 1000, read('tesh.cal.tz', LOCAL_TZ)), true);
  const [kind, setKind] = useKept<Kind>('cal.kind', 'economic');
  const [countries, setCountriesState] = useState<string[] | null>(() => read('tesh.cal.countries', null));
  const [importance, setImportance] = useKept<0 | 2 | 3>('cal.importance', 0);
  const [cats, setCats] = useKept<EcoCategory[] | null>('cal.cats', null);
  const [cardsOpen, setCardsOpen] = useKept('cal.cardsOpen', true);
  const [data, setData] = useKept<{ key: string } & Week>('cal.data', { key: '', eco: null, earnings: null, dividends: null, ipo: null, errors: {} }, true);
  const dateRef = useRef<HTMLInputElement>(null);

  const setTz = (z: string) => { setTzState(z); write('tesh.cal.tz', z); setWeek(weekStart(day + 3600 * 12, z)); setDay(dayStart(day + 3600 * 12, z)); };
  const setCountries = (c: string[] | null) => { setCountriesState(c); write('tesh.cal.countries', c); };
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(id); }, []);

  const markets = useMemo(() => (countries ? COUNTRIES.filter((c) => countries.includes(c.code) && c.market).map((c) => c.market!) : null), [countries]);
  const key = `${week}|${markets?.join(',') ?? 'all'}`;
  useEffect(() => {
    const ctrl = new AbortController();
    const from = week, to = week + 7 * DAY;
    const set = (patch: Partial<Week>) => { if (!ctrl.signal.aborted) setData((d) => ({ ...(d.key === key ? d : EMPTY_WEEK), ...patch, key })); };
    const fail = (k: Kind) => (e: unknown) => set({ errors: { [k]: e instanceof Error ? e.message : String(e) } });
    fetchEconomic().then((eco) => set({ eco }), fail('economic'));
    // only the euro area chosen: no stock market
    if (markets && !markets.length) return () => ctrl.abort();
    fetchEarnings(from, to, markets, ctrl.signal).then((earnings) => set({ earnings }), fail('earnings'));
    fetchDividends(from, to, markets, ctrl.signal).then((dividends) => set({ dividends }), fail('dividends'));
    fetchIpos(from, to, markets, ctrl.signal).then((ipo) => set({ ipo }), fail('ipo'));
    return () => ctrl.abort();
  }, [key, week, markets, setData]);
  const noStocks = markets != null && !markets.length;
  const loaded: Week = data.key === key ? data : EMPTY_WEEK;
  const d: Week = noStocks ? { ...loaded, earnings: NONE_E, dividends: NONE_D, ipo: NONE_I } : loaded;

  const inCountry = (c: string | null) => !countries || (c != null && countries.includes(c));
  const eco = useMemo(() => (d.eco ?? []).filter((e) => e.time >= week && e.time < week + 7 * DAY && inCountry(e.country)), [d.eco, week, countries]); // eslint-disable-line react-hooks/exhaustive-deps
  const keep = (e: EcoEvent) => (!importance || (importance === 2 ? e.impact === 'Medium' || e.impact === 'High' : e.impact === 'High')) && (!cats || cats.includes(e.category));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => dayStart(week + i * DAY + 3600 * 12, tz)), [week, tz]);
  // the rows of each day of the week (in the chosen time zone)
  const byDay = useMemo(() => {
    const starts = new Map<number, number>();
    const dayOf = (t: number) => { let v = starts.get(t); if (v == null) { v = dayStart(t, tz); starts.set(t, v); } return v; };
    return {
      eco: groupByDay(eco, (e) => e.time, dayOf), earnings: groupByDay(d.earnings, (r) => r.date, dayOf),
      dividends: groupByDay(d.dividends, (r) => r.exDate, dayOf), ipo: groupByDay(d.ipo, (r) => r.date, dayOf),
    };
  }, [eco, d.earnings, d.dividends, d.ipo, tz]);
  const counts = (d0: number) => ({
    economic: byDay.eco.get(d0)?.length ?? 0, earnings: byDay.earnings.get(d0)?.length ?? 0,
    dividends: byDay.dividends.get(d0)?.length ?? 0, ipo: byDay.ipo.get(d0)?.length ?? 0,
  });
  const today = dayStart(now, tz);
  const goWeek = (n: number) => { const w = weekStart(week + n * 7 * DAY + 3600 * 12, tz); setWeek(w); setDay(w + (day - week)); };
  const jump = (t: number) => { setWeek(weekStart(t, tz)); setDay(dayStart(t, tz)); };
  const nextEvent = eco.find((e) => e.time > now && keep(e))?.time ?? null;

  // ---------- day tables
  const dayTitle = fmt(day + 3600 * 12, tz, { weekday: 'long', day: 'numeric', month: 'long' });
  let body: ReactNode = null;
  if (kind === 'economic') {
    const rows = (byDay.eco.get(day) ?? []).filter(keep);
    body = (
      <table className="cal-table">
        <thead><tr><th colSpan={4} className="left cal-day-title">{dayTitle}</th><th>Actuel</th><th>Prévision</th><th>Précédent</th></tr></thead>
        <tbody>
          {rows.map((e, i) => {
            const prev = rows[i - 1];
            const sameTime = prev && prev.time === e.time;
            return (
              <tr key={`${e.time}${e.title}${i}`} className={e.time < now ? 'past' : ''}>
                <td className="cal-time">{!sameTime && (e.impact === 'Holiday' ? 'Journée' : <span className={e.time === nextEvent ? 'cal-next' : ''}>{hhmm(e.time, tz)}</span>)}</td>
                <td className="cal-country">{!(sameTime && prev.country === e.country) && <><img src={flagUrl(e.country)} alt="" />{countryName(e.country)}</>}</td>
                <td className="cal-imp-cell"><Importance level={e.impact} /></td>
                <td className="left cal-title">{e.title}</td>
                <td className="cal-actual">{e.actual || (e.time > now && e.time - now < 3600 ? <Countdown to={e.time} now={now} /> : '')}</td>
                <td>{e.forecast}</td>
                <td>{e.previous}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
    if (!d.eco && !d.errors.economic) body = <div className="pg-empty"><span className="spinner" /> Chargement…</div>;
    else if (!rows.length) body = <>{body}<div className="pg-empty">{week !== weekStart(now, tz) ? 'Le flux économique gratuit (ForexFactory) ne couvre que la semaine en cours.' : 'Aucun événement ce jour-là avec ces filtres.'}</div></>;
  } else if (kind === 'earnings') {
    const rows = byDay.earnings.get(day) ?? [];
    const surprise = (a: number | null, b: number | null) => (a != null && b ? ((a - b) / Math.abs(b)) * 100 : null);
    body = !d.earnings ? <div className="pg-empty"><span className="spinner" /> Chargement…</div> : (
      <table className="cal-table">
        <thead><tr><th className="left cal-day-title">{dayTitle}</th><th>Capitalisation (USD)</th><th>BPA estimé</th><th>BPA déclaré</th><th>Surprise</th><th>Revenu estimé</th><th>Revenu déclaré</th><th>Surprise</th><th>Moment</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const s1 = surprise(r.epsActual, r.epsEstimate), s2 = surprise(r.revenueActual, r.revenueEstimate);
            return (
              <tr key={r.id} className="click" onClick={() => showOnChart(tvToSymbol(r.id, r.name))}>
                <td className="left pg-sym"><TvLogo logoid={r.logoid} text={r.ticker} /><b>{r.ticker}</b><span>{r.name}</span></td>
                <td>{big(r.marketCap)}</td>
                <td>{r.epsEstimate != null ? fr(r.epsEstimate) : '—'}</td>
                <td>{r.epsActual != null ? fr(r.epsActual) : '—'}</td>
                <td className={s1 == null ? '' : s1 >= 0 ? 'up' : 'down'}>{pct(s1)}</td>
                <td>{big(r.revenueEstimate)}</td>
                <td>{big(r.revenueActual)}</td>
                <td className={s2 == null ? '' : s2 >= 0 ? 'up' : 'down'}>{pct(s2)}</td>
                <td title={r.when === 'before' ? 'Avant l’ouverture' : r.when === 'after' ? 'Après la clôture' : 'Heure non communiquée'}>{r.when === 'before' ? '☀' : r.when === 'after' ? '☾' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
    if (d.earnings && !rows.length) body = <>{body}<div className="pg-empty">Aucune publication ce jour-là.</div></>;
  } else if (kind === 'dividends') {
    const rows = byDay.dividends.get(day) ?? [];
    body = !d.dividends ? <div className="pg-empty"><span className="spinner" /> Chargement…</div> : (
      <table className="cal-table">
        <thead><tr><th className="left cal-day-title">{dayTitle} · détachement</th><th>Dividende</th><th>Rendement</th><th>Cours</th><th>Date de paiement</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.id}${r.exDate}`} className="click" onClick={() => showOnChart(tvToSymbol(r.id, r.name))}>
              <td className="left pg-sym"><TvLogo logoid={r.logoid} text={r.ticker} /><b>{r.ticker}</b><span>{r.name}</span></td>
              <td>{r.amount != null ? `${fr(r.amount, 3)} ${r.currency}` : '—'}</td>
              <td>{r.yieldPct != null ? `${fr(r.yieldPct)}%` : '—'}</td>
              <td>{price(r.close)}</td>
              <td>{r.payDate ? fmt(r.payDate, tz, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    if (d.dividends && !rows.length) body = <>{body}<div className="pg-empty">Aucun détachement ce jour-là.</div></>;
  } else {
    const rows = byDay.ipo.get(day) ?? [];
    body = !d.ipo ? <div className="pg-empty"><span className="spinner" /> Chargement…</div> : (
      <table className="cal-table">
        <thead><tr><th className="left cal-day-title">{dayTitle}</th><th>Bourse</th><th>Prix (USD)</th><th>Actions offertes</th><th>Montant levé</th><th>Capitalisation</th><th>Statut</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => showOnChart(tvToSymbol(r.id, r.name))}>
              <td className="left pg-sym"><TvLogo logoid={r.logoid} text={r.ticker} /><b>{r.ticker}</b><span>{r.name}</span></td>
              <td>{r.exchange}</td>
              <td>{r.price != null ? fr(r.price) : r.rangeLo != null ? `${fr(r.rangeLo)} – ${fr(r.rangeHi ?? r.rangeLo)}` : '—'}</td>
              <td>{big(r.shares)}</td>
              <td>{big(r.amount)}</td>
              <td>{big(r.cap)}</td>
              <td>{IPO_STATUS[r.status] ?? (r.status || '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    if (d.ipo && !rows.length) body = <>{body}<div className="pg-empty">Aucune introduction en bourse ce jour-là.</div></>;
  }

  const zoneLabel = (z: string) => `(${utcLabel(now, z)}) ${ZONES.find((x) => x[0] === z)?.[1] ?? z.split('/').pop()?.replace('_', ' ')}`;
  const regions = ['Amériques', 'Europe', 'Asie-Pacifique', 'Moyen-Orient et Afrique'] as const;

  return (
    <div className="pg cal-page">
      <div className="pg-head">
        <h1>Calendrier</h1>
        <button className="hm-icon" title={cardsOpen ? 'Masquer la semaine' : 'Afficher la semaine'} onClick={() => setCardsOpen(!cardsOpen)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ transform: cardsOpen ? '' : 'rotate(180deg)' }}><path d="M4 10l4-4 4 4" /></svg>
        </button>
      </div>
      <div className="cal-bar">
        <button className="cal-today" onClick={() => jump(now)}>Aujourd’hui</button>
        <button className="hm-icon" title="Choisir une date" onClick={() => dateRef.current?.showPicker?.()}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2.5" y="3.5" width="13" height="12" rx="2" /><path d="M2.5 7.5h13M6 2v3M12 2v3" /></svg>
        </button>
        <input ref={dateRef} className="cal-date-input" type="date" onChange={(e) => { if (e.target.value) jump(Date.parse(`${e.target.value}T12:00:00Z`) / 1000); }} />
        <button className="hm-icon" title="Semaine précédente" onClick={() => goWeek(-1)}>‹</button>
        <button className="hm-icon" title="Semaine suivante" onClick={() => goWeek(1)}>›</button>
        <span className="cal-range">{fmt(week + 3600 * 12, tz, { day: 'numeric', month: 'short' })} — {fmt(week + 6 * DAY + 3600 * 12, tz, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <span className="op-spacer" />
        <Dropdown align="right" title="Pays" label={<><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="9" cy="9" r="6.5" /><path d="M2.5 9h13M9 2.5c2 2 2.8 4.2 2.8 6.5S11 13.5 9 15.5M9 2.5C7 4.5 6.2 6.7 6.2 9S7 13.5 9 15.5" /></svg><span>{!countries ? 'Tous les pays' : countries.length === G20.length && G20.every((c) => countries.includes(c)) ? 'G20' : `${countries.length} pays`}</span></>}>
          {() => (
            <div className="cal-countries">
              <div className="cal-presets">
                <button className={!countries ? 'active' : ''} onClick={() => setCountries(null)}>Tous</button>
                <button onClick={() => setCountries(G20)}>G20</button>
                {regions.map((r) => <button key={r} onClick={() => setCountries(COUNTRIES.filter((c) => c.region === r).map((c) => c.code))}>{r}</button>)}
              </div>
              {regions.map((r) => (
                <div key={r}>
                  <div className="op-dd-head">{r}</div>
                  {COUNTRIES.filter((c) => c.region === r).map((c) => (
                    <label key={c.code} className="home-check">
                      <input
                        type="checkbox" checked={!countries || countries.includes(c.code)}
                        onChange={(e) => { const cur = countries ?? COUNTRIES.map((x) => x.code); setCountries(e.target.checked ? [...cur, c.code] : cur.filter((x) => x !== c.code)); }}
                      />
                      <img className="cal-flag" src={flagUrl(c.code)} alt="" />{c.name}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Dropdown>
        <Dropdown align="right" title="Fuseau horaire" label={<><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6.3" /><path d="M8 4.5V8l2.5 1.5" /></svg><b>{hhmm(now, tz)}</b><span>({utcLabel(now, tz)})</span></>}>
          {(close) => (
            <div className="op-dd-list">
              <button className={tz === LOCAL_TZ ? 'active' : ''} onClick={() => { setTz(LOCAL_TZ); close(); }}>Heure locale {zoneLabel(LOCAL_TZ)}</button>
              {ZONES.map(([z]) => <button key={z} className={tz === z ? 'active' : ''} onClick={() => { setTz(z); close(); }}>{zoneLabel(z)}</button>)}
            </div>
          )}
        </Dropdown>
      </div>

      {cardsOpen && (
        <div className="cal-week">
          {days.map((d0) => {
            const c = counts(d0);
            const lines: [string, number][] = [['Economie', c.economic], ['Bénéfices', c.earnings], ['Dividendes', c.dividends], ['IPO (Introduction en bourse)', c.ipo]];
            return (
              <button key={d0} className={`cal-card ${d0 === day ? 'active' : ''} ${d0 === today ? 'today' : ''}`} onClick={() => setDay(d0)}>
                <b>{fmt(d0 + 3600 * 12, tz, { weekday: 'short', day: 'numeric' })}</b>
                {lines.filter(([, n]) => n > 0).map(([l, n]) => <span key={l}><em>{l}</em><i>{n}</i></span>)}
              </button>
            );
          })}
        </div>
      )}

      <div className="cal-tabs">
        <div className="pg-chips">
          {KINDS.map(([id, l]) => <button key={id} className={`pg-chip ${kind === id ? 'active' : ''}`} onClick={() => setKind(id)}>{l}</button>)}
        </div>
        <span className="op-spacer" />
        {kind === 'economic' && (
          <>
            <Dropdown align="right" title="Importance" label={<Importance level={importance === 3 ? 'High' : importance === 2 ? 'Medium' : 'Low'} />}>
              {(close) => (
                <div className="op-dd-list">
                  {([[0, 'Toutes les importances'], [2, 'Moyenne et élevée'], [3, 'Élevée seulement']] as [0 | 2 | 3, string][]).map(([v, l]) => (
                    <button key={v} className={importance === v ? 'active' : ''} onClick={() => { setImportance(v); close(); }}>{l}</button>
                  ))}
                </div>
              )}
            </Dropdown>
            <Dropdown align="right" label={<><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 4h9M5 8h9M5 12h9M2 4h.5M2 8h.5M2 12h.5" /></svg>{!cats ? 'Toutes les catégories' : cats.length === 1 ? ECO_CATEGORIES.find((c) => c[0] === cats[0])?.[1] : `${cats.length} catégories`}</>}>
              {() => (
                <div className="op-dd-list">
                  <label className="home-check"><input type="checkbox" checked={!cats} onChange={() => setCats(cats ? null : [])} />Toutes les catégories</label>
                  {ECO_CATEGORIES.map(([id, l]) => (
                    <label key={id} className="home-check">
                      <input type="checkbox" checked={!cats || cats.includes(id)} onChange={(e) => { const cur = cats ?? ECO_CATEGORIES.map((c) => c[0]); const next = e.target.checked ? [...cur, id] : cur.filter((x) => x !== id); setCats(next.length === ECO_CATEGORIES.length ? null : next); }} />{l}
                    </label>
                  ))}
                </div>
              )}
            </Dropdown>
          </>
        )}
      </div>
      {d.errors[kind] && <div className="pg-error">{d.errors[kind]}</div>}
      <div className="pg-scroll cal-body">{body}</div>
      <div className="pg-note">
        {kind === 'economic'
          ? 'Événements économiques : ForexFactory (semaine en cours ; la valeur publiée n’est pas fournie par ce flux gratuit).'
          : 'Données TradingView (actions et certificats de dépôt, cotations principales).'}
      </div>
    </div>
  );
}
