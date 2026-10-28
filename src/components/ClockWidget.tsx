import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { TIME_ZONES, utcLabel, zoneOffsetSec } from '../data/timeZone';

function pad(n: number) { return String(n).padStart(2, '0'); }

export default function ClockWidget() {
  const [now, setNow] = useState(new Date());
  const [showMenu, setShowMenu] = useState(false);
  const timeZone = useStore((s) => s.timeZone);
  const setTimeZone = useStore((s) => s.setTimeZone);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const local = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // the zone's offset today: UTC+1 in Paris in winter, UTC+2 in summer
  const nowSec = now.getTime() / 1000;
  const offset = zoneOffsetSec(timeZone, nowSec);
  const zoned = new Date(now.getTime() + offset * 1000);
  const zonedTime = `${pad(zoned.getUTCHours())}:${pad(zoned.getUTCMinutes())}:${pad(zoned.getUTCSeconds())}`;
  const currentCity = TIME_ZONES.find((t) => t.zone === timeZone)?.label ?? timeZone;

  return (
    <div className="clock-widget">
      <span>{local} (local)</span>
      <span className="clock-sep">·</span>
      <span className="clock-utc" onClick={(e) => { e.stopPropagation(); setShowMenu((v) => !v); }} title="Changer le fuseau horaire (heure d'été / d'hiver suivie)">
        {zonedTime} {utcLabel(offset)} ({currentCity})
      </span>
      {showMenu && (
        <div className="clock-tz-backdrop" onClick={() => setShowMenu(false)}>
          <div className="clock-tz-menu" onClick={(e) => e.stopPropagation()}>
            {TIME_ZONES.map((tz) => (
              <button
                key={tz.zone}
                className={`clock-tz-item ${tz.zone === timeZone ? 'active' : ''}`}
                onClick={() => { setTimeZone(tz.zone); setShowMenu(false); }}
              >
                <span>{tz.label}</span>
                <span className="clock-tz-offset">{utcLabel(zoneOffsetSec(tz.zone, nowSec))}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
