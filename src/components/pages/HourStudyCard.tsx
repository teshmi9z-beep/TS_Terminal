import { useEffect, useMemo, useState } from 'react';
import { useKept } from '../kept';
import { nextId, useStore } from '../../store/store';
import { MARKET_LABEL, platformSymbol } from '../../data/labSymbols';
import { showOnChart } from '../tabs/tabActions';
import type { HourCell, HourStudy } from '../../robots/report';
import { LOCALE, DEC } from '../../i18n/lang';

// "Range horaire": for every market and hour (Paris time), does the first close out of
// that hour's range give the day's direction? One row a market, one column an hour,
// colored from blue (the break is right more often than the day's plain direction:
// it launches the day) to red (it comes back more often: the break fails), gray when
// it says nothing. A cell is marked when both periods agree (tuning and check).

const LENGTHS: [string, string][] = [['30m', '30 min'], ['1h', '1 h'], ['2h', '2 h'], ['4h', '4 h']];
const CLOSES: [string, string][] = [['c', 'Clôture hors du range'], ['m', 'Clôture franche (20 % du range au-delà)'], ['b', 'Grande bougie (corps ≥ 60 %)']];
type Metric = 'edge' | 'follow' | 'fade';
const METRICS: [Metric, string, string][] = [
  ['edge', 'Direction', 'Précision de la direction de la cassure, moins celle d’un jour quelconque (points)'],
  ['follow', 'Suivre la cassure', 'R moyen par trade dans le sens de la cassure, stop de l’autre côté du range, sortie à 23 h, frais compris'],
  ['fade', 'Contre la cassure', 'R moyen par trade à l’envers de la cassure, sortie à 23 h, frais compris'],
];
// the color scale's ends: 10 points of precision, 0.25 R a trade
const SPAN: Record<Metric, number> = { edge: 10, follow: 0.25, fade: 0.25 };
// both periods agree: 3 points of precision the same way, or R above 0 in both
const confirmed = (m: Metric, is: number, oos: number) => (m === 'edge' ? (is >= 3 && oos >= 3) || (is <= -3 && oos <= -3) : is > 0 && oos > 0);
const CLASS_ORDER = ['Commodity', 'Forex', 'Index', 'Crypto'];
const year = (t: number) => new Date(t * 1000).getUTCFullYear();
const num = (v: number, d: number) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d, signDisplay: 'exceptZero' });

function pick(c: HourCell, m: Metric): [number, number] {
  return m === 'edge' ? [c[2], c[3]] : m === 'follow' ? [c[4], c[5]] : [c[6], c[7]];
}

export default function HourStudyCard() {
  const [data, setData] = useKept<HourStudy | null>('robots.hour.data', null, true);
  const [missing, setMissing] = useState(false);
  const [cls, setCls] = useKept('robots.hour.cls', 'Commodity');
  const [len, setLen] = useKept('robots.hour.len', '1h');
  const [close, setClose] = useKept('robots.hour.close', 'c');
  const [metric, setMetric] = useKept<Metric>('robots.hour.metric', 'edge');
  const [tip, setTip] = useState<{ x: number; y: number; text: string[] } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/robots/hours.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: HourStudy) => { if (alive) setData(j); })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [setData]);

  const rows = useMemo(() => {
    const ms = (data?.markets ?? []).filter((m) => m.market === cls).sort((a, b) => a.symbol.localeCompare(b.symbol));
    // the class's average first (trades weighted alike: one vote a market)
    const avg: (HourCell | null)[] = Array.from({ length: 24 }, (_, H) => {
      const cs = ms.map((m) => m.cells[`${H}_${len}_${close}`]).filter(Boolean);
      if (!cs.length) return null;
      const mean = (k: number) => cs.reduce((a, c) => a + c[k], 0) / cs.length;
      return [mean(0), mean(1), mean(2), mean(3), mean(4), mean(5), mean(6), mean(7)] as HourCell;
    });
    return [
      { symbol: 'Moyenne', market: cls, from: 0, to: 0, split: 0, avg: true, cells: avg },
      ...ms.map((m) => ({ ...m, avg: false, cells: Array.from({ length: 24 }, (_, H) => m.cells[`${H}_${len}_${close}`] ?? null) })),
    ];
  }, [data, cls, len, close]);

  if (missing) return null;
  if (!data) return <div className="rb-card"><div className="rb-note">Chargement de l’étude du range horaire…</div></div>;

  const classes = CLASS_ORDER.filter((c) => data.markets.some((m) => m.market === c));
  const span = SPAN[metric];
  const colorOf = (v: number) => {
    const k = Math.round(Math.min(1, Math.abs(v) / span) * 100);
    return `color-mix(in oklab, var(${v >= 0 ? '--hr-pos' : '--hr-neg'}) ${k}%, var(--hr-mid))`;
  };
  // cells where both periods agree, over the class's markets
  let agreeUp = 0, agreeDown = 0, all = 0;
  for (const r of rows) {
    if (r.avg) continue;
    for (const c of r.cells) {
      if (!c) continue;
      all++;
      const [a, b] = pick(c, metric);
      if (confirmed(metric, a, b)) { if (metric === 'edge' && a < 0) agreeDown++; else agreeUp++; }
    }
  }
  const openChart = (symbol: string, market: string, H: number) => {
    showOnChart(platformSymbol(symbol, market));
    const st = useStore.getState();
    st.setTimeframe('15m');
    for (const i of st.indicators.filter((x) => x.type === 'HOUR_RANGE')) st.removeIndicator(i.id);
    const id = nextId();
    st.addIndicator({ id, type: 'HOUR_RANGE', period: 0, color: '#ff6803', overlay: true, inputs: { targetHour: H } });
    useStore.getState().updateIndicator(id, { inputs: { targetHour: H } });
  };
  const tipText = (sym: string, H: number, c: HourCell, avg: boolean, split: number, from: number, to: number) => {
    const per = avg ? ['réglage (70 % de l’historique)', 'contrôle (30 %)'] : [`réglage ${year(from)}-${year(split)}`, `contrôle ${year(split)}-${year(to)}`];
    return [
      `${sym} · range de ${H} h (${LENGTHS.find(([k]) => k === len)![1]}, heure de Paris)`,
      ...[0, 1].map((p) => `${per[p]} : ${Math.round(c[p]).toLocaleString(LOCALE)} cassures · direction ${num(c[2 + p], 1)} pt · suivre ${num(c[4 + p], 2)} R · contre ${num(c[6 + p], 2)} R`),
      avg ? '' : 'Clic : ouvrir le graphique 15 min avec ce range',
    ].filter(Boolean);
  };

  return (
    <div className="rb-card hr-study">
      <div className="rb-card-title">Range horaire : à quelle heure la cassure lance-t-elle la journée ?</div>
      <div className="rb-note">
        Chaque jour, la bougie de l’heure H (heure de Paris) fait un range ; la première clôture au-dessus ou en dessous, avant 23 h, donne un sens.
        On regarde si le prix à 23 h lui donne raison plus souvent qu’un jour quelconque (même marché, même heure), sur {data.markets.length} marchés
        en 15 minutes{data.from ? `, depuis le ${new Date(data.from * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })}` : ''} :
        les 70 premiers % de la période (réglage) puis les 30 derniers (contrôle). Bleu : la cassure lance la journée ; rouge : elle se retourne ;
        gris : elle ne dit rien. Un point : les deux périodes sont d’accord.
      </div>
      <div className="hr-controls">
        <div className="hr-chips">{classes.map((c) => <button key={c} className={cls === c ? 'on' : ''} onClick={() => setCls(c)}>{MARKET_LABEL[c] ?? c}</button>)}</div>
        <div className="hr-chips">{LENGTHS.map(([k, l]) => <button key={k} className={len === k ? 'on' : ''} onClick={() => setLen(k)} title="Durée du range">Range {l}</button>)}</div>
        <select value={close} onChange={(e) => setClose(e.target.value)} title="Ce qui compte comme une cassure">
          {CLOSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <div className="hr-chips">{METRICS.map(([k, l, t]) => <button key={k} className={metric === k ? 'on' : ''} onClick={() => setMetric(k)} title={t}>{l}</button>)}</div>
      </div>
      <div className="hr-legend">
        <span>{metric === 'edge' ? 'se retourne' : 'perd'}</span>
        <i style={{ background: `linear-gradient(90deg, var(--hr-neg), var(--hr-mid), var(--hr-pos))` }} />
        <span>{metric === 'edge' ? 'lance la journée' : 'gagne'}</span>
        <small>{metric === 'edge' ? `±${span} points de précision` : `±${String(span).replace('.', DEC)} R par trade`} · {METRICS.find(([k]) => k === metric)![2]}</small>
      </div>
      <div className="hr-grid" style={{ gridTemplateColumns: `max-content repeat(24, minmax(22px, 1fr))` }} onMouseLeave={() => setTip(null)}>
        <div className="hr-h" />
        {Array.from({ length: 24 }, (_, H) => <div key={H} className="hr-h">{H}</div>)}
        {rows.map((r) => (
          <div key={r.symbol} className="hr-row" style={{ display: 'contents' }}>
            <div className={`hr-name ${r.avg ? 'avg' : ''}`}>{r.symbol}</div>
            {r.cells.map((c, H) => {
              if (!c) return <div key={H} className="hr-cell empty" />;
              const [a, b] = pick(c, metric);
              const ok = confirmed(metric, a, b);
              return (
                <div
                  key={H}
                  className={`hr-cell ${ok ? 'ok' : ''} ${r.avg ? '' : 'click'}`}
                  style={{ background: colorOf((a + b) / 2) }}
                  onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, text: tipText(r.symbol, H, c, r.avg, r.split, r.from, r.to) })}
                  onClick={() => !r.avg && openChart(r.symbol, r.market, H)}
                >{ok ? '•' : ''}</div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="rb-note hr-foot">
        {metric === 'edge'
          ? `${agreeUp} cases sur ${all} où la cassure lance la journée sur les deux périodes, ${agreeDown} où elle se retourne.`
          : `${agreeUp} cases sur ${all} gagnantes sur les deux périodes, frais compris.`}
        {' '}Frais comptés : ceux du labo (écart et commission moyens) ; le soir les écarts réels sont souvent plus larges.
        {' '}Pendant le rollover du forex (16 h 45 – 18 h 15 à New York, vers 23 h – minuit à Paris), aucun range n’est construit et aucune cassure n’est lue : l’écart explose et
        {' '}l’historique HistData, en prix vendeur seul, plonge puis revient, un faux mouvement qu’on ne peut pas trader.
      </div>
      {tip && (
        // on the cursor's left near the window's right edge
        <div className="hr-tip" style={{ left: tip.x + 14, top: tip.y + 14, transform: tip.x > window.innerWidth - 380 ? 'translateX(calc(-100% - 28px))' : undefined }}>
          {tip.text.map((t, i) => <div key={i} className={i === 0 ? 'b' : ''}>{t}</div>)}
        </div>
      )}
    </div>
  );
}
