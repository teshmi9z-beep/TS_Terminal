import type { Connect, Plugin } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BarSizeSetting, EventName, IBApi, SecType, WhatToShow, type Contract } from '@stoqey/ib'

// Relay to Interactive Brokers through the IB Gateway (or TWS) running on this computer, for
// the charts and the watchlist. Read-only: it only asks for contract data, historical bars
// and quotes, and never sends an order (the gateway's "Read-Only API" option blocks them too).
//
//   GET /api/ib/bars?id=CFD:IBUS30:SMART:USD&bar=15m&dur=1 M[&end=unix]  -> { candles }
//   GET /api/ib/quotes?ids=id1,id2                                          -> { [id]: { last, bid, ask, prevClose, live } }
//   GET /api/ib/warm?ids=id1,id2&bar=15m&dur=1 M                            -> { queued } (first pages loaded in the background)
//
// An id is "secType:symbol:exchange:currency", plus the trading class for a future
// ("FUT:DAX:EUREX:EUR:FDAX"). A FUT id is the front month stitched from the real contracts,
// each one up to its last trading day: real prices, like TradingView's DAX1! (IBKR's own
// continuous future, CONTFUT, is back-adjusted and can't be paged back).
// Without a market data subscription IBKR sends delayed prices (15 minutes for index CFDs, 10
// for CME futures): `live` says which one it is.
// The gateway is looked for on IB_PORT (one port or a comma-separated list), by default on
// IB Gateway's ports (4001 live login, 4002 paper trading) then TWS's (7496, 7497).

const PORTS = (process.env.IB_PORT ?? '4001,4002,7496,7497').split(',').map(Number).filter((p) => p > 0)
// one client id per server process and per restart of it, so two Vite servers (dev and
// preview) can both connect and a restarted server never collides with its old connection
// (the counter lives on globalThis: a restart loads this module afresh)
const CLIENT_BASE = Number(process.env.IB_CLIENT_ID ?? 100 + (process.pid % 800))
const shared = globalThis as { __ibLinks?: number }
const SEC_TYPES = new Set<string>([SecType.CFD, SecType.FUT, SecType.CONTFUT, SecType.IND, SecType.CASH, SecType.STK])

// the platform's bar names -> IBKR's
const BARS: Record<string, BarSizeSetting> = {
  '1m': BarSizeSetting.MINUTES_ONE, '2m': BarSizeSetting.MINUTES_TWO, '3m': BarSizeSetting.MINUTES_THREE,
  '5m': BarSizeSetting.MINUTES_FIVE, '10m': BarSizeSetting.MINUTES_TEN, '15m': BarSizeSetting.MINUTES_FIFTEEN,
  '20m': BarSizeSetting.MINUTES_TWENTY, '30m': BarSizeSetting.MINUTES_THIRTY, '1h': BarSizeSetting.HOURS_ONE,
  '2h': BarSizeSetting.HOURS_TWO, '3h': BarSizeSetting.HOURS_THREE, '4h': BarSizeSetting.HOURS_FOUR,
  '8h': BarSizeSetting.HOURS_EIGHT, '1d': BarSizeSetting.DAYS_ONE, '1w': BarSizeSetting.WEEKS_ONE, '1M': BarSizeSetting.MONTHS_ONE,
}
const STEPS: Record<string, number> = {
  '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900, '20m': 1200, '30m': 1800, '1h': 3600,
  '2h': 7200, '3h': 10800, '4h': 14400, '8h': 28800, '1d': 86400, '1w': 604800, '1M': 2678400,
}
// The bars received, kept on disk by contract and bar size (robots/cache/ib, never copied): a
// chart opened again asks IBKR only for the bars since its last one. IBKR takes 5 to 70 s for a
// first page (a month of 15-minute bars of a stitched future), well under a second for the
// bars of the last hours.
const CACHE_DIR = resolve('robots/cache/ib')
// bars kept per series, the oldest dropped first
const CACHE_BARS = 50_000
// the warmed series brought up to date at most this often
const WARM_FRESH = 5 * 60_000
// '1M' (months) and '1m' (minutes) are one file name on Windows
const cacheFile = (key: string) => join(CACHE_DIR, `${key.replace('|1M', '|month').replace(/[^\w.-]+/g, '_')}.json`)
// a short request for the bars since `secs` ago (IBKR wants at least two bars' duration)
function tailDur(secs: number, step: number): string {
  const s = Math.max(secs, 2 * step)
  if (step < 86400 && s <= 86400) return `${Math.ceil(s)} S`
  if (step <= 86400) return `${Math.ceil(s / 86400) + 1} D`
  if (step <= 604800) return `${Math.ceil(s / 604800) + 1} W`
  return `${Math.ceil(s / 2678400) + 1} M`
}

// warnings the gateway sends with a request id without failing the request
const isWarning = (code: number) => (code >= 2100 && code < 2200) || code === 10167 || code === 10090

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number }
type Pending = { rows: Bar[]; resolve: (rows: Bar[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type Details = { rows: Contract[]; resolve: (rows: Contract[]) => void; reject: (e: Error) => void }
type Quote = { bid?: number; ask?: number; last?: number; prevClose?: number; live: boolean; reqId: number; readAt: number }
// one contract of a stitched future: its bars from `from` (the previous contract's roll) to `to`
type Leg = { contract: Contract; from: number; to: number }
// the bars kept of one contract and bar size: complete from `from` to the last one; `topped`: when
// they were last brought up to now (ms)
type Series = { from: number; bars: Bar[]; topped: number; saving?: ReturnType<typeof setTimeout> }

function contractOf(id: string): Contract {
  const [secType, symbol, exchange, currency, tradingClass] = id.split(':')
  if (!SEC_TYPES.has(secType) || !symbol || !exchange || !currency) throw new Error(`identifiant IBKR invalide : ${id}`)
  return { secType: secType as SecType, symbol, exchange, currency, ...(tradingClass ? { tradingClass } : {}) }
}

// "20260928" for daily bars and above, epoch seconds as text below
function barTime(t: string): number {
  if (/^\d{8}$/.test(t)) return Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) / 1000
  return Number(t)
}

// IBKR's end time, in UTC: "20260928-18:30:00"
function ibTime(unix: number): string {
  const d = new Date(unix * 1000).toISOString()
  return `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-${d.slice(11, 19)}`
}

const UNIT: Record<string, number> = { S: 1, D: 86400, W: 7 * 86400, M: 31 * 86400, Y: 366 * 86400 }
const durSeconds = (dur: string) => Number(dur.split(' ')[0]) * UNIT[dur.split(' ')[1]]

// a contract rolls to the next one at 00:00 UTC on its last trading day ("20261218 13:00:00 MET")
function rollTime(last: string): number {
  const d = last.slice(0, 8)
  return /^\d{8}$/.test(d) ? Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 1000 : 0
}

class IbLink {
  private api: IBApi | null = null
  private ready: Promise<IBApi> | null = null
  private nextId = 1000
  private pending = new Map<number, Pending>()
  private details = new Map<number, Details>()
  private quotes = new Map<string, Quote>()
  private quoteIds = new Map<number, string>()
  // identical historical requests within 15 s break IBKR's pacing rules: short-lived cache
  private recent = new Map<string, { at: number; rows: Promise<Bar[]> }>()
  // the contracts of each stitched future (checked every 6 hours)
  private chains = new Map<string, { at: number; legs: Promise<Leg[]> }>()
  // the bars kept of each contract and bar size (read from disk on first use), and the first
  // pages being asked from IBKR
  private series = new Map<string, Promise<Series>>()
  private loading = new Map<string, Promise<Bar[]>>()
  // the first pages to load in the background, one at a time
  private warmQueue: { id: string; bar: string; dur: string }[] = []
  private warming = false
  private clientId = CLIENT_BASE + 1000 * (shared.__ibLinks = (shared.__ibLinks ?? 0) + 1)
  // the port that answered last, tried first next time
  private port = 0

  private connect(): Promise<IBApi> {
    this.ready ??= this.openAny().catch((e: Error) => { this.ready = null; throw e })
    return this.ready
  }

  private async openAny(): Promise<IBApi> {
    for (const port of new Set([this.port, ...PORTS].filter((p) => p > 0))) {
      try {
        const api = await this.open(port)
        this.port = port
        return api
      } catch { /* nothing on this port: the next one */ }
    }
    throw new Error(`IB Gateway injoignable (ports ${PORTS.join(', ')}) : est-il lancé et connecté ?`)
  }

  private open(port: number): Promise<IBApi> {
    return new Promise<IBApi>((resolve, reject) => {
      const api = new IBApi({ host: '127.0.0.1', port, clientId: this.clientId })
      let opened = false
      const giveUp = () => { clearTimeout(timer); try { api.disconnect() } catch { /* closed */ } reject(new Error(`rien sur le port ${port}`)) }
      const timer = setTimeout(giveUp, 6000)
      api.once(EventName.nextValidId, () => {
        opened = true
        clearTimeout(timer)
        this.api = api
        // delayed prices when there is no subscription, real-time ones as soon as there is
        api.reqMarketDataType(3)
        resolve(api)
      })
      // an old connection's events never touch the current one
      api.on(EventName.disconnected, () => { if (!opened) giveUp(); else if (this.api === api) this.drop() })
      api.on(EventName.error, (err: Error, code: number, reqId: number) => this.onError(err, code, reqId))
      api.on(EventName.historicalData, (reqId: number, time: string, open: number, high: number, low: number, close: number, volume: number) => {
        const p = this.pending.get(reqId)
        if (!p) return
        // the last row is "finished-<start>-<end>"
        if (time.startsWith('finished')) this.finish(reqId)
        else if (open > 0) p.rows.push({ time: barTime(time), open, high, low, close, volume: Math.max(0, volume) })
      })
      api.on(EventName.contractDetails, (reqId: number, d: { contract: Contract }) => this.details.get(reqId)?.rows.push(d.contract))
      api.on(EventName.contractDetailsEnd, (reqId: number) => {
        const w = this.details.get(reqId)
        if (!w) return
        this.details.delete(reqId)
        w.resolve(w.rows)
      })
      api.on(EventName.marketDataType, (reqId: number, type: number) => {
        const q = this.quoteOf(reqId)
        if (q) q.live = type === 1
      })
      api.on(EventName.tickPrice, (reqId: number, field: number, price: number) => {
        const q = this.quoteOf(reqId)
        if (!q || !(price > 0)) return
        // real-time / delayed tick types: bid 1/66, ask 2/67, last 4/68, previous close 9/75
        if (field === 1 || field === 66) q.bid = price
        else if (field === 2 || field === 67) q.ask = price
        else if (field === 4 || field === 68) q.last = price
        else if (field === 9 || field === 75) q.prevClose = price
      })
      api.connect()
    })
  }

  private drop() {
    const lost = new Error('connexion à IB Gateway perdue')
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(lost) }
    this.pending.clear()
    for (const [, w] of this.details) w.reject(lost)
    this.details.clear()
    this.chains.clear()
    this.quotes.clear()
    this.quoteIds.clear()
    try { this.api?.disconnect() } catch { /* already closed */ }
    this.api = null
    this.ready = null
  }

  private quoteOf(reqId: number) {
    const id = this.quoteIds.get(reqId)
    return id ? this.quotes.get(id) : undefined
  }

  private onError(err: Error, code: number, reqId: number) {
    if (isWarning(code)) return
    const w = this.details.get(reqId)
    if (w) { this.details.delete(reqId); w.reject(new Error(`IBKR ${code} : ${err?.message ?? err}`)); return }
    const p = this.pending.get(reqId)
    if (p) {
      this.pending.delete(reqId)
      clearTimeout(p.timer)
      // "no data" for a period before the first bar: an empty page, not a failure
      // (the gateway speaks the user's language: English or French)
      if (code === 162 && /no data|aucune donn/i.test(err?.message ?? '')) p.resolve([])
      else p.reject(new Error(`IBKR ${code} : ${err?.message ?? err}`))
      return
    }
    const qid = this.quoteIds.get(reqId)
    if (qid) { this.quoteIds.delete(reqId); this.quotes.delete(qid) }
  }

  private finish(reqId: number) {
    const p = this.pending.get(reqId)
    if (!p) return
    this.pending.delete(reqId)
    clearTimeout(p.timer)
    p.resolve(p.rows.sort((a, b) => a.time - b.time))
  }

  close() {
    if (this.api) this.drop()
  }

  async bars(id: string, bar: string, dur: string, end?: number): Promise<{ candles: Bar[] }> {
    const size = BARS[bar]
    if (!size) throw new Error(`unité IBKR inconnue : ${bar}`)
    if (!/^\d+ [SDWMY]$/.test(dur)) throw new Error(`durée IBKR invalide : ${dur}`)
    contractOf(id)
    const key = `${id}|${bar}|${dur}|${end ?? ''}`
    const hit = this.recent.get(key)
    if (hit && Date.now() - hit.at < 15_000) return { candles: await hit.rows }
    const rows = this.kept(id, bar, dur, end)
    this.recent.set(key, { at: Date.now(), rows })
    for (const [k, v] of this.recent) if (Date.now() - v.at > 60_000) this.recent.delete(k)
    try {
      return { candles: await rows }
    } catch (e) {
      this.recent.delete(key)
      throw e
    }
  }

  // the bars of [end - dur, end), up to now without `end`: the kept ones when they cover the
  // period, only the bars since the last one asked from IBKR
  private async kept(id: string, bar: string, dur: string, end?: number, waited = false): Promise<Bar[]> {
    const key = `${id}|${bar}`
    const step = STEPS[bar]
    const s = await this.stored(key)
    const now = Math.floor(Date.now() / 1000)
    const from = Math.min(end ?? now, now) - durSeconds(dur)
    const to = end ?? Infinity
    const slice = () => s.bars.filter((b) => b.time >= from && b.time < to)
    const last = s.bars[s.bars.length - 1]
    if (last && from >= s.from && last.time >= from) {
      if (end !== undefined && end <= last.time) return slice()
      // the last bar kept was still forming: asked again with the newer ones
      const tail = await this.fetch(id, bar, tailDur(now - last.time + step, step))
      // in place of the kept ones from its first bar, or after the last kept when it starts later
      this.merge(key, s, tail, tail.length && tail[0].time <= last.time ? tail[0].time : last.time + 1, Infinity)
      s.topped = Date.now()
      return slice()
    }
    // a first page already asked (a background load, another chart): its bars, then the newer ones
    const busy = end === undefined && !waited ? this.loading.get(key) : undefined
    if (busy) {
      await busy.catch(() => undefined)
      return this.kept(id, bar, dur, end, true)
    }
    const rows = this.fetch(id, bar, dur, end)
    if (end === undefined) {
      this.loading.set(key, rows)
      rows.catch(() => undefined).finally(() => { if (this.loading.get(key) === rows) this.loading.delete(key) })
    }
    const got = await rows
    this.merge(key, s, got, from, to)
    if (end === undefined) s.topped = Date.now()
    return got
  }

  // one request to IBKR; a future is stitched from its contracts
  private fetch(id: string, bar: string, dur: string, end?: number): Promise<Bar[]> {
    const contract = contractOf(id)
    return contract.secType === SecType.FUT ? this.stitched(id, BARS[bar], dur, end) : this.request(contract, BARS[bar], dur, end)
  }

  // the bars of [from, to) put in place of the kept ones there; a period apart from the kept bars
  // replaces them when newer, and is not kept when older
  private merge(key: string, s: Series, rows: Bar[], from: number, to: number) {
    if (!rows.length) return
    const lo = Math.min(from, rows[0].time)
    const hi = Math.max(to, rows[rows.length - 1].time + 1)
    const last = s.bars[s.bars.length - 1]
    if (!last || lo > last.time + STEPS[key.split('|')[1]]) {
      s.bars = rows
      s.from = lo
    } else if (hi >= s.from) {
      s.bars = [...s.bars.filter((b) => b.time < lo), ...rows, ...s.bars.filter((b) => b.time >= hi)]
      s.from = Math.min(s.from, lo)
    } else return
    if (s.bars.length > CACHE_BARS) {
      s.bars = s.bars.slice(-CACHE_BARS)
      s.from = s.bars[0].time
    }
    this.save(key, s)
  }

  private stored(key: string): Promise<Series> {
    let s = this.series.get(key)
    if (!s) {
      s = readFile(cacheFile(key), 'utf8')
        .then((text): Series => {
          const j = JSON.parse(text) as { from: number; bars: number[][] }
          return { from: j.from, bars: j.bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume })), topped: 0 }
        })
        .catch((): Series => ({ from: Infinity, bars: [], topped: 0 }))
      this.series.set(key, s)
    }
    return s
  }

  // written half a minute after a change (the live bars change at each poll); bars lost when the
  // server stops before are asked again with the next ones
  private save(key: string, s: Series) {
    if (s.saving) return
    s.saving = setTimeout(() => {
      s.saving = undefined
      const bars = s.bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume])
      mkdir(CACHE_DIR, { recursive: true })
        .then(() => writeFile(cacheFile(key), JSON.stringify({ from: s.from, bars })))
        .catch((e) => console.warn('[ib] cache :', e instanceof Error ? e.message : e))
    }, 30_000)
  }

  // first pages loaded in the background for the charts likely opened next (the markets of a
  // list): one request at a time, a series brought up to date in the last minutes skipped
  warm(ids: string[], bar: string, dur: string): number {
    if (!BARS[bar] || !/^\d+ [SDWMY]$/.test(dur)) throw new Error('préchargement IBKR invalide')
    let queued = 0
    for (const id of ids) {
      contractOf(id)
      if (this.warmQueue.some((w) => w.id === id && w.bar === bar)) continue
      this.warmQueue.push({ id, bar, dur })
      queued++
    }
    void this.runWarm()
    return queued
  }

  private async runWarm() {
    if (this.warming) return
    this.warming = true
    try {
      for (let w = this.warmQueue.shift(); w; w = this.warmQueue.shift()) {
        const s = await this.stored(`${w.id}|${w.bar}`)
        if (Date.now() - s.topped < WARM_FRESH) continue
        try { await this.bars(w.id, w.bar, w.dur) } catch { /* the chart says it when opened */ }
        // IBKR paces the historical requests: a pause between two
        await new Promise((r) => setTimeout(r, 1000))
      }
    } finally {
      this.warming = false
    }
  }

  private async request(contract: Contract, size: BarSizeSetting, dur: string, end?: number): Promise<Bar[]> {
    const api = await this.connect()
    const what = contract.secType === SecType.CFD || contract.secType === SecType.CASH ? WhatToShow.MIDPOINT : WhatToShow.TRADES
    const reqId = this.nextId++
    return new Promise<Bar[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(reqId)) return
        try { api.cancelHistoricalData(reqId) } catch { /* gone */ }
        reject(new Error('IBKR ne répond pas (historique)'))
      }, 60_000)
      this.pending.set(reqId, { rows: [], resolve, reject, timer })
      // useRTH 0: every session (23 h a day for the index CFDs and futures); formatDate 2: epoch seconds
      api.reqHistoricalData(reqId, contract, end ? ibTime(end) : '', dur, size, what, 0, 2, false)
    })
  }

  private async contracts(c: Contract): Promise<Contract[]> {
    const api = await this.connect()
    const reqId = this.nextId++
    return new Promise<Contract[]>((resolve, reject) => {
      this.details.set(reqId, { rows: [], resolve, reject })
      api.reqContractDetails(reqId, c)
    })
  }

  // the contracts of a stitched future, expired ones included (IBKR keeps about a year of them)
  private legs(id: string): Promise<Leg[]> {
    const hit = this.chains.get(id)
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.legs
    const c = contractOf(id)
    const legs = this.contracts({ ...c, includeExpired: true }).then((list) => {
      const rows = list
        .filter((k) => !c.tradingClass || k.tradingClass === c.tradingClass)
        .map((k) => ({ contract: { conId: k.conId, exchange: k.exchange, includeExpired: true } as Contract, to: rollTime(k.lastTradeDateOrContractMonth ?? '') }))
        .filter((l) => l.to > 0)
        .sort((a, b) => a.to - b.to)
      if (!rows.length) throw new Error(`aucun contrat IBKR pour ${id}`)
      // the oldest contract known was the front month for one contract's span before it, not forever
      const first = rows.length > 1 ? rows[1].to - rows[0].to : 92 * 86400
      return rows.map((l, i): Leg => ({ ...l, from: i ? rows[i - 1].to : l.to - first }))
    })
    legs.catch(() => this.chains.delete(id))
    this.chains.set(id, { at: Date.now(), legs })
    return legs
  }

  // the bars of each contract over its own stretch of the requested period, oldest first
  private async stitched(id: string, size: BarSizeSetting, dur: string, end?: number): Promise<Bar[]> {
    const now = Math.floor(Date.now() / 1000)
    const to = Math.min(end ?? now, now)
    const from = to - durSeconds(dur)
    const out: Bar[] = []
    for (const leg of await this.legs(id)) {
      const a = Math.max(from, leg.from), b = Math.min(to, leg.to)
      if (a >= b) continue
      const days = Math.min(365, Math.ceil((b - a) / 86400) + 1)
      const rows = await this.request(leg.contract, size, `${days} D`, b >= now ? undefined : b)
      for (const r of rows) if (r.time >= a && r.time < b) out.push(r)
    }
    return out
  }

  // the contract to quote: a future is its front month
  private async quoted(id: string): Promise<Contract> {
    const c = contractOf(id)
    if (c.secType === SecType.FUT) {
      const now = Date.now() / 1000
      const front = (await this.legs(id)).find((l) => l.to > now)
      if (!front) throw new Error(`pas d'échéance en cours pour ${id}`)
      return { conId: front.contract.conId, exchange: front.contract.exchange }
    }
    if (c.secType === SecType.CONTFUT) {
      const [k] = await this.contracts(c)
      if (!k?.conId) throw new Error('contrat IBKR introuvable')
      return { conId: k.conId, exchange: k.exchange }
    }
    return c
  }

  // quotes stream once asked for, and stop two minutes after the last read
  async quote(ids: string[]): Promise<Record<string, Omit<Quote, 'reqId' | 'readAt'>>> {
    const api = await this.connect()
    const now = Date.now()
    const out: Record<string, Omit<Quote, 'reqId' | 'readAt'>> = {}
    for (const id of ids) {
      let q = this.quotes.get(id)
      if (!q) {
        const reqId = this.nextId++
        q = { live: false, reqId, readAt: now }
        this.quotes.set(id, q)
        this.quoteIds.set(reqId, id)
        this.quoted(id).then((c) => { if (this.quotes.get(id)?.reqId === reqId) api.reqMktData(reqId, c, '', false, false) })
          .catch(() => { this.quotes.delete(id); this.quoteIds.delete(reqId) })
      }
      q.readAt = now
      const mid = q.bid && q.ask ? (q.bid + q.ask) / 2 : undefined
      out[id] = { bid: q.bid, ask: q.ask, last: q.last ?? mid, prevClose: q.prevClose, live: q.live }
    }
    for (const [id, q] of this.quotes) {
      if (now - q.readAt < 120_000) continue
      try { api.cancelMktData(q.reqId) } catch { /* gone */ }
      this.quotes.delete(id)
      this.quoteIds.delete(q.reqId)
    }
    return out
  }
}

// the server's one link to the gateway, shared by the relay and the history downloads
// (scripts/history-download.ts)
let current: IbLink | null = null
export function ibLink(): Pick<IbLink, 'bars'> {
  current ??= new IbLink()
  return current
}

export function ibRelay(): Plugin {
  const link = (current ??= new IbLink())
  const json = (res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const handler: Connect.NextHandleFunction = async (req, res) => {
    const url = new URL(req.url ?? '', 'http://local')
    const q = url.searchParams
    try {
      if (url.pathname === '/bars') {
        const end = q.get('end') ? Number(q.get('end')) : undefined
        json(res, 200, await link.bars(q.get('id') ?? '', q.get('bar') ?? '', q.get('dur') ?? '', end))
      } else if (url.pathname === '/quotes') {
        const ids = (q.get('ids') ?? '').split(',').filter(Boolean).slice(0, 50)
        json(res, 200, await link.quote(ids))
      } else if (url.pathname === '/warm') {
        const ids = (q.get('ids') ?? '').split(',').filter(Boolean).slice(0, 30)
        json(res, 200, { queued: link.warm(ids, q.get('bar') ?? '', q.get('dur') ?? '') })
      } else json(res, 404, { error: 'inconnu' })
    } catch (e) {
      json(res, 503, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const mount = (server: { middlewares: Connect.Server }) => { server.middlewares.use('/api/ib', handler) }
  // a restarted dev server (config edited) drops its old connection
  return { name: 'ib-relay', configureServer: mount, configurePreviewServer: mount, closeBundle: () => { link.close(); current = null } }
}
