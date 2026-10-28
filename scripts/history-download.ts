import fs from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'
import { datasetFiles, idOfFile, mergeNewer, readDataset, readHeader, writeDataset } from './robots/dataset.ts'
import { ibLink } from './ib-relay.ts'

// History downloads started from the "Développeur · Data" tab, run by the dev server into
// robots/data, where the charts and the robot lab read them:
//
//   POST /api/data/download/start  { ticker, market, tf, days, coarser, plan: { source, id, label } }  -> { id }
//   GET  /api/data/download/jobs                                            -> { jobs }
//   POST /api/data/download/cancel?id=
//
// The page picks the source (src/data/downloadPlan.ts) and sends it, with how far back it goes.
// Sources: Binance for crypto, page by page from the oldest bar;
// Interactive Brokers through IB Gateway (read-only historical requests, never an order),
// page by page back from now; Yahoo for the rest, as far as it goes. Binance and IBKR only
// bring what the file lacks: the bars after its last one and before its first. A download is merged
// into dl_<source>_<ticker>_<tf>.bin (bars already there are kept), saved as it goes, and
// optionally rebuilds the coarser timeframes (15 min to 4 h) from the whole file.
// The files carry `platform`, the ticker the charts show them on.

type Job = {
  id: string; ticker: string; market: string; tf: string; source: string; label: string
  from: number; started: number; finished?: number
  state: 'running' | 'done' | 'error' | 'cancelled' | 'queued'
  bars: number; oldest?: number; progress: number; message?: string; files: string[]
  cancel?: boolean
  // the cash index's closes (aligned downloads)
  closes?: CashDay[]
  // what the file already holds (Binance and IBKR bring the rest only)
  have?: { from: number; to: number }
}
type Row = [number, number, number, number, number, number]
type DlPlan = { source: 'binance' | 'ibkr' | 'yahoo'; id: string; label: string; align?: string }
type Start = { ticker?: string; market?: string; tf?: string; days?: number; coarser?: boolean; plan?: Partial<DlPlan> }

const DL_TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
const DL_SECONDS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }
const MARKETS = ['Crypto', 'Forex', 'Commodity', 'Index', 'Stock']

// bars grouped into longer ones, aligned on UTC multiples of `seconds`
function resampleRows(d: Float64Array, seconds: number): Float64Array {
  const out = new Float64Array(d.length)
  let m = 0
  for (let k = 0; k < d.length; k += 6) {
    const t = Math.floor(d[k] / seconds) * seconds
    const last = (m - 1) * 6
    if (m && out[last] === t) {
      out[last + 2] = Math.max(out[last + 2], d[k + 2])
      out[last + 3] = Math.min(out[last + 3], d[k + 3])
      out[last + 4] = d[k + 4]
      out[last + 5] += d[k + 5]
    } else {
      out.set(d.subarray(k, k + 6), m * 6)
      out[m * 6] = t
      m++
    }
  }
  return out.slice(0, m * 6)
}

const DIR = path.resolve('robots/data')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)

const toRows = (bars: Row[]): Float64Array => {
  const out = new Float64Array(bars.length * 6)
  bars.forEach((b, i) => out.set(b, i * 6))
  return out
}
const sortUnique = (bars: Row[]): Row[] => {
  bars.sort((a, b) => a[0] - b[0])
  return bars.filter((b, i) => i === 0 || b[0] !== bars[i - 1][0])
}

// ---------------------------------------------------------------- sources

const BINANCE_TF: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' }

// the stretches of [from, now] the file of the download lacks, with their length for the progress
type Stretch = { from: number; to: number }
function missing(job: Job): Stretch[] {
  const top = now()
  const h = job.have
  if (!h || h.to < job.from || h.from > top) return [{ from: job.from, to: top }]
  const out: Stretch[] = []
  if (h.to < top) out.push({ from: h.to, to: top })
  if (job.from < h.from) out.push({ from: job.from, to: h.from })
  return out
}
const progressOf = (stretches: Stretch[], done: number) => Math.min(1, done / Math.max(1, stretches.reduce((a, s) => a + s.to - s.from, 0)))

// Binance spot klines, 1000 a request, forward through each stretch
async function binance(job: Job, plan: DlPlan, add: (rows: Row[]) => void) {
  const step = DL_SECONDS[job.tf]
  const stretches = missing(job)
  let done = 0
  for (const st of stretches) {
    let start = st.from * 1000
    while (start < st.to * 1000 && !job.cancel) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${plan.id}&interval=${BINANCE_TF[job.tf]}&startTime=${start}&endTime=${st.to * 1000}&limit=1000`
      const r = await fetch(url)
      if (!r.ok) throw new Error(`Binance ${r.status}`)
      const k = (await r.json()) as [number, string, string, string, string, string][]
      if (!k.length) break
      add(k.map((x) => [x[0] / 1000, +x[1], +x[2], +x[3], +x[4], +x[5]]))
      const last = k[k.length - 1][0]
      job.progress = progressOf(stretches, done + (last / 1000 - st.from))
      if (k.length < 1000) break
      start = last + step * 1000
      await sleep(120)
    }
    done += st.to - st.from
  }
}

// IBKR's page per timeframe (the spans the charts use, src/data/feeds/ib.ts)
const IB_SPAN: Record<string, [string, number]> = {
  '1m': ['3 D', 3 * 86400], '5m': ['2 W', 14 * 86400], '15m': ['1 M', 30 * 86400], '30m': ['2 M', 60 * 86400],
  '1h': ['6 M', 182 * 86400], '4h': ['1 Y', 365 * 86400], '1d': ['5 Y', 5 * 365 * 86400],
}

// Interactive Brokers, each stretch back from its end one span at a time, until its start or
// no older bar
async function ibkr(job: Job, plan: DlPlan, add: (rows: Row[]) => void) {
  const stretches = missing(job)
  let done = 0
  for (const st of stretches) {
    if (job.cancel) break
    await ibkrStretch(job, plan, st, add, (at) => { job.progress = progressOf(stretches, done + (st.to - at)) })
    done += st.to - st.from
  }
}
async function ibkrStretch(job: Job, plan: DlPlan, st: Stretch, add: (rows: Row[]) => void, reached: (t: number) => void) {
  const [dur, span] = IB_SPAN[job.tf]
  const link = ibLink()
  const top = now()
  // the most recent stretch asks IBKR for "now", the older one from its end
  let end: number | undefined = st.to >= top - 60 ? undefined : st.to
  let empty = 0
  while (!job.cancel) {
    let candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
    for (let attempt = 0; ; attempt++) {
      try { candles = (await link.bars(plan.id, job.tf, dur, end)).candles; break } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // the gateway closed or missing: no use trying again
        if (attempt >= 2 || /injoignable|perdue/.test(msg)) throw e
        job.message = `${msg} · nouvel essai`
        await sleep(5000)
      }
    }
    job.message = undefined
    const older = candles.filter((c) => end == null || c.time < end)
    if (!older.length) {
      // a page without bars: holidays, or nothing older at IBKR (three in a row)
      if (++empty >= 3) break
      end = (end ?? top) - span
      if (end <= st.from) break
      continue
    }
    empty = 0
    add(older.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]))
    end = older[0].time
    reached(end)
    if (end <= st.from) break
  }
}

const YAHOO_TF: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '4h': '60m', '1d': '1d' }

// Yahoo: what it keeps (1 minute: 8 days a request)
async function yahoo(job: Job, plan: DlPlan, add: (rows: Row[]) => void) {
  const chunk = job.tf === '1m' ? 7 * 86400 : Infinity
  const top = now()
  const from = job.from
  for (let a = from; a < top && !job.cancel; a += chunk) {
    const b = Math.min(top, a + chunk)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(plan.id)}?interval=${YAHOO_TF[job.tf]}&period1=${a}&period2=${b}`
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
    if (!r.ok) throw new Error(`Yahoo ${r.status}`)
    const j = (await r.json()) as { chart: { result?: { timestamp?: number[]; meta?: { gmtoffset?: number }; indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] } }[] } }
    const res = j.chart.result?.[0]
    const q = res?.indicators.quote[0]
    const rows: Row[] = []
    res?.timestamp?.forEach((t, i) => {
      if (!q || q.open[i] == null || q.close[i] == null) return
      // daily bars at 00:00 UTC of their day, like the lab's
      const time = job.tf === '1d' ? Math.floor((t + (res.meta?.gmtoffset ?? 0)) / 86400) * 86400 : t
      rows.push([time, q.open[i]!, q.high[i] ?? q.open[i]!, q.low[i] ?? q.open[i]!, q.close[i]!, q.volume[i] ?? 0])
    })
    add(job.tf === '4h' ? rowsOf(resampleRows(toRows(sortUnique(rows)), 14400)) : rows)
    job.progress = Math.min(1, (b - from) / Math.max(1, top - from))
  }
}
const rowsOf = (d: Float64Array): Row[] => {
  const out: Row[] = []
  for (let i = 0; i < d.length; i += 6) out.push([d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5]])
  return out
}

// ---------------------------------------------------------------- alignment on a cash index

// New York's offset from UTC on a day (hours): 4 in summer time, 5 in winter
const NY_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
const nyOffset = (dayUtc: number) => 12 - Number(NY_HOUR.format(new Date((dayUtc + 12 * 3600) * 1000)))

// a session of the cash index: its close time (UTC, 16:00 New York) and official high, low, close
type CashDay = { close: number; h: number; l: number; c: number }

// the cash index's sessions, oldest first
async function cashCloses(yahooId: string, from: number): Promise<CashDay[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooId)}?interval=1d&period1=${from - 10 * 86400}&period2=${now() + 86400}`
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error(`Yahoo ${r.status} (clôtures de ${yahooId})`)
  const j = (await r.json()) as { chart: { result?: { timestamp?: number[]; meta?: { gmtoffset?: number }; indicators: { quote: { high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] } }[] } }
  const res = j.chart.result?.[0]
  const q = res?.indicators.quote[0]
  const out: CashDay[] = []
  res?.timestamp?.forEach((t, i) => {
    const c = q?.close[i], h = q?.high[i], l = q?.low[i]
    if (c == null || h == null || l == null) return
    const day = Math.floor((t + (res.meta?.gmtoffset ?? 0)) / 86400) * 86400
    out.push({ close: day + (16 + nyOffset(day)) * 3600, h, l, c })
  })
  // today's bar is the last price, not a close, until 16:00 New York
  return out.filter((d) => d.close <= now())
}

const median3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

// the offset of each session: the bars against the cash index over its session (9:30 to 16:00
// New York), the middle one of the three gaps at the high, the low and the close. The close
// alone lies on the days of a big closing auction (index rebalancing: 143 points on the Dow
// on 2026-06-26). A session without its last bar (an early close) gets none. A session runs
// from one close to the next; the bars before the first close known take its offset, those
// after the last one the last offset.
function sessionOffsets(rows: Float64Array, days: CashDay[], step: number): [number, number][] {
  const out: [number, number][] = []
  const n = rows.length / 6
  let k = 0
  for (const d of days) {
    const open = d.close - 6.5 * 3600
    while (k < n && rows[k * 6] < open) k++
    let h = -Infinity, l = Infinity, c = NaN, last = 0
    for (let i = k; i < n && rows[i * 6] < d.close; i++) {
      h = Math.max(h, rows[i * 6 + 2])
      l = Math.min(l, rows[i * 6 + 3])
      c = rows[i * 6 + 4]
      last = rows[i * 6]
    }
    if (!Number.isFinite(c) || d.close - last > step) continue
    out.push([d.close, median3(h - d.h, l - d.l, c - d.c)])
  }
  return out
}

function shifted(rows: Float64Array, offsets: [number, number][]): Float64Array {
  if (!offsets.length) return rows
  const out = rows.slice()
  let s = 0
  for (let k = 0; k < out.length; k += 6) {
    // the session the bar belongs to: the first close after it
    while (s + 1 < offsets.length && out[k] >= offsets[s][0]) s++
    const d = offsets[s][1]
    out[k + 1] -= d; out[k + 2] -= d; out[k + 3] -= d; out[k + 4] -= d
  }
  return out
}

// ---------------------------------------------------------------- jobs

const jobs: Job[] = []
// one IBKR download at a time (its pacing rules), the others side by side
let ibQueue: Promise<void> = Promise.resolve()

const fileId = (source: string, ticker: string, tf: string) => `dl_${source}_${ticker.replace(/[^A-Za-z0-9]/g, '')}_${tf}`

// the bars brought merged into the job's file (the new ones win on the same time). With
// `align` they are moved onto the cash index's closes, the offsets measured on the job's own
// timeframe (an hour at most): only the new bars when the file is already aligned, the whole
// file the first time
// (files aligned before the high / low / close measure said "calé sur": aligned again once)
const ALIGNED = 'calé chaque séance sur'
function save(job: Job, plan: DlPlan, rows: Float64Array): string {
  const id = fileId(plan.source, job.ticker, job.tf)
  const old = datasetFiles(DIR).find((f) => idOfFile(f) === id)
  const prev = old ? readDataset(path.join(DIR, old)) : null
  const before = prev?.rows ?? new Float64Array(0)
  const fresh = !prev || !String(prev.meta.source).includes(ALIGNED)
  let merged: Float64Array
  const offsets = job.closes?.length && DL_SECONDS[job.tf] <= 3600 ? sessionOffsets(fresh ? mergeNewer(before, rows) : rows, job.closes, DL_SECONDS[job.tf]) : []
  const aligned = offsets.length > 0 || (!fresh && !!job.closes?.length)
  if (!offsets.length) merged = mergeNewer(before, rows)
  else if (fresh) merged = shifted(mergeNewer(before, rows), offsets)
  else merged = mergeNewer(before, shifted(rows, offsets))
  write(job, id, job.tf, aligned ? `${plan.label} · ${ALIGNED} ${plan.align}` : plan.label, merged)
  return id
}

const write = (job: Job, id: string, tf: string, source: string, rows: Float64Array) => {
  fs.mkdirSync(DIR, { recursive: true })
  writeDataset(path.join(DIR, `${id}.bin`), { id, market: job.market, source, symbol: job.ticker, platform: job.ticker, tf }, rows)
}

// the coarser timeframes, rebuilt from the whole file of the job's timeframe (aligned or not
// like it); bars of an older coarse file beyond that span are kept
function saveCoarser(job: Job, plan: DlPlan, finest: string): string[] {
  const { meta, rows } = readDataset(path.join(DIR, `${finest}.bin`))
  const out: string[] = []
  for (const tf of DL_TFS) {
    const s = DL_SECONDS[tf]
    // days excepted: the sessions' own days differ from UTC days
    if (tf === '1d' || s <= DL_SECONDS[job.tf] || s % DL_SECONDS[job.tf]) continue
    const id = fileId(plan.source, job.ticker, tf)
    const old = datasetFiles(DIR).find((f) => idOfFile(f) === id)
    const before = old ? readDataset(path.join(DIR, old)).rows : new Float64Array(0)
    write(job, id, tf, meta.source, mergeNewer(before, resampleRows(rows, s)))
    out.push(id)
  }
  return out
}

async function run(job: Job, plan: DlPlan, coarser: boolean) {
  const got: Row[] = []
  let savedAt = Date.now()
  const flush = () => {
    if (!got.length) return
    save(job, plan, toRows(sortUnique([...got])))
    savedAt = Date.now()
  }
  const add = (rows: Row[]) => {
    for (const r of rows) {
      if (!r.every(Number.isFinite) || !(r[4] > 0)) continue
      got.push(r)
      if (r[0] < (job.oldest ?? Infinity)) job.oldest = r[0]
    }
    job.bars = got.length
    // what came so far is on disk every half minute: a stopped server loses little
    if (Date.now() - savedAt > 30_000) flush()
  }
  try {
    job.state = 'running'
    const file = datasetFiles(DIR).find((f) => idOfFile(f) === fileId(plan.source, job.ticker, job.tf))
    if (file?.endsWith('.bin')) { const { meta } = readHeader(path.join(DIR, file)); if (meta.bars) job.have = { from: meta.from, to: meta.to } }
    // the whole history of closes: a short download re-aligns all the file holds
    if (plan.align) job.closes = await cashCloses(plan.align, Date.UTC(1990, 0, 1) / 1000)
    if (plan.source === 'binance') await binance(job, plan, add)
    else if (plan.source === 'ibkr') await ibkr(job, plan, add)
    else await yahoo(job, plan, add)
    const rows = toRows(sortUnique(got))
    // (an aligned file is measured again even when nothing new came)
    if (rows.length || (plan.align && job.have)) {
      const finest = save(job, plan, rows)
      job.files.push(finest)
      if (coarser) job.files.push(...saveCoarser(job, plan, finest))
    }
    job.state = job.cancel ? 'cancelled' : 'done'
    job.progress = job.cancel ? job.progress : 1
    if (!rows.length && !job.cancel) job.message = 'aucune barre reçue'
  } catch (e) {
    flush()
    job.state = 'error'
    job.message = e instanceof Error ? e.message : String(e)
  }
  job.finished = Date.now()
}

function start(body: Start): Job {
  const ticker = String(body.ticker ?? '')
  if (!/^[A-Za-z0-9.^=_-]{1,24}$/.test(ticker)) throw new Error('actif inconnu')
  const tf = body.tf ?? ''
  if (!DL_TFS.includes(tf)) throw new Error('unité inconnue')
  const market = MARKETS.includes(body.market ?? '') ? body.market! : 'Stock'
  const p = body.plan ?? {}
  if (!p.source || !['binance', 'ibkr', 'yahoo'].includes(p.source) || !p.id || !/^[A-Za-z0-9.^=:_-]{1,40}$/.test(p.id)) throw new Error(`aucune source de téléchargement pour ${ticker}`)
  const align = p.align && /^\^?[A-Za-z0-9.=-]{1,20}$/.test(p.align) ? p.align : undefined
  const plan: DlPlan = { source: p.source, id: p.id, label: String(p.label ?? p.id).slice(0, 80), align }
  const days = Math.min(Number(body.days) || 365, 60 * 365)
  const job: Job = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ticker, market, tf, source: plan.source, label: plan.label,
    from: now() - Math.floor(days * 86400), started: Date.now(), state: 'queued', bars: 0, progress: 0, files: [],
  }
  jobs.unshift(job)
  jobs.splice(30)
  if (plan.source === 'ibkr') ibQueue = ibQueue.then(() => (job.cancel ? undefined : run(job, plan, body.coarser !== false)))
  else void run(job, plan, body.coarser !== false)
  return job
}

export function historyDownload(): Plugin {
  const json = (res: Parameters<Connect.NextHandleFunction>[1], status: number, v: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(v))
  }
  const handle: Connect.NextHandleFunction = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    try {
      if (req.method === 'GET' && url.pathname === '/jobs') {
        json(res, 200, { jobs: jobs.map(({ cancel: _c, closes: _cl, ...j }) => ({ ...j, oldest: Number.isFinite(j.oldest) ? j.oldest : undefined })) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/start') {
        const parts: Buffer[] = []
        for await (const c of req) parts.push(c as Buffer)
        const job = start(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
        json(res, 200, { id: job.id })
        return
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        const job = jobs.find((j) => j.id === url.searchParams.get('id'))
        if (job) { job.cancel = true; if (job.state === 'queued') { job.state = 'cancelled'; job.finished = Date.now() } }
        json(res, 200, { ok: !!job })
        return
      }
      json(res, 404, { error: 'inconnu' })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const mount = (server: { middlewares: Connect.Server }) => { server.middlewares.use('/api/data/download', handle) }
  return { name: 'history-download', configureServer: mount, configurePreviewServer: mount }
}
