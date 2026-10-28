import { PRESETS } from '../data/presets';
import { useStore } from '../store/store';

export default function PresetPicker({ onClose }: { onClose: () => void }) {
  const addWatchlistTab = useStore((s) => s.addWatchlistTab);

  function add(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    addWatchlistTab(preset.label, preset.symbols);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Listes predefinies</div>
        <div className="modal-list">
          {PRESETS.map((p) => (
            <button key={p.id} className="modal-item" onClick={() => add(p.id)}>
              <span>{p.label}</span>
              <span className="cat-count">{p.symbols.length} actifs</span>
            </button>
          ))}
        </div>
        <button className="pill-btn close-btn" onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}
