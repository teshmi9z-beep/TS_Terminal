import { useEffect, useMemo, useState } from 'react';
import { useKept } from '../kept';
import { nextId, useStore } from '../../store/store';
import { MARKET_LABEL, TF_LABEL, platformSymbol, platformTf } from '../../data/labSymbols';
import { openChartTab } from '../tabs/tabActions';
import type { IndicatorConfig } from '../../types';
import { LANG, LOCALE } from '../../i18n/lang';

// "Flux MM20 / MM50": the study of trading in the flux's direction on retracements, order
// blocks and imbalances (robots/flux/FLUX.md, scripts/robots/flux-*.ts, 29 October 2026),
// published by scripts/robots/flux-publish.mjs to public/robots/flux.json. No setting was
// kept, so the tab shows the study itself: the verdict, the family averages, the one
// unproven lead, every setting of the 27 groups and the simulator bias found on the way.

// a period: [trades, R a trade, t, markets positive, markets with trades (20 at least, 10 on the check)]
type St = [number, number | null, number | null, number, number];
type Row = {
  // the setting's label in French and in English
  g: number; k: string; l: string; le: string; is: St; oos: St;
  // the whole period, then its win rate and profit factor
  all: [number, number | null, number | null, number, number, number | null, number | null];
  // per market: [symbol, tuning trades, tuning R a trade, check trades, check R a trade]
  per: [string, number, number | null, number, number | null][];
  // per year: [year, R in total]
  y: [number, number | null][];
};
type Group = { tf: string; fluxTf: string; cls: string; markets: number; settings: number; found: number; holds: number; is: number | null; oos: number | null; posIS: number; posBoth: number };
type FluxStudy = {
  generatedAt: number; from: string; split: string; groups: Group[]; rows: Row[]; lead: number;
  families: { fam: string; intra: { is: number | null; oos: number | null }; swing: { is: number | null; oos: number | null } }[];
  markets: Record<string, string[]>;
};

const FAMILY: Record<string, string> = { flip: 'Entrée au changement de flux', pb: 'Retour sur le nuage', fib: 'Retracement de Fibonacci', ob: 'Order block', fvg: 'Imbalance (FVG)' };
const FAMILY_SHORT: [string, string][] = [['all', 'Toutes'], ['flip', 'Changement'], ['pb', 'Nuage'], ['fib', 'Fibonacci'], ['ob', 'Order block'], ['fvg', 'Imbalance']];
// the indicator's timeframe input for the flux read on the lab's timeframe
const FLUX_TF: Record<string, string> = { '1h': '1 heure', '4h': '4 heures', '1d': 'Journalier' };
const num = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const sR = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)} R`);
const tone = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const markets = (s: St) => (s[4] ? `${s[0]} trades · ${s[3]}/${s[4]} marchés positifs` : `${s[0]} trades · trop peu par marché`);

// the market's chart on the entry timeframe, with the flux read where the setting read it
function open(sym: string, cls: string, tf: string, fluxTf: string) {
  const cfg: IndicatorConfig = { id: nextId(), type: 'FLUX', period: 0, color: '#4caf50', overlay: true, visible: true, inputs: { tf: FLUX_TF[fluxTf] ?? '1 heure' } };
  useStore.getState().setBottomDock({ tab: null });
  // WTI-Y is the lab's Yahoo copy of the oil
  openChartTab(platformSymbol(sym === 'WTI-Y' ? 'WTI' : sym, cls), platformTf(tf), [cfg]);
}

function Years({ y }: { y: Row['y'] }) {
  return <div className="dow-years">{y.map(([yr, r]) => <span key={yr} className={tone(r)} title={`${yr} : ${sR(r, 1)} au total`}>{String(yr).slice(2)} {sR(r, 0)}</span>)}</div>;
}

function PerMarket({ row, group }: { row: Row; group: Group }) {
  return (
    <table className="rb-table fx-per">
      <thead><tr><th>Marché</th><th>Réglage</th><th>Validation</th><th /></tr></thead>
      <tbody>
        {row.per.map(([sym, isN, isR, oosN, oosR]) => (
          <tr key={sym}>
            <td><b>{sym}</b></td>
            <td className={tone(isN ? isR : null)}>{isN ? sR(isR) : '—'}<small>{` ${isN} trades`}</small></td>
            <td className={tone(oosN ? oosR : null)}>{oosN ? sR(oosR) : '—'}<small>{` ${oosN} trades`}</small></td>
            <td><button className="pill-btn" onClick={() => open(sym, group.cls, group.tf, group.fluxTf)}>Ouvrir le graphique</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function FluxStudyCard() {
  const [data, setData] = useKept<FluxStudy | null>('robots.flux.data', null, true);
  const [missing, setMissing] = useState(false);
  const [group, setGroup] = useKept<number | null>('robots.flux.group', null);
  const [fam, setFam] = useKept('robots.flux.fam', 'all');
  const [row, setRow] = useKept<string | null>('robots.flux.row', null, true);
  const [showLead, setShowLead] = useKept('robots.flux.lead', false);

  useEffect(() => {
    let alive = true;
    fetch(`/robots/flux.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: FluxStudy) => { if (alive) setData(j); })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [setData]);

  // the chosen group's settings, best over the whole period first
  const rows = useMemo(() => (data && group != null
    ? data.rows.filter((r) => r.g === group && (fam === 'all' || r.k.split('|')[0] === fam)).sort((a, z) => (z.all[1] ?? -9) - (a.all[1] ?? -9))
    : []), [data, group, fam]);

  if (missing) return <div className="rb-card"><div className="rb-note">L’étude du flux n’a pas encore été publiée.</div></div>;
  if (!data) return <div className="rb-card"><div className="rb-note">Chargement de l’étude…</div></div>;
  const lead = data.rows[data.lead];
  const leadGroup = lead ? data.groups[lead.g] : undefined;
  const g = group != null ? data.groups[group] : undefined;
  const groupName = (x: Group) => `entrées ${TF_LABEL[x.tf] ?? x.tf} · flux ${TF_LABEL[x.fluxTf] ?? x.fluxTf} · ${MARKET_LABEL[x.cls] ?? x.cls}`;

  return (
    <>
      <div className="rb-card">
        <div className="rb-card-title">Flux MM20 / MM50 · ce que dit l’étude <span className="fx-badge">Aucun robot gardé</span></div>
        <ul className="dow-verdict">
          <li>Toujours dans le sens du flux (achats quand le nuage est vert, ventes quand il est rouge), entrée sur un retour sur le nuage, un retracement de Fibonacci, un order block ou une imbalance, sortie au changement de flux au plus tard.</li>
          <li>{`${data.rows.length.toLocaleString(LOCALE)} réglages en ${data.groups.length} groupes : entrées de 5 min au jour, flux en 1 h, 4 h ou jour, sur les indices, le forex et les matières premières.`}</li>
          <li>{`Aucun réglage ne tient : 0 trouvé sur 2020 → août 2024, dans les ${data.groups.length} groupes. Le 5 et le 15 min perdent partout.`}</li>
          <li>Le flux n’apporte presque rien : sur les imbalances des indices, entrer contre le flux fait aussi bien que dans son sens.</li>
          <li>Les matières premières avec un flux journalier ne gagnent que depuis septembre 2024 : c’est la hausse de l’or et du pétrole, pas une règle. Le gaz perd.</li>
        </ul>
        <div className="rb-note">
          Réglage sur janvier 2020 → août 2024, validation depuis septembre 2024, jamais utilisée pour choisir. Frais réels de chaque marché, une limite
          n’est exécutée que si le prix la dépasse de 0,05 ATR, le stop est vérifié avant l’objectif, et les ordres sont simulés bougie par bougie.
          Résultats en R par trade (1 R = le risque prévu), frais compris.
        </div>
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Moyenne par famille d’entrée (tous les réglages et marchés)</div>
        <table className="rb-table">
          <thead>
            <tr><th>Entrée</th><th colSpan={2}>5 min à 1 h</th><th colSpan={2}>4 h et jour</th></tr>
            <tr><th /><th>Réglage</th><th>Validation</th><th>Réglage</th><th>Validation</th></tr>
          </thead>
          <tbody>
            {data.families.map((f) => (
              <tr key={f.fam}>
                <td>{FAMILY[f.fam] ?? f.fam}</td>
                <td className={tone(f.intra.is)}>{sR(f.intra.is)}</td><td className={tone(f.intra.oos)}>{sR(f.intra.oos)}</td>
                <td className={tone(f.swing.is)}>{sR(f.swing.is)}</td><td className={tone(f.swing.oos)}>{sR(f.swing.oos)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lead && leadGroup && (
        <div className="rb-card">
          <div className="rb-card-title">La seule piste · indices en journalier <span className="fx-badge">Non prouvée</span></div>
          <div className="rb-note">{LANG === 'en' ? lead.le : lead.l}</div>
          <table className="rb-table">
            <thead><tr><th>Période</th><th>Trades</th><th>R par trade</th><th>t</th><th>Indices positifs</th></tr></thead>
            <tbody>
              {([['Réglage (2020 → août 2024)', lead.is], ['Validation (depuis septembre 2024)', lead.oos], ['Total', lead.all]] as [string, St][]).map(([name, s]) => (
                <tr key={name}><td>{name}</td><td>{s[0]}</td><td className={tone(s[1])}>{sR(s[1])}</td><td>{s[2] == null ? '—' : num(s[2], 1)}</td><td>{s[3]} / {s[4]}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="rb-note" style={{ marginTop: 8 }}>Année par année, les 5 indices ensemble (R au total)</div>
          <Years y={lead.y} />
          <div className="rb-note" style={{ marginTop: 8 }}>
            Pas prouvée : t de 1,5 sur chaque période, 1 réglage sur 78, et des indices presque toujours en hausse depuis 2020. L’étude des indices
            demande aussi qu’une règle journalière batte le simple fait d’être acheté les mêmes jours, ce qui n’a pas encore été fait.
          </div>
          <button className="rb-card-title rb-toggle" onClick={() => setShowLead(!showLead)}>{showLead ? '▾' : '▸'} Indice par indice</button>
          {showLead && <PerMarket row={lead} group={leadGroup} />}
        </div>
      )}

      <div className="rb-card">
        <div className="rb-card-title">{`Les ${data.groups.length} groupes testés · clique sur un groupe pour voir tous ses réglages`}</div>
        <table className="rb-table rb-general fx-groups">
          <thead>
            <tr>
              <th>Entrées</th><th>Flux</th><th>Marchés</th><th>Réglage</th><th>Validation</th>
              <th title="Réglages positifs sur la période de réglage (au moins 100 trades), et combien le restent sur la validation">Positifs avant ⇒ après</th><th>Gardés</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((x, i) => (
              <tr key={i} className={`click ${group === i ? 'best' : ''}`} onClick={() => { setGroup(group === i ? null : i); setRow(null); }}>
                <td>{TF_LABEL[x.tf] ?? x.tf}</td>
                <td>{TF_LABEL[x.fluxTf] ?? x.fluxTf}</td>
                <td>{MARKET_LABEL[x.cls] ?? x.cls}<small> {x.markets}</small></td>
                <td className={tone(x.is)}>{sR(x.is)}</td>
                <td className={tone(x.oos)}>{sR(x.oos)}</td>
                <td>{x.posIS} ⇒ {x.posBoth}</td>
                <td>{x.holds} / {x.settings}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="rb-note">Moyenne par trade de tous les réglages du groupe, frais compris.</div>
      </div>

      {g && (
        <div className="rb-card">
          <div className="rb-card-title">{`Les réglages du groupe · ${groupName(g)}`}</div>
          <div className="hr-controls">
            <div className="hr-chips">{FAMILY_SHORT.map(([k, l]) => <button key={k} className={fam === k ? 'on' : ''} onClick={() => { setFam(k); setRow(null); }}>{l}</button>)}</div>
            <span className="rb-note">{`${rows.length} réglages, du meilleur au pire sur toute la période · clique sur un réglage pour le détail par marché`}</span>
          </div>
          <div className="rb-note">Peu de trades, c’est surtout du hasard : un réglage en tête avec un t sous 2 ne prouve rien, et aucun n’a passé les critères de l’étude.</div>
          <table className="rb-table rb-general fx-table">
            <thead><tr><th>Réglage</th><th title="Marchés positifs parmi ceux qui ont au moins 20 trades (10 en validation)">Réglage</th><th title="Marchés positifs parmi ceux qui ont au moins 20 trades (10 en validation)">Validation</th><th>Total</th><th>Années</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <FluxRow key={r.k} r={r} group={g} open={row === r.k} onToggle={() => setRow(row === r.k ? null : r.k)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rb-card">
        <div className="rb-card-title">Le biais trouvé dans le simulateur du labo</div>
        <ul className="dow-verdict">
          <li>Le premier essai donnait l’imbalance des indices en 1 h gagnante : +0,11 R par trade sur la validation, et 10 000 € devenaient environ 38 000 €.</li>
          <li>L’ancien simulateur traitait les ordres limites l’un après l’autre : un vieil ordre qui finissait par être exécuté sautait un ordre plus récent que le prix avait touché avant, et qui aurait souvent perdu. C’est connaître le futur.</li>
          <li>La preuve : avec des limites valables une seule bougie, les deux simulateurs donnent le même résultat ; l’« avantage » grandissait avec la durée d’attente de la limite.</li>
          <li>Simulé bougie par bougie, le premier ordre touché gagne et les autres sont annulés : l’imbalance perd −0,15 R par trade, sur les 5 indices.</li>
          <li>Les robots déjà gardés ne sont pas touchés : ils entrent au prix du marché ou n’ont qu’un ordre à la fois.</li>
        </ul>
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Marchés et données</div>
        <ul className="dow-verdict">
          <li>{`Indices (${data.markets.Index?.join(', ')}) : S&P, Nasdaq et Nikkei chez HistData, DAX et Dow chez IBKR, car HistData n’a pas de DAX de juin 2020 à décembre 2023.`}</li>
          <li>{`Forex (${data.markets.Forex?.join(', ')}) : HistData.`}</li>
          <li>Matières premières : or chez HistData, pétrole WTI chez HistData jusqu’en novembre 2023 puis Yahoo depuis septembre 2024 (WTI-Y), gaz naturel chez Yahoo (1 h sur deux ans seulement).</li>
          <li>{`Depuis le ${new Date(data.from).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })}. Rapport complet : robots/flux/FLUX.md.`}</li>
        </ul>
      </div>
    </>
  );
}

function FluxRow({ r, group, open: isOpen, onToggle }: { r: Row; group: Group; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`click ${isOpen ? 'best' : ''}`} onClick={onToggle}>
        <td className="left">{LANG === 'en' ? r.le : r.l}</td>
        <td className={tone(r.is[1])}>{sR(r.is[1])}<small>{markets(r.is)}</small></td>
        <td className={tone(r.oos[1])}>{sR(r.oos[1])}<small>{markets(r.oos)}</small></td>
        <td className={tone(r.all[1])}>{sR(r.all[1])}<small>t {r.all[2] == null ? '—' : num(r.all[2], 1)}</small></td>
        <td className="left"><Years y={r.y} /></td>
      </tr>
      {isOpen && <tr><td colSpan={5}><PerMarket row={r} group={group} /></td></tr>}
    </>
  );
}
