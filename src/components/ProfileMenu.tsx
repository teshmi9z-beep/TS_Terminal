import { useState } from 'react';
import { useStore } from '../store/store';
import { captureThumbnail } from './mainChart';
import type { Profile } from '../types';
import { LOCALE } from '../i18n/lang';

// hover preview: a snapshot of the chart taken when the template was saved
function Preview({ profile, at }: { profile: Profile; at: { left: number; top: number } }) {
  const date = profile.savedAt ? new Date(profile.savedAt).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : null;
  return (
    <div className="profile-preview" style={{ left: Math.max(8, Math.min(at.left, window.innerWidth - 352)), top: Math.max(8, Math.min(at.top, window.innerHeight - 260)) }}>
      {profile.thumbnail
        ? <img src={profile.thumbnail} alt={`Aperçu ${profile.name}`} />
        : <div className="profile-preview-empty">Pas d’aperçu : réenregistrez ce modèle pour en créer un.</div>}
      <div className="profile-preview-meta">
        <b>{profile.name}</b>
        <span>
          {profile.indicators.length} indicateur{profile.indicators.length > 1 ? 's' : ''}
          {profile.ticker ? ` · ${profile.ticker}` : ''}{profile.timeframe ? ` ${profile.timeframe}` : ''}
          {date ? ` · ${date}` : ''}
        </span>
      </div>
    </div>
  );
}

export default function ProfileMenu({ onClose }: { onClose: () => void }) {
  const profiles = useStore((s) => s.profiles);
  const saveProfile = useStore((s) => s.saveProfile);
  const loadProfile = useStore((s) => s.loadProfile);
  const deleteProfile = useStore((s) => s.deleteProfile);
  const [name, setName] = useState('');
  const [hover, setHover] = useState<{ profile: Profile; at: { left: number; top: number } } | null>(null);

  function save() {
    if (!name.trim()) return;
    saveProfile(name.trim(), captureThumbnail());
    setName('');
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Enregistrer le modèle actuel</div>
        <div className="profile-save-row">
          <input
            className="preset-search" placeholder="Nom du modèle..."
            value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          />
          <button className="pill-btn" onClick={save}>Enregistrer</button>
        </div>

        <div className="modal-title">Modèles enregistrés</div>
        {profiles.length === 0 && <div className="ind-popover-row" style={{ color: 'var(--text-muted)' }}>Aucun modèle pour l'instant.</div>}
        <div className="modal-list">
          {profiles.map((p) => (
            <div
              key={p.name} className="modal-item active-item profile-row"
              onMouseEnter={(e) => {
                const r = (e.currentTarget.closest('.modal') ?? e.currentTarget).getBoundingClientRect();
                const row = e.currentTarget.getBoundingClientRect();
                setHover({ profile: p, at: { left: r.right + 12, top: row.top - 20 } });
              }}
              onMouseLeave={() => setHover(null)}
            >
              {p.thumbnail ? <img className="profile-thumb" src={p.thumbnail} alt="" /> : <span className="profile-thumb empty" />}
              <span className="profile-name">{p.name}</span>
              <span>
                <button className="pill-btn" style={{ marginRight: 6, padding: '3px 8px' }} onClick={() => { loadProfile(p.name); onClose(); }}>Charger</button>
                <button className="remove-btn" onClick={() => deleteProfile(p.name)}>✕</button>
              </span>
            </div>
          ))}
        </div>
        <button className="pill-btn close-btn" onClick={onClose}>Fermer</button>
      </div>
      {hover && <Preview profile={hover.profile} at={hover.at} />}
    </div>
  );
}
