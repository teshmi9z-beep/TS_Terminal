import type { ChartEngine } from './chartUtils';
import { useChartUi } from '../store/chartUi';

// handle on the single-layout chart, for toolbar actions (screenshot) that live outside it;
// loadBefore pages older history in until a time (true once the chart reaches it)
export const mainChart: { engine: ChartEngine | null; drawingCanvas: HTMLCanvasElement | null; loadBefore: ((time: number) => Promise<boolean>) | null } = {
  engine: null,
  drawingCanvas: null,
  loadBefore: null,
};

// chart + drawings as a small JPEG data URL (template previews)
export function captureThumbnail(maxWidth = 360): string | undefined {
  const chart = mainChart.engine?.chart;
  if (!chart) return undefined;
  try {
    const shot = chart.takeScreenshot();
    const scale = Math.min(1, maxWidth / shot.width);
    const out = document.createElement('canvas');
    out.width = Math.round(shot.width * scale);
    out.height = Math.round(shot.height * scale);
    const ctx = out.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(shot, 0, 0, out.width, out.height);
    if (mainChart.drawingCanvas) ctx.drawImage(mainChart.drawingCanvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  }
}

export function downloadScreenshot(ticker: string) {
  const chart = mainChart.engine?.chart;
  if (!chart) return;
  const shot = chart.takeScreenshot();
  const drawings = mainChart.drawingCanvas;
  if (drawings) {
    const ctx = shot.getContext('2d');
    ctx?.drawImage(drawings, 0, 0, shot.width, shot.height);
  }
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.download = `${ticker}_${stamp}.png`;
  a.href = shot.toDataURL('image/png');
  a.click();
}

// shows the bars from `from` to `to` (a trade of the strategy tester), with some margin
export async function focusChartOn(from: number, to: number) {
  // an older trade (the robots' tests start years back): its bars first
  const first = mainChart.engine?.candles[0]?.time;
  if (first != null && first > from && mainChart.loadBefore && !(await mainChart.loadBefore(from))) {
    useChartUi.getState().showToast('Trade plus ancien que l’historique chargé par le graphique : faites défiler vers la gauche pour en charger davantage.');
  }
  const e = mainChart.engine;
  const chart = e?.chart;
  if (!chart || !e.candles.length) return;
  const idx = (t: number) => {
    let lo = 0, hi = e.candles.length - 1, best = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (e.candles[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best;
  };
  const a = idx(from), b = idx(to);
  const pad = Math.max(10, Math.round((b - a) * 0.6));
  chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
}
