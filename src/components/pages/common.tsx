import { useState, type ReactNode } from 'react';
import { tvLogo } from '../../data/tv';

// logo of a TradingView symbol (initials when there is none)
export function TvLogo({ logoid, text, size = 24 }: { logoid: string | null | undefined; text: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!logoid || failed) {
    return <span className="pg-logo pg-logo-txt" style={{ width: size, height: size, fontSize: size * 0.4 }}>{text.slice(0, 2)}</span>;
  }
  return <img className="pg-logo" src={tvLogo(logoid)} alt="" width={size} height={size} onError={() => setFailed(true)} />;
}

// title row of a tool page
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pg-head">
      <h1>{title}</h1>
      <div className="pg-head-tools">{children}</div>
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="pg-chips">
      {options.map(([id, label]) => (
        <button key={id} className={`pg-chip ${value === id ? 'active' : ''}`} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

export function Loading({ text = 'Chargement…' }: { text?: string }) {
  return <div className="pg-empty"><span className="spinner" /> {text}</div>;
}
