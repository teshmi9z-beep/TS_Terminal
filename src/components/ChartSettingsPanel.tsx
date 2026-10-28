import { useStore } from '../store/store';
import type { ChartSettings } from '../types';
import { ColorSwatch } from './ColorPicker';
import { QUICK_COLORS } from './colors';

const STYLE_LABELS: Record<ChartSettings['candleStyle'], string> = {
  candles: 'Bougies', bars: 'Barres', line: 'Ligne', area: 'Aire', heikin_ashi: 'Heikin Ashi',
};

type ColorKey = 'background' | 'gridColor' | 'upColor' | 'downColor' | 'borderUpColor' | 'borderDownColor' | 'wickUpColor' | 'wickDownColor';
const COLOR_ROWS: [ColorKey, string][] = [
  ['upColor', 'Corps hausse'], ['downColor', 'Corps baisse'],
  ['borderUpColor', 'Contour hausse'], ['borderDownColor', 'Contour baisse'],
  ['wickUpColor', 'Mèche hausse'], ['wickDownColor', 'Mèche baisse'],
  ['background', 'Fond'], ['gridColor', 'Grille'],
];

export default function ChartSettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.chartSettings);
  const update = useStore((s) => s.updateChartSettings);
  const reset = useStore((s) => s.resetChartSettings);
  const theme = useStore((s) => s.uiTheme);

  // candle outlines fall back to the body color in older saved settings
  const valueOf = (k: ColorKey) => settings[k] ?? (k === 'borderUpColor' ? settings.upColor : k === 'borderDownColor' ? settings.downColor : '#000000');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Style du graphique</div>
        <div className="settings-row">
          {(['candles', 'heikin_ashi', 'bars', 'line', 'area'] as const).map((st) => (
            <button key={st} className={`pill-btn ${settings.candleStyle === st ? 'active' : ''}`} onClick={() => update({ candleStyle: st })}>
              {STYLE_LABELS[st]}
            </button>
          ))}
        </div>

        <div className="modal-title">Couleurs · thème {theme === 'dark' ? 'sombre' : 'clair'}</div>
        <div className="cs-colors">
          {COLOR_ROWS.map(([k, label]) => {
            const v = valueOf(k);
            return (
              <div key={k} className="cs-color-row">
                <span>{label}</span>
                <ColorSwatch value={v} onChange={(c) => update({ [k]: c } as Partial<ChartSettings>)} />
                <div className="cs-quick">
                  {QUICK_COLORS.map((c) => (
                    <button key={c} title={c} style={{ background: c }} className={c.toLowerCase() === v.toLowerCase() ? 'on' : ''} onClick={() => update({ [k]: c } as Partial<ChartSettings>)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <label className="settings-checkbox">
          <input type="checkbox" checked={settings.showGrid} onChange={(e) => update({ showGrid: e.target.checked })} />
          Afficher la grille
        </label>
        <label className="settings-checkbox">
          <input type="checkbox" checked={settings.showCountdown !== false} onChange={(e) => update({ showCountdown: e.target.checked })} />
          Compte à rebours avant la clôture de la bougie
        </label>
        <div className="cs-subtitle">Événements en bas du graphique</div>
        <label className="settings-checkbox">
          <input type="checkbox" checked={settings.showEarnings !== false} onChange={(e) => update({ showEarnings: e.target.checked })} />
          Résultats (E)
        </label>
        <label className="settings-checkbox">
          <input type="checkbox" checked={settings.showDividends !== false} onChange={(e) => update({ showDividends: e.target.checked })} />
          Dividendes (D)
        </label>
        <label className="settings-checkbox">
          <input type="checkbox" checked={settings.showNews !== false} onChange={(e) => update({ showNews: e.target.checked })} />
          Actualités (⚡)
        </label>

        <div className="cs-actions">
          <button className="pill-btn" title="Couleurs d’origine de ce thème" onClick={reset}>Couleurs par défaut</button>
          <button className="pill-btn close-btn" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
