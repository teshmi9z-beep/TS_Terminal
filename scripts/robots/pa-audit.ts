import fs from 'node:fs';
import path from 'node:path';
import { COLS, readDataset } from './dataset';

// The price-action study (2026-11-11): which files cover 2020 → now without holes.
const DATA = path.resolve('robots/data');
const FROM = Date.UTC(2020, 0, 1) / 1000;
const want = process.argv.slice(2);
const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
for (const pat of want) {
  const re = new RegExp(pat);
  for (const f of fs.readdirSync(DATA).filter((x) => re.test(x)).sort()) {
    const { rows } = readDataset(path.join(DATA, f));
    const n = rows.length / COLS;
    let k = 0, first = 0, last = 0, vol = 0;
    const holes: string[] = [];
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const t = rows[i * COLS];
      if (t < FROM) continue;
      if (!k) first = t;
      else if (t - prev > 6 * 86400) holes.push(`${d(prev)}→${d(t)}`);
      prev = t; last = t; k++;
      if (rows[i * COLS + 5] > 0) vol++;
    }
    console.log(`${f.padEnd(34)} ${String(k).padStart(8)} ${k ? d(first) : '-'} → ${k ? d(last) : '-'} vol ${k ? Math.round((100 * vol) / k) : 0}% ${holes.length ? 'TROUS ' + holes.slice(0, 6).join(' ') : ''}`);
  }
}
