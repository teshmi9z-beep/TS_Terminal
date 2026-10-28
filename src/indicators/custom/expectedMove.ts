import type { Candle } from '../../types';
import type { IndicatorDef, Plot, PlotBox, PlotLabel, PlotMarker } from '../types';
import { boolInput, inputOf, stringInput, withTransparency } from '../helpers';
import { SYMBOLS } from '../../data/symbols';
import { tfSeconds } from '../../data/timeframes';
import { familyOf, inCashSession, localDay, zoned, hhmm, type IndexFamily } from '../../data/indexFamilies';
import { chartIsLight, companion, currentChartSeries } from '../companion';
import { emLevels, emRegimeOk, emTrades, type EmDay } from '../../robots/emRule';
import { LOCALE } from '../../i18n/lang';

// The user's Pine script "Expected Move Calibré v6 (US + DAX + CAC)", rebuilt natively (the Pine
// interpreter has no arrays, no request.security and no time zones). At the cash open the day's
// expected move is open × volatility / 100 / √252. The volatility is an implied index (VIX1D for
// the S&P, VXN for the Nasdaq, VXD for the Dow, RVX for the Russell, the last three brought back
// to one day × VIX1D / VIX; for the DAX and the CAC the symbol typed in the settings, if any) or
// else the realized volatility of the last cash closes. Over the last N sessions, how far the
// price actually went above and below the open, in expected moves, gives the average distances
// and their σ envelope, frozen in the morning and judged that evening. At the close, the next
// day's levels are projected from the close, the closing volatility × the usual ratio between
// the next open's volatility and the close's, and the probable opening zone (average gap ± σ).
// The calibration runs on 30-minute (or 15-minute) bars of the chart's own symbol, completed
// with hourly ones further back (see mergedSessions), whatever the chart's timeframe; an implied
// index is read at its daily open (≈ its quote at the cash open) and its daily close.

const VOL: Record<string, string> = { spx: 'VIX1D', ndx: 'VXN', dji: 'VXD', rut: 'RVX' };
const EU = new Set(['dax', 'cac']);
// the markets the robot was studied on (robots/em/EM.txt); the Russell's cash index lags, its
// future was not tested
const ROBOT_MARKETS = new Set(['spx', 'ndx', 'dji', 'rut', 'dax', 'nikkei']);

type Day = { day: string; o: number; h: number; l: number; c: number; firstMin: number; lastMin: number; firstT: number; lastT: number };
type Frozen = { o: number; iv: number; em: number; fu: number; fd: number; su: number; sd: number; n: number; src: 0 | 1 };
type Proj = { day: string; anc: number; k: number; iv: number; em: number; fu: number; fd: number; su: number; sd: number; gm: number; gs: number };
type Stats = { n: number; ca: number; ce: number; tu: number; td: number; raw: number; excluded: number };
type DailyQuotes = { map: Map<string, { o: number; c: number }>; days: string[] };

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
// Pine's array.stdev (population)
const stdev = (a: number[]) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// annualized realized volatility (%) of the last `len` returns of the cash closes
function realizedVol(closes: number[], len: number): number {
  const n = closes.length;
  if (n < len + 1) return NaN;
  const rets: number[] = [];
  for (let i = n - len; i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  return stdev(rets) * Math.sqrt(252) * 100;
}

// the cash sessions of intraday bars: open, high, low, close, first and last bar (minutes, local)
function sessionsOf(f: IndexFamily, bars: Candle[]): Day[] {
  const out: Day[] = [];
  for (const c of bars) {
    if (!inCashSession(f, c.time)) continue;
    const day = localDay(f, c.time);
    const m = zoned(c.time, f.tz).minutes;
    const s = out[out.length - 1];
    if (s && s.day === day) { s.h = Math.max(s.h, c.high); s.l = Math.min(s.l, c.low); s.c = c.close; s.lastMin = m; s.lastT = c.time; }
    else out.push({ day, o: c.open, h: c.high, l: c.low, c: c.close, firstMin: m, lastMin: m, firstT: c.time, lastT: c.time });
  }
  return out;
}

// the sessions of the 30-minute bars (as in the Pine script; Yahoo keeps 59 days of them,
// the lab's history more), then the hourly ones for the days before. A session only counts
// when its first bar starts at the open: the futures' and CFDs' hourly bars run from :00, the
// 9:00 bar mixes the pre-open with the open, and its open is not the 9:30 one.
function mergedSessions(f: IndexFamily, fineBars: Candle[], b60: Candle[]): Day[] {
  const exact = (d: Day) => d.firstMin === hhmm(f.open);
  const fine = sessionsOf(f, fineBars).filter(exact);
  const start = fine[0]?.day ?? '9999';
  return [...sessionsOf(f, b60).filter((d) => exact(d) && d.day < start), ...fine];
}

// the robot's sessions: the 15-minute bars of each cash session that starts with the open bar
function robotSessions(f: IndexFamily, bars: Candle[]) {
  type S = { day: string; t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; first: number };
  const out: S[] = [];
  for (const x of bars) {
    if (!inCashSession(f, x.time)) continue;
    const day = localDay(f, x.time);
    let s = out[out.length - 1];
    if (!s || s.day !== day) { s = { day, t: [], o: [], h: [], l: [], c: [], first: zoned(x.time, f.tz).minutes }; out.push(s); }
    s.t.push(x.time); s.o.push(x.open); s.h.push(x.high); s.l.push(x.low); s.c.push(x.close);
  }
  return out.filter((s) => s.first === hhmm(f.open));
}

// daily bars are stamped at midnight UTC of their exchange date
function dailyQuotes(bars: Candle[]): DailyQuotes {
  const map = new Map(bars.map((c) => [new Date(c.time * 1000).toISOString().slice(0, 10), { o: c.open, c: c.close }]));
  return { map, days: [...map.keys()].sort() };
}

// the last close before `day` (the European indices may only quote from 9:15)
function closeBefore(q: DailyQuotes, day: string): number {
  let lo = 0, hi = q.days.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (q.days[mid] < day) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? q.map.get(q.days[best])!.c : NaN;
}

export const EXPECTED_MOVE: IndicatorDef = {
  type: 'EXPECTED_MOVE',
  label: 'Expected Move calibré (US + DAX + CAC)',
  short: 'EM Cal',
  category: 'Personnalises',
  overlay: true,
  description: 'Mouvement attendu du jour d’après la volatilité à l’ouverture, recalibré sur les séances passées : distances moyennes, enveloppe σ, projection J+1, vérif de trade',
  defaults: { period: 0, color: '#00bcd4' },
  inputs: [
    { key: 'volMode', label: 'Source de volatilité', default: 'Auto', kind: 'string', options: ['Auto', 'Indice implicite', 'Volatilité réalisée'], group: 'Marché', tooltip: 'Auto : indice implicite s’il est renseigné et disponible, sinon volatilité réalisée des clôtures cash. Pour DAX/CAC sans symbole renseigné, la volatilité réalisée est utilisée.' },
    { key: 'calibTf', label: 'UT de calcul en arrière-plan', default: '30', kind: 'string', options: ['15', '30'], group: 'Marché', tooltip: '30 min = environ deux fois plus d’historique que 15 min' },
    { key: 'iv', label: 'Indice de volatilité US', default: 'Auto', kind: 'string', options: ['Auto', 'VIX1D', 'VXN', 'VXD', 'RVX'], group: 'Source volatilité US', tooltip: 'Auto : VIX1D pour le S&P, VXN pour le Nasdaq, VXD pour le Dow, RVX pour le Russell' },
    { key: 'scale1D', label: 'Ramener VXN/VXD/RVX à 1 jour (× VIX1D / VIX)', default: true, kind: 'bool', group: 'Source volatilité US' },
    { key: 'symDax', label: 'Symbole vol. DAX (VDAX-NEW)', default: '', kind: 'string', group: 'Source volatilité Europe', tooltip: 'Vide = volatilité réalisée. Sinon le ticker exact d’un symbole de la plateforme.' },
    { key: 'symCac', label: 'Symbole vol. CAC (VSTOXX en proxy)', default: '', kind: 'string', group: 'Source volatilité Europe', tooltip: 'Vide = volatilité réalisée. Sinon le ticker exact d’un symbole de la plateforme.' },
    { key: 'rvLen', label: 'Période vol. réalisée (séances)', default: 20, min: 5, max: 60, step: 1, group: 'Source volatilité Europe' },
    { key: 'lookback', label: 'Séances de calibration', default: 60, min: 10, max: 250, step: 1, group: 'Calibration' },
    { key: 'requireFull', label: 'Exiger l’échantillon complet', default: true, kind: 'bool', group: 'Calibration' },
    { key: 'sigK', label: 'Multiplicateur sigma', default: 1, min: 0.1, max: 5, step: 0.1, group: 'Calibration' },
    { key: 'stopPct', label: 'SL indicatif (% de l’EM)', default: 20, min: 1, max: 200, step: 1, group: 'Calibration' },
    { key: 'roundUp', label: 'Arrondir les distances au tick supérieur', default: true, kind: 'bool', group: 'Calibration' },
    { key: 'tEntry', label: 'Prix d’entrée', default: 0, min: 0, max: 1e7, step: 0.25, group: 'Vérif trade (0 = désactivé)' },
    { key: 'tStop', label: 'Stop', default: 0, min: 0, max: 1e7, step: 0.25, group: 'Vérif trade (0 = désactivé)' },
    { key: 'tTarget', label: 'Objectif (0 = seulement 1R)', default: 0, min: 0, max: 1e7, step: 0.25, group: 'Vérif trade (0 = désactivé)' },
    { key: 'drawSess', label: 'Tracer de … à (heure de Paris, indices US)', default: '1530-2200', kind: 'session', group: 'Affichage', tooltip: 'Les niveaux ne sont tracés que sur cette plage, jusqu’à sa fin même avant qu’elle soit atteinte. DAX et CAC : la séance cash.' },
    { key: 'showOpen', label: 'Prix d’ouverture', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showRaw', label: 'EM brut (non calibré)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showCal', label: 'Distances moyennes (calibré)', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showEnv', label: 'Enveloppe σ', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showTable', label: 'Tableau', default: true, kind: 'bool', group: 'Affichage' },
    { key: 'showProj', label: 'Projection du lendemain', default: true, kind: 'bool', group: 'Projection J+1', tooltip: 'Calculée à la clôture cash : ancrage = clôture, EM = volatilité de clôture × coefficient ouverture/clôture calibré, ratios = ceux qui serviront demain matin' },
    { key: 'projFut', label: 'Prolonger dans le futur', default: true, kind: 'bool', group: 'Projection J+1' },
    { key: 'showGap', label: 'Zone d’ouverture probable (gap moyen ± σ)', default: true, kind: 'bool', group: 'Projection J+1' },
    { key: 'robot', label: 'Signaux du robot « cassure confirmée »', default: false, kind: 'bool', group: 'Robot (non prouvé)', tooltip: 'Une bougie de 15 min clôture au-delà de la distance moyenne (vol. réalisée 20 j, 120 séances) : entrée dans son sens à la bougie suivante, stop 20 % de l’EM, objectif 3 R, sortie à la clôture, seulement si le VIX est à 20 ou plus. Non prouvé : +0,06 R par trade depuis 2022 aux frais CME, en baisse depuis 2023, perdant aux frais d’un CFD.' },
    { key: 'robotColor', label: 'Couleur du robot', default: '#ab47bc', kind: 'color', group: 'Robot (non prouvé)' },
    { key: 'upColor', label: 'Haut', default: '#00bcd4', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'downColor', label: 'Bas', default: '#f23645', kind: 'color', group: 'Couleurs', inline: 'c' },
    { key: 'fillUp', label: 'Zone haute', default: '#00bcd4', kind: 'color', group: 'Couleurs de fond', inline: 'f' },
    { key: 'fillDown', label: 'Zone basse', default: '#f23645', kind: 'color', group: 'Couleurs de fond', inline: 'f' },
    { key: 'fillTransp', label: 'Transparence séance (%)', default: 85, min: 0, max: 100, step: 1, group: 'Couleurs de fond', tooltip: '0 = opaque, 100 = invisible' },
    { key: 'projTransp', label: 'Transparence J+1 (%)', default: 93, min: 0, max: 100, step: 1, group: 'Couleurs de fond' },
    { key: 'gapColor', label: 'Zone d’ouverture', default: '#ffeb3b', kind: 'color', group: 'Couleurs de fond', inline: 'g' },
    { key: 'gapTransp', label: 'Transp. (%)', default: 90, min: 0, max: 100, step: 1, group: 'Couleurs de fond', inline: 'g' },
  ],
  styles: [],
  params: (cfg) => `${inputOf(cfg, EXPECTED_MOVE, 'lookback')}, σ ${inputOf(cfg, EXPECTED_MOVE, 'sigK')}`,
  compute(k, cfg) {
    const up = stringInput(cfg, EXPECTED_MOVE, 'upColor'), down = stringInput(cfg, EXPECTED_MOVE, 'downColor');
    // on a light background the yellow turns dark gold, the white and the silver dark grey
    const light = chartIsLight();
    const yellow = light ? '#c98f00' : '#ffeb3b', ink = light ? '#131722' : '#ffffff', tableInk = light ? '#434651' : '#c0c0c0';
    const fillUp = stringInput(cfg, EXPECTED_MOVE, 'fillUp'), fillDown = stringInput(cfg, EXPECTED_MOVE, 'fillDown');
    const gapIn = stringInput(cfg, EXPECTED_MOVE, 'gapColor');
    const gapColor = gapIn.toLowerCase() === '#ffeb3b' ? yellow : gapIn;
    const fillTransp = inputOf(cfg, EXPECTED_MOVE, 'fillTransp'), projTransp = inputOf(cfg, EXPECTED_MOVE, 'projTransp'), gapTransp = inputOf(cfg, EXPECTED_MOVE, 'gapTransp');
    const boxes: PlotBox[] = [], labels: PlotLabel[] = [], markers: PlotMarker[] = [];
    const on = (key: string) => boolInput(cfg, EXPECTED_MOVE, key);
    const robotColor = stringInput(cfg, EXPECTED_MOVE, 'robotColor');
    const out = (): Plot[] => [
      { key: 'boxes', name: 'Niveaux de séance et trade', color: up, kind: 'boxes', data: [], boxes },
      { key: 'labels', name: 'Tableau', color: '#ffffff', kind: 'labels', data: [], labels },
      { key: 'robot', name: 'Robot (non prouvé)', color: robotColor, kind: 'markers', data: [], markers },
    ];

    const st = currentChartSeries();
    if (!st || k.length < 2) return out();
    const fam = familyOf(st.sym.ticker);
    const step = tfSeconds(st.tf) ?? 60;
    if (!fam || !(VOL[fam.family.id] || EU.has(fam.family.id) || fam.family.id === 'nikkei') || step > 86400) return out();
    const f = fam.family;
    // the Nikkei as the European indices: no implied index here, the realized volatility
    const isEU = EU.has(f.id) || f.id === 'nikkei';
    const mkt = f.id === 'dax' ? 'DAX' : f.id === 'cac' ? 'CAC 40' : f.id === 'nikkei' ? 'Nikkei' : 'US';
    const daily = step >= 86400;

    // the volatility source: an implied index when there is one, else the realized volatility
    const volMode = stringInput(cfg, EXPECTED_MOVE, 'volMode');
    const choice = stringInput(cfg, EXPECTED_MOVE, 'iv');
    const ivTicker = isEU
      ? f.id === 'nikkei' ? '' : stringInput(cfg, EXPECTED_MOVE, f.id === 'dax' ? 'symDax' : 'symCac').trim().toUpperCase()
      : choice === 'Auto' ? VOL[f.id] : choice;
    const useIdx = volMode !== 'Volatilité réalisée' && ivTicker !== '';
    // no bringing back to one day in Europe: VIX1D / VIX do not quote at 9:00 Paris, and the
    // calibrated ratios absorb the 30-day / 1-day scale anyway
    const needScale = useIdx && !isEU && boolInput(cfg, EXPECTED_MOVE, 'scale1D') && ivTicker !== 'VIX1D';
    const rvLen = Math.round(inputOf(cfg, EXPECTED_MOVE, 'rvLen'));
    const lookback = Math.round(inputOf(cfg, EXPECTED_MOVE, 'lookback'));
    // two years back: the calibration needs lookback sessions before the first one shown
    const from = Math.floor(Date.now() / 1000) - 730 * 86400;
    const findSym = (ticker: string) => (ticker === st.sym.ticker ? st.sym : SYMBOLS.find((s) => s.ticker === ticker));
    const load = (ticker: string, tf: '1D' | '1h' | '30m' | '15m') => {
      const sym = findSym(ticker);
      return sym ? companion(sym, tf, from) : null;
    };
    const fineTf = stringInput(cfg, EXPECTED_MOVE, 'calibTf') === '15' ? '15m' : '30m';
    const H = load(st.sym.ticker, fineTf), H60 = load(st.sym.ticker, '1h');
    const IV = useIdx ? load(ivTicker, '1D') : null;
    // VIX also gives the regime line of the table
    const V1 = needScale ? load('VIX1D', '1D') : null, VX = load('VIX', '1D');
    const waiting = [H, H60, IV, V1, VX].filter((c) => c && c.state === 'loading');
    if (!H || !H60 || waiting.length || H.state === 'error' || H60.state === 'error') {
      const err = [H, H60].find((c) => c?.state === 'error');
      labels.push({ time: k[k.length - 1].time, price: k[k.length - 1].close, color: '#787b86', style: 'down', size: 10,
        text: err ? `EM : données manquantes (${err.error ?? st.sym.ticker})` : `EM : chargement de la volatilité et de l’historique intraday…` });
      return out();
    }
    // a missing or unknown index: no implied volatility (Auto falls back on the realized one)
    const ivQ = IV?.state === 'ready' ? dailyQuotes(IV.candles) : null;
    const v1Q = V1?.state === 'ready' ? dailyQuotes(V1.candles) : null;
    const vxQ = VX?.state === 'ready' ? dailyQuotes(VX.candles) : null;
    const ivMissing = useIdx && !ivQ;
    const scaled = (iv: number, day: string, key: 'o' | 'c') => {
      if (!needScale) return iv;
      const a = v1Q?.map.get(day)?.[key] ?? NaN, b = vxQ?.map.get(day)?.[key] ?? NaN;
      return b > 0 ? (iv * a) / b : NaN;
    };
    const ivAtOpen = (day: string) => {
      if (!ivQ) return NaN;
      const o = ivQ.map.get(day)?.o ?? closeBefore(ivQ, day);
      return scaled(o, day, 'o');
    };
    const ivAtClose = (day: string) => (ivQ ? scaled(ivQ.map.get(day)?.c ?? NaN, day, 'c') : NaN);

    // ---- the engine: each session frozen at the open, judged at the close ----
    const sigK = inputOf(cfg, EXPECTED_MOVE, 'sigK');
    const requireFull = boolInput(cfg, EXPECTED_MOVE, 'requireFull');
    const closeMin = hhmm(f.close);
    const sq252 = Math.sqrt(252);
    const upA: number[] = [], dnA: number[] = [];
    const ev = { ca: [] as number[], ce: [] as number[], tu: [] as number[], td: [] as number[], raw: [] as number[] };
    const closesA: number[] = [], ratA: number[] = [], gapA: number[] = [], errA: number[] = [];
    let excluded = 0, lastErr = NaN, prevIvCl = NaN, prevClose = NaN;
    let proj: Proj | null = null;
    const frozen = new Map<string, Frozen>();
    const projections = new Map<string, Proj>();
    const days = mergedSessions(f, H.candles, H60.candles);
    const nowS = Math.floor(Date.now() / 1000);
    // when the history holds fewer sessions than asked (Yahoo's 59 days of 30-minute bars on
    // a future), the full sample is all of it but the first ten
    const full = Math.min(lookback, Math.max(20, days.length - 10));
    const isEnough = (n: number) => n >= (requireFull ? full : 10);
    for (const d of days) {
      // ---- the open: everything frozen ----
      const rvO = realizedVol(closesA, rvLen);
      const ivIdx = useIdx ? ivAtOpen(d.day) : NaN;
      const ivE = useIdx ? (!Number.isFinite(ivIdx) && volMode === 'Auto' ? rvO : ivIdx) : rvO;
      const em = Number.isFinite(ivE) && ivE > 0 ? (d.o * ivE) / 100 / sq252 : NaN;
      if (Number.isFinite(em)) {
        const n = upA.length, enough = isEnough(n);
        const c: Frozen = {
          o: d.o, iv: ivE, em, n, src: useIdx && Number.isFinite(ivIdx) ? 0 : 1,
          fu: enough ? avg(upA) : NaN, fd: enough ? avg(dnA) : NaN,
          su: enough ? stdev(upA) : NaN, sd: enough ? stdev(dnA) : NaN,
        };
        frozen.set(d.day, c);
        if (prevIvCl > 0) { ratA.push(ivE / prevIvCl); if (ratA.length > lookback) ratA.shift(); }
        if (Number.isFinite(prevClose)) { gapA.push((d.o - prevClose) / em); if (gapA.length > lookback) gapA.shift(); }
        // how far last night's projected levels were from this morning's
        if (proj && Number.isFinite(proj.fu) && Number.isFinite(c.fu)) {
          const eU = Math.abs(proj.anc + proj.em * proj.fu - (d.o + em * c.fu));
          const eD = Math.abs(proj.anc - proj.em * proj.fd - (d.o - em * c.fd));
          lastErr = (eU + eD) / 2;
          errA.push((lastErr / em) * 100);
          if (errA.length > 250) errA.shift();
        }
      }
      proj = null;

      // the session still running is not judged yet
      const running = d === days[days.length - 1] && inCashSession(f, nowS);
      if (running) break;

      // ---- the close ----
      // a short day (closing an hour early or more) or no volatility: left out
      if (!Number.isFinite(em) || d.lastMin < closeMin - 60) excluded++;
      else {
        const upR = (d.h - d.o) / em, dnR = (d.o - d.l) / em;
        const c = frozen.get(d.day)!;
        // judged out of sample, with the bounds frozen that morning
        if (Number.isFinite(c.fu)) {
          ev.ca.push(upR <= c.fu && dnR <= c.fd ? 1 : 0);
          ev.ce.push(upR <= c.fu + sigK * c.su && dnR <= c.fd + sigK * c.sd ? 1 : 0);
          ev.tu.push(upR >= c.fu ? 1 : 0);
          ev.td.push(dnR >= c.fd ? 1 : 0);
          ev.raw.push(upR <= 1 && dnR <= 1 ? 1 : 0);
          if (ev.ca.length > 250) Object.values(ev).forEach((a) => a.shift());
        }
        upA.push(upR); dnA.push(dnR);
        if (upA.length > lookback) { upA.shift(); dnA.shift(); }
      }
      closesA.push(d.c);
      if (closesA.length > rvLen + 1) closesA.shift();
      let ivCl = useIdx ? ivAtClose(d.day) : NaN;
      if (!useIdx || (!Number.isFinite(ivCl) && volMode === 'Auto')) ivCl = realizedVol(closesA, rvLen);

      // ---- the next day's projection, frozen at the close ----
      const enough = isEnough(upA.length);
      const pk = ratA.length >= 5 ? median(ratA) : 1;
      const piv = ivCl * pk;
      proj = {
        day: d.day, anc: d.c, k: pk, iv: piv, em: (d.c * piv) / 100 / sq252,
        fu: enough ? avg(upA) : NaN, fd: enough ? avg(dnA) : NaN,
        su: enough ? stdev(upA) : NaN, sd: enough ? stdev(dnA) : NaN,
        gm: gapA.length >= 5 ? avg(gapA) : NaN, gs: gapA.length >= 5 ? stdev(gapA) : NaN,
      };
      if (!Number.isFinite(proj.em)) proj = null;
      else projections.set(d.day, proj);
      prevIvCl = ivCl;
      prevClose = d.c;
    }
    const pctOf = (a: number[]) => (a.length ? avg(a) * 100 : NaN);
    const stats: Stats = { n: ev.ca.length, ca: pctOf(ev.ca), ce: pctOf(ev.ce), tu: pctOf(ev.tu), td: pctOf(ev.td), raw: pctOf(ev.raw), excluded };

    // ---- the levels on this chart's bars ----
    // CME E-mini ticks, Eurex / Euronext half points on the futures, cents on the cash index and the CFD
    const tick = fam.role === 'future' ? (isEU ? 0.5 : 0.25) : 0.01;
    const roundUp = boolInput(cfg, EXPECTED_MOVE, 'roundUp');
    const ceil = (x: number) => (roundUp ? Math.ceil(x / tick - 1e-9) * tick : x);
    const levels = (c: Frozen) => {
      const dUp = ceil(c.em * c.fu), dDn = ceil(c.em * c.fd);
      const dUpE = ceil(c.em * (c.fu + sigK * c.su)), dDnE = ceil(c.em * (c.fd + sigK * c.sd));
      const em = Math.round(c.em / tick) * tick;
      return { dUp, dDn, dUpE, dDnE, em, rawUp: c.o + em, rawDn: c.o - em, calUp: c.o + dUp, calDn: c.o - dDn, envUp: c.o + dUpE, envDn: c.o - dDnE };
    };
    const projLevels = (p: Proj) => {
      const dUp = ceil(p.em * p.fu), dDn = ceil(p.em * p.fd);
      const dUpE = ceil(p.em * (p.fu + sigK * p.su)), dDnE = ceil(p.em * (p.fd + sigK * p.sd));
      return { dUp, dDn, calUp: p.anc + dUp, calDn: p.anc - dDn, envUp: p.anc + dUpE, envDn: p.anc - dDnE,
        gapHi: p.anc + p.em * (p.gm + p.gs), gapLo: p.anc + p.em * (p.gm - p.gs) };
    };
    // each session's levels as horizontal segments over its own bars only (nothing joins one
    // session to the next): the US ones over the window chosen in Paris time, the European
    // ones over their cash session
    let winTz = 'Europe/Paris', wFrom: number, wTo: number;
    if (isEU) { winTz = f.tz; wFrom = hhmm(f.open); wTo = hhmm(f.close); }
    else {
      const win = stringInput(cfg, EXPECTED_MOVE, 'drawSess');
      wFrom = hhmm(`${win.slice(0, 2)}:${win.slice(2, 4)}`); wTo = hhmm(`${win.slice(5, 7)}:${win.slice(7, 9)}`);
    }
    const spans: { day: string; first: number; last: number; end: number }[] = [];
    for (const c of k) {
      let end = c.time;
      if (!daily) {
        const z = zoned(c.time, winTz);
        if (z.minutes < wFrom || z.minutes >= wTo) continue;
        // the window's end on this bar's day, to draw the running session up to it
        end = c.time + (wTo - z.minutes) * 60 - step;
      }
      const day = daily ? new Date(c.time * 1000).toISOString().slice(0, 10) : localDay(f, c.time);
      const s = spans[spans.length - 1];
      if (s && s.day === day) s.last = c.time; else spans.push({ day, first: c.time, last: c.time, end });
    }
    const hline = (seg: Pick<PlotBox, 'left' | 'leftBars' | 'right' | 'rightBars'>, price: number, color: string, width: number, style: PlotBox['borderStyle'] = 'solid') => {
      if (Number.isFinite(price)) boxes.push({ ...seg, top: price, bottom: price, fill: 'rgba(0,0,0,0)', border: color, borderWidth: width, borderStyle: style });
    };
    const zone = (seg: Pick<PlotBox, 'left' | 'leftBars' | 'right' | 'rightBars'>, a: number, b: number, color: string, transp: number) => {
      if (Number.isFinite(a) && Number.isFinite(b)) boxes.push({ ...seg, top: Math.max(a, b), bottom: Math.min(a, b), fill: withTransparency(color, transp) });
    };
    for (const s of spans) {
      const fz = frozen.get(s.day);
      if (!fz) continue;
      const L = levels(fz);
      const seg = { left: s.first, leftBars: -0.4, right: s.last, rightBars: Math.max(0, Math.round((s.end - s.last) / step)) + 0.4 };
      if (on('showEnv') && on('showCal')) { zone(seg, L.calUp, L.envUp, fillUp, fillTransp); zone(seg, L.calDn, L.envDn, fillDown, fillTransp); }
      if (on('showOpen')) hline(seg, fz.o, withTransparency(yellow, 30), 1);
      if (on('showRaw')) { hline(seg, L.rawUp, withTransparency('#787b86', 20), 1); hline(seg, L.rawDn, withTransparency('#787b86', 20), 1); }
      if (on('showEnv')) { hline(seg, L.envUp, withTransparency(up, 40), 1); hline(seg, L.envDn, withTransparency(down, 40), 1); }
      if (on('showCal')) { hline(seg, L.calUp, up, 2); hline(seg, L.calDn, down, 2); }
    }

    // ---- the projections: from each close to the next open, the last one into the future ----
    const last = k[k.length - 1];
    const latestProj = proj;
    if (on('showProj') && !daily) {
      const fineStep = fineTf === '15m' ? 900 : 1800;
      days.forEach((d, i) => {
        const p = projections.get(d.day);
        if (!p) return;
        const startT = d.lastT + fineStep, endT = days[i + 1]?.firstT ?? Infinity;
        const isLatest = p === latestProj;
        let first = -1, lastI = -1;
        for (let j = 0; j < k.length; j++) {
          if (k[j].time < startT) continue;
          if (k[j].time >= endT) break;
          if (first < 0) first = j;
          lastI = j;
        }
        // a cash index has no bars after its close: only the lines into the future
        if (first < 0 && !(isLatest && on('projFut'))) return;
        const futureBars = isLatest && on('projFut') ? 40 : 0.4;
        const seg = first < 0
          ? { left: last.time, leftBars: 0.6, right: last.time, rightBars: futureBars }
          : { left: k[first].time, leftBars: -0.4, right: k[lastI].time, rightBars: futureBars };
        const P = projLevels(p);
        zone(seg, P.calUp, P.envUp, fillUp, projTransp); zone(seg, P.calDn, P.envDn, fillDown, projTransp);
        if (on('showGap')) zone(seg, P.gapHi, P.gapLo, gapColor, gapTransp);
        hline(seg, p.anc, withTransparency(yellow, light ? 30 : 50), 1, 'dotted');
        hline(seg, P.calUp, withTransparency(up, 30), 1, 'dashed');
        hline(seg, P.calDn, withTransparency(down, 30), 1, 'dashed');
        hline(seg, P.envUp, withTransparency(up, 60), 1, 'dotted');
        hline(seg, P.envDn, withTransparency(down, 60), 1, 'dotted');
        if (isLatest && on('projFut')) {
          const at = (seg.right) + step * futureBars;
          const tag = (price: number, color: string, txt: string) => {
            if (Number.isFinite(price)) labels.push({ time: at, price, color, style: 'down', size: 9, text: `${txt}  ${price.toLocaleString(LOCALE, { maximumFractionDigits: 2 })}` });
          };
          tag(P.envUp, withTransparency(up, 20), 'J+1 enveloppe +');
          tag(P.calUp, up, 'J+1 dist. moy. +');
          tag(p.anc, withTransparency(yellow, light ? 10 : 30), 'J+1 ancrage');
          tag(P.calDn, down, 'J+1 dist. moy. −');
          tag(P.envDn, withTransparency(down, 20), 'J+1 enveloppe −');
        }
      });
    }

    // ---- the robot (src/robots/emRule.ts): its levels, entries and exits on the 15-minute bars,
    // calibrated on the cash index's daily bars like the automatic mode ----
    const robotLines: string[] = [];
    const p2 = (v: number) => (Number.isFinite(v) ? v.toLocaleString(LOCALE, { maximumFractionDigits: 2 }) : '—');
    if (on('robot') && !daily) {
      if (!ROBOT_MARKETS.has(f.id)) robotLines.push('Robot : pas étudié sur ce marché');
      else {
        const R15 = fineTf === '15m' ? H : load(st.sym.ticker, '15m');
        const CD = load(f.cash, '1D');
        if (!R15 || !CD || R15.state !== 'ready' || CD.state !== 'ready') {
          const err = [R15, CD].find((x) => x?.state === 'error');
          robotLines.push(err ? `Robot : données manquantes (${err.error ?? f.cash})` : 'Robot : chargement des bougies 15 min et du cash journalier…');
        } else {
          const cashDays: EmDay[] = CD.candles.map((x) => ({ day: new Date(x.time * 1000).toISOString().slice(0, 10), o: x.open, h: x.high, l: x.low, c: x.close, full: true }));
          const before = (day: string) => { let n = 0; while (n < cashDays.length && cashDays[n].day < day) n++; return cashDays.slice(0, n); };
          const vixAt = (day: string) => {
            if (!vxQ) return NaN;
            const q = !isEU ? vxQ.map.get(day) : undefined;
            return q && q.o > 0 ? q.o : closeBefore(vxQ, day);
          };
          // the chart's bar holding a time (markers sit on bars)
          const snap = (t: number) => { let lo = 0, hi = k.length - 1, best = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (k[m].time <= t) { best = m; lo = m + 1; } else hi = m - 1; } return k[best].time; };
          const rs = robotSessions(f, R15.candles).filter((x) => x.t[x.t.length - 1] >= k[0].time);
          const fr = (v: number) => `${v >= 0 ? '+' : ''}${v.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} R`;
          let n = 0, sumR = 0;
          for (const s of rs) {
            const lv = emLevels(before(s.day), s.o[0]);
            if (!lv) continue;
            const vix = vixAt(s.day), ok = emRegimeOk(vix);
            const running = s === rs[rs.length - 1] && inCashSession(f, nowS);
            const lastT = s.t[s.t.length - 1];
            const end = running ? lastT + Math.max(0, (hhmm(f.close) - zoned(lastT, f.tz).minutes) * 60 - 900) : lastT;
            if (s === rs[rs.length - 1]) {
              robotLines.push(`Robot cassure confirmée (non prouvé) · ${s.day.slice(8, 10)}/${s.day.slice(5, 7)} · VIX ${fmt(vix, 1)} ${ok ? '≥ 20 : actif' : '< 20 : pas de trade'}`);
              robotLines.push(`Niveaux du robot + / − : ${p2(lv.up)} / ${p2(lv.dn)} (vol. réalisée ${fmt(lv.vol, 1)} %)`);
            }
            if (!ok) continue;
            const seg = { left: s.t[0], leftBars: -0.4, right: end, rightBars: 0.4 };
            for (const lvl of [lv.up, lv.dn]) boxes.push({ ...seg, top: lvl, bottom: lvl, fill: 'rgba(0,0,0,0)', border: withTransparency(robotColor, 35), borderWidth: 1, borderStyle: 'dotted' });
            for (const t of emTrades(s, lv, !running)) {
              const cost = (2 * 0.00005 * t.entry) / Math.abs(t.entry - t.stop);
              const tIn = s.t[t.entryIdx], tOut = s.t[t.exitIdx];
              const span = { left: tIn, leftBars: -0.4, right: tOut, rightBars: 0.4 };
              boxes.push({ ...span, top: Math.max(t.entry, t.stop), bottom: Math.min(t.entry, t.stop), fill: withTransparency(down, 88) });
              boxes.push({ ...span, top: Math.max(t.entry, t.target), bottom: Math.min(t.entry, t.target), fill: withTransparency(up, 90) });
              markers.push({ time: snap(tIn), position: t.side > 0 ? 'belowBar' : 'aboveBar', shape: t.side > 0 ? 'arrowUp' : 'arrowDown', color: robotColor, text: t.side > 0 ? 'EM achat' : 'EM vente' });
              const label = { stop: 'stop', objectif: 'objectif', 'clôture': 'clôture', 'en cours': 'en cours' }[t.reason];
              if (t.reason !== 'en cours') {
                markers.push({ time: snap(tOut), position: t.side > 0 ? 'aboveBar' : 'belowBar', shape: 'circle', color: withTransparency(robotColor, 20), text: `${label} ${fr(t.r - cost)}`, size: 0.7 });
                n++; sumR += t.r - cost;
              }
              if (s === rs[rs.length - 1]) robotLines.push(`  ${t.side > 0 ? 'Achat' : 'Vente'} à ${p2(t.entry)}, stop ${p2(t.stop)}, objectif ${p2(t.target)} : ${label}${t.reason !== 'en cours' ? ` ${fr(t.r - cost)}` : ''}`);
            }
          }
          markers.sort((a, z) => a.time - z.time);
          robotLines.push(`Sur ces bougies : ${n} trades, ${fr(sumR)} (frais CME 0,005 %)`);
          robotLines.push(`Étude : +0,06 R/trade depuis 2022, en baisse depuis 2023${f.id === 'rut' ? ' · Russell : future non testé' : ''}`);
        }
      }
    }

    // ---- the last frozen session: table and trade check ----
    const lastDayKey = [...frozen.keys()].pop();
    const c = lastDayKey ? frozen.get(lastDayKey)! : null;
    if (!c) {
      if (on('showTable')) labels.push({ time: last.time, price: last.close, color: '#787b86', style: 'down', size: 10,
        text: [`EM : pas encore de volatilité (${ivMissing ? `${ivTicker} indisponible, ` : ''}vol. réalisée après ${rvLen + 1} séances)`, ...robotLines].join('\n') });
      return out();
    }
    const L = levels(c);
    const lastSess = days[days.length - 1];
    const today = lastSess?.day === lastDayKey && inCashSession(f, nowS);
    const consumed = today && c.em > 0 ? ((lastSess.h - lastSess.l) / c.em) * 100 : NaN;
    // the regime: the European index when used, else VIX
    const regEU = isEU && useIdx && !!ivQ;
    const volNow = regEU ? IV!.candles.at(-1)?.close ?? NaN : VX?.candles.at(-1)?.close ?? NaN;
    const regime = !Number.isFinite(volNow) ? 'n/a' : volNow < 15 ? 'calme' : volNow < 20 ? 'normal' : volNow < 30 ? 'stressé' : 'critique';
    const p = (v: number) => (Number.isFinite(v) ? v.toLocaleString(LOCALE, { maximumFractionDigits: 2 }) : '—');
    const stopPct = inputOf(cfg, EXPECTED_MOVE, 'stopPct');
    const slInd = ceil((c.em * stopPct) / 100);
    const srcTxt = c.src === 1 ? `vol. réalisée ${rvLen} j${ivMissing ? ` (${ivTicker} indisponible)` : ''}` : `${ivTicker}${needScale ? ' ajusté' : ''}`;
    const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

    const lines = [
      `${st.sym.ticker} · ${mkt} · ${srcTxt} · ${ddmm(lastDayKey!)} ${today ? '(en cours)' : '(terminée)'}`,
      `Échantillon : ${c.n} / ${lookback} séances`,
      `Open ${p(c.o)} · vol ${fmt(c.iv)} %`,
      `EM non calibré ± ${p(L.em)} pts`,
      `Ratios moyens haut / bas : ${fmt(c.fu)} / ${fmt(c.fd)}`,
      `Écarts-types : ${fmt(c.su)} / ${fmt(c.sd)}`,
      `Distances moyennes + / − : ${p(L.dUp)} / ${p(L.dDn)}`,
      `Enveloppe + / − : ${p(L.dUpE)} / ${p(L.dDnE)}`,
      `SL indicatif ${stopPct} % : ${p(slInd)} pts`,
      `Séances contenues moy. / env. : ${fmt(stats.ca)} % / ${fmt(stats.ce)} %`,
      `Touch moyenne haute / basse : ${fmt(stats.tu)} % / ${fmt(stats.td)} %`,
      `Évaluées / exclues : ${stats.n} / ${stats.excluded} · dans EM brut ${fmt(stats.raw)} %`,
      `${regEU ? `Vol 30j ${mkt}` : 'VIX'} ${fmt(volNow)} · ${regime}${today ? ` · range consommé ${fmt(consumed, 0)} %` : ''}`,
    ];
    if (c.n < lookback) lines.push(`Historique court : calibré sur ${c.n} séances au lieu de ${lookback}`);

    if (on('showProj')) {
      if (latestProj) {
        const P = projLevels(latestProj);
        lines.push(
          `— Projection J+1 (clôture du ${ddmm(latestProj.day)}) —`,
          `Ancrage ${p(latestProj.anc)} · vol. prévue ${fmt(latestProj.iv)} %`,
          `Coeff. vol. ouverture / clôture ${fmt(latestProj.k)} (médiane, n=${ratA.length})`,
          `EM projeté ± ${p(Math.round(latestProj.em / tick) * tick)} · distances ${p(P.dUp)} / ${p(P.dDn)}`,
          `Bornes projetées + / − : ${p(P.calUp)} / ${p(P.calDn)}`,
          `Gap d’ouverture moyen ${Number.isFinite(latestProj.gm) ? `${fmt(latestProj.gm * latestProj.em, 0)} ± ${fmt(latestProj.gs * latestProj.em, 0)} pts` : '—'}`,
        );
      } else lines.push('Projection J+1 : disponible après la clôture cash');
      lines.push(`Écart projection / réel : ${errA.length ? `${fmt(avg(errA))} % de l’EM (n=${errA.length}) · dernier ${fmt(lastErr, 0)} pts` : '—'}`);
    }

    // the trade check
    const tEntry = inputOf(cfg, EXPECTED_MOVE, 'tEntry'), tStop = inputOf(cfg, EXPECTED_MOVE, 'tStop'), tTarget = inputOf(cfg, EXPECTED_MOVE, 'tTarget');
    if (tEntry > 0 && tStop > 0 && tEntry !== tStop) {
      const isLong = tEntry > tStop, risk = Math.abs(tEntry - tStop);
      const r1 = isLong ? tEntry + risk : tEntry - risk;
      const tz = (lvl: number) => (isLong ? (lvl <= L.calUp ? 0 : lvl <= L.envUp ? 1 : 2) : (lvl >= L.calDn ? 0 : lvl >= L.envDn ? 1 : 2));
      const zTxt = ['dans la distance moyenne ✓', 'ambitieux ⚠', 'hors enveloppe ✗'];
      lines.push(`Trade ${isLong ? 'LONG' : 'SHORT'} · stop ${p(risk)} : ${risk < slInd ? 'trop court ✗' : 'OK ✓'}`);
      lines.push(`1R (${p(r1)}) : ${zTxt[tz(r1)]}`);
      if (tTarget > 0) lines.push(`Objectif (${p(tTarget)}) : ${zTxt[tz(tTarget)]}`);
      const seg = { left: k[Math.max(0, k.length - 30)].time, right: last.time, rightBars: 15 };
      hline(seg, tEntry, ink, 1);
      hline(seg, tStop, '#f23645', 1, 'dashed');
      hline(seg, r1, yellow, 1, 'dotted');
      if (tTarget > 0) hline(seg, tTarget, '#00e676', 1, 'dashed');
    }
    if (robotLines.length) lines.push('— Robot —', ...robotLines);
    if (on('showTable')) {
      labels.push({ time: last.time + step * 12, price: c.o, text: lines.join('\n'), color: tableInk, style: 'up', size: 10 });
    }
    return out();
  },
};
