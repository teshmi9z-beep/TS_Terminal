import { useEffect, useMemo, useState } from 'react';
import { useKept } from '../kept';
import { nextId, useStore } from '../../store/store';
import { MARKET_LABEL, platformSymbol, platformTf } from '../../data/labSymbols';
import { openChartTab } from '../tabs/tabActions';
import type { IndicatorConfig, Timeframe } from '../../types';
import { LineChart } from './options/ui';
import { LOCALE } from '../../i18n/lang';

// "Structure Dow": what the night's study of the Dow structure indicator found
// (scripts/robots/dow-study.ts, dow-report.ts --publish -> public/robots/dow.json):
// the settings kept (chosen on the first 70 % of the history, checked on the last 30 %,
// real costs), the market's active hours (Paris time, as on Mataf's volatility page), and
// each market's best setting with its check. A click opens the chart with the indicator
// set as the robot.

type S = { n: number; ry: number; pf: number; win: number; dd: number; exp: number };
// a year: [year, trades, R]
type Year = [number, number, number];
export type DowPick = {
  id: string; symbol: string; market: string; tf: string; source: string; key: string; label: string;
  inputs: Record<string, number | string | boolean>; is: S | null; oos: S | null; years: Year[]; note?: string;
  // re-tuned once a year: each year from 2023 traded with the best setting of the years before
  wf: { total: number; steps: Year[] };
  // share of random-entry runs (same trend, stops, exits, costs) the robot beats
  luck?: { is: number | null; oos: number | null };
};
export type DowStudy = {
  generatedAt: number; from: number; split: number; verdict: string[];
  picks: DowPick[];
  markets: { id: string; symbol: string; market: string; tf: string; key: string | null; label: string; is: S | null; oos: S | null; ok: boolean; wf: number | null; wfYears: Year[] }[];
  hours: { symbol: string; market: string; profile: number[]; med: number[]; top: number[] }[];
  raw: { market: string; tf: string; raw: number; net: number }[];
  // the walk-forward of every market of a class added up (no market chosen after the fact)
  // all: the same with stage 1's 144 settings only to choose from
  classes?: { market: string; tf: string; total: number; markets: number; positive: number; years: [number, number][]; all?: number | null }[];
  // the kept robots on one account since 2023, their walk-forward trades
  portfolio?: {
    start: number; risk: number; trades: number; final: number; maxDD: number; years: [number, number][]; curve: [number, number][];
    // the drawdown with the trades in random orders (median, 1 in 20); the end with costs × 1.5
    ddMedian?: number; dd95?: number; finalCosts15?: number;
  } | null;
};

const TF_NAME: Record<string, string> = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '1h': '1 h', '4h': '4 h', '1d': 'Jour', '150T': '150 ticks', '250T': '250 ticks', '500T': '500 ticks', '1000T': '1000 ticks' };
const num = (v: number, d = 1) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const sR = (v: number, d = 1) => `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)} R`;
const CLASS_ORDER = ['Forex', 'Index', 'Commodity', 'Crypto'];

// the platform shows ticks for Binance's markets only: a HistData tick robot opens on 1 minute
function chartTf(p: DowPick): Timeframe {
  if (/T$/.test(p.tf) && p.source === 'HistData') return '1m' as Timeframe;
  return platformTf(p.tf);
}

function open(p: DowPick) {
  const cfg: IndicatorConfig = { id: nextId(), type: 'DOW_STRUCTURE', period: 0, color: '#2962ff', overlay: true, visible: true, inputs: p.inputs };
  useStore.getState().setBottomDock({ tab: null });
  openChartTab(platformSymbol(p.symbol, p.market), chartTf(p), [cfg]);
}

function Hours({ h }: { h: DowStudy['hours'][number] }) {
  // from the quietest hour to the busiest, as Mataf's chart
  const max = Math.max(...h.profile), min = Math.min(...h.profile), span = max - min || 1;
  return (
    <div className="dow-hours">
      {h.profile.map((v, H) => {
        const top = h.top.includes(H), med = h.med.includes(H);
        return (
          <div key={H} className="dow-hour" title={`${H} h – ${H + 1} h (Paris) : ${top ? 'très active' : med ? 'active' : 'calme'}`}>
            <div className={`dow-bar ${top ? 'top' : med ? 'med' : ''}`} style={{ height: `${8 + ((v - min) / span) * 92}%` }} />
            <span>{H}</span>
          </div>
        );
      })}
    </div>
  );
}

// onPick: shows a kept robot's report (the list's robot, with its chart and its tester)
export default function DowStudyCard({ onPick }: { onPick?: (id: string) => void } = {}) {
  const [data, setData] = useKept<DowStudy | null>('robots.dow.data', null, true);
  const [missing, setMissing] = useState(false);
  const [hourSym, setHourSym] = useKept('robots.dow.hourSym', '');
  const [showAll, setShowAll] = useKept('robots.dow.showAll', false);

  useEffect(() => {
    let alive = true;
    fetch(`/robots/dow.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: DowStudy) => { if (alive) { setData(j); setHourSym((h) => h || (j.hours[0]?.symbol ?? '')); } })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [setData, setHourSym]);

  const markets = useMemo(() => [...(data?.markets ?? [])].sort((a, z) => CLASS_ORDER.indexOf(a.market) - CLASS_ORDER.indexOf(z.market) || a.symbol.localeCompare(z.symbol)), [data]);
  if (missing) return <div className="rb-card"><div className="rb-note">L’étude de la structure de Dow n’a pas encore été publiée.</div></div>;
  if (!data) return <div className="rb-card"><div className="rb-note">Chargement de l’étude…</div></div>;
  const hours = data.hours.find((h) => h.symbol === hourSym);

  return (
    <>
      <div className="rb-card">
        <div className="rb-card-title">Structure de marché (Dow) · ce que dit l’étude</div>
        <ul className="dow-verdict">{data.verdict.map((v, i) => <li key={i}>{v}</li>)}</ul>
        <div className="rb-note">
          Réglage sur les 70 premiers % de l’historique (depuis le 1er janvier 2020), validation sur les 30 derniers %, jamais utilisés pour choisir.
          Frais réels de chaque marché, aller et retour, comptés en R (1 R = le risque du trade).
        </div>
      </div>

      {!!data.classes?.length && (
        <div className="rb-card">
          <div className="rb-card-title">Walk-forward par classe de marchés (tous les marchés, réglage refait chaque année)</div>
          <table className="rb-table rb-general">
            <thead><tr><th>Classe</th><th>Unité</th><th>Total depuis 2023</th><th>Marchés positifs</th><th>Par année</th><th title="Le même walk-forward quand il ne choisit que parmi les 144 réglages de départ (au lieu d’environ 1 300)">Avec les réglages de départ</th></tr></thead>
            <tbody>
              {data.classes.map((c) => (
                <tr key={c.market + c.tf}>
                  <td>{MARKET_LABEL[c.market] ?? c.market}</td><td>{TF_NAME[c.tf] ?? c.tf}</td>
                  <td className={c.total >= 0 ? 'up' : 'down'}>{sR(c.total, 0)}</td>
                  <td>{c.positive} / {c.markets}</td>
                  <td className="left"><div className="dow-years">{c.years.map(([y, r]) => <span key={y} className={r >= 0 ? 'up' : 'down'}>{String(y).slice(2)} {sR(r, 0)}</span>)}</div></td>
                  <td className={(c.all ?? 0) >= 0 ? 'up' : 'down'}>{c.all == null ? '—' : sR(c.all, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rb-note">
            Le chiffre sans tri après coup : si tu avais tradé tous les marchés d’une classe avec le réglage refait chaque année (parmi les quelque
            1 300 réglages essayés dans la nuit ; dernière colonne : parmi les 144 de départ seulement). Là où les deux colonnes ne sont pas d’accord,
            le résultat dépend des réglages laissés au choix : il est fragile. Les robots ne sont retenus que dans les classes qui gagnent dans les deux
            (au total, et sur la moitié des marchés au moins).
          </div>
        </div>
      )}

      <div className="rb-card">
        <div className="rb-card-title">Robots retenus ({data.picks.length})</div>
        <div className="rb-note">
          Retenus sur le walk-forward : chaque année depuis 2023 est tradée avec le réglage qui avait le mieux marché
          les années d’avant, comme si tu réglais le robot une fois par an. Le réglage affiché est celui à utiliser
          aujourd’hui (le meilleur de toutes les années).
        </div>
        {data.picks.length ? (
          <table className="rb-table rb-general">
            <thead><tr><th>Marché</th><th>Unité</th><th>Réglage à utiliser</th><th>Walk-forward depuis 2023</th><th>Ce réglage depuis 2020</th><th title="Part des 200 tirages d’entrées au hasard (même tendance, mêmes stops, mêmes sorties, mêmes frais) que le robot bat en validation">Bat le hasard</th><th /></tr></thead>
            <tbody>
              {data.picks.map((p) => (
                <tr key={p.id + p.key}>
                  <td><b>{p.symbol}</b><small>{MARKET_LABEL[p.market] ?? p.market}</small></td>
                  <td>{TF_NAME[p.tf] ?? p.tf}</td>
                  <td className="left"><small>{p.label}</small>{p.note && <small className="rb-warn">{p.note}</small>}</td>
                  <td className={p.wf.total >= 0 ? 'up left' : 'down left'}>
                    {sR(p.wf.total, 0)}
                    <div className="dow-years">
                      {p.wf.steps.map(([y, n, r]) => <span key={y} className={r >= 0 ? 'up' : 'down'} title={`${y} : ${n} trades, ${sR(r)}`}>{String(y).slice(2)} {sR(r, 0)}</span>)}
                    </div>
                  </td>
                  <td className="left">
                    <div className="dow-years">
                      {p.years.map(([y, n, r]) => <span key={y} className={r >= 0 ? 'up' : 'down'} title={`${y} : ${n} trades, ${sR(r)}`}>{String(y).slice(2)}</span>)}
                    </div>
                    {p.oos && <small>validation {sR(p.oos.ry, 0)}/an · PF {num(p.oos.pf, 2)} · {num(p.oos.win, 0)} % gagnants</small>}
                  </td>
                  <td>{p.luck && p.luck.oos != null ? <>{num((p.luck.oos ?? 0) * 100, 0)} %<small>réglage {p.luck.is != null ? `${num(p.luck.is * 100, 0)} %` : '—'}</small></> : '—'}</td>
                  <td>{onPick
                    ? <button className="pill-btn" onClick={() => onPick(`dow_${p.id}`)}>Voir le robot</button>
                    : <button className="pill-btn" onClick={() => open(p)}>Ouvrir le graphique</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="rb-note">Aucun réglage ne tient à la fois le réglage, la validation et la plupart des années.</div>}
      </div>

      {data.portfolio && (
        <div className="rb-card">
          <div className="rb-card-title">Les robots retenus sur un compte de {data.portfolio.start.toLocaleString(LOCALE)} € depuis 2023</div>
          <LineChart
            height={200}
            series={[{ label: 'Compte', color: data.portfolio.final >= data.portfolio.start ? '#089981' : '#f23645', points: data.portfolio.curve }]}
            xFmt={(x) => new Date(x * 1000).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' })}
            yFmt={(y) => `${Math.round(y).toLocaleString(LOCALE)} €`}
          />
          <div className="rb-note">
            {data.portfolio.trades} trades, {num(data.portfolio.risk * 100, 1)} % du compte risqué par trade, chaque année avec le réglage choisi sur les années d’avant :
            {' '}{data.portfolio.start.toLocaleString(LOCALE)} € → {data.portfolio.final.toLocaleString(LOCALE)} €, pire creux {num(data.portfolio.maxDD, 1)} %
            {' '}({data.portfolio.years.map(([y, p]) => `${y} : ${p >= 0 ? '+' : ''}${num(p, 1)} %`).join(', ')}).
            {data.portfolio.dd95 != null && <> Les mêmes trades dans un autre ordre : pire creux de {num(data.portfolio.ddMedian ?? 0, 1)} % en moyenne, {num(data.portfolio.dd95, 1)} % une fois sur 20.</>}
            {data.portfolio.finalCosts15 != null && <> Avec des frais 50 % plus chers : {data.portfolio.finalCosts15.toLocaleString(LOCALE)} €.</>}
            {' '}Les marchés eux-mêmes ont été choisis avec ces années : le résultat reste optimiste.
          </div>
        </div>
      )}

      {hours && (
        <div className="rb-card">
          <div className="rb-card-title rb-hours-title">
            Heures actives (heure de Paris), comme la page volatilité de Mataf
            <select value={hourSym} onChange={(e) => setHourSym(e.target.value)}>
              {data.hours.map((h) => <option key={h.symbol} value={h.symbol}>{h.symbol}</option>)}
            </select>
          </div>
          <Hours h={hours} />
          <div className="rb-note">
            Mouvement moyen du prix dans chaque heure (période de réglage). En couleur vive : les heures les plus actives (le tiers haut),
            en clair : actives (au-dessus de la médiane). Les réglages « heures actives » ne prennent de trades que là.
          </div>
        </div>
      )}

      <div className="rb-card">
        <button className="rb-card-title rb-toggle" onClick={() => setShowAll(!showAll)}>
          {showAll ? '▾' : '▸'} Meilleur réglage de chaque marché ({markets.length})
        </button>
        {showAll && (
          <>
            <table className="rb-table rb-general">
              <thead><tr><th>Marché</th><th>Unité</th><th>Meilleur réglage (choisi sur le réglage)</th><th>Réglage</th><th>Validation</th><th /><th>Walk-forward</th></tr></thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.id}>
                    <td><b>{m.symbol}</b><small>{MARKET_LABEL[m.market] ?? m.market}</small></td>
                    <td>{TF_NAME[m.tf] ?? m.tf}</td>
                    <td className="left"><small>{m.key ? m.label : 'aucun réglage gagnant en réglage'}</small></td>
                    <td className={(m.is?.ry ?? 0) >= 0 ? 'up' : 'down'}>{m.is ? `${sR(m.is.ry, 0)}/an` : '—'}</td>
                    <td className={(m.oos?.ry ?? 0) >= 0 ? 'up' : 'down'}>{m.oos ? `${sR(m.oos.ry, 0)}/an` : '—'}<small>{m.oos ? `${m.oos.n} trades · PF ${num(m.oos.pf, 2)}` : ''}</small></td>
                    <td>{m.ok ? '✓' : ''}</td>
                    <td className={(m.wf ?? 0) >= 0 ? 'up' : 'down'} title={m.wfYears.map(([y, n, r]) => `${y} : ${n} trades, ${sR(r)}`).join(' · ')}>{m.wf == null ? '—' : sR(m.wf, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="rb-card-title" style={{ marginTop: 14 }}>Avantage brut de la méthode (R par trade en validation, moyenne des réglages)</div>
            <table className="rb-table">
              <thead><tr><th>Marché</th><th>Unité</th><th>Sans frais</th><th>Avec frais</th></tr></thead>
              <tbody>
                {data.raw.map((r) => (
                  <tr key={r.market + r.tf}>
                    <td>{MARKET_LABEL[r.market] ?? r.market}</td><td>{TF_NAME[r.tf] ?? r.tf}</td>
                    <td className={r.raw >= 0 ? 'up' : 'down'}>{sR(r.raw, 3)}</td><td className={r.net >= 0 ? 'up' : 'down'}>{sR(r.net, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
