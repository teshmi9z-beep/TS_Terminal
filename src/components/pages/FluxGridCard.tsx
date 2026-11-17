import { useEffect, useMemo } from 'react';
import { useKept } from '../kept';
import { nextId, useStore } from '../../store/store';
import { MARKET_LABEL, TF_LABEL, platformSymbol, platformTf } from '../../data/labSymbols';
import { openChartTab } from '../tabs/tabActions';
import { LineChart } from './options/ui';
import type { IndicatorConfig } from '../../types';
import { LANG, LOCALE } from '../../i18n/lang';

// "Grille sur le flux": the user's robot of 3 November 2026 (src/robots/fluxGrid.ts): the flux
// of 1 hour for the side, a grid of growing orders from the end of the leg to the MM20 on 5 or
// 15 minutes, out at the end of the leg or when the flux turns, guards on big levels and big
// wicks. Its study (scripts/robots/fluxgrid-*.ts, robots/fluxgrid/GRILLE.md) is published by
// scripts/robots/fluxgrid-publish.mjs to public/robots/fluxgrid.json. Nothing held, so the
// card shows the rules, the verdict, the account curves, what each choice changes and every
// setting.

// a period: [baskets, R a basket, t, markets positive, markets with baskets, win rate, worst basket]
type St = [number, number | null, number | null, number, number, number | null, number | null];
type Row = {
  g: number; k: string; l: string; le: string; is: St; oos: St; gross: number | null; fills: number | null; cut: number | null;
  // per market: [symbol, tuning baskets, R, check baskets, R, worst basket]
  per: [string, number, number | null, number, number | null, number | null][];
  y: [number, number | null][];
};
type Group = { tf: string; cls: string; markets: number; settings: number; found: number; holds: number; is: number | null; oos: number | null };
type Curve = { id: string; key: string; l: string; le: string; groups: Record<string, { n: number; win: number; total: number; worst: number; is: number; oos: number; pts: [number, number][] }> };
type Choice = { key: string; name: string; opts: ({ v: string; label: string } & Record<string, [number | null, number | null, number]>)[] };
type GridStudy = {
  generatedAt: number; from: string; split: string; groups: Group[]; rows: Row[]; choices: Choice[]; curves: Curve[];
  recent: Record<string, { t: number; sym: string; dir: number; fills: number; why: string; r: number }[]>;
  markets: Record<string, string[]>;
  // the inverse (scripts/robots/fluxrev-*.ts): the turn traded where the guards keep the grid out
  inverse?: {
    settings: number; groups: number; found: number; holds: number;
    // the settings found on the tuning, per group: how many, R a trade before and after, the random twins' after
    foundIn?: { tf: string; cls: string; n: number; is: number | null; oos: number | null; oosRnd: number | null }[];
    signals: { tf: string; k: string; label: string; is: number | null; isRnd: number | null; isGross: number | null; oos: number | null; oosRnd: number | null; oosGross: number | null; beat: number | null; beatOos?: number | null }[];
  };
};

const CLASSES: [string, string][] = [['Index', 'Indices'], ['Forex', 'Forex'], ['Commodity', 'Or et pétrole']];
// the inverse's entry timeframes, with the flux read for them
const UNIT: Record<string, string> = { '4h': '4 h · flux 4 h', '1d': 'Jour · flux jour' };
const TF_WORD: Record<string, string> = { '5m': '5 min', '15m': '15 min', '1h': '1 h', '4h': '4 h', '1d': 'journalier' };
const ON_CLASS: Record<string, string> = { Index: 'les indices', Forex: 'le forex', Commodity: 'l’or et le pétrole' };
const CURVE_NAME: Record<string, string> = { user: 'Ta règle', bare: 'Ta règle sans garde-fous', best: 'La moins mauvaise' };
const CURVE_COLOR: Record<string, string> = { user: '#2962ff', bare: '#f23645', best: '#ff9800' };
const WHY: Record<string, string> = { tp: 'objectif', flip: 'flux retourné', stop: 'stop', end: 'en cours' };
const num = (v: number, d = 2) => v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const sR = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${num(Math.abs(v), d)} R`);
const tone = (v: number | null | undefined) => (v == null ? '' : v >= 0 ? 'up' : 'down');
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)} %`);
const month = (t: number) => new Date(t * 1000).toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' });
const dayTime = (t: number) => new Date(t * 1000).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// the market's chart on the entry timeframe with the robot drawn (flux, baskets, guards)
function openChart(sym: string, cls: string, tf: string) {
  const cfg: IndicatorConfig = { id: nextId(), type: 'FLUX_GRID', period: 0, color: '#f23645', overlay: true, visible: true, inputs: {} };
  useStore.getState().setBottomDock({ tab: null });
  openChartTab(platformSymbol(sym, cls), platformTf(tf), [cfg]);
}

// how the robot trades a red flux, in one picture
function Sketch() {
  const lv = [123, 106, 90, 73, 56];
  // the correction from the low (200, 140) to the MM20 (330, 56): where it crosses each order
  const xAt = (y: number) => 200 + ((140 - y) / 84) * 130;
  return (
    <svg className="fg-sketch" viewBox="0 0 520 178" role="img" aria-label="Schéma de la grille sur un flux rouge">
      <path d="M10 22 L510 40 L510 64 L10 46 Z" fill="#f23645" opacity="0.18" />
      <path d="M10 46 L510 64" stroke="#f23645" strokeWidth="1.5" fill="none" />
      <text x="14" y="16" className="fg-t">Flux 1 h rouge : ventes seulement</text>
      <text x="398" y="78" className="fg-t fg-r">MM20</text>
      <polyline points="20,50 80,70 120,95 160,118 200,140 330,56 360,90 400,112 440,128 480,150" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {lv.map((y, k) => (
        <g key={y}>
          <line x1="190" x2="480" y1={y} y2={y} stroke="#f23645" strokeDasharray="4 3" opacity="0.7" />
          <path d={`M${xAt(y) - 4 - k} ${y - 9 - k} L${xAt(y) + 4 + k} ${y - 9 - k} L${xAt(y)} ${y - 2}`} fill="#f23645" />
        </g>
      ))}
      <text x="486" y={lv[0] + 4} className="fg-t">1</text>
      <text x="486" y={lv[4] + 4} className="fg-t">16</text>
      <line x1="200" x2="510" y1="140" y2="140" stroke="#089981" strokeWidth="1.5" strokeDasharray="2 3" />
      <text x="372" y="156" className="fg-t fg-g">objectif : bout de la jambe</text>
      <text x="14" y="170" className="fg-t">Bout de la jambe sur un gros support ou marteau : pas de grille</text>
    </svg>
  );
}

export default function FluxGridCard() {
  const [data, setData] = useKept<GridStudy | null>('robots.grid.data', null, true);
  const [missing, setMissing] = useKept('robots.grid.missing', false, true);
  const [tf, setTf] = useKept('robots.grid.tf', '15m');
  const [cls, setCls] = useKept('robots.grid.cls', 'Index');
  const [row, setRow] = useKept<string | null>('robots.grid.row', null, true);
  const [all, setAll] = useKept('robots.grid.all', false);
  const [showChoices, setShowChoices] = useKept('robots.grid.choices', true);

  useEffect(() => {
    let alive = true;
    fetch(`/robots/fluxgrid.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: GridStudy) => { if (alive) setData(j); })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [setData, setMissing]);

  const gi = data ? data.groups.findIndex((x) => x.tf === tf && x.cls === cls) : -1;
  const rows = useMemo(() => (data && gi >= 0
    ? data.rows.filter((r) => r.g === gi).sort((a, z) => (z.is[1] ?? -9) - (a.is[1] ?? -9))
    : []), [data, gi]);

  if (missing && !data) return <div className="rb-card"><div className="rb-note">L’étude de la grille n’a pas encore été publiée.</div></div>;
  if (!data) return <div className="rb-card"><div className="rb-note">Chargement de l’étude…</div></div>;
  const g = data.groups[gi];
  const gk = `${tf}|${cls}`;
  const user = data.curves.find((c) => c.id === 'user')?.groups[gk];
  const bare = data.curves.find((c) => c.id === 'bare')?.groups[gk];
  const best = data.curves.find((c) => c.id === 'best')?.groups[gk];
  const syms = data.markets[cls] ?? [];
  const split = Date.parse(data.split) / 1000;

  return (
    <>
      <div className="rb-card">
        <div className="rb-card-title">Robot grille sur le flux · entrées 5 ou 15 min <span className="fx-badge">Aucun réglage rentable</span></div>
        <div className="fg-head">
          <Sketch />
          <ol className="fg-rules">
            <li><b>Sens</b> : flux MM20 / MM50 en 1 heure. Rouge, ventes seulement ; vert, achats seulement.</li>
            <li><b>Grille</b> : quand le prix revient vers le flux, 5 ordres du bout de la jambe jusqu’à la MM20, chacun deux fois plus gros (1-2-4-8-16).</li>
            <li><b>Sortie</b> : tout le panier quand le prix revient au bout de la jambe.</li>
            <li><b>Invalidation</b> : le flux change de couleur, tout est fermé.</li>
            <li><b>Garde-fous</b> : pas de grille si la jambe finit sur un gros support ou une grosse résistance du jour ou de la semaine (balayage de liquidité compris), ni après un marteau ou une grande mèche au bout de la jambe (5-15 min, 1 h, 4 h). Une grande mèche contre le panier arrête les ajouts.</li>
          </ol>
        </div>
        <div className="fg-open">
          <span className="rb-note">Voir le robot sur un graphique :</span>
          {syms.map((s) => <button key={s} className="pill-btn" onClick={() => openChart(s, cls, tf)}>{s} {TF_LABEL[tf] ?? tf}</button>)}
        </div>
      </div>

      <div className="rb-card">
        <div className="rb-card-title">Ce que dit le test · depuis 2020, frais réels</div>
        <div className="hr-controls">
          <div className="hr-chips">{['5m', '15m'].map((x) => <button key={x} className={tf === x ? 'on' : ''} onClick={() => { setTf(x); setRow(null); }}>{TF_LABEL[x] ?? x}</button>)}</div>
          <div className="hr-chips">{CLASSES.map(([k, l]) => <button key={k} className={cls === k ? 'on' : ''} onClick={() => { setCls(k); setRow(null); }}>{l}</button>)}</div>
        </div>
        {user && bare && best && (
          <>
            <div className="rb-kpis fg-kpis">
              <div className={`rb-kpi ${user.win > 0.5 ? 'good' : ''}`}><span>Paniers gagnants</span><b>{pct(user.win)}</b><small>{user.n.toLocaleString(LOCALE)} paniers</small></div>
              <div className="rb-kpi bad"><span>Résultat total</span><b>{sR(user.total, 0)}</b><small>1 R = 1 % du compte par panier</small></div>
              <div className="rb-kpi bad"><span>Pire panier</span><b>{sR(user.worst, 1)}</b><small>la martingale prise à contre-sens</small></div>
              <div className="rb-kpi"><span>Par panier</span><b>{sR(user.is, 3)}</b><small>{`validation ${sR(user.oos, 3)}`}</small></div>
            </div>
            <ul className="dow-verdict">
              <li>{`Ta règle gagne ${pct(user.win)} des paniers, mais les petits gains ne paient pas les grosses pertes : ${sR(user.total, 0)} au total sur ${ON_CLASS[cls] ?? cls} en ${TF_LABEL[tf] ?? tf}. À 1 % de risque par panier, le compte de 10 000 € serait vidé.`}</li>
              <li>{`Les garde-fous vont dans le bon sens : ${Math.round((1 - user.n / bare.n) * 100)} % de paniers en moins, et la perte passe de ${sR(bare.total, 0)} à ${sR(user.total, 0)}. Mais ils ne suffisent pas.`}</li>
              <li>{`Même sans aucun frais, aucun des ${g?.settings ?? 0} réglages ne gagne de façon stable (0 trouvé sur 2020 → août 2024, dans les 6 groupes).`}</li>
              <li>{`La moins mauvaise version (objectif à mi-chemin, stop au-delà du nuage, jambes d’au moins 3 ATR 1 h) perd encore ${sR(best.is, 3)} par panier en réglage et ${sR(best.oos, 3)} en validation.`}</li>
            </ul>
            <LineChart
              height={230}
              series={(['user', 'bare', 'best'] as const).map((id) => ({ label: CURVE_NAME[id], color: CURVE_COLOR[id], points: data.curves.find((c) => c.id === id)!.groups[gk].pts }))}
              xFmt={month} yFmt={(y) => `${Math.round(y).toLocaleString(LOCALE)} R`}
              marker={{ x: split, label: 'Début de la validation' }}
            />
            <div className="fg-legend">
              {(['user', 'bare', 'best'] as const).map((id) => <span key={id}><i style={{ background: CURVE_COLOR[id] }} />{CURVE_NAME[id]}</span>)}
              <small>R cumulés, tous les marchés de la classe ensemble</small>
            </div>
          </>
        )}
      </div>

      {data.inverse && (
        <div className="rb-card">
          <div className="rb-card-title">L’inverse : prendre le retournement <span className="fx-badge">Aucun réglage rentable</span></div>
          <ul className="dow-verdict">
            <li>Là où les garde-fous bloquent la grille : en flux rouge, achat au bout de la jambe après une grande mèche ou un marteau, ou une clôture revenue au-dessus d’un gros support (vente en flux vert). Stop juste sous le bas, objectif le retour au flux ou 1 à 3 R, sortie au plus tard après 3 jours.</li>
            <li>{`${data.inverse.settings} réglages en 5 min, 15 min, 1 h, 4 h et jour, sur les indices, le forex, l’or et le pétrole, frais de nuit des CFD compris : ${data.inverse.found} trouvés sur 2020 → août 2024, ${data.inverse.holds ? `${data.inverse.holds} qui tiennent ensuite` : "aucun ne tient ensuite"}.`}</li>
            {data.inverse.foundIn?.map((f) => (
              <li key={`${f.tf}${f.cls}`}>{`Les ${f.n} trouvés sont en ${TF_WORD[f.tf] ?? f.tf} sur ${ON_CLASS[f.cls] ?? f.cls} : ${sR(f.is, 2)} par trade en réglage, puis ${sR(f.oos, 2)} en validation, moins que des entrées au hasard au même endroit (${sR(f.oosRnd, 2)}).`}</li>
            ))}
            <li>En 5 min, 15 min et 1 h, le marteau 1 h ou 4 h posé sur un gros niveau bat le hasard sur les deux périodes : c’est pour ça que tes garde-fous aident la grille. Mais avant frais il ne gagne que 0 à 0,06 R par trade, et les frais d’un trade intraday en coûtent 0,10 à 0,15 R.</li>
            <li>En 4 h et en jour, les frais pèsent moins, mais l’avantage sur le hasard disparaît en validation. En jour, depuis septembre 2024, même des entrées au hasard au bout des jambes gagnent (les marchés en V de 2025) : le signal fait moins bien qu’elles.</li>
          </ul>
          <table className="rb-table">
            <thead>
              <tr><th>Signal</th><th>Unité</th><th>Après frais</th><th title="Le même nombre d’entrées tirées au hasard au même endroit de la jambe, sans le signal">Au hasard, même endroit</th><th>Sans frais</th><th title="Part des 30 tirages au hasard que le signal bat, réglage → validation">Tirages battus</th></tr>
            </thead>
            <tbody>
              {data.inverse.signals.filter((s) => !(s.tf === '1h' && s.k === 'wick|htf')).map((s) => (
                <tr key={`${s.tf}${s.k}`}>
                  <td className="left">{s.label}</td><td>{UNIT[s.tf] ?? TF_LABEL[s.tf] ?? s.tf}</td>
                  <td className={tone(s.oos)}>{sR(s.is, 3)} → {sR(s.oos, 3)}</td>
                  <td>{sR(s.isRnd, 3)} → {sR(s.oosRnd, 3)}</td>
                  <td className={tone(s.oosGross)}>{sR(s.isGross, 3)} → {sR(s.oosGross, 3)}</td>
                  <td>{pct(s.beat)}{s.beatOos != null && ` → ${pct(s.beatOos)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rb-note">R par trade, réglage (2020 → août 2024) → validation (depuis septembre 2024), tous les objectifs, jambes et stops ensemble. À partir de 1 h, les mèches plus courtes que la bougie n’existent pas : une seule ligne de mèches est gardée. En 4 h, le flux est lu en 4 h (lu en jour, c’est pire) ; en jour, en jour.</div>
        </div>
      )}

      <div className="rb-card">
        <button className="rb-card-title rb-toggle" onClick={() => setShowChoices(!showChoices)}>{showChoices ? '▾' : '▸'} Ce que change chaque choix · R par panier, réglage → validation</button>
        {showChoices && (
          <table className="rb-table">
            <thead><tr><th>Choix</th><th>Option</th><th>5 min</th><th>15 min</th></tr></thead>
            <tbody>
              {data.choices.flatMap((c) => c.opts.map((o, i) => (
                <tr key={`${c.key}${o.v}`}>
                  <td>{i === 0 ? <b>{c.name}</b> : ''}</td>
                  <td className="left">{o.label}</td>
                  {(['5m', '15m'] as const).map((x) => <td key={x} className={tone(o[x][1])}>{sR(o[x][0], 3)} → {sR(o[x][1], 3)}</td>)}
                </tr>
              )))}
            </tbody>
          </table>
        )}
      </div>

      {data.recent[gk]?.length > 0 && (
        <div className="rb-card">
          <div className="rb-card-title">{`Derniers paniers de ta règle · ${MARKET_LABEL[cls] ?? cls} ${TF_LABEL[tf] ?? tf}`}</div>
          <table className="rb-table">
            <thead><tr><th>Date</th><th>Marché</th><th>Sens</th><th>Entrées</th><th>Sortie</th><th>Résultat</th></tr></thead>
            <tbody>
              {data.recent[gk].map((b, i) => (
                <tr key={i}>
                  <td>{dayTime(b.t)}</td><td><b>{b.sym}</b></td>
                  <td className={b.dir > 0 ? 'up' : 'down'}>{b.dir > 0 ? 'Achats' : 'Ventes'}</td>
                  <td>{b.fills} / 5</td><td>{WHY[b.why] ?? b.why}</td>
                  <td className={tone(b.r)}>{sR(b.r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {g && (
        <div className="rb-card">
          <div className="rb-card-title">{`Tous les réglages · ${MARKET_LABEL[cls] ?? cls} ${TF_LABEL[tf] ?? tf} (${g.markets} marchés) · du meilleur au pire en réglage`}</div>
          <div className="rb-note">Clique sur un réglage pour le détail par marché. Aucun n’est positif en réglage avec un t de 2 sur la majorité des marchés.</div>
          <table className="rb-table rb-general fx-table">
            <thead><tr><th>Paramètres</th><th>Réglage</th><th>Validation</th><th title="Paniers gagnants · pire panier">Gagnants</th><th>Sans frais</th></tr></thead>
            <tbody>
              {(all ? rows : rows.slice(0, 15)).map((r) => (
                <GridRow key={r.k} r={r} cls={cls} tf={tf} open={row === r.k} onToggle={() => setRow(row === r.k ? null : r.k)} />
              ))}
            </tbody>
          </table>
          {rows.length > 15 && <button className="off-link" onClick={() => setAll(!all)}>{all ? 'Afficher les 15 premiers' : `Afficher les ${rows.length} réglages`}</button>}
        </div>
      )}

      <div className="rb-card">
        <div className="rb-card-title">Comment c’est testé</div>
        <ul className="dow-verdict">
          <li>{`Indices (${data.markets.Index?.join(', ')}), forex (${data.markets.Forex?.join(', ')}), or et pétrole, du 1er janvier 2020 à aujourd’hui ; le gaz n’a pas d’historique en 5 et 15 min.`}</li>
          <li>Réglage sur janvier 2020 → août 2024, validation depuis septembre 2024, jamais utilisée pour choisir.</li>
          <li>Chaque bougie est rejouée dans l’ordre : un ordre n’est rempli que si le prix le dépasse de 0,05 ATR ; si l’objectif et un nouvel ordre tombent dans la même bougie, l’ordre est ignoré ; le stop passe avant l’objectif.</li>
          <li>1 R = ce que perd le panier si tous ses ordres sont remplis et que le prix va 0,5 ATR 1 h au-delà du nuage. Avec l’invalidation au flux, une perte peut dépasser 1 R de loin.</li>
          <li>Frais réels de chaque marché, à l’entrée et à la sortie de chaque ordre. Rapport complet : robots/fluxgrid/GRILLE.md.</li>
        </ul>
      </div>
    </>
  );
}

function GridRow({ r, cls, tf, open, onToggle }: { r: Row; cls: string; tf: string; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`click ${open ? 'best' : ''}`} onClick={onToggle}>
        <td className="left">{LANG === 'en' ? r.le : r.l}</td>
        <td className={tone(r.is[1])}>{sR(r.is[1], 3)}<small>{`${r.is[0]} paniers · ${r.is[3]}/${r.is[4]} marchés positifs`}</small></td>
        <td className={tone(r.oos[1])}>{sR(r.oos[1], 3)}<small>{`${r.oos[0]} paniers · ${r.oos[3]}/${r.oos[4]} marchés positifs`}</small></td>
        <td>{pct(r.is[5])}<small>{`pire ${sR(r.is[6], 1)}`}</small></td>
        <td className={tone(r.gross)}>{sR(r.gross, 3)}</td>
      </tr>
      {open && (
        <tr><td colSpan={5}>
          <table className="rb-table fx-per">
            <thead><tr><th>Marché</th><th>Réglage</th><th>Validation</th><th>Pire panier</th><th /></tr></thead>
            <tbody>
              {r.per.map(([sym, isN, isR, oosN, oosR, worst]) => (
                <tr key={sym}>
                  <td><b>{sym}</b></td>
                  <td className={tone(isN ? isR : null)}>{isN ? sR(isR, 3) : '—'}<small>{` ${isN} paniers`}</small></td>
                  <td className={tone(oosN ? oosR : null)}>{oosN ? sR(oosR, 3) : '—'}<small>{` ${oosN} paniers`}</small></td>
                  <td className={tone(worst)}>{sR(worst, 1)}</td>
                  <td><button className="pill-btn" onClick={() => openChart(sym, cls, tf)}>Ouvrir le graphique</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </td></tr>
      )}
    </>
  );
}
