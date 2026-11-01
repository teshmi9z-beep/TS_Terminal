import { useState, type ReactElement } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { tvIdOf } from '../data/assetInfo';
import { setFundamentalsTarget } from '../data/fundamentals';
import { goToChart, openTool } from './tabs/tabActions';
import { remember } from './kept';

const ic = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const CandlesIcon = () => <svg {...ic}><path d="M5 2v3M5 12v4M13 3v3M13 11v3" /><rect x="3" y="5" width="4" height="7" /><rect x="11" y="6" width="4" height="5" /></svg>;
const FinancialsIcon = () => <svg {...ic}><path d="M3 15h12" /><rect x="4" y="9" width="2.4" height="6" /><rect x="7.8" y="6" width="2.4" height="9" /><rect x="11.6" y="3" width="2.4" height="12" /></svg>;
const NewsIcon = () => <svg {...ic}><rect x="3" y="3" width="12" height="12" rx="1.5" /><path d="M6 6.5h6M6 9h6M6 11.5h4" /></svg>;
const OptionsIcon = () => <svg {...ic}><path d="M3 15V3" /><path d="M3 12c3 0 4-6 7-6s3 3 5 3" /></svg>;
const InfoIcon = () => <svg {...ic}><circle cx="9" cy="9" r="6.5" /><path d="M9 8.2v4.3M9 5.6v.2" /></svg>;

type Item = { label: string; icon: () => ReactElement; run: () => void } | { head: string };

// TradingView's quick menu next to the symbol: what the platform has on the asset shown, in one click
export default function SymbolQuickMenu() {
  const symbol = useStore((s) => s.symbol);
  const openSymbolInfo = useChartUi((s) => s.openSymbolInfo);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const close = () => setAt(null);

  const items: Item[] = [
    { label: 'Graphique', icon: CandlesIcon, run: () => goToChart() },
    { head: 'Données fondamentales' },
    { label: 'Données financières', icon: FinancialsIcon, run: () => { void tvIdOf(symbol).then((id) => { if (id) setFundamentalsTarget(id); openTool('fundamentals'); }); } },
    { head: 'Analyse' },
    {
      label: 'Actualités', icon: NewsIcon,
      run: () => {
        // the news page opens on this asset's stories
        void tvIdOf(symbol).then((id) => {
          remember('news.symbolText', symbol.ticker);
          remember('news.symbol', id ?? symbol.ticker);
          remember('news.selected', null, true);
          openTool('news');
        });
      },
    },
    { head: 'Actifs' },
    // the option chain of this asset (of its index for a future or an index)
    { label: 'Options', icon: OptionsIcon, run: () => { remember('options.query', symbol.ticker); openTool('options'); } },
    { label: 'Infos du symbole', icon: InfoIcon, run: () => openSymbolInfo(symbol) },
  ];

  return (
    <div className="tb-dropdown">
      <button
        className={`tb-btn tb-sym-menu ${at ? 'tb-active' : ''}`} title={`${symbol.ticker} : graphique, données financières, actualités, options…`}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { left: Math.max(4, Math.min(r.left, window.innerWidth - 250)), top: r.bottom + 4 }); }}
      >
        <CandlesIcon />
      </button>
      {at && (
        <>
          <div className="tb-dropdown-backdrop" onClick={close} />
          <div className="tb-dropdown-menu sq-menu" style={{ left: at.left, top: at.top }}>
            {items.map((it) => ('head' in it
              ? <div key={it.head} className="sq-head">{it.head}</div>
              : (
                <button key={it.label} className={`tb-menu-item ${it.label === 'Graphique' ? 'sq-first' : ''}`} onClick={() => { close(); it.run(); }}>
                  <it.icon /><span>{it.label}</span>
                </button>
              )))}
          </div>
        </>
      )}
    </div>
  );
}
