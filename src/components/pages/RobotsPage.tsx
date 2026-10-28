import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { onRobotStatus, robotStatus } from '../../robots/autoRunner';
import { nextId, useStore } from '../../store/store';
import { robotInputs } from '../../robots/robotIndicator';
import { ROLE_LABEL, robotParts } from '../../robots/robotChart';
import { MARKET_LABEL, TF_LABEL, platformSymbol, platformTf } from '../../data/labSymbols';
import { SYMBOLS } from '../../data/symbols';
import { activateTab, openChartTab } from '../tabs/tabActions';
import { LineChart } from './options/ui';
import HourStudyCard from './HourStudyCard';
import DowStudyCard from './DowStudyCard';
import EmRobotCard from './EmRobotCard';
import type { Stats } from '../../robots/engine';
import { REAL_COSTS_FROM, type GeneralSetting, type RobotReport, type RobotStrategy } from '../../robots/report';
import type { IndicatorConfig } from '../../types';
import { LOCALE, DEC } from '../../i18n/lang';

// "Robots de trading": the strategies the lab kept (most profitable, meeting the
// criteria on the tuning AND the validation periods), each with a full report.

const eur = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { maximumFractionDigits: 0 })} €`;
const pct = (v: number, d = 1) => `${v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d })} %`;
const n2 = (v: number) => (v >= 99 ? '∞' : v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rr = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE, { maximumFractionDigits: 2 })} R`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = (t: number) => new Date(t * 1000).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const toPlatform = (s: RobotStrategy) => platformSymbol(s.symbol, s.market);

type Sort = 'annual' | 'profit' | 'winRate' | 'ratio' | 'dd' | 'robust';
const SORTS: [Sort, string][] = [['annual', 'Rendement annuel'], ['profit', 'Profit net total'], ['winRate', 'Trades gagnants'], ['ratio', 'Ratio gains/pertes'], ['dd', 'Drawdown le plus faible'], ['robust', 'Robustesse']];

// the page's choices (sort, market, selection, robot) survive leaving the tab and a reload
const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
function useKept<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => read(`tesh.robots.${key}`, init));
  return [v, (x: T) => { setV(x); write(`tesh.robots.${key}`, x); }];
}
// kept while the app runs: on coming back the report shows at once, scrolled where it was
let lastReport: RobotReport | null = null;
const scrolled = { list: 0, main: 0 };

// a study's card, folded above the robot chosen in the list (open when asked, remembered)
function Folded({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useKept(`folded.${id}`, false);
  return (
    <>
      <div className="rb-card">
        <button className="rb-card-title rb-toggle" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {title}</button>
      </div>
      {open && children}
    </>
  );
}

function Kpi({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div className={`rb-kpi ${good === true ? 'good' : good === false ? 'bad' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function StatsRow({ label, s, note }: { label: string; s: Stats; note?: string }) {
  return (
    <tr>
      <td>{label}{note && <small> {note}</small>}</td>
      <td>{s.groups}</td>
      <td>{s.trades}</td>
      <td className={s.winRate > 50 ? 'up' : 'down'}>{pct(s.winRate)}</td>
      <td className={s.ratio > 1.3 ? 'up' : 'down'}>{n2(s.ratio)}</td>
      <td>{n2(s.profitFactor)}</td>
      <td className={s.totalR >= 0 ? 'up' : 'down'}>{rr(s.totalR)}</td>
      <td>{rr(-s.maxDDR)}</td>
    </tr>
  );
}

const STATS_HEAD = <tr><th /><th>Signaux</th><th>Trades</th><th>Gagnants</th><th>Ratio G/P</th><th>Profit factor</th><th>Total</th><th>Drawdown</th></tr>;

// the robot trading the virtual account on live data, or not
function AutoToggle({ s }: { s: RobotStrategy }) {
  const robot = useStore((st) => st.autoRobots.find((r) => r.id === s.id));
  const toggle = () => {
    const st = useStore.getState();
    if (robot) { st.upsertAutoRobot({ ...robot, enabled: !robot.enabled }); return; }
    const future = s.kind === 'em' ? SYMBOLS.find((x) => x.ticker === s.future) : undefined;
    st.upsertAutoRobot({
      id: s.id, name: s.name, symbol: future ?? toPlatform(s), tf: platformTf(s.tf), riskPct: 0.3, enabled: true, createdAt: Date.now(),
      ...(s.kind === 'em' ? { kind: 'em' as const } : s.kind === 'dow' ? { kind: 'dow' as const, inputs: s.inputs } : {}),
      spec: { signal: s.signal.id, filter: s.filter.id, stop: s.stop.id, dir: s.dir, tpR: s.legs.tpR, trailK: s.legs.trailK, cost: s.cost },
    });
  };
  return (
    <button className={`pill-btn ${robot?.enabled ? 'rb-on' : ''}`} onClick={toggle} title="Le robot prend lui-même les positions sur le compte virtuel, en direct, tant que la plateforme est ouverte">
      {robot?.enabled ? '⏸ Arrêter le mode automatique' : '▶ Trader en automatique (virtuel)'}
    </button>
  );
}

// robots set to trade: status, open entries, realised result
function ActiveRobots() {
  const robots = useStore((s) => s.autoRobots);
  const paper = useStore((s) => s.paper);
  useSyncExternalStore(onRobotStatus, () => robots.map((r) => robotStatus(r.id)).join('|'));
  if (!robots.length) return null;
  return (
    <div className="rb-active">
      <div className="rb-active-head">
        <b>Robots en automatique</b>
        <span>Compte virtuel : {paper.balance.toLocaleString(LOCALE, { maximumFractionDigits: 0 })} €</span>
        <button className="off-link" onClick={() => { if (window.confirm('Remettre le compte virtuel à 10 000 € (positions et historique effacés) ?')) useStore.getState().paperReset(10_000); }}>Remettre à 10 000 €</button>
      </div>
      {robots.map((r) => {
        const pos = paper.positions.filter((p) => p.robot?.robotId === r.id);
        const done = paper.history.filter((t) => t.robot?.robotId === r.id);
        const pnl = done.reduce((a, t) => a + t.pnl, 0);
        return (
          <div key={r.id} className="rb-active-row">
            <span className={`rb-dot ${r.enabled ? 'on' : ''}`} />
            <b>{r.name}</b>
            <span>{r.enabled ? robotStatus(r.id) ?? 'Démarrage…' : 'Arrêté'}</span>
            <span>{pos.length} position{pos.length > 1 ? 's' : ''} ouverte{pos.length > 1 ? 's' : ''}</span>
            <span className={pnl >= 0 ? 'up' : 'down'}>{done.length} trades · {eur(pnl)}</span>
            <button className="off-link" onClick={() => useStore.getState().upsertAutoRobot({ ...r, enabled: !r.enabled })}>{r.enabled ? 'Arrêter' : 'Relancer'}</button>
            <button className="tf-menu-icon" title="Retirer" onClick={() => useStore.getState().removeAutoRobot(r.id)}>✕</button>
          </div>
        );
      })}
    </div>
  );
}

function Report({ s }: { s: RobotStrategy }) {
  const fixed = s.money[0];
  const best = s.money.find((m) => m.mm === s.bestMM) ?? fixed;
  const legNames = [`A · fixe (objectif ${String(s.legs.tpR).replace('.', DEC)} R)`, `B · suiveur (stop ${s.legs.trailK} ATR, objectif +1 R à chaque palier)`, 'C · paliers 1 R / 2 R / 3 R avec break-even'];
  // the indicators it reads (entry signal, filter), set as the robot uses them
  const em = s.kind === 'em', dow = s.kind === 'dow', single = em || dow;
  const parts = single ? [] : robotParts({ id: s.id, signal: s.signal.id, filter: s.filter.id });
  // a chart tab of its own: the robot's market and timeframe with the robot and its
  // indicators on it, and the strategy tester replaying it on the report's history (the
  // tab already open for it, if any, given the indicators it lacks)
  const open = () => {
    const st = useStore.getState();
    st.setBottomDock({ tab: 'tester' });
    const mine = (i: IndicatorConfig) => (i.type === 'ROBOT' || i.type === 'EXPECTED_MOVE' || i.type === 'DOW_STRUCTURE') && i.robot?.id === s.id;
    const tab = st.tabs.find((t) => t.kind === 'chart' && t.state?.indicators?.some(mine));
    if (tab) {
      activateTab(tab.id);
      const now = useStore.getState();
      if (!now.indicators.some((i) => i.robotPart === s.id) && parts.length) {
        useStore.setState({ indicators: [...parts.map((p) => ({ ...p.cfg, id: nextId() })), ...now.indicators] });
      }
      const cfg = useStore.getState().indicators.find(mine);
      if (cfg) useStore.getState().setTesterRobot(cfg.id);
      return;
    }
    const sym = toPlatform(s);
    const origin = {
      id: s.id, name: `${s.rank ? `#${s.rank} ` : ''}${s.name}`, dataset: s.dataset ?? s.id.split('|')[0], source: s.source, market: s.market,
      ticker: sym.ticker, tf: platformTf(s.tf), from: s.period.from, to: s.period.to, split: s.period.split,
    };
    // the Expected Move robot: the indicator with its signals, the tester on the lab's history
    if (em) {
      const emCfg: IndicatorConfig = {
        id: nextId(), type: 'EXPECTED_MOVE', period: 0, color: '#00bcd4', overlay: true, visible: true, inputs: { robot: true },
        robot: { ...origin, dataset: s.dataset ?? origin.dataset },
      };
      openChartTab(sym, platformTf(s.tf), [emCfg], { testerRobot: emCfg.id });
      return;
    }
    // a Dow structure robot: the indicator set as the robot, the tester on the lab's history
    if (dow) {
      const dowCfg: IndicatorConfig = {
        id: nextId(), type: 'DOW_STRUCTURE', period: 0, color: '#2962ff', overlay: true, visible: true, inputs: s.inputs,
        robot: { ...origin, dataset: s.dataset ?? origin.dataset },
      };
      openChartTab(sym, platformTf(s.tf), [dowCfg], { testerRobot: dowCfg.id });
      return;
    }
    const cfg: IndicatorConfig = {
      id: nextId(), type: 'ROBOT', period: 0, color: '#2962ff', overlay: true, visible: true,
      inputs: robotInputs({ signal: s.signal.id, filter: s.filter.id, stop: s.stop.id, dir: s.dir, tpR: s.legs.tpR, trailK: s.legs.trailK, cost: s.cost }),
      robot: {
        id: s.id, name: `${s.rank ? `#${s.rank} ` : ''}${s.name}`, dataset: s.id.split('|')[0], source: s.source, market: s.market,
        ticker: sym.ticker, tf: platformTf(s.tf), from: s.period.from, to: s.period.to, split: s.period.split,
      },
    };
    // the robot last, its arrows over the lines
    openChartTab(sym, platformTf(s.tf), [...parts.map((p) => ({ ...p.cfg, id: nextId() })), cfg], { testerRobot: cfg.id });
  };
  return (
    <div className="rb-report">
      <div className="rb-head">
        <div>
          <h2>{s.rank ? `#${s.rank} ` : ''}{s.name}</h2>
          <div className="rb-badges">
            <span>{MARKET_LABEL[s.market] ?? s.market}</span><span>{TF_LABEL[s.tf] ?? s.tf}</span><span>{s.source}</span><span>{s.dirLabel}</span>
            <span>{day(s.period.from)} → {day(s.period.to)}</span>
            {s.years < 1 && <span className="rb-short" title="Moins d’un an d’historique : résultats à confirmer sur une plus longue période">Historique court ({Math.max(1, Math.round(s.years * 12))} mois)</span>}
            {em && <span className="rb-short" title="La seule règle de l’étude Expected Move qui tient un peu : +0,06 R par trade sur 5 indices, en baisse depuis 2023, pas significative sur la validation">Non prouvé</span>}
          </div>
        </div>
        <div className="rb-actions">
          <button className="pill-btn active" onClick={open}>Ouvrir le graphique</button>
          <AutoToggle s={s} />
        </div>
      </div>

      <div className="rb-rules">
        <div><b>Entrée</b>{s.signal.label}</div>
        <div><b>Filtre</b>{s.filter.label}</div>
        <div><b>Stop</b>{s.stop.label}</div>
        {em && <div><b>Sur le graphique</b>Expected Move calibré, avec les niveaux du robot, ses flèches, ses stops et ses objectifs ; le testeur rejoue tous ses trades depuis 2020</div>}
        {dow && <div><b>Sur le graphique</b>Structure de marché (Dow) réglée comme le robot : sommets, cassures, boîtes, entrées et sorties ; le testeur rejoue tous ses trades depuis 2020</div>}
        {parts.length > 0 && (
          <div><b>Sur le graphique</b>{parts.map((p) => `${p.label} (${ROLE_LABEL[p.role]}${p.role === 'filter' && p.cfg.type === 'STOCH_ENV' ? ', lignes pâles' : ''})`).join(' · ')}</div>
        )}
        <div><b>Sorties</b>{em
          ? `1 entrée de 0,3 % par signal : objectif ${s.legs.tpR} R, sinon sortie à la clôture cash · en automatique, le future ${s.future}`
          : dow
          ? '1 entrée de 0,3 % par configuration : sortie au stop ou au retournement de structure · en automatique, un ordre limite au bord de la boîte'
          : '3 entrées de 0,3 % par signal : fixe · suiveur · paliers 1-2-3 R avec break-even ; signal contraire = clôture et retournement'}</div>
        <div><b>Frais</b>{pct(s.cost * 100, 3)} du prix par côté (commission + écart + glissement)</div>
        <div><b>Robustesse</b>{s.robustText ?? <>{s.robust.passed} réglages voisins sur {s.robust.total} ({em ? 'autres stops, objectifs, calibrage et seuil du VIX) gagnent aussi en réglage et en validation' : 'autres stops et sorties) remplissent aussi les critères'}{s.alsoOn.length ? ` · validé aussi sur ${s.alsoOn.slice(0, 8).join(', ')}${s.alsoOn.length > 8 ? '…' : ''}` : ''}</>}</div>
      </div>

      <div className="rb-kpis">
        <Kpi label="Profit net" value={eur(fixed.netProfit)} sub={s.years >= 1 ? `${pct(fixed.netPct)} en ${s.years.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} ans · ${pct(s.annualPct)} par an` : `${pct(fixed.netPct)} en ${Math.max(1, Math.round(s.years * 12))} mois`} good={fixed.netProfit > 0} />
        <Kpi label="Trades gagnants" value={pct(s.stats.full.winRate)} sub={`${s.stats.full.wins} / ${s.stats.full.trades}`} good={s.stats.full.winRate > 50} />
        <Kpi label="Ratio gains/pertes" value={n2(s.stats.full.ratio)} sub="gain moyen / perte moyenne" good={s.stats.full.ratio > 1.3} />
        <Kpi label="Profit factor" value={n2(s.stats.full.profitFactor)} />
        <Kpi label="Drawdown max" value={pct(fixed.maxDDPct)} sub="du capital" />
        <Kpi label="Signaux" value={String(s.stats.full.groups)} sub={single ? '1 trade par signal' : `${s.stats.full.trades} trades (3 par signal)`} />
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Courbe de capital · 0,3 % par entrée</div>
        <LineChart
          height={240}
          series={[{ label: 'Capital', color: fixed.netProfit >= 0 ? '#089981' : '#f23645', points: s.equity }]}
          xFmt={(x) => day(x)} yFmt={(y) => `${Math.round(y).toLocaleString(LOCALE)} €`}
          marker={{ x: s.period.split, label: 'Début de la validation' }}
        />
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Réglage et validation</div>
        <table className="rb-table">
          <thead>{STATS_HEAD}</thead>
          <tbody>
            <StatsRow label="Réglage" note={em ? `(juillet 2020 → ${day(s.period.split)}, où la règle a été choisie)` : `(70 %, jusqu’au ${day(s.period.split)})`} s={s.stats.is} />
            <StatsRow label="Validation" note={em ? '(depuis, jamais utilisée pour choisir)' : '(30 % jamais utilisés pour choisir)'} s={s.stats.oos} />
            <StatsRow label="Total" s={s.stats.full} />
          </tbody>
        </table>
      </div>

      {!single && (
        <div className="rb-card">
          <div className="rb-card-title">Les 3 entrées de chaque signal</div>
          <table className="rb-table">
            <thead>{STATS_HEAD}</thead>
            <tbody>{s.stats.legs.map((l, i) => <StatsRow key={i} label={legNames[i]} s={l} />)}</tbody>
          </table>
        </div>
      )}

      <div className="rb-card">
        <div className="rb-card-title">Gestion du capital <small>meilleure : {best.label}</small></div>
        <table className="rb-table">
          <thead><tr><th>Méthode</th><th>Profit net</th><th>Rendement</th><th>Drawdown</th><th>Gagnants</th><th>Ratio G/P</th><th>Profit factor</th></tr></thead>
          <tbody>
            {s.money.map((m) => (
              <tr key={m.mm} className={m.mm === s.bestMM ? 'best' : ''}>
                <td>{m.label}</td>
                <td className={m.netProfit >= 0 ? 'up' : 'down'}>{eur(m.netProfit)}</td>
                <td>{pct(m.netPct)}</td>
                <td>{pct(m.maxDDPct)}</td>
                <td>{pct(m.winRate)}</td>
                <td>{n2(m.ratio)}</td>
                <td>{n2(m.profitFactor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Derniers signaux</div>
        <table className="rb-table">
          <thead><tr><th>Date</th><th>Sens</th><th>Entrée</th>{single ? <th>R</th> : <><th>A fixe</th><th>B suiveur</th><th>C paliers</th></>}<th>Résultat</th></tr></thead>
          <tbody>
            {s.recent.map((g, i) => (
              <tr key={i}>
                <td>{dayTime(g.time)}</td>
                <td className={g.side > 0 ? 'up' : 'down'}>{g.side > 0 ? 'Achat' : 'Vente'}</td>
                <td>{g.entry.toLocaleString(LOCALE, { maximumSignificantDigits: 6 })}</td>
                {g.legs.map((r, k) => <td key={k} className={r >= 0 ? 'up' : 'down'}>{rr(r)}</td>)}
                <td className={g.eur >= 0 ? 'up' : 'down'}>{eur(g.eur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// the settings that pass on many markets of a class at once; a click shows one of its robots
function GeneralCard({ rows, strategies, onPick }: { rows: GeneralSetting[]; strategies: RobotStrategy[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const robotOf = (g: GeneralSetting) => strategies.find((s) => s.market === g.market && s.tf === g.tf && s.signal.id === g.signal.id && s.filter.id === g.filter.id
    && s.dir === g.dir && s.stop.id === g.stop.id && s.legs.tpR === g.legs.tpR && s.legs.trailK === g.legs.trailK);
  return (
    <div className="rb-card">
      <button className="rb-card-title rb-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Réglages validés sur plusieurs marchés à la fois ({rows.length})
      </button>
      {open && (
        <>
          <div className="rb-note">Le même réglage testé sur tous les marchés d’une classe et d’une unité de temps (au moins 3 ans d’historique chacun) : plus il passe les critères sur de marchés, moins c’est un hasard.</div>
          {rows.some((g) => (g.ranAt ?? 0) < REAL_COSTS_FROM) && (
            <div className="rb-note rb-warn">Mesurés avec les anciens frais du labo (0,01 % pour l’or ou le pétrole, 0,004 % pour le forex), bien plus bas que les frais réels : à confirmer par une nouvelle recherche. Les robots des listes, eux, sont recontrôlés aux frais réels.</div>
          )}
          <table className="rb-table rb-general">
            <thead><tr><th>Classe</th><th>Unité</th><th>Réglage</th><th>Marchés validés</th><th>Contrôle positif</th><th>R / an (moyenne)</th><th>Validé sur</th></tr></thead>
            <tbody>
              {rows.map((g, i) => {
                const robot = robotOf(g);
                return (
                  <tr key={i} className={robot ? 'click' : ''} onClick={() => robot && onPick(robot.id)} title={robot ? 'Voir un robot de ce réglage' : undefined}>
                    <td>{MARKET_LABEL[g.market] ?? g.market}</td><td>{TF_LABEL[g.tf] ?? g.tf}</td>
                    <td className="left"><b>{g.signal.label}</b><small>{g.filter.label} · {g.dirLabel} · stop {g.stop.label} · A à {String(g.legs.tpR).replace('.', DEC)} R, B suiveur {String(g.legs.trailK).replace('.', DEC)} ATR</small></td>
                    <td>{g.passed} / {g.markets}</td><td>{pct(g.posOOS * 100, 0)}</td><td>{g.fullRY.toLocaleString(LOCALE, { maximumFractionDigits: 1 })}</td>
                    <td className="left muted">{g.on.slice(0, 12).join(', ')}{g.on.length > 12 ? '…' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export default function RobotsPage() {
  const [report, setReport] = useState<RobotReport | null>(lastReport);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useKept<string | null>('sel', null);
  const [sort, setSort] = useKept<Sort>('sort', 'annual');
  const [market, setMarket] = useKept('market', 'all');
  const [showMarkets, setShowMarkets] = useState(false);
  // which selection: the best robots of every indicator, the Stoch Price Envelope range / trend
  // ones, the hour range (its study, and its robots when some pass), or the Dow structure study
  const [view, setView] = useKept<'main' | 'spe' | 'hr' | 'dow' | 'em' | null>('view', null);
  const listRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    // the Expected Move robots come from their own study (public/robots/em.json)
    const em = fetch(`/robots/em.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() as Promise<{ strategies: RobotStrategy[] }> : null)).catch(() => null);
    // and the Dow structure robots from theirs (public/robots/dow-robots.json)
    const dow = fetch(`/robots/dow-robots.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() as Promise<{ strategies: RobotStrategy[] }> : null)).catch(() => null);
    fetch(`/robots/report.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(async (j: RobotReport) => {
        const [e, d] = await Promise.all([em, dow]);
        const merged = { ...j, strategies: [...j.strategies.filter((x) => x.set !== 'em' && x.set !== 'dow'), ...(d?.strategies ?? []), ...(e?.strategies ?? [])] };
        lastReport = merged;
        if (alive) setReport(merged);
      })
      .catch(() => { if (alive) setError('Aucun rapport pour l’instant : le labo des robots n’a pas encore tourné.'); });
    return () => { alive = false; };
  }, []);
  // back where the lists were once they are drawn; where they are, noted on leaving the tab
  const drawn = !!report;
  useLayoutEffect(() => {
    const l = listRef.current, m = mainRef.current;
    if (!l || !m) return;
    l.scrollTop = scrolled.list;
    m.scrollTop = scrolled.main;
    return () => { scrolled.list = l.scrollTop; scrolled.main = m.scrollTop; };
  }, [drawn]);

  const speCount = report?.strategies.filter((s) => s.set === 'spe').length ?? 0;
  const hrCount = report?.strategies.filter((s) => s.set === 'hr').length ?? 0;
  const emCount = report?.strategies.filter((s) => s.set === 'em').length ?? 0;
  const dowCount = report?.strategies.filter((s) => s.set === 'dow').length ?? 0;
  // the Stoch Price Envelope selection first when there is one
  const shown = view ?? (speCount ? 'spe' : 'main');
  const list = useMemo(() => {
    const xs = (report?.strategies ?? []).filter((s) => (s.set ?? 'main') === shown && (market === 'all' || s.market === market));
    const key = (s: RobotStrategy) => sort === 'annual' ? -s.annualPct : sort === 'profit' ? -s.money[0].netPct : sort === 'winRate' ? -s.stats.full.winRate
      : sort === 'ratio' ? -s.stats.full.ratio : sort === 'robust' ? -s.robust.passed / s.robust.total : s.money[0].maxDDPct;
    return [...xs].sort((a, b) => key(a) - key(b));
  }, [report, sort, market, shown]);

  if (error) return <div className="rb-page"><div className="rb-empty">{error}</div></div>;
  if (!report) return <div className="rb-page"><div className="rb-empty">Chargement des rapports…</div></div>;
  const mainCount = report.strategies.length - speCount - hrCount - emCount - dowCount;
  // a year of history or more first; shorter ones saw a single market phase
  // the Stoch Price Envelope selection: settings validated on several markets first
  const groups: [string, RobotStrategy[]][] = shown === 'dow' ? [
    ['Retenus au walk-forward (réglage refait chaque année)', list],
  ] : shown === 'em' ? [
    ['Non prouvés · la règle de l’étude, un robot par indice', list],
  ] : shown === 'hr' ? [
    ['Validés sur plusieurs marchés à la fois', list.filter((s) => s.general)],
    ['Un seul marché · à confirmer', list.filter((s) => !s.general)],
  ] : shown === 'spe' ? [
    ['Validés sur plusieurs marchés à la fois', list.filter((s) => s.general)],
    ['Au moins 3 ans d’historique', list.filter((s) => !s.general && s.years >= 3)],
    ['Moins de 3 ans d’historique · à confirmer', list.filter((s) => !s.general && s.years < 3)],
  ] : [
    ['Plus d’un an d’historique', list.filter((s) => s.years >= 1)],
    ['Moins d’un an d’historique · à confirmer', list.filter((s) => s.years < 1)],
  ];
  const current = list.find((s) => s.id === sel) ?? groups.flatMap(([, g]) => g)[0];
  const markets = [...new Set(report.strategies.map((s) => s.market))];
  const c = report.criteria;

  return (
    <div className="rb-page">
      <div className="rb-top">
        <h1>Robots de trading</h1>
        <div className="rb-summary">
          {report.tested.toLocaleString(LOCALE)} stratégies testées sur {report.datasets.length} marchés et unités de temps ·
          {' '}{report.candidates.toLocaleString(LOCALE)} validées · {mainCount} gardées (les plus rentables){speCount ? ` + ${speCount} Stoch Price Envelope range / tendance` : ''} ·
          {' '}mis à jour le {dayTime(report.generatedAt / 1000)}
        </div>
        <div className="rb-criteria">
          <span>Trades gagnants &gt; {c.winRate} %</span>
          <span>Ratio gains/pertes &gt; {String(c.ratio).replace('.', DEC)}</span>
          <span>3 entrées × {String(c.riskPerEntryPct).replace('.', DEC)} % par signal</span>
          <span>Capital {c.capital.toLocaleString(LOCALE)} €</span>
          {!!c.from && <span>Marché depuis le {day(c.from)} seulement</span>}
          <span>Réglage sur {Math.round(c.split * 100)} % de l’historique, validation sur le reste</span>
          <span>Au moins {c.minTradesIS} trades en réglage et {c.minTradesOOS} en validation</span>
        </div>
      </div>

      <div className="rb-body">
        <aside className="rb-list" ref={listRef}>
          <div className="rb-sets">
            {speCount > 0 && <button className={shown === 'spe' ? 'on' : ''} onClick={() => setView('spe')} title="Range détecté sur une unité supérieure, tendance en escalier sur l’unité du robot">Stoch Price Envelope · range / tendance ({speCount})</button>}
            <button className={shown === 'hr' ? 'on' : ''} onClick={() => setView('hr')} title="La bougie d’une heure (heure de Paris) fait un range, la clôture hors du range donne le sens de la journée">Range horaire · cassure de la bougie d’une heure ({hrCount})</button>
            <button className={shown === 'main' ? 'on' : ''} onClick={() => setView('main')}>Meilleurs robots, tous indicateurs ({mainCount})</button>
            <button className={shown === 'dow' ? 'on' : ''} onClick={() => setView('dow')} title="Plus hauts / plus bas, cassure en clôture franche, retour dans la boîte, liquidité : l’étude de l’indicateur Structure de marché (Dow)">Structure Dow · price action ({dowCount})</button>
            <button className={shown === 'em' ? 'on' : ''} onClick={() => setView('em')} title="L’indicateur Expected Move calibré transformé en robot sur les indices : la seule règle qui tient un peu (non prouvée)">Expected Move · indices · non prouvé ({emCount})</button>
          </div>
          <div className="rb-list-tools">
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {SORTS.map(([k, l]) => <option key={k} value={k}>Tri : {l}</option>)}
            </select>
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              <option value="all">Tous les marchés</option>
              {markets.map((m) => <option key={m} value={m}>{MARKET_LABEL[m] ?? m}</option>)}
            </select>
          </div>
          {groups.map(([title, group]) => group.length > 0 && (
            <div key={title} className="rb-group">
              <div className="rb-group-title">{title}</div>
              {group.map((s) => (
                <button key={s.id} className={`rb-item ${current?.id === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
                  <div className="rb-item-top"><b>{s.rank ? `#${s.rank} ` : ''}{s.symbol}</b><span>{TF_LABEL[s.tf] ?? s.tf}</span><em className={s.annualPct >= 0 ? 'up' : 'down'} title={s.years >= 1 ? 'Rendement annuel moyen' : 'Rendement sur la période (moins d’un an)'}>{pct(s.annualPct)}{s.years >= 1 ? '/an' : ` en ${Math.max(1, Math.round(s.years * 12))} mois`}</em></div>
                  <div className="rb-item-sig">{s.signal.label}</div>
                  <div className="rb-item-stats">
                    <span>{pct(s.stats.full.winRate, 0)} gagnants</span><span>ratio {n2(s.stats.full.ratio)}</span><span>DD {pct(s.money[0].maxDDPct)}</span><span title={s.kind === 'dow' ? 'Années positives au walk-forward depuis 2023' : 'Réglages voisins validés'}>⚙ {s.robust.passed}/{s.robust.total}</span>
                  </div>
                </button>
              ))}
            </div>
          ))}
          {!list.length && <div className="rb-empty small">Aucune stratégie pour ce marché.</div>}
        </aside>
        <main className="rb-main" ref={mainRef}>
          <ActiveRobots />
          {shown === 'hr' && <HourStudyCard />}
          {shown === 'dow' && <Folded id="dow" title="Structure Dow · ce que dit l’étude (verdict, walk-forward, heures actives, tous les marchés)"><DowStudyCard onPick={setSel} /></Folded>}
          {shown === 'em' && <EmRobotCard />}
          {current ? <Report s={current} /> : shown !== 'hr' && <div className="rb-empty">Aucune stratégie ne remplit encore les critères.</div>}
          {shown !== 'main' && !!report.general?.some((g) => (g.set ?? 'spe') === shown) && (
            <GeneralCard rows={report.general.filter((g) => (g.set ?? 'spe') === shown)} strategies={report.strategies.filter((s) => s.set === shown)} onPick={setSel} />
          )}

          <div className="rb-card">
            <button className="rb-card-title rb-toggle" onClick={() => setShowMarkets(!showMarkets)}>
              {showMarkets ? '▾' : '▸'} Tous les marchés testés ({report.datasets.length})
            </button>
            {showMarkets && (
              <>
                <table className="rb-table">
                  <thead><tr><th>Marché</th><th>Unité</th><th>Source</th><th>Barres</th><th>Testées</th><th>Bonnes en réglage</th><th>Validées</th></tr></thead>
                  <tbody>
                    {report.datasets.map((d) => (
                      <tr key={d.id}>
                        <td>{d.symbol}</td><td>{TF_LABEL[d.tf] ?? d.tf}</td><td>{d.source}</td><td>{d.bars.toLocaleString(LOCALE)}</td>
                        <td>{d.tested.toLocaleString(LOCALE)}</td><td>{d.passIS.toLocaleString(LOCALE)}</td>
                        <td className={d.passBoth ? 'up' : ''}>{d.passBoth.toLocaleString(LOCALE)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="rb-families">
                  {Object.entries(report.families).map(([f, v]) => (
                    <span key={f}><b>{f}</b> {v.passed.toLocaleString(LOCALE)} validées sur {v.tested.toLocaleString(LOCALE)}</span>
                  ))}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
