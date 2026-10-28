import { useState } from 'react';
import { useStore } from '../store/store';
import { TF_SECTIONS, sectionOf, sortTfs, tfLongLabel, type TfSectionId } from '../data/timeframes';
import type { TfUnit, Timeframe } from '../types';

const UNITS: { unit: TfUnit; label: string }[] = [
  { unit: 'T', label: 'ticks' },
  { unit: 's', label: 'secondes' },
  { unit: 'm', label: 'minutes' },
  { unit: 'h', label: 'heures' },
  { unit: 'D', label: 'jours' },
];

// TradingView's interval dropdown: sections, favorites (stars), custom intervals
// `anchor`: screen position under the button (the top bar scrolls horizontally,
// so the menu is fixed-positioned instead of nested in it)
export default function TimeframeMenu({ onClose, anchor }: { onClose: () => void; anchor: { left: number; top: number } }) {
  const timeframe = useStore((s) => s.timeframe);
  const setTimeframe = useStore((s) => s.setTimeframe);
  const favorites = useStore((s) => s.favoriteTimeframes);
  const toggleFavorite = useStore((s) => s.toggleFavoriteTf);
  const custom = useStore((s) => s.customTimeframes);
  const addCustom = useStore((s) => s.addCustomTf);
  const removeCustom = useStore((s) => s.removeCustomTf);
  const [closed, setClosed] = useState<Partial<Record<TfSectionId, boolean>>>({});
  const [adding, setAdding] = useState(false);
  const [count, setCount] = useState('2');
  const [unit, setUnit] = useState<TfUnit>('m');

  function pick(tf: Timeframe) {
    setTimeframe(tf);
    onClose();
  }

  function submitCustom(e: React.FormEvent) {
    e.preventDefault();
    const n = parseInt(count);
    if (!n || n < 1) return;
    const tf = `${n}${unit}` as Timeframe;
    const standard = TF_SECTIONS.some((s) => s.items.includes(tf));
    if (!standard) addCustom(tf);
    setAdding(false);
    pick(tf);
  }

  return (
    <>
      <div className="tb-dropdown-backdrop" onClick={onClose} />
      <div className="tf-menu" style={{ left: anchor.left, top: anchor.top }}>
        {adding ? (
          <form className="tf-custom-form" onSubmit={submitCustom}>
            <input type="number" min={1} max={100000} value={count} onChange={(e) => setCount(e.target.value)} autoFocus />
            <select value={unit} onChange={(e) => setUnit(e.target.value as TfUnit)}>
              {UNITS.map((u) => <option key={u.unit} value={u.unit}>{u.label}</option>)}
            </select>
            <button type="submit" className="pill-btn">Ajouter</button>
            <button type="button" className="remove-btn" onClick={() => setAdding(false)}>✕</button>
          </form>
        ) : (
          <button className="tf-menu-add" onClick={() => setAdding(true)}>＋ Ajouter un intervalle personnalisé…</button>
        )}
        {TF_SECTIONS.map((sec) => {
          const items = sortTfs([...sec.items, ...custom.filter((tf) => sectionOf(tf) === sec.id)]);
          const isClosed = !!closed[sec.id];
          return (
            <div key={sec.id} className="tf-menu-section">
              <button className="tf-menu-head" onClick={() => setClosed((c) => ({ ...c, [sec.id]: !c[sec.id] }))}>
                <span>{sec.title.toUpperCase()}</span>
                <span className={`tf-menu-caret ${isClosed ? 'closed' : ''}`}>⌃</span>
              </button>
              {!isClosed && items.map((tf) => {
                const fav = favorites.includes(tf);
                const isCustom = custom.includes(tf) && !sec.items.includes(tf);
                return (
                  <div key={tf} className={`tf-menu-item ${tf === timeframe ? 'active' : ''}`} onClick={() => pick(tf)}>
                    <span className="tf-menu-label">{tfLongLabel(tf)}</span>
                    {isCustom && (
                      <button className="tf-menu-icon" title="Supprimer cet intervalle" onClick={(e) => { e.stopPropagation(); removeCustom(tf); }}>
                        <TrashIcon />
                      </button>
                    )}
                    <button
                      className={`tf-menu-icon star ${fav ? 'on' : ''}`} title={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(tf); }}
                    >
                      {fav ? '★' : '☆'}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h12M7 5V3h4v2M5 5l.8 10h6.4L13 5" />
    </svg>
  );
}
