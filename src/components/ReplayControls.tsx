import { useEffect, useRef, type RefObject } from 'react';
import { useStore } from '../store/store';
import { useChartUi } from '../store/chartUi';
import { timeFormatters, type ChartEngine } from './chartUtils';
import { endReplaySession } from './tradingAccount';
import ReplaySessionBadge from './ReplaySessionBadge';

const SPEEDS = [0.1, 0.3, 0.5, 1, 3, 5, 10];

const ic = { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

// bar replay toolbar (bottom of the chart) and, while picking the start bar,
// a blue cut line that follows the mouse with the "future" greyed out
export default function ReplayControls({ engine, containerRef, onStep, onRandom }: {
  engine: RefObject<ChartEngine>;
  containerRef: RefObject<HTMLDivElement | null>;
  onStep: () => void;
  onRandom: () => void;
}) {
  const replay = useChartUi((s) => s.replay);
  const setReplay = useChartUi((s) => s.setReplay);
  useChartUi((s) => s.dataVersion);
  const timeZone = useStore((s) => s.timeZone);
  const timeframe = useStore((s) => s.timeframe);
  const cutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || replay.mode !== 'select') return;
    const onMove = (e: MouseEvent) => {
      const cut = cutRef.current;
      const chart = engine.current.chart;
      if (!cut || !chart) return;
      const x = e.clientX - el.getBoundingClientRect().left;
      const plotW = chart.paneSize(0).width;
      cut.style.display = x >= 0 && x < plotW ? 'block' : 'none';
      cut.style.left = `${x}px`;
      cut.style.width = `${Math.max(0, plotW - x)}px`;
    };
    el.addEventListener('mousemove', onMove);
    return () => el.removeEventListener('mousemove', onMove);
  }, [containerRef, engine, replay.mode]);

  if (replay.mode === 'off') return null;

  if (replay.mode === 'select') {
    return (
      <>
        <div ref={cutRef} className="replay-cut" style={{ display: 'none' }} />
        <div className="replay-bar chart-ui">
          <span className="replay-hint">✂ Cliquez sur le graphique pour choisir la barre de départ du replay</span>
          <button className="rp-btn rp-random" title="Période choisie au hasard dans l’historique" onClick={() => { endReplaySession(); onRandom(); }}>🎲 Aléatoire</button>
          <button className="rp-btn" onClick={() => { endReplaySession(); setReplay({ mode: 'off', playing: false, time: null, at: null }); }}>Annuler</button>
        </div>
      </>
    );
  }

  const e = engine.current;
  const last = e.candles[e.candles.length - 1];
  const label = last ? timeFormatters(timeZone, timeframe).timeFormatter(last.time as never) : '';

  return (
    <div className="replay-bar chart-ui">
      <span className="replay-badge">REPLAY</span>
      <button className="rp-btn" title="Choisir une autre barre de départ" onClick={() => { endReplaySession(); setReplay({ mode: 'select', playing: false }); }}>
        <svg {...ic}><circle cx="5" cy="5" r="2.2" /><circle cx="5" cy="13" r="2.2" /><path d="M6.8 6.3L15 13M6.8 11.7L15 5" /></svg>
      </button>
      <button className="rp-btn" title="Autre période au hasard" onClick={() => { endReplaySession(); onRandom(); }}>🎲</button>
      <button
        className="rp-btn rp-play" title={replay.playing ? 'Pause' : 'Lecture'}
        onClick={() => setReplay({ playing: !replay.playing })}
      >
        {replay.playing
          ? <svg {...ic}><path d="M6 4v10M12 4v10" /></svg>
          : <svg {...ic}><path d="M5 3.5l10 5.5-10 5.5z" fill="currentColor" /></svg>}
      </button>
      <button className="rp-btn" title="Avancer d'une barre (Maj + →)" onClick={() => { setReplay({ playing: false }); onStep(); }}>
        <svg {...ic}><path d="M4 3.5l8 5.5-8 5.5z" fill="currentColor" /><path d="M14 4v10" /></svg>
      </button>
      <select className="rp-speed" value={replay.speed} onChange={(ev) => setReplay({ speed: parseFloat(ev.target.value) })} title="Vitesse">
        {SPEEDS.map((s) => <option key={s} value={s}>{s}x</option>)}
      </select>
      <span className="replay-date">{label}</span>
      <ReplaySessionBadge />
      <button className="rp-btn rp-text" title="Quitter le replay et revenir au temps réel" onClick={() => { endReplaySession(); setReplay({ mode: 'off', playing: false, time: null, at: null }); }}>
        <svg {...ic}><path d="M3 4l6 5-6 5zM9 4l6 5-6 5z" fill="currentColor" /></svg> Temps réel
      </button>
    </div>
  );
}
