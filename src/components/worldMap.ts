import { geoPath, geoProjection, type GeoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
import worldUrl from 'world-atlas/countries-110m.json?url';
import { LANG } from '../i18n/lang';

// World map shared by the yield curves and Macro Maps panels: world-atlas
// countries (Natural Earth 1:110m), Miller projection, no Antarctica.

export type Country = Feature<Geometry, { name: string }>;

// ISO 3166 numeric (world-atlas ids) -> alpha-2, generated from the ISO table
const NUMERIC = '242FJ,834TZ,732EH,124CA,840US,398KZ,860UZ,598PG,360ID,032AR,152CL,180CD,706SO,404KE,729SD,148TD,332HT,214DO,643RU,044BS,238FK,578NO,304GL,260TF,626TL,710ZA,426LS,484MX,858UY,076BR,068BO,604PE,170CO,591PA,188CR,558NI,340HN,222SV,320GT,084BZ,862VE,328GY,740SR,250FR,218EC,630PR,388JM,192CU,716ZW,072BW,516NA,686SN,466ML,478MR,204BJ,562NE,566NG,120CM,768TG,288GH,384CI,324GN,624GW,430LR,694SL,854BF,140CF,178CG,266GA,226GQ,894ZM,454MW,508MZ,748SZ,024AO,108BI,376IL,422LB,450MG,275PS,270GM,788TN,012DZ,400JO,784AE,634QA,414KW,368IQ,512OM,548VU,116KH,764TH,418LA,104MM,704VN,408KP,410KR,496MN,356IN,050BD,064BT,524NP,586PK,004AF,762TJ,417KG,795TM,364IR,760SY,051AM,752SE,112BY,804UA,616PL,040AT,348HU,498MD,642RO,440LT,428LV,233EE,276DE,100BG,300GR,792TR,008AL,191HR,756CH,442LU,056BE,528NL,620PT,724ES,372IE,540NC,090SB,554NZ,036AU,144LK,156CN,158TW,380IT,208DK,826GB,352IS,031AZ,268GE,608PH,458MY,096BN,705SI,246FI,703SK,203CZ,232ER,392JP,600PY,887YE,682SA,010AQ,196CY,504MA,818EG,434LY,231ET,262DJ,800UG,646RW,070BA,807MK,688RS,499ME,780TT,728SS';
const NUM_TO_A2 = new Map(NUMERIC.split(',').map((x) => [x.slice(0, 3), x.slice(3)]));

// alpha-2 of a map feature (Kosovo has no ISO numeric id in world-atlas)
export function countryCode(f: Country): string | undefined {
  if (f.id != null) return NUM_TO_A2.get(String(f.id));
  return f.properties.name === 'Kosovo' ? 'XK' : undefined;
}

// Miller cylindrical projection (TradingView-like world map)
const miller = (lambda: number, phi: number): [number, number] => [lambda, 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi))];

let worldPromise: Promise<Country[]> | null = null;
export function loadWorld(): Promise<Country[]> {
  worldPromise ??= fetch(worldUrl)
    .then((r) => r.json() as Promise<Topology<{ countries: GeometryCollection<{ name: string }> }>>)
    .then((topo) => (feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>).features
      // no Antarctica, as on TradingView
      .filter((f) => f.id !== '010'));
  worldPromise.catch(() => { worldPromise = null; });
  return worldPromise;
}

// projected paths fitted to a width; the height follows the map's proportions
export function projectWorld(world: Country[], width: number): { paths: { f: Country; d: string }[]; height: number; path: GeoPath } {
  const collection: FeatureCollection<Geometry, { name: string }> = { type: 'FeatureCollection', features: world };
  const projection = geoProjection(miller).fitWidth(width - 8, collection);
  const path = geoPath(projection);
  const [[, y0], [, y1]] = path.bounds(collection);
  projection.translate([projection.translate()[0] + 4, projection.translate()[1] - y0 + 4]);
  return { paths: world.map((f) => ({ f, d: path(f) ?? '' })), height: Math.ceil(y1 - y0 + 8), path };
}

// French country names ('EU' is the euro area, as on TradingView)
const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames([LANG], { type: 'region' }) : null;
export function frenchCountryName(code: string, fallback?: string): string {
  if (code === 'EU') return 'Zone euro';
  try { return names?.of(code) ?? fallback ?? code; } catch { return fallback ?? code; }
}

export const flagUrl = (code: string) => `https://flagcdn.com/w40/${code.toLowerCase()}.png`;

// PNG download of an SVG (map / chart) at twice its size
export function downloadSvgAsPng(svg: SVGSVGElement, background: string, filename: string) {
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
}
