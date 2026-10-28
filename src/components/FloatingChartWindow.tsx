import { useStore } from '../store/store';
import type { FreeWindow } from '../store/store';
import MiniChartPane from './MiniChartPane';
import { findSymbol } from './symbolDnd';
import { openPopout } from './popouts';

const MIN_W = 260;
const MIN_H = 200;

export default function FloatingChartWindow({ win }: { win: FreeWindow }) {
  const updateFreeWindow = useStore((s) => s.updateFreeWindow);
  const removeFreeWindow = useStore((s) => s.removeFreeWindow);
  const bringWindowToFront = useStore((s) => s.bringWindowToFront);
  const timeframe = useStore((s) => s.timeframe);

  function onDragDown(e: React.MouseEvent) {
    e.preventDefault();
    bringWindowToFront(win.id);
    const startX = e.clientX, startY = e.clientY;
    const startWinX = win.x, startWinY = win.y;
    function onMove(ev: MouseEvent) {
      updateFreeWindow(win.id, { x: Math.max(0, startWinX + (ev.clientX - startX)), y: Math.max(0, startWinY + (ev.clientY - startY)) });
    }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onResizeDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    bringWindowToFront(win.id);
    const startX = e.clientX, startY = e.clientY;
    const startW = win.w, startH = win.h;
    function onMove(ev: MouseEvent) {
      updateFreeWindow(win.id, {
        w: Math.max(MIN_W, startW + (ev.clientX - startX)),
        h: Math.max(MIN_H, startH + (ev.clientY - startY)),
      });
    }
    function onUp() { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // turns this in-page window into a real browser window, at the same spot on screen
  function detach(e: React.MouseEvent) {
    e.stopPropagation();
    const sym = findSymbol(win.ticker);
    if (!sym) return;
    const r = (e.currentTarget as HTMLElement).closest('.float-window')!.getBoundingClientRect();
    openPopout(sym, win.tf ?? timeframe, {
      left: window.screenX + r.left, top: window.screenY + (window.outerHeight - window.innerHeight) + r.top,
      width: Math.max(700, r.width), height: Math.max(450, r.height),
    });
    removeFreeWindow(win.id);
  }

  return (
    <div
      className="float-window"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onMouseDown={() => bringWindowToFront(win.id)}
    >
      <div className="float-window-header" onMouseDown={onDragDown}>
        <span className="float-window-grip">⠿⠿⠿</span>
        <span className="float-window-actions">
          <button className="remove-btn" title="Détacher dans une vraie fenêtre (déplaçable sur un autre écran)" onMouseDown={(e) => e.stopPropagation()} onClick={detach}>↗</button>
          <button className="remove-btn" title="Fermer" onMouseDown={(e) => e.stopPropagation()} onClick={() => removeFreeWindow(win.id)}>✕</button>
        </span>
      </div>
      <div className="float-window-body">
        <MiniChartPane
          initialTicker={win.ticker} initialTimeframe={win.tf}
          onTickerChange={(t) => updateFreeWindow(win.id, { ticker: t })}
          onTimeframeChange={(tf) => updateFreeWindow(win.id, { tf })}
        />
      </div>
      <div className="float-window-resize" onMouseDown={onResizeDown} />
    </div>
  );
}
