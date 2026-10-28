// Treemap layout shared by the heatmaps

export type Rect = { x: number; y: number; w: number; h: number };

// squarified treemap (Bruls, Huizing, van Wijk)
export function squarify<T>(items: { value: number; item: T }[], r: Rect): (Rect & { item: T })[] {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total || r.w <= 0 || r.h <= 0) return [];
  const scale = (r.w * r.h) / total;
  let rest = items.map((i) => ({ ...i, area: i.value * scale }));
  const out: (Rect & { item: T })[] = [];
  let box = { ...r };
  const worst = (row: typeof rest, side: number) => {
    const s = row.reduce((a, i) => a + i.area, 0);
    const max = Math.max(...row.map((i) => i.area)), min = Math.min(...row.map((i) => i.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  while (rest.length) {
    const side = Math.min(box.w, box.h);
    let row = [rest[0]];
    for (let i = 1; i < rest.length; i++) {
      const next = [...row, rest[i]];
      if (worst(next, side) <= worst(row, side)) row = next; else break;
    }
    const area = row.reduce((a, i) => a + i.area, 0);
    if (box.w >= box.h) {
      const w = area / box.h;
      let y = box.y;
      for (const it of row) { const h = it.area / w; out.push({ x: box.x, y, w, h, item: it.item }); y += h; }
      box = { x: box.x + w, y: box.y, w: box.w - w, h: box.h };
    } else {
      const h = area / box.w;
      let x = box.x;
      for (const it of row) { const w = it.area / h; out.push({ x, y: box.y, w, h, item: it.item }); x += w; }
      box = { x: box.x, y: box.y + h, w: box.w, h: box.h - h };
    }
    rest = rest.slice(row.length);
  }
  return out;
}

