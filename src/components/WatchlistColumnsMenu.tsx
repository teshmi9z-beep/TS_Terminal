import { useStore } from '../store/store';

export default function WatchlistColumnsMenu({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.watchlistSettings);
  const update = useStore((s) => s.updateWatchlistSettings);

  return (
    <div className="wl-cols-backdrop" onClick={onClose}>
      <div className="wl-cols-menu" onClick={(e) => e.stopPropagation()}>
        <label className="wl-cols-toggle-row">
          Vue tableau
          <span className={`wl-toggle-switch ${settings.tableView ? 'on' : ''}`} onClick={() => update({ tableView: !settings.tableView })}>
            <span className="wl-toggle-knob" />
          </span>
        </label>

        <div className="wl-cols-title">Personnaliser les colonnes</div>
        {([
          ['showLast', 'Dernier'],
          ['showChg', 'Variation'],
          ['showChgPct', 'Variation %'],
          ['showVolume', 'Volume'],
          ['showExtendedHours', 'Horaire etendu'],
        ] as const).map(([key, label]) => (
          <label key={key} className="wl-cols-check">
            <input type="checkbox" checked={settings[key]} onChange={(e) => update({ [key]: e.target.checked } as any)} />
            {label}
          </label>
        ))}

        <div className="wl-cols-title">Affichage du symbole</div>
        <label className="wl-cols-check">
          <input type="checkbox" checked={settings.showLogo} onChange={(e) => update({ showLogo: e.target.checked })} />
          Logo
        </label>
        <label className="wl-cols-check">
          <input type="radio" name="wl-label-mode" checked={settings.labelMode === 'symbol'} onChange={() => update({ labelMode: 'symbol' })} />
          Symbole
        </label>
        <label className="wl-cols-check">
          <input type="radio" name="wl-label-mode" checked={settings.labelMode === 'name'} onChange={() => update({ labelMode: 'name' })} />
          Nom
        </label>
      </div>
    </div>
  );
}
