import type { ToolId } from '../../store/store';

// icons of the tools of the "Nouvel onglet" page and of their tabs
export default function ToolIcon({ tool, size = 18 }: { tool: ToolId | 'home'; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (tool) {
    case 'screener': return <svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12l6.5-6.5M17 3.5l1.5 2 2 1.5" /></svg>;
    case 'heatmap': return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M11 3v18M11 12h10M3 15h8M16 12v9" /></svg>;
    case 'calendar': return <svg {...p}><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>;
    case 'news': return <svg {...p}><rect x="3" y="4" width="14" height="16" rx="2" /><path d="M7 8h6M7 12h3M7 16h2" /><circle cx="16" cy="15" r="3.5" /><path d="M18.5 17.5L21 20" /></svg>;
    case 'portfolios': return <svg {...p}><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M8.5 7V5a2 2 0 012-2h3a2 2 0 012 2v2M3 12.5h18M10 12.5v2h4v-2" /></svg>;
    case 'yields': return <svg {...p}><path d="M5 3v18M5 21h0" /><path d="M8 20c2-8 5-12 12-13" /><path d="M16 5l4 2-2 4" /></svg>;
    case 'options': return <svg {...p}><path d="M4 4v16h16" /><path d="M7 16h5l6-9" /><path d="M14 11h6" /></svg>;
    case 'fundamentals': return <svg {...p}><rect x="4" y="5" width="6" height="14" rx="1" /><path d="M14 5h4a2 2 0 012 2v10a2 2 0 01-2 2h-4" /><path d="M14 3v18" /></svg>;
    case 'markets': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z" /></svg>;
    case 'community': return <svg {...p}><path d="M3 19h18L14 6l-3.5 6.5L8 9z" /><path d="M9 14l3-2 3 3" /></svg>;
    case 'macro': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M7 5.5c1 1.5 3 1.5 3.5 3.5s-2 2-1.5 4 3 1.5 3 4-1 2.5-1 4M15 3.5c-.5 1.5.5 3 2 3.5s2.5 2 3.5 3" /></svg>;
    case 'data': return <svg {...p}><ellipse cx="12" cy="5.5" rx="7" ry="2.5" /><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" /></svg>;
    case 'robots': return <svg {...p}><rect x="5" y="8" width="14" height="11" rx="2.5" /><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5M3 12v3M21 12v3" /><circle cx="12" cy="3.5" r="1" /></svg>;
    default: return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 8v8M8 12h8" /></svg>;
  }
}
