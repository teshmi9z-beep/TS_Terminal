import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PaperSide } from '../store/store';
import { LOCALE, DEC } from '../i18n/lang';

// Small panels opened by a double-click on an order's lines (ChartTrading):
// the quantity of a pending order, and a stop or target set by its amount.

export type EditorAt = { top?: number; bottom?: number; right: number };

const num = (v: string) => parseFloat(v.replace(/\s/g, '').replace(',', '.'));
const fmtMoney = (v: number) => v.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// step of the ▲▼ arrows, from the quantity they start at: 1.2 → 0.1, 3 → 1, 150 → 10, 0.05 → 0.01
function stepFor(q: number): number {
  if (!(q > 0)) return 1;
  const mag = Math.floor(Math.log10(q));
  if (q < 1) return 10 ** mag;
  return Number.isInteger(q) ? Math.max(1, 10 ** (mag - 1)) : 10 ** (mag - 1);
}
const decimalsOf = (v: number) => {
  const s = String(v);
  return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1]?.length ?? 0);
};

// a quantity field with ▲▼ arrows (held down, they keep going), the keyboard arrows and the mouse wheel
export function QtyStepper({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [step] = useState(() => stepFor(num(value)));
  // the value while an arrow is held down (the next repeat reads it before the re-render)
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  const repeat = useRef<{ t?: number; i?: number }>({});
  const stop = () => { clearTimeout(repeat.current.t); clearInterval(repeat.current.i); repeat.current = {}; };
  useEffect(() => stop, []);

  const bump = (dir: 1 | -1) => {
    const q = num(latest.current);
    const base = Number.isFinite(q) ? q : 0;
    const next = Number((base + dir * step).toFixed(Math.min(8, Math.max(decimalsOf(step), decimalsOf(base)))));
    if (next > 0) { latest.current = String(next); onChange(String(next)); }
  };
  const press = (dir: 1 | -1) => (ev: React.MouseEvent) => {
    ev.preventDefault();
    bump(dir);
    stop();
    repeat.current.t = window.setTimeout(() => { repeat.current.i = window.setInterval(() => bump(dir), 70); }, 400);
    window.addEventListener('mouseup', stop, { once: true });
  };
  return (
    <span className="ct-qty">
      <input
        autoFocus={autoFocus} value={value} onFocus={(ev) => ev.target.select()} onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'ArrowUp') { ev.preventDefault(); bump(1); }
          if (ev.key === 'ArrowDown') { ev.preventDefault(); bump(-1); }
        }}
        onWheel={(ev) => { if (document.activeElement === ev.currentTarget) bump(ev.deltaY < 0 ? 1 : -1); }}
      />
      <span className="ct-step">
        <button type="button" tabIndex={-1} title={`+ ${String(step).replace('.', DEC)}`} onMouseDown={press(1)} onMouseLeave={stop}>▲</button>
        <button type="button" tabIndex={-1} title={`− ${String(step).replace('.', DEC)}`} onMouseDown={press(-1)} onMouseLeave={stop}>▼</button>
      </span>
    </span>
  );
}

// the frame: closes on Échap or a press outside, validates on Entrée
function EditorBox({ at, title, onSave, onClose, children }: {
  at: EditorAt; title: ReactNode; onSave: () => void; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (ev: MouseEvent) => { if (!ref.current?.contains(ev.target as Node)) onClose(); };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [onClose]);
  return (
    <div
      ref={ref} className="ct-edit chart-ui" style={at}
      onMouseDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        // kept here so the chart's own Échap (drop the order being placed) doesn't fire too
        if (ev.key === 'Escape') { ev.stopPropagation(); onClose(); }
        if (ev.key === 'Enter') { ev.stopPropagation(); onSave(); }
      }}
    >
      <div className="ct-edit-title">{title}</div>
      {children}
      <div className="ct-edit-btns">
        <button className="ct-btn ghost" onClick={onClose}>Annuler</button>
        <button className="ct-btn primary" onClick={onSave}>Valider</button>
      </div>
    </div>
  );
}

// quantity of a pending order, with what it risks and aims for at that size
export function QtyEditor({ at, title, qty, riskPerUnit, gainPerUnit, unit, onSave, onClose }: {
  at: EditorAt; title: string; qty: number;
  // money lost at the stop / won at the target for one unit (null: none set)
  riskPerUnit: number | null; gainPerUnit: number | null; unit: string;
  onSave: (qty: number) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(String(qty));
  const [error, setError] = useState('');
  const q = num(value);
  const save = () => {
    if (!(q > 0)) { setError('Quantité invalide'); return; }
    onSave(q);
    onClose();
  };
  return (
    <EditorBox at={at} title={title} onSave={save} onClose={onClose}>
      <label className="ct-edit-row">Quantité
        <QtyStepper autoFocus value={value} onChange={(v) => { setValue(v); setError(''); }} />
      </label>
      {q > 0 && (riskPerUnit != null || gainPerUnit != null) && (
        <div className="ct-edit-note">
          {riskPerUnit != null && <>Stop <b className="down">−{fmtMoney(riskPerUnit * q)} {unit}</b></>}
          {riskPerUnit != null && gainPerUnit != null && ' · '}
          {gainPerUnit != null && <>Limite <b className="up">+{fmtMoney(gainPerUnit * q)} {unit}</b></>}
        </div>
      )}
      {error && <div className="ct-edit-err">{error}</div>}
    </EditorBox>
  );
}

// a stop or target set by its price or by the amount it loses / wins; the other
// one can follow so that the ratio between them stays the same
export function LevelEditor({ at, field, side, entry, qty, sl, tp, rate, unit, prec, last, onSave, onClose }: {
  at: EditorAt; field: 'sl' | 'tp'; side: PaperSide; entry: number; qty: number; sl?: number; tp?: number;
  // money per unit of price for one unit of quantity (the EUR rate)
  rate: number; unit: string; prec: number;
  // an open position: its stop and target must still be ahead of the current price
  last: number | null;
  onSave: (patch: { sl?: number; tp?: number }) => void; onClose: () => void;
}) {
  const s = side === 'long' ? 1 : -1;
  const level = field === 'sl' ? sl : tp;
  const round = (v: number) => Number(v.toFixed(prec));
  const perPrice = qty * rate;
  const amountOf = (lv: number) => Math.abs(lv - entry) * perPrice;
  const levelOf = (amount: number) => round(entry + (field === 'sl' ? -s : s) * amount / perPrice);
  const ratio = sl != null && tp != null && sl !== entry ? Math.abs(tp - entry) / Math.abs(entry - sl) : null;

  const [amount, setAmount] = useState(level != null ? amountOf(level).toFixed(2) : '');
  const [price, setPrice] = useState(level != null ? String(level) : '');
  const [keep, setKeep] = useState(ratio != null);
  const [error, setError] = useState('');

  const lv = num(price);
  const newLevel = Number.isFinite(lv) && lv > 0 ? lv : null;
  const dist = newLevel != null ? Math.abs(newLevel - entry) : null;
  const other = keep && ratio != null && dist != null ? round(entry + (field === 'sl' ? s * ratio : -s / ratio) * dist) : null;
  const otherName = field === 'sl' ? 'la limite' : 'le stop';

  const changeAmount = (v: string) => {
    setAmount(v);
    setError('');
    const a = Math.abs(num(v));
    if (a > 0 && perPrice > 0) setPrice(String(levelOf(a)));
  };
  const changePrice = (v: string) => {
    setPrice(v);
    setError('');
    const p = num(v);
    if (Number.isFinite(p)) setAmount(amountOf(p).toFixed(2));
  };

  const save = () => {
    if (newLevel == null) { setError('Prix invalide'); return; }
    const stop = field === 'sl' ? newLevel : other;
    const target = field === 'tp' ? newLevel : other;
    if (stop != null && (stop - entry) * s >= 0) { setError(`Le stop doit être ${s > 0 ? 'sous' : 'au-dessus de'} l’entrée`); return; }
    if (target != null && (target - entry) * s <= 0) { setError(`La limite doit être ${s > 0 ? 'au-dessus de' : 'sous'} l’entrée`); return; }
    if (last != null && stop != null && (stop - last) * s >= 0) { setError('Ce stop serait déjà touché au cours actuel'); return; }
    if (last != null && target != null && (target - last) * s <= 0) { setError('Cette limite serait déjà atteinte au cours actuel'); return; }
    onSave({ ...(stop != null ? { sl: stop } : {}), ...(target != null ? { tp: target } : {}) });
    onClose();
  };

  return (
    <EditorBox at={at} title={<>{field === 'sl' ? 'Stop' : 'Limite (objectif)'} · {qty} @ {entry.toFixed(prec)}</>} onSave={save} onClose={onClose}>
      <label className="ct-edit-row">{field === 'sl' ? 'Perte' : 'Gain'} ({unit})
        <input autoFocus value={amount} onFocus={(ev) => ev.target.select()} onChange={(ev) => changeAmount(ev.target.value)} />
      </label>
      <label className="ct-edit-row">Prix
        <input value={price} onFocus={(ev) => ev.target.select()} onChange={(ev) => changePrice(ev.target.value)} />
      </label>
      {ratio != null && (
        <label className="ct-edit-check">
          <input type="checkbox" checked={keep} onChange={(ev) => setKeep(ev.target.checked)} />
          <span>
            Garder le ratio {ratio.toFixed(1).replace('.', DEC)} R
            {other != null && <> : {otherName} passe à {other.toFixed(prec)} ({field === 'sl' ? '+' : '−'}{fmtMoney(Math.abs(other - entry) * perPrice)} {unit})</>}
          </span>
        </label>
      )}
      {error && <div className="ct-edit-err">{error}</div>}
    </EditorBox>
  );
}
