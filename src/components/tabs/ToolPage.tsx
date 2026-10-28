import { useRef } from 'react';
import { useScrollMemory } from '../kept';
import type { ToolId } from '../../store/store';
import { PanelModeContext } from '../panelMode';
import Screener from '../Screener';
import YieldCurves from '../YieldCurves';
import MacroMap from '../MacroMap';
import CalendarPage from '../pages/CalendarPage';
import NewsPage from '../pages/NewsPage';
import PortfoliosPage from '../pages/PortfoliosPage';
import OptionsPage from '../pages/OptionsPage';
import FundamentalsPage from '../pages/FundamentalsPage';
import MarketsPage from '../pages/MarketsPage';
import CommunityPage from '../pages/CommunityPage';
import HeatmapPage from '../pages/HeatmapPage';
import RobotsPage from '../pages/RobotsPage';
import DataPage from '../pages/DataPage';

// a tool opened in its own tab, full page
export default function ToolPage({ tool }: { tool: ToolId }) {
  // back on the tab, the page and its lists are scrolled where they were left
  const ref = useRef<HTMLDivElement>(null);
  useScrollMemory(ref, tool);
  return (
    <PanelModeContext.Provider value="page">
      <div ref={ref} className={`tool-page tool-${tool}`}>
        {tool === 'screener' && <Screener display="table" />}
        {tool === 'heatmap' && <HeatmapPage />}
        {tool === 'yields' && <YieldCurves />}
        {tool === 'macro' && <MacroMap />}
        {tool === 'calendar' && <CalendarPage />}
        {tool === 'news' && <NewsPage />}
        {tool === 'portfolios' && <PortfoliosPage />}
        {tool === 'options' && <OptionsPage />}
        {tool === 'fundamentals' && <FundamentalsPage />}
        {tool === 'markets' && <MarketsPage />}
        {tool === 'community' && <CommunityPage />}
        {tool === 'robots' && <RobotsPage />}
        {tool === 'data' && <DataPage />}
      </div>
    </PanelModeContext.Provider>
  );
}
