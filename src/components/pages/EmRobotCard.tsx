// The Expected Move study (robots/em/EM.txt, scripts/robots/em-study.ts, 16 October 2026), shown
// above the robot chosen in the list, as the hour range's study is: what was tried, what held,
// how little. The robots themselves (public/robots/em.json) are in the list like the others.

import { LOCALE } from '../../i18n/lang';

// the rule on the 5 indices, per year (R at CME costs)
const YEARS: [number, number][] = [[2020, 69], [2021, 80], [2022, 182], [2023, 15], [2024, 17], [2025, 17], [2026, -4]];
const sR = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE)} R`;

export default function EmRobotCard() {
  return (
    <div className="rb-card">
      <div className="rb-card-title">Expected Move · ce que dit l’étude <span className="rb-short">Non prouvé</span></div>
      <ul className="dow-verdict">
        <li>12 000 règles × 9 découpes (sens, régime du VIX) testées depuis 2020 sur S&amp;P, Nasdaq, Dow, DAX et Nikkei, aux frais d’un future CME. Jouer contre les niveaux, l’usage habituel de l’Expected Move, perd environ 0,13 R par trade.</li>
        <li>La seule règle qui tient un peu : une clôture de 15 min au-delà de la distance moyenne, entrée dans son sens, stop à 20 % de l’EM, objectif 3 R, sortie à la clôture, seulement quand le VIX est à 20 ou plus.</li>
        <li>Pas à pas sur les 5 indices : +0,06 R par trade, 4 années sur 5 positives, mais en baisse depuis 2023 et pas significative sur la validation. Aux frais d’un CFD, elle perd.</li>
        <li>Russell 2000 absent : son indice cash est en retard sur ses actions, ce qui fausse ses cassures, et l’historique du future RTY manque. Le DAX ne se trade en automatique que si IB Gateway est lancé.</li>
      </ul>
      <div className="rb-note">La règle année par année, sur les 5 indices. Les années jusqu’en août 2024 ont servi à la choisir.</div>
      <div className="dow-years">{YEARS.map(([y, r]) => <span key={y} className={r >= 0 ? 'up' : 'down'} title={`${y}, 5 indices, frais CME`}>{y} {sR(r)}</span>)}</div>
    </div>
  );
}
