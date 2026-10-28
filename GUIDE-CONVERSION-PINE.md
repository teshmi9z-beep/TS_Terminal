# Convertir un indicateur TradingView (Pine Script) pour la Plateforme Maison

Ce fichier sert à **deux personnes** :

- **Toi** : la partie A dit quoi faire, étape par étape.
- **Claude (claude.ai, version normale)** : la partie B contient tout ce qu'il doit savoir sur la plateforme. Il ne voit pas ton ordinateur, donc tout est écrit ici.

---

## A. Mode d'emploi (pour toi)

### 1. Essaie d'abord le convertisseur intégré

Dans la plateforme : **Indicateurs → Nouveau script Pine**, colle le code.

- Si le script s'affiche, c'est fini.
- Les avertissements jaunes (« line.new est ignoré », « table », « alertcondition »…) ne bloquent pas.
- Une **erreur rouge** (« fonction non prise en charge », « les tableaux ne sont pas encore pris en charge »…) veut dire que le script est trop riche pour le convertisseur : passe à l'étape 2.

En général ça bloque avec : `array.*`, `request.security`, `str.*` (sauf `str.tostring`), heures avec fuseau (`hour(t, "America/New_York")`), `var` dans une fonction, fonctions qui renvoient plusieurs valeurs.

### 2. Demande la conversion à Claude

1. Ouvre une nouvelle conversation sur claude.ai.
2. **Joins ce fichier** (glisser-déposer) ou colle tout son contenu.
3. Écris ce message, puis colle ton code Pine en dessous :

```
Lis le guide joint (partie B) et convertis cet indicateur Pine Script en indicateur natif pour ma plateforme.
Nom du type : MON_NOM (en MAJUSCULES, sans espace)
Indicateur sur le prix (overlay) ou dans un panneau séparé : comme dans le script
Donne-moi : 1) le fichier complet, 2) les trois petites modifications à faire, 3) ce qui n'a pas pu être converti.

<colle ton code Pine ici>
```

Remplace `MON_NOM` par un nom court, par exemple `SUPER_TREND_V2`.

### 3. Installe ce que Claude te donne

Le dossier de la plateforme est celui qui contient `package.json` et `lancer.bat`.

1. **Le fichier** : crée `src\indicators\custom\monNom.ts` (le nom que Claude donne) et colle le code dedans.
2. **`src\types.ts`** : cherche la ligne qui commence par `export type OverlayIndicatorType` (indicateur sur le prix) ou `export type PaneIndicatorType` (panneau séparé). Ajoute `| 'MON_NOM'` juste avant le `;` de la fin.
3. **`src\indicators\registry.ts`** :
   - en haut, avec les autres `import`, ajoute la ligne d'import que Claude donne ;
   - plus bas, dans la liste `export const INDICATORS = { ... }`, ajoute `MON_NOM,` juste avant `ROBOT,`.

### 4. Vérifie

Dans un terminal ouvert dans le dossier de la plateforme :

```bash
npx tsc --noEmit -p tsconfig.app.json
```

- **Rien ne s'affiche** : c'est bon. Relance la plateforme (`lancer.bat`) ; l'indicateur est dans **Indicateurs**, catégorie Personnalisés.
- **Des erreurs s'affichent** : copie-les **toutes** et renvoie-les à Claude dans la même conversation (« voici les erreurs, corrige le fichier »).
- **L'indicateur ne ressemble pas à TradingView** : envoie à Claude une capture de TradingView et une de la plateforme, sur le même symbole, la même unité de temps et la même date, avec 2 ou 3 valeurs lues sur chacune.

Conseil : avant de modifier les fichiers, fais une copie du dossier `src` pour pouvoir revenir en arrière.

---

## B. Instructions pour Claude

Tu convertis un indicateur Pine Script (TradingView) en **indicateur natif TypeScript** pour une plateforme de trading personnelle (React + TypeScript + Vite). Tu ne vois pas le dépôt : tout ce dont tu as besoin est ci-dessous. N'invente aucune fonction, aucun fichier, aucun import qui n'y figure pas.

### B1. Ce que tu dois rendre

1. **Un fichier complet** `src/indicators/custom/<camelCase>.ts` qui exporte `export const MON_NOM: IndicatorDef = { ... }`.
2. **Les trois modifications** à faire, écrites exactement :
   - dans `src/types.ts`, ajouter `| 'MON_NOM'` à `OverlayIndicatorType` (si `overlay: true`) ou à `PaneIndicatorType` (sinon) ;
   - dans `src/indicators/registry.ts`, la ligne `import { MON_NOM } from './custom/<camelCase>';` ;
   - dans `src/indicators/registry.ts`, l'entrée `MON_NOM,` à mettre dans l'objet `INDICATORS`.
3. **Une liste courte, en français, de ce qui n'a pas été converti** ou l'a été autrement : alertes, tableaux, `request.security`… et pourquoi.

Les textes vus par l'utilisateur (libellés, description, infobulles) sont **en français**. Les commentaires du code sont en anglais, courts, et disent le pourquoi.

### B2. Le contrat : types disponibles (ne pas les redéclarer, les importer)

```ts
// src/types.ts
export type Candle = { time: number /* unix SECONDES, début de la bougie */; open: number; high: number; low: number; close: number; volume: number };

export type IndicatorConfig = {
  id: string; type: IndicatorType; period: number; color: string; overlay: boolean; visible: boolean;
  inputs?: Record<string, number | boolean | string>;   // valeurs des réglages (clé = InputDef.key)
  plotColors?: Record<string, string>;
  // (d'autres champs existent pour les indicateurs intégrés : ne pas s'en servir)
};

// src/indicators/types.ts
export type PlotPoint = { time: number; value: number; color?: string };   // color = couleur par bougie
export type PlotMarker = {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar' | 'atPriceTop' | 'atPriceBottom' | 'atPriceMiddle';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string; text?: string; price?: number /* pour atPrice* */; size?: number /* 1 = normal, 0.6 ≈ size.tiny */;
};
// box.new : de la bougie `left` à la bougie `right` (+ rightBars bougies, peut aller dans le futur)
// leftBars / rightBars en bougies, fractions permises (-0.4 / 0.4 = largeur d'une bougie)
export type PlotBox = {
  left: number; leftBars?: number; right: number; rightBars?: number;
  top: number; bottom: number; fill: string; border?: string; borderWidth?: number;
  borderStyle?: 'solid' | 'dotted' | 'dashed';
};
// label.new sans fond : style 'down' = texte au-dessus du prix (label_down), 'up' = en dessous
export type PlotLabel = { time: number; price: number; text: string; color: string; style: 'down' | 'up'; size?: number /* px, 10 conseillé */ };
export type PlotFillPoint = { time: number; a: number; b: number; color: string };   // fill() : une bande par bougie, NaN = trou
export type PlotBackground = { from: number; to: number; color: string };            // bgcolor()
export type PlotCandle = { time: number; open: number; high: number; low: number; close: number; color: string };

export type Plot = {
  key: string; name: string; color: string;
  kind: 'line' | 'histogram' | 'candles' | 'hline' | 'markers' | 'boxes' | 'labels' | 'fill' | 'bgcolor';
  width?: number;
  step?: boolean;      // plot.style_stepline
  data: PlotPoint[];   // line / histogram ; [] pour les autres kinds
  price?: number;      // hline
  dashed?: boolean;
  markers?: PlotMarker[]; candles?: PlotCandle[]; boxes?: PlotBox[]; labels?: PlotLabel[];
  fill?: PlotFillPoint[]; bg?: PlotBackground[];
};

export type InputDef = {
  key: string; label: string; default: number | boolean | string;
  kind?: 'number' | 'bool' | 'source' | 'string' | 'color' | 'session';   // session = "HHMM-HHMM"
  group?: string; inline?: string; tooltip?: string;
  options?: string[];                 // liste déroulante (avec kind: 'string')
  min?: number; max?: number; step?: number;
};
export type StyleDef = { key: string; name: string; color: string };

export type IndicatorDef = {
  type: IndicatorType;                // 'MON_NOM'
  label: string;                      // nom long dans le menu
  short: string;                      // nom court dans la légende
  category: 'Tendance' | 'Oscillateurs' | 'Volatilite' | 'Volume' | 'Personnalises';   // mettre 'Personnalises'
  overlay: boolean;                   // true = sur le prix, false = panneau séparé
  description: string;
  defaults: { period: number; color: string };   // en pratique { period: 0, color: '#xxxxxx' }
  inputs?: InputDef[];
  styles?: StyleDef[];                // mettre [] si pas besoin
  range?: [number, number];           // oscillateur à échelle fixe, ex. [0, 100]
  levels?: number[];                  // niveaux pointillés (70/30…)
  params: (cfg: IndicatorConfig) => string;      // texte court après le nom dans la légende
  compute: (candles: Candle[], cfg: IndicatorConfig) => Plot[];
};
```

Imports depuis le fichier `src/indicators/custom/xxx.ts` :

```ts
import type { Candle } from '../../types';
import type { IndicatorDef, Plot, PlotPoint, PlotMarker, PlotBox, PlotLabel, PlotFillPoint, PlotBackground } from '../types';
import { inputOf, boolInput, stringInput, plotColor, withTransparency, toPoints,
         highest, lowest, smaNa, linreg, stoch, highs, lows, closes } from '../helpers';
import { sma, ema, wma, zlema, rsi, atr, cci, momentum, bollinger, macd, stochastic, vwap, donchian, obv, williamsR, adx, heikinAshi } from '../math';
```

N'importe que ce dont tu te sers.

### B3. Fonctions déjà prêtes

`src/indicators/helpers.ts` (séries = `number[]` alignées sur les bougies, `NaN` = `na`) :

| Fonction | Équivalent Pine |
|---|---|
| `inputOf(cfg, DEF, 'key'): number` | lire un input numérique |
| `boolInput(cfg, DEF, 'key'): boolean` | input.bool |
| `stringInput(cfg, DEF, 'key'): string` | input.string, input.color, input.session |
| `plotColor(cfg, DEF, 'key'): string` | couleur d'un `styles` |
| `withTransparency('#rrggbb', transp)` | `color.new(c, transp)` (0 = opaque, 100 = invisible) |
| `toPoints(candles, values)` | série → `PlotPoint[]` en sautant les NaN |
| `highest(src, len)` / `lowest(src, len)` | `ta.highest` / `ta.lowest` |
| `smaNa(src, len)` | `ta.sma` sur une série (NaN tant que la fenêtre est incomplète) |
| `linreg(src, len)` | `ta.linreg(src, len, 0)` |
| `stoch(candles, len)` | `ta.stoch(close, high, low, len)` |
| `highs(k)`, `lows(k)`, `closes(k)` | séries high, low, close |

`src/indicators/math.ts` : chacune prend les **bougies** et renvoie des `LinePoint[]` (`{ time, value }`), pas un `number[]` :

- Une seule série : `sma(k, n)`, `ema(k, n)`, `wma(k, n)`, `zlema(k, n)`, `rsi(k, n)`, `atr(k, n)`, `cci(k, n)`, `momentum(k, n)`, `vwap(k)`, `obv(k)`, `williamsR(k, n)`.
- Plusieurs séries (objet) : `bollinger(k, n, mult)` → `{ basis, upper, lower }` ; `donchian(k, n)` → `{ upper, lower, basis }`. `macd(k, fast, slow, signal)` → `{ macdLine, signal, histogram }` ; `stochastic(k, kP, dP)` → `{ kLine, dLine }` ; `adx(k, n)` → `{ adxLine, plusDI, minusDI }`.
- `heikinAshi(k)` → `Candle[]`.

Pour une moyenne **sur une autre série que le close** (ex. `ta.ema(rsi, 9)`), écris-la toi-même dans le fichier : une boucle simple.

### B4. Règles de conversion

**Calcul**
- `compute` reçoit **toutes** les bougies chargées, de la plus ancienne à la plus récente, et refait tout le calcul à chaque appel. Écris des boucles `for (let i = 0; i < k.length; i++)` : c'est l'équivalent de l'exécution Pine bougie par bougie.
- `var x = …` en Pine = une variable déclarée **avant** la boucle. `x[1]` = la valeur à `i - 1`, donc garde les séries dans des tableaux.
- `na` = `NaN` ; `na(x)` = `!Number.isFinite(x)` ; `nz(x, y)` = `Number.isFinite(x) ? x : y`.
- **Jamais de regard vers le futur** : à la bougie `i`, n'utilise que `0..i`. Exception, comme Pine : les dessins (`box`, `label`, `line`) peuvent être prolongés vers la droite.
- Un indicateur doit rester rapide (il tourne à chaque nouvelle bougie) : pas de boucle dans une boucle sur tout l'historique si on peut l'éviter.
- Si les données sont insuffisantes, renvoie un tableau de plots vides plutôt que de planter.

**Dessin**

| Pine | Plateforme |
|---|---|
| `plot()` | `{ kind: 'line', data: toPoints(k, serie) }` ; couleur par bougie : `data.map(p => ({ ...p, color }))` |
| `plot.style_linebr` | les NaN coupent déjà la ligne |
| `plot.style_stepline` | `step: true` |
| `plot.style_histogram` / `columns` | `kind: 'histogram'` |
| `hline()` | `{ kind: 'hline', price, dashed: true, data: [] }` |
| `plotshape` / `plotchar` / `plotarrow` | `{ kind: 'markers', markers: [...] }` |
| `fill(p1, p2)` | `{ kind: 'fill', fill: [{ time, a, b, color }] }` (un point par bougie, NaN pour couper) |
| `bgcolor()` | `{ kind: 'bgcolor', bg: [{ from, to, color }] }` |
| `box.new` | `{ kind: 'boxes', boxes: [...] }` |
| `line.new` (horizontale) | un `PlotBox` avec `top === bottom`, `fill: 'rgba(0,0,0,0)'`, `border`, `borderWidth`, `borderStyle` |
| `line.new` (oblique) | pas d'équivalent direct : approche avec une `line` dont les points sont interpolés, ou signale-le |
| `label.new` | `{ kind: 'labels', labels: [...] }` (texte sans fond) |
| `table.new` / `table.cell` | **un seul `PlotLabel`** multi-lignes (`text` avec `\n`), placé à droite de la dernière bougie (`time: dernière.time + pas * 12`) |
| `plotcandle` / `barcolor` | `{ kind: 'candles', candles: [...] }` |
| `alertcondition` / `alert()` | **pas d'équivalent dans l'indicateur** : à signaler dans la liste « non converti » |

- Chaque `Plot` a une `key` **unique et stable**, et un `name` en français.
- Un affichage désactivé par un input garde son plot, avec `data: []` : la légende ne change pas de forme.
- Pas plus de quelques milliers de boxes ou labels : garde les plus récents (`.slice(-1500)`).

**Réglages (`input.*`)**

| Pine | `InputDef` |
|---|---|
| `input.int` / `input.float` | `{ key, label, default, min, max, step }` |
| `input.bool` | `kind: 'bool'` |
| `input.string(options=[…])` | `kind: 'string', options: [...]` |
| `input.color` | `kind: 'color'` (valeur `'#rrggbb'`) |
| `input.session` | `kind: 'session'` (valeur `"0930-1600"`) |
| `input.source` | `kind: 'source'` (valeur `'close'`, `'hlc3'`…) : la lire avec `stringInput` et calculer la série toi-même |

Garde `group` et `inline` comme dans le script. Traduis les libellés en français s'ils sont en anglais.

**Heures et fuseaux**
- `candle.time` est en **secondes UTC**. Pour l'heure locale d'une place boursière, utilise `Intl.DateTimeFormat` avec `timeZone: 'America/New_York'` (ou autre), `hourCycle: 'h23'`. Mets le formateur en cache, hors de la boucle : il est lent.
- L'unité de temps du graphique : déduis le pas des bougies (`k[k.length-1].time - k[k.length-2].time`) plutôt que de le supposer.
- Bougies journalières : `time` = minuit UTC de la date de la place (« 2026-10-09 » → `new Date(time*1000).toISOString().slice(0,10)`).

**Autres symboles (`request.security`)**

L'indicateur ne reçoit que les bougies du graphique. Si le script en a besoin, choisis dans l'ordre :

1. **Une autre unité de temps du même symbole** (ex. `request.security(syminfo.tickerid, "D", close)`) : recalcule-la depuis les bougies du graphique en les regroupant (par jour, semaine…), sans regarder dans le futur (la valeur d'un jour n'est connue qu'à sa clôture).
2. **Un autre symbole** (VIX, DXY…) : la plateforme a un mécanisme `companion(sym, timeframe, from?)` dans `src/indicators/companion.ts`. Il renvoie `{ candles, state: 'loading' | 'ready' | 'error', error? }` et se recharge seul. On trouve `sym` avec `SYMBOLS.find(s => s.ticker === 'VIX')` (import `{ SYMBOLS } from '../../data/symbols'`), et le symbole du graphique avec `currentChartSeries()` (`{ sym, tf } | null`, même fichier companion). Le timeframe s'écrit `'1D'`, `'1h'`, `'30m'`, `'15m'`… Tant que `state !== 'ready'`, affiche un label « chargement… ».
   **Préviens l'utilisateur** : le symbole doit exister dans la plateforme. Sinon il faut l'ajouter dans `src/data/symbols.ts`, au format `{ ticker: 'VIX1D', name: '…', basePrice: 12, category: 'Indices', yahoo: '^VIX1D' }`, et donne-lui cette ligne.
3. **Sinon** : signale-le comme non converti.

**Symboles de la plateforme utiles** (`ticker`) :
- indices cash : `SPX500`, `NDX100`, `DJI`, `RUT2000`, `DAX40`, `CAC40`, `NIKKEI`, `HSI` ;
- futures : `US500`, `US100`, `US30`, `US2000`, `DE40`, `FR40`, `J225`, `HK50` ;
- volatilité : `VIX`, `VIX1D`, `VXN`, `VXD`, `RVX` ; dollar : `DXY`.

### B5. Exemple complet (à imiter)

Conversion du Pine « Sto+RSI » (stochastique lent + RSI dans un panneau) :

```ts
import type { IndicatorDef, Plot, PlotPoint } from '../types';
import { rsi } from '../math';
import { boolInput, inputOf, smaNa, stoch, stringInput, toPoints } from '../helpers';

const LIME = '#00E676', RED = '#FF5252', GREEN = '#4CAF50', BLACK = '#363A45';

// Port of the Pine Script indicator "Sto+RSI": slow stochastic (D colored by its direction) and RSI in one pane.
export const STO_RSI: IndicatorDef = {
  type: 'STO_RSI',
  label: 'Sto+RSI',
  short: 'Sto+RSI',
  category: 'Personnalises',
  overlay: false,
  description: 'Stochastique lent (D vert ou rouge selon sa pente) et RSI dans le même panneau',
  defaults: { period: 0, color: '#2196F3' },
  inputs: [
    { key: 'voirSto', label: 'Stochastique', default: true, kind: 'bool', group: 'STO', inline: 'st' },
    { key: 'lengthK', label: 'Longueur K', default: 200, min: 1, max: 5000, group: 'STO', inline: 'st1' },
    { key: 'colorK', label: '', default: '#2196F3', kind: 'color', group: 'STO', inline: 'st1' },
    { key: 'lengthD', label: 'Lissage D', default: 200, min: 1, max: 5000, group: 'STO', inline: 'st2' },
    { key: 'smoothK', label: 'Lissage K', default: 3, min: 1, max: 500, group: 'STO', inline: 'st3' },
    { key: 'upper', label: 'Haut', default: 80, min: 50, max: 100, group: 'STO', inline: 'st4' },
    { key: 'lower', label: 'Bas', default: 20, min: 0, max: 50, group: 'STO', inline: 'st4' },
    { key: 'voirRsi', label: 'RSI', default: true, kind: 'bool', group: 'RSI', inline: '0' },
    { key: 'rsiLength', label: 'Période', default: 14, min: 1, max: 500, group: 'RSI', inline: '1' },
  ],
  styles: [],
  range: [0, 100],
  params(cfg) {
    const v = (key: string) => inputOf(cfg, STO_RSI, key);
    return `${v('lengthK')} ${v('smoothK')} ${v('lengthD')} ${v('rsiLength')}`;
  },
  compute(candles, cfg) {
    const num = (key: string) => inputOf(cfg, STO_RSI, key);
    const int = (key: string) => Math.max(1, Math.round(num(key)));
    const on = (key: string) => boolInput(cfg, STO_RSI, key);

    const k = smaNa(stoch(candles, int('lengthK')), int('smoothK'));
    const d = smaNa(k, int('lengthD'));
    // D colored by its direction, like the script
    const dPoints: PlotPoint[] = toPoints(candles, d).map((p, i, arr) => ({ ...p, color: i > 0 && p.value > arr[i - 1].value ? LIME : RED }));

    // hidden plots stay, empty, so the legend keeps its shape
    const plots: Plot[] = [
      { key: 'k', name: 'K', color: stringInput(cfg, STO_RSI, 'colorK'), kind: 'line', width: 1, data: on('voirSto') ? toPoints(candles, k) : [] },
      { key: 'd', name: 'D', color: LIME, kind: 'line', width: 1, data: on('voirSto') ? dPoints : [] },
      { key: 'rsi', name: 'RSI', color: BLACK, kind: 'line', width: 1, data: on('voirRsi') ? rsi(candles, int('rsiLength')) : [] },
      { key: 'ob', name: 'Surachat', color: RED, kind: 'hline', price: num('upper'), dashed: true, data: [] },
      { key: 'os', name: 'Survente', color: GREEN, kind: 'hline', price: num('lower'), dashed: true, data: [] },
    ];
    return plots;
  },
};
```

Exemple de **niveaux par séance** (traits horizontaux qui ne relient pas les jours entre eux) : pour chaque séance, un `PlotBox` plat par niveau, de la première à la dernière bougie de la séance :

```ts
boxes.push({ left: first.time, leftBars: -0.4, right: last.time, rightBars: 0.4,
             top: level, bottom: level, fill: 'rgba(0,0,0,0)', border: color, borderWidth: 2 });
```

### B6. Avant de rendre ta réponse, vérifie

- [ ] Le fichier compile en TypeScript : aucune variable, aucun paramètre et aucun import inutilisés (le projet a `noUnusedLocals` et `noUnusedParameters` : un paramètre inutile s'écrit `_cfg`), pas de `any` inutile.
- [ ] `type` dans le fichier = le nom ajouté dans `types.ts` = le nom ajouté dans `registry.ts`.
- [ ] Aucune bougie ne lit une bougie future.
- [ ] Les `key` des plots sont uniques.
- [ ] Tous les textes visibles sont en français.
- [ ] La liste « non converti » est donnée, même si elle est vide (« tout est converti »).
- [ ] Si l'utilisateur renvoie des erreurs `tsc`, corrige **le fichier entier** et redonne-le complet.
