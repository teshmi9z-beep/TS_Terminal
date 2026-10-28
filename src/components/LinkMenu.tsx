import { useState, type ReactElement } from 'react';
import { useStore, POPOUT_ID, type LinkGroup } from '../store/store';
import { LINK_COLORS } from './chartLink';

const ic = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function ChainIcon() {
  return <svg {...ic}><path d="M7.5 10.5l3-3" /><path d="M8.2 5.3l1.4-1.4a2.8 2.8 0 014 4l-1.4 1.4" /><path d="M9.8 12.7l-1.4 1.4a2.8 2.8 0 01-4-4l1.4-1.4" /></svg>;
}
function ClockIcon() {
  return <svg {...ic}><circle cx="9" cy="9" r="6.5" /><path d="M9 5.2V9l2.6 1.6" /></svg>;
}
function ScrollIcon() {
  return <svg {...ic}><path d="M2.5 13.5h13" /><path d="M5 5.5h8M5 5.5l2-2M5 5.5l2 2M13 5.5l-2-2M13 5.5l-2 2" /><path d="M9 9.5v4" /></svg>;
}
const ICONS: Record<'symbol' | 'tf' | 'scroll', () => ReactElement> = { symbol: ChainIcon, tf: ClockIcon, scroll: ScrollIcon };
const GROUP_LABEL: Record<LinkGroup, string> = { 0: 'Non lié', 1: 'Groupe 1 (orange)', 2: 'Groupe 2 (bleu)' };

// the three choices of a link: not linked, group 1, group 2
function Groups({ kind, value, onPick }: { kind: 'symbol' | 'tf' | 'scroll'; value: LinkGroup; onPick: (g: LinkGroup) => void }) {
  const Icon = ICONS[kind];
  return (
    <div className="link-groups">
      {([0, 1, 2] as LinkGroup[]).map((g) => (
        <button key={g} className={`link-group ${value === g ? 'active' : ''}`} title={GROUP_LABEL[g]} onClick={() => onPick(g)} style={g ? { color: LINK_COLORS[g] } : undefined}>
          <Icon />
          {g === 0 && <span className="link-off" aria-hidden="true">✕</span>}
          {g > 0 && <span className="link-num">{g}</span>}
        </button>
      ))}
    </div>
  );
}

// "Lier", like ProRealTime: this chart's link groups for the symbol, the
// timeframe and the time scale, and whether it is the principal chart
export default function LinkMenu() {
  const link = useStore((s) => s.chartLink);
  const set = useStore((s) => s.setChartLink);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const group = link.symbol || link.tf || link.scroll;
  const summary = [link.symbol && `instrument ${link.symbol}`, link.tf && `unité de temps ${link.tf}`, link.scroll && `défilement ${link.scroll}`].filter(Boolean).join(', ');

  return (
    <div className="tb-dropdown">
      <button
        className={`tb-btn tb-link ${group ? 'on' : ''}`} style={group ? { color: LINK_COLORS[group] } : undefined}
        title={summary ? `Lié : ${summary}` : 'Lier ce graphique aux autres fenêtres (instrument, unité de temps, défilement)'}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { left: Math.max(4, Math.min(r.left, window.innerWidth - 330)), top: r.bottom + 4 }); }}
      >
        <ChainIcon />
      </button>
      {at && (
        <>
          <div className="tb-dropdown-backdrop" onClick={() => setAt(null)} />
          <div className="link-menu" style={{ left: at.left, top: at.top }}>
            <div className="link-title">Lier par instrument</div>
            <Groups kind="symbol" value={link.symbol} onPick={(g) => set({ symbol: g })} />
            <label className="link-check" title={link.principal ? 'Pour changer, cochez-le dans une autre fenêtre' : undefined}>
              <input type="checkbox" checked={link.principal} disabled={link.principal} onChange={(e) => set({ principal: e.target.checked })} />
              <span>Définir comme graphique principal <small>(la liste de surveillance ouvre ses symboles ici)</small></span>
            </label>
            <div className="link-title">Lier par unité de temps</div>
            <Groups kind="tf" value={link.tf} onPick={(g) => set({ tf: g })} />
            <label className="link-check">
              <input type="checkbox" checked={link.bars} disabled={!link.tf} onChange={(e) => set({ bars: e.target.checked })} />
              <span>Lier la quantité d’historique affiché <small>(même nombre de bougies à l’écran)</small></span>
            </label>
            <div className="link-title">Lier le défilement de l’échelle de temps</div>
            <Groups kind="scroll" value={link.scroll} onPick={(g) => set({ scroll: g })} />
            <div className="link-note">
              Les graphiques d’un même groupe se suivent : la fenêtre principale et les fenêtres détachées (↗).
              {POPOUT_ID ? ' Ce réglage vaut pour cette fenêtre.' : ' Chaque fenêtre détachée a son propre bouton.'}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
