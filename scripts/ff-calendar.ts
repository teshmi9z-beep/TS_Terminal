import fs from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'

// ForexFactory's weekly economic calendar (the "Calendrier" page), fetched by the server and kept
// on disk (robots/cache/calendrier, never copied). Their export answers about once per five minutes
// per address and blocks anything more ("429 Too Many Requests"), and the file only changes once an
// hour: so the server fetches it at most every 30 minutes, waits as long as a refusal asks, and in
// the meantime serves the last copy it has. GET /ffcal/ff_calendar_thisweek.json
const SOURCE = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const FILE = path.resolve('robots/cache/calendrier/ff_calendar_thisweek.json')
const FRESH = 30 * 60_000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

let copy: { at: number; body: string } | null = null
let blockedUntil = 0
let pending: Promise<void> | null = null
let lastError = ''

function loadDisk() {
  if (copy) return
  try {
    const at = fs.statSync(FILE).mtimeMs
    copy = { at, body: fs.readFileSync(FILE, 'utf8') }
  } catch { /* no copy yet */ }
}

async function refresh() {
  try {
    const r = await fetch(SOURCE, { headers: { 'user-agent': UA, accept: 'application/json' } })
    if (!r.ok) {
      const wait = Number(r.headers.get('retry-after'))
      blockedUntil = Date.now() + (wait > 0 ? wait * 1000 : 5 * 60_000)
      lastError = `ForexFactory ${r.status}`
      return
    }
    const body = await r.text()
    if (!Array.isArray(JSON.parse(body))) throw new Error('réponse inattendue')
    copy = { at: Date.now(), body }
    lastError = ''
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, body)
  } catch (e) {
    // network down or a page instead of the file: try again in a minute
    blockedUntil = Date.now() + 60_000
    lastError = `ForexFactory : ${e instanceof Error ? e.message : String(e)}`
  }
}

const serve: Connect.NextHandleFunction = async (_req, res) => {
  loadDisk()
  if ((!copy || Date.now() - copy.at > FRESH) && Date.now() >= blockedUntil) {
    pending ??= refresh().finally(() => { pending = null })
    await pending
  }
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  if (copy) {
    res.setHeader('x-copy-age', String(Math.round((Date.now() - copy.at) / 1000)))
    res.end(copy.body)
    return
  }
  res.statusCode = 503
  res.end(JSON.stringify({ error: lastError || 'ForexFactory indisponible' }))
}

export function ffCalendar(): Plugin {
  const mount = (server: { middlewares: Connect.Server }) => { server.middlewares.use('/ffcal/ff_calendar_thisweek.json', serve) }
  return { name: 'ff-calendar', configureServer: mount, configurePreviewServer: mount }
}
