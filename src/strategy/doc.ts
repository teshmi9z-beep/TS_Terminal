import { defaultRules, type RulesStrategy } from './rules';

// a strategy of the editor: built with the assisted creation, or written in Pine
export type StrategyDoc = {
  id: string;
  name: string;
  mode: 'assisted' | 'code';
  rules: RulesStrategy;
  code: string;
  // values of the Pine script's inputs (code mode), by input key
  inputs?: Record<string, number | boolean | string>;
  updatedAt: number;
};

// the same first test written as a TradingView strategy script
export const MA_CROSS_PINE = `//@version=5
strategy("Croisement MM 10/50", overlay=true, initial_capital=100000)

// ---------- Paramètres
rapide = input.int(10, "Moyenne rapide", minval=1)
lente = input.int(50, "Moyenne lente", minval=1)
rr = input.float(1.0, "Ratio risque / rendement", options=[1.0, 3.0])
nbBougies = input.int(3, "Stop : plus bas / plus haut des N dernières bougies", minval=1)
risque = input.float(1.0, "Risque par trade (% du capital)")

// ---------- Signaux
mmRapide = ta.sma(close, rapide)
mmLente = ta.sma(close, lente)
achat = ta.crossover(mmRapide, mmLente)
vente = ta.crossunder(mmRapide, mmLente)

// ---------- Stop sous le plus bas des 3 dernières bougies (au-dessus du plus haut pour une vente)
stopAchat = ta.lowest(low, nbBougies)
stopVente = ta.highest(high, nbBougies)
objectifAchat = close + rr * (close - stopAchat)
objectifVente = close - rr * (stopVente - close)

// ---------- Money management : la perte au stop vaut "risque" % du capital
qteAchat = close - stopAchat > 0 ? strategy.equity * risque / 100 / (close - stopAchat) : 1
qteVente = stopVente - close > 0 ? strategy.equity * risque / 100 / (stopVente - close) : 1

// ---------- Ordres (un signal contraire retourne la position)
if achat
    strategy.entry("Achat", strategy.long, qty=qteAchat)
    strategy.exit("Sortie achat", "Achat", stop=stopAchat, limit=objectifAchat)
if vente
    strategy.entry("Vente", strategy.short, qty=qteVente)
    strategy.exit("Sortie vente", "Vente", stop=stopVente, limit=objectifVente)

plot(mmRapide, "Moyenne rapide", color=color.orange)
plot(mmLente, "Moyenne lente", color=color.blue)
`;

export function defaultStrategies(): StrategyDoc[] {
  const now = Date.now();
  return [
    { id: 'st_ma_assisted', name: 'Croisement MM 10/50', mode: 'assisted', rules: defaultRules(), code: '', updatedAt: now },
    { id: 'st_ma_pine', name: 'Croisement MM 10/50 (Pine)', mode: 'code', rules: defaultRules(), code: MA_CROSS_PINE, updatedAt: now },
  ];
}

export function newAssisted(name: string): StrategyDoc {
  const rules: RulesStrategy = {
    ...defaultRules(),
    longEntry: { join: 'and', conditions: [] },
    shortEntry: { join: 'and', conditions: [] },
  };
  return { id: `st${Date.now().toString(36)}`, name, mode: 'assisted', rules, code: '', updatedAt: Date.now() };
}

export const NEW_STRATEGY_CODE = `//@version=5
strategy("Ma stratégie", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)

rapide = ta.ema(close, 9)
lente = ta.ema(close, 21)

if ta.crossover(rapide, lente)
    strategy.entry("Achat", strategy.long)
if ta.crossunder(rapide, lente)
    strategy.close("Achat")
`;

export function newCode(name: string): StrategyDoc {
  return { id: `st${Date.now().toString(36)}`, name, mode: 'code', rules: defaultRules(), code: NEW_STRATEGY_CODE, updatedAt: Date.now() };
}
