import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin, type ProxyOptions } from 'vite'
import { ibRelay } from './scripts/ib-relay.ts'
import { historyDownload } from './scripts/history-download.ts'
import { datasetFiles, idOfFile, mergeNewer, readDataset, readHeader, readPage, writeDataset, type DatasetMeta } from './scripts/robots/dataset.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

// strips the browser-only headers (origin, referer, cookies) that make the
// upstream APIs reject or rate-limit a relayed request
const cleanRequest: ProxyOptions['configure'] = (proxy) => {
  proxy.on('proxyReq', (req) => {
    req.removeHeader('origin')
    req.removeHeader('referer')
    req.removeHeader('cookie')
    req.setHeader('user-agent', UA)
  })
}

// Yahoo Finance does not send CORS headers, so the browser can't call it directly:
// the dev/preview server relays /yf/* to it
const yahooProxy: ProxyOptions = {
  target: 'https://query1.finance.yahoo.com',
  changeOrigin: true,
  rewrite: (p) => p.replace(/^\/yf/, ''),
  configure: cleanRequest,
}

// OpenFIGI (Bloomberg's free identifier API) for the FIGI of a symbol
const figiProxy: ProxyOptions = {
  target: 'https://api.openfigi.com',
  changeOrigin: true,
  rewrite: (p) => p.replace(/^\/figi/, ''),
  configure: cleanRequest,
}

// TradingView's public screener: government bond yields for the yield curves panel
const tvScanProxy: ProxyOptions = {
  target: 'https://scanner.tradingview.com',
  changeOrigin: true,
  rewrite: (p) => p.replace(/^\/tvscan/, ''),
  configure: cleanRequest,
}

const relay = (target: string, prefix: string): ProxyOptions => ({
  target,
  changeOrigin: true,
  rewrite: (p) => p.replace(new RegExp(`^${prefix}`), ''),
  configure: cleanRequest,
})
// TradingView news (list, and the text of a story), community scripts (search,
// source of open scripts), and the ForexFactory economic calendar feed
const tvNewsProxy = relay('https://news-mediator.tradingview.com', '/tvnews')
const tvStoryProxy = relay('https://news-headlines.tradingview.com', '/tvstory')
const tvWebProxy = relay('https://www.tradingview.com', '/tvweb')
const tvPineProxy = relay('https://pine-facade.tradingview.com', '/tvpine')
const ffProxy = relay('https://nfs.faireconomy.media', '/ffcal')
// Nasdaq's company data: the last four earnings (date reported, EPS, consensus) of US listings,
// for the chart's earnings marks
const nasdaqProxy = relay('https://api.nasdaq.com', '/nasdaq')
// MEXC and BingX futures (no CORS header): history of the perpetuals behind the futures estimate
const mexcProxy = relay('https://contract.mexc.com', '/mexc')
const bingxProxy = relay('https://open-api.bingx.com', '/bingx')

// Yahoo's company profile (quoteSummary) and option chain endpoints need a
// session cookie plus a "crumb" token. The server gets them once, caches them,
// and serves /api/yinfo?symbol=XXX and /api/yoptions?symbol=XXX&date=UNIX to the app, and
// /api/yearnings?symbol=XXX: the dates of a company's earnings (with EPS estimate and actual).
function yahooInfo(): Plugin {
  let auth: { cookie: string; crumb: string; at: number } | null = null

  async function getAuth(force: boolean) {
    if (auth && !force && Date.now() - auth.at < 30 * 60_000) return auth
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual' })
    const cookies = r1.headers.getSetCookie?.() ?? [r1.headers.get('set-cookie') ?? '']
    const cookie = cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'user-agent': UA, cookie } })
    const crumb = (await r2.text()).trim()
    if (!r2.ok || !crumb || crumb.includes('<')) throw new Error(`crumb Yahoo indisponible (${r2.status})`)
    auth = { cookie, crumb, at: Date.now() }
    return auth
  }

  // relays the Yahoo URL built from the query string, with the session
  const relayWith = (build: (q: URLSearchParams) => string | null): Connect.NextHandleFunction => async (req, res) => {
    res.setHeader('content-type', 'application/json')
    try {
      const target = build(new URL(req.url ?? '', 'http://local').searchParams)
      if (!target) { res.statusCode = 400; res.end('{"error":"symbol manquant"}'); return }
      for (const force of [false, true]) {
        const a = await getAuth(force)
        const url = `${target}${target.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(a.crumb)}`
        const r = await fetch(url, { headers: { 'user-agent': UA, cookie: a.cookie } })
        if ((r.status === 401 || r.status === 403) && !force) continue
        res.statusCode = r.status
        res.end(await r.text())
        return
      }
    } catch (e) {
      res.statusCode = 502
      res.end(JSON.stringify({ error: String(e) }))
    }
  }
  const info = relayWith((q) => {
    const symbol = q.get('symbol')
    return symbol ? `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,quoteType,price,summaryProfile` : null
  })
  const options = relayWith((q) => {
    const symbol = q.get('symbol'), date = q.get('date')
    return symbol ? `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}${date ? `?date=${encodeURIComponent(date)}` : ''}` : null
  })
  // Yahoo's earnings calendar (its "visualization" API, a POST with the session)
  const earnings: Connect.NextHandleFunction = async (req, res) => {
    res.setHeader('content-type', 'application/json')
    try {
      const symbol = new URL(req.url ?? '', 'http://local').searchParams.get('symbol')
      if (!symbol) { res.statusCode = 400; res.end('{"error":"symbol manquant"}'); return }
      const body = JSON.stringify({
        sortType: 'DESC', entityIdType: 'earnings', sortField: 'startdatetime', offset: 0, size: 100,
        includeFields: ['ticker', 'eventname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct'],
        query: { operator: 'eq', operands: ['ticker', symbol] },
      })
      for (const force of [false, true]) {
        const a = await getAuth(force)
        const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/visualization?crumb=${encodeURIComponent(a.crumb)}&lang=en-US&region=US`, {
          method: 'POST', headers: { 'user-agent': UA, cookie: a.cookie, 'content-type': 'application/json' }, body,
        })
        if ((r.status === 401 || r.status === 403) && !force) continue
        res.statusCode = r.status
        res.end(await r.text())
        return
      }
    } catch (e) {
      res.statusCode = 502
      res.end(JSON.stringify({ error: String(e) }))
    }
  }
  const mount = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use('/api/yinfo', info)
    server.middlewares.use('/api/yoptions', options)
    server.middlewares.use('/api/yearnings', earnings)
  }

  return { name: 'yahoo-info', configureServer: mount, configurePreviewServer: mount }
}

// The robot lab's history on disk (robots/data, format in scripts/robots/dataset.ts),
// for the "Développeur · Data" tab and the charts. GET /api/data/lab lists every file
// (symbol, timeframe, first and last bar); GET /api/data/lab/bars?id= sends one file's
// bars as raw float64 rows; GET /api/data/lab/page?id=&before=&limit= only the last
// `limit` bars before a time (the charts' older pages); POST /api/data/lab/import?symbol=&market=&tf= merges imported bars
// (same rows) into robots/data/import_<symbol>_<tf>.bin; DELETE /api/data/lab?id=
// removes an imported file.
const LAB_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
const LAB_MARKETS = ['Crypto', 'Forex', 'Commodity', 'Index', 'Stock']
type LabEntry = DatasetMeta & {
  file: string; size: number; mtime: number
  // Yahoo's 1h files: the lab also builds 4h bars from them
  bars4h?: number; derived?: boolean
}

function labData(): Plugin {
  const DIR = path.resolve('robots/data')
  const INDEX = path.resolve('robots/.data-index.json')
  let cache: Record<string, LabEntry> | null = null

  // a .bin file says it all in its header; a .json one is read through
  const describe = (file: string, st: fs.Stats): LabEntry => {
    const full = path.join(DIR, file)
    if (file.endsWith('.bin')) return { ...readHeader(full).meta, file, size: st.size, mtime: st.mtimeMs }
    const { meta, rows } = readDataset(full)
    const e: LabEntry = { ...meta, file, size: st.size, mtime: st.mtimeMs }
    if (/^yahoo_.*_1h$/.test(meta.id)) {
      const slots = new Set<number>()
      for (let k = 0; k < rows.length; k += 6) slots.add(Math.floor(rows[k] / 14400))
      e.bars4h = slots.size
    }
    return e
  }

  // every file, read once and then remembered by size and date
  function list(): LabEntry[] {
    if (!cache) {
      try { cache = JSON.parse(fs.readFileSync(INDEX, 'utf8')) } catch { cache = {} }
    }
    const index = cache!
    const files = datasetFiles(DIR)
    let dirty = false
    const out: LabEntry[] = []
    for (const file of files) {
      const st = fs.statSync(path.join(DIR, file))
      let e = index[file]
      if (!e || e.size !== st.size || e.mtime !== st.mtimeMs) {
        try { e = describe(file, st) } catch { continue }
        index[file] = e
        dirty = true
      }
      out.push(e)
      if (e.bars4h) out.push({ ...e, id: e.id.replace(/_1h$/, '_4h'), tf: '4h', bars: e.bars4h, bars4h: undefined, derived: true })
    }
    for (const f of Object.keys(index)) if (!files.includes(f)) { delete index[f]; dirty = true }
    if (dirty) fs.writeFileSync(INDEX, JSON.stringify(index))
    return out
  }
  const fileOf = (id: string) => (/^[A-Za-z0-9_.=^-]+$/.test(id) ? datasetFiles(DIR).find((f) => idOfFile(f) === id) : undefined)

  const body = (req: IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
  const json = (res: ServerResponse, status: number, v: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(v))
  }

  const handle: Connect.NextHandleFunction = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const q = url.searchParams
    try {
      if (req.method === 'GET' && url.pathname === '/') { json(res, 200, { dir: 'robots/data', entries: list() }); return }
      if (req.method === 'GET' && url.pathname === '/bars') {
        const file = fileOf(q.get('id') ?? '')
        if (!file) { json(res, 404, { error: 'fichier inconnu' }); return }
        const full = path.join(DIR, file)
        res.setHeader('content-type', 'application/octet-stream')
        const { meta, offset } = file.endsWith('.bin') ? readHeader(full) : { meta: null, offset: 0 }
        if (meta && !meta.scale) {
          // float64 rows: as they are on disk, after the header
          res.setHeader('content-length', String(meta.bars * 48))
          fs.createReadStream(full, { start: offset }).on('error', () => res.destroy()).pipe(res)
          return
        }
        const { rows } = readDataset(full)
        res.end(Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength))
        return
      }
      if (req.method === 'GET' && url.pathname === '/page') {
        const file = fileOf(q.get('id') ?? '')
        if (!file) { json(res, 404, { error: 'fichier inconnu' }); return }
        const before = Number(q.get('before') || Infinity)
        const limit = Math.min(100_000, Math.max(1, Math.floor(Number(q.get('limit')) || 1500)))
        const rows = readPage(path.join(DIR, file), Number.isNaN(before) ? Infinity : before, limit)
        res.setHeader('content-type', 'application/octet-stream')
        res.end(Buffer.from(rows.buffer, rows.byteOffset, rows.byteLength))
        return
      }
      if (req.method === 'POST' && url.pathname === '/import') {
        const symbol = (q.get('symbol') ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '')
        const market = q.get('market') ?? '', tf = q.get('tf') ?? ''
        if (!symbol || symbol.length > 20 || !LAB_MARKETS.includes(market) || !LAB_TFS.includes(tf)) { json(res, 400, { error: 'symbole, classe ou unité invalide' }); return }
        const buf = await body(req)
        if (buf.length % 48) { json(res, 400, { error: 'données tronquées' }); return }
        const d = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length))
        const add = new Float64Array(d.length)
        let n = 0
        for (let i = 0; i < d.length; i += 6) if (Number.isFinite(d[i]) && Number.isFinite(d[i + 4])) { add.set(d.subarray(i, i + 6), n * 6); n++ }
        const id = `import_${symbol}_${tf}`
        const old = fileOf(id)
        const before = old ? readDataset(path.join(DIR, old)).rows : new Float64Array(0)
        // merged with the bars already imported (the new ones win on the same time)
        const rows = mergeNewer(before, add.subarray(0, n * 6))
        fs.mkdirSync(DIR, { recursive: true })
        const meta = writeDataset(path.join(DIR, `${id}.bin`), { id, market, source: 'Import', symbol, tf }, rows)
        if (old?.endsWith('.json')) fs.unlinkSync(path.join(DIR, old))
        json(res, 200, { id, bars: meta.bars, added: meta.bars - before.length / 6 })
        return
      }
      if (req.method === 'DELETE' && url.pathname === '/') {
        const id = q.get('id') ?? ''
        // only what was imported here: the downloaded files come back with the next update anyway
        const file = /^import_[A-Z0-9.]+_\w+$/.test(id) ? fileOf(id) : undefined
        if (!file) { json(res, 400, { error: 'seuls les fichiers importés se suppriment ici' }); return }
        fs.unlinkSync(path.join(DIR, file))
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'inconnu' })
    } catch (e) {
      json(res, 500, { error: String(e) })
    }
  }
  const mount = (server: { middlewares: Connect.Server }) => { server.middlewares.use('/api/data/lab', handle) }
  return { name: 'lab-data', configureServer: mount, configurePreviewServer: mount }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), yahooInfo(), labData(), ibRelay(), historyDownload()],
  server: { proxy: { '/yf': yahooProxy, '/figi': figiProxy, '/tvscan': tvScanProxy, '/tvnews': tvNewsProxy, '/tvstory': tvStoryProxy, '/tvweb': tvWebProxy, '/tvpine': tvPineProxy, '/ffcal': ffProxy, '/nasdaq': nasdaqProxy, '/mexc': mexcProxy, '/bingx': bingxProxy } },
  preview: { proxy: { '/yf': yahooProxy, '/figi': figiProxy, '/tvscan': tvScanProxy, '/tvnews': tvNewsProxy, '/tvstory': tvStoryProxy, '/tvweb': tvWebProxy, '/tvpine': tvPineProxy, '/ffcal': ffProxy, '/nasdaq': nasdaqProxy, '/mexc': mexcProxy, '/bingx': bingxProxy } },
})
