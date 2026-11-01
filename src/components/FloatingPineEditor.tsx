import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import PineEditor from './PineEditor';

const MIN_W = 420;
const MIN_H = 320;

// the Pine editor detached from the right panel ("⧉ Détacher"): a window moved by its title bar
// and sized by its corner, kept where it was left
export default function FloatingPineEditor() {
  const rect = useStore((s) => s.pineFloat);
  const setRect = useStore((s) => s.setPineFloat);
  const open = useChartUi((s) => s.pineEditor.open);
  const close = useChartUi((s) => s.closePineEditor);
  if (!rect || !open) return null;

  function track(e: React.MouseEvent, move: (dx: number, dy: number) => void) {
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    const onMove = (ev: MouseEvent) => move(ev.clientX - x0, ev.clientY - y0);
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  const r = rect;
  // its title bar always stays reachable
  const onDrag = (e: React.MouseEvent) => track(e, (dx, dy) => setRect({
    ...r,
    x: Math.min(window.innerWidth - 120, Math.max(0, r.x + dx)),
    y: Math.min(window.innerHeight - 40, Math.max(0, r.y + dy)),
  }));
  const onResize = (e: React.MouseEvent) => { e.stopPropagation(); track(e, (dx, dy) => setRect({ ...r, w: Math.max(MIN_W, r.w + dx), h: Math.max(MIN_H, r.h + dy) })); };

  return (
    <div className="float-window pine-float" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
      <div className="float-window-header" onMouseDown={onDrag}>
        <span className="float-window-grip">⠿⠿⠿</span>
        <span className="pine-float-title">Éditeur Pine</span>
        <span className="float-window-actions">
          <button className="remove-btn" title="Fermer" onMouseDown={(e) => e.stopPropagation()} onClick={close}>✕</button>
        </span>
      </div>
      <div className="float-window-body">
        <PineEditor floating />
      </div>
      <div className="float-window-resize" onMouseDown={onResize} />
    </div>
  );
}
