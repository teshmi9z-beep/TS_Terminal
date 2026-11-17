// The price-action study of 11 November 2026 (robots/pa/PRICE-ACTION.md, scripts/robots/pa-*.ts),
// shown above the robot chosen in the list: what was tried, what held, how little. The robots
// themselves (public/robots/nb.json) are in the list like the others.

import { LOCALE } from '../../i18n/lang';

// the walk-forward 2022 → 2026 of the study, all markets, per year (R at tight costs)
const YEARS: [number, number][] = [[2022, 43], [2023, 22], [2024, 11], [2025, -5], [2026, 30]];
const sR = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString(LOCALE)} R`;

export default function NbRobotCard() {
  return (
    <div className="rb-card">
      <div className="rb-card-title">Bande de bruit · ce que dit l’étude <span className="rb-short">Non prouvé</span></div>
      <ul className="dow-verdict">
        <li>Étude price action du 11 novembre sur 18 marchés (indices, forex majeur, matières premières) depuis 2020 : tendance journalière, force relative des devises et vente de la sortie de bande ne donnent rien.</li>
        <li>La seule idée qui tient un peu : toutes les 30 min, une clôture hors de l’écart habituel à l’ouverture (14 séances) est suivie jusqu’à la fin de séance. Avant frais, l’or et le Nasdaq gagnent 7 années sur 7.</li>
        <li>Pas à pas 2022 → 2026, marché et réglage choisis sur les années d’avant : +0,03 R par trade sur 3 105 trades (t 1,8). Des entrées au hasard aux mêmes heures ne font jamais aussi bien.</li>
        <li>Fragile : aux frais habituels du labo elle ne gagne rien, et frais doublés il reste +40 R sur 5 ans. Les frais comptés ici sont ceux d’un future micro ou d’un CFD aux heures principales, à vérifier sur ton compte.</li>
        <li>Les 4 marchés de la liste sont ceux que l’étude a gardés le plus longtemps : choisis après coup, leurs chiffres sont donc optimistes. L’or n’est pas confirmé sur une seconde source de prix.</li>
        <li>Premier test sur des données jamais vues, du 19 septembre au 11 novembre 2026 : −6,9 R sur 87 signaux (Nasdaq, USDJPY, or), soit −6,7 % à 1 % par signal. Malchance ou avantage surestimé : seul le suivi virtuel le dira.</li>
      </ul>
      <div className="rb-note">Le pas à pas année par année, tous marchés. Stop à 2 fois le mouvement habituel d’une séance : les stops serrés coûtent plus qu’ils ne protègent.</div>
      <div className="dow-years">{YEARS.map(([y, r]) => <span key={y} className={r >= 0 ? 'up' : 'down'} title={`${y}, pas à pas, frais serrés`}>{y} {sR(r)}</span>)}</div>
    </div>
  );
}
