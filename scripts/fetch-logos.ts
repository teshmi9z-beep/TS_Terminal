import fs from 'node:fs'
import path from 'node:path'
import { SYMBOLS } from '../src/data/symbols.ts'
import { logoFileName, logoKeyOfFile } from '../src/data/logoName.ts'

// Downloads the small company / coin logos shown next to each symbol (watchlist, search,
// tabs...) into public/logos, so they show offline and load at once:
//
//   node scripts/fetch-logos.ts                 every stock and crypto of the catalog
//   node scripts/fetch-logos.ts SPCX NOK.OL     plus these extra stocks (Yahoo symbols)
//   node scripts/fetch-logos.ts --force         download again the ones already there
//
// Stocks: Parqet first (square logos, like TradingView's), then Financial Modeling Prep.
// Crypto: CoinCap's icons, then the spothq set. A symbol with no logo anywhere keeps its
// coloured initials. The list of files is written to src/data/logoFiles.ts; symbols outside
// it fetch their logo from the same sites when shown (src/components/SymbolLogo.tsx).

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'public', 'logos')
const LIST = path.join(ROOT, 'src', 'data', 'logoFiles.ts')

const args = process.argv.slice(2)
const force = args.includes('--force')
const extra = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase())

// listings the logo sites only know under another symbol (ArcelorMittal: Amsterdam; FDJ United: its old ticker)
const STOCK_ALIAS: Record<string, string> = { 'MT.PA': 'MT.AS', 'FDJU.PA': 'FDJ.PA' }

// tickers Parqet still shows under their former owner (SPCX: the old AXS SPAC ETF, now SpaceX)
const FMP_FIRST = new Set(['SPCX'])

const stockSources = (y: string) => {
  const urls = [
    `https://assets.parqet.com/logos/symbol/${encodeURIComponent(y)}?format=png&size=64`,
    `https://financialmodelingprep.com/image-stock/${encodeURIComponent(y)}.png`,
  ]
  return FMP_FIRST.has(y) ? urls.reverse() : urls
}
const cryptoSources = (base: string) => [
  `https://assets.coincap.io/assets/icons/${base.toLowerCase()}@2x.png`,
  `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${base.toLowerCase()}.png`,
  `https://cdn.jsdelivr.net/gh/ErikThiart/cryptocurrency-icons@master/32/${base.toLowerCase()}.png`,
]

// key = file path under public/logos without .png, as SymbolLogo builds it
const jobs = new Map<string, string[]>()
for (const s of SYMBOLS) {
  if (s.category === 'Actions') { const y = s.yahoo ?? s.ticker; jobs.set(`stocks/${y}`, stockSources(STOCK_ALIAS[y] ?? y)) }
  if (s.category === 'Crypto' && /USDT?$/.test(s.ticker)) { const b = s.ticker.replace(/USDT?$/, ''); jobs.set(`crypto/${b}`, cryptoSources(b)) }
}
for (const y of extra) jobs.set(`stocks/${y}`, stockSources(STOCK_ALIAS[y] ?? y))

async function fetchPng(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    const b = Buffer.from(await r.arrayBuffer())
    // a real image only (PNG, or WebP that CoinCap sometimes serves; the browser reads either
    // under .png): some sites answer an HTML page or an empty body for unknown symbols
    const png = b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const webp = b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
    return b.length > 64 && (png || webp) ? b : null
  } catch { return null }
}

fs.mkdirSync(path.join(OUT, 'stocks'), { recursive: true })
fs.mkdirSync(path.join(OUT, 'crypto'), { recursive: true })

const missing: string[] = []
let got = 0, kept = 0
const queue = [...jobs]
async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const [key, urls] = job
    const [dir, name] = key.split('/')
    const file = path.join(OUT, dir, `${logoFileName(name)}.png`)
    if (!force && fs.existsSync(file)) { kept++; continue }
    let png: Buffer | null = null
    for (const u of urls) if ((png = await fetchPng(u))) break
    if (png) { fs.writeFileSync(file, png); got++ } else missing.push(key)
  }
}
await Promise.all(Array.from({ length: 8 }, worker))

// the list SymbolLogo reads: every file present, also those from earlier runs
const keys = ['stocks', 'crypto'].flatMap((dir) =>
  fs.readdirSync(path.join(OUT, dir)).filter((f) => f.endsWith('.png')).map((f) => `${dir}/${logoKeyOfFile(f.slice(0, -4))}`)).sort()
fs.writeFileSync(LIST,
  '// written by scripts/fetch-logos.ts: the logos stored in public/logos (key = path without .png)\n' +
  `export const LOGO_FILES: string[] = ${JSON.stringify(keys, null, 0).replace(/","/g, '", "')};\n`)

console.log(`${got} downloaded, ${kept} already there, ${keys.length} in all`)
if (missing.length) console.log(`no logo found: ${missing.sort().join(' ')}`)
