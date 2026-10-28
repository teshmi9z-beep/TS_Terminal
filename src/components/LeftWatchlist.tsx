import { useStore } from '../store/store';
import Watchlist from './Watchlist';

// the watchlist docked on the left of the terminal (see its ⇆ button)
export default function LeftWatchlist() {
  const width = useStore((s) => s.watchlistWidth);
  const setWidth = useStore((s) => s.setWatchlistWidth);

  function onResizeDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const onMove = (ev: MouseEvent) => setWidth(startW + (ev.clientX - startX));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className="left-panel" style={{ width }}>
      <Watchlist />
      <div className="left-resize-handle" onMouseDown={onResizeDown} />
    </div>
  );
}
