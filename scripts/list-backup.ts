import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Connect, Plugin } from 'vite'

// The watchlists and the indicator templates kept on disk, so that no browser mishap (its data
// cleared, a list closed by mistake) loses them: sauvegardes/listes/AAAA-MM-JJ_<browser>.json, the day's last state of each
// browser (one file a day each, so another browser opened on the platform never writes over yours;
// 60 days kept), and AAAA-MM-JJ_<browser>_HHMM_avant-restauration.json, the lists as they were before
// a restore. The main window posts its lists a few seconds after each change (src/components/listBackup.ts).
// POST /api/backup/lists?client=<browser>[&label=avant-restauration] { watchlists } · GET /api/backup/lists
// (the files) · GET /api/backup/lists/file?name= (one of them)
const DIR = path.resolve('sauvegardes/listes')
const KEEP_DAYS = 60
const MAX_BODY = 8 * 1024 * 1024

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// (files of 2026-10-30 morning have no browser id)
const FILE = /^\d{4}-\d{2}-\d{2}(_[a-z0-9]{1,12})?(_\d{4}_avant-restauration)?\.json$/

type Tab = { id?: unknown; name?: unknown; items?: unknown }
// what a file holds, for the list of backups (the indicator templates came along on 2026-10-30)
function summary(lists: Tab[], templates?: unknown) {
  const symbols = lists.reduce((n, t) => n + (Array.isArray(t.items) ? t.items.filter((r: { kind?: string }) => r?.kind === 'asset').length : 0), 0)
  return { lists: lists.length, symbols, names: lists.map((t) => String(t.name ?? '')), templates: Array.isArray(templates) ? templates.length : 0 }
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('trop gros')); req.destroy() } else parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

// the files older than KEEP_DAYS go
function prune() {
  const limit = dayOf(new Date(Date.now() - KEEP_DAYS * 86400_000))
  for (const f of fs.readdirSync(DIR)) if (FILE.test(f) && f.slice(0, 10) < limit) fs.unlinkSync(path.join(DIR, f))
}

export function listBackup(): Plugin {
  const json = (res: Parameters<Connect.NextHandleFunction>[1], status: number, v: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(v))
  }
  const handle: Connect.NextHandleFunction = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    try {
      if (req.method === 'POST' && url.pathname === '/') {
        const data = JSON.parse(await body(req)) as { watchlists?: unknown; indicatorTemplates?: unknown }
        const lists = data.watchlists
        const templates = Array.isArray(data.indicatorTemplates) ? data.indicatorTemplates : []
        if (!Array.isArray(lists) || !lists.length) { json(res, 400, { error: 'aucune liste' }); return }
        // an empty set of lists is never written over a real one
        if (summary(lists as Tab[]).symbols === 0) { json(res, 200, { skipped: true }); return }
        fs.mkdirSync(DIR, { recursive: true })
        const now = new Date()
        const client = url.searchParams.get('client') ?? ''
        if (!/^[a-z0-9]{1,12}$/.test(client)) { json(res, 400, { error: 'navigateur inconnu' }); return }
        const label = url.searchParams.get('label') === 'avant-restauration'
        const base = `${dayOf(now)}_${client}`
        const name = label ? `${base}_${pad(now.getHours())}${pad(now.getMinutes())}_avant-restauration.json` : `${base}.json`
        const text = JSON.stringify({ savedAt: now.getTime(), watchlists: lists, indicatorTemplates: templates }, null, 1)
        const full = path.join(DIR, name)
        // the same lists and templates as the file already holds: nothing to write
        const old = fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) as { watchlists?: unknown; indicatorTemplates?: unknown } : null
        const same = !!old && JSON.stringify(old.watchlists) === JSON.stringify(lists) && JSON.stringify(old.indicatorTemplates ?? []) === JSON.stringify(templates)
        if (!same) fs.writeFileSync(full, text)
        prune()
        json(res, 200, { name, written: !same })
        return
      }
      if (req.method === 'GET' && url.pathname === '/') {
        if (!fs.existsSync(DIR)) { json(res, 200, { dir: 'sauvegardes/listes', files: [] }); return }
        // the newest first
        const files = fs.readdirSync(DIR).filter((f) => FILE.test(f)).map((f) => {
          const full = path.join(DIR, f)
          try {
            const d = JSON.parse(fs.readFileSync(full, 'utf8')) as { savedAt?: number; watchlists?: Tab[]; indicatorTemplates?: unknown }
            const client = /^\d{4}-\d{2}-\d{2}_([a-z0-9]{1,12})(_|\.json)/.exec(f)?.[1] ?? null
            return { name: f, savedAt: d.savedAt ?? fs.statSync(full).mtimeMs, client, beforeRestore: f.includes('avant-restauration'), ...summary(d.watchlists ?? [], d.indicatorTemplates) }
          } catch {
            return null
          }
        }).filter((x) => x !== null).sort((a, b) => b.savedAt - a.savedAt)
        json(res, 200, { dir: 'sauvegardes/listes', files })
        return
      }
      if (req.method === 'GET' && url.pathname === '/file') {
        const name = url.searchParams.get('name') ?? ''
        if (!FILE.test(name) || !fs.existsSync(path.join(DIR, name))) { json(res, 404, { error: 'sauvegarde inconnue' }); return }
        res.setHeader('content-type', 'application/json')
        res.end(fs.readFileSync(path.join(DIR, name)))
        return
      }
      json(res, 404, { error: 'inconnu' })
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const mount = (server: { middlewares: Connect.Server }) => { server.middlewares.use('/api/backup/lists', handle) }
  return { name: 'list-backup', configureServer: mount, configurePreviewServer: mount }
}
