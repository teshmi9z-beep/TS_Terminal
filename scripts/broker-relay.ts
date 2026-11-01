import type { Connect, Plugin } from 'vite'
import type { IncomingMessage } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Relay to the broker the platform trades through, picked from the "Trader" menu like TradingView's
// "Tradez avec votre courtier": IG, on two separate relays that never share a session.
// - /api/broker: IG's demo server.
// - /api/broker-live: IG's live server (real money). Its sign-in needs `realMoney: true` (the box the
//   user ticks in the login) and its login is never kept on disk: typed again at each start.
// The browser never sees the API key nor the password: they stay in this server, and on disk only
// when "Rester connecté" is ticked for the demo, in the user's profile (never in the platform's folder,
// which is copied and published). The guards (Garde-fous: size, risk, daily loss...) are checked by the
// platform before an order reaches here (components/brokerAccount.ts).
//
//   GET  /api/broker/status                 -> { broker, live, account, error } (account null when not connected)
//   POST /api/broker/connect                { apiKey, identifier, password, remember }
//   POST /api/broker/disconnect
//   GET  /api/broker/snapshot[?history=1]   -> { account, positions, orders, history }
//   GET  /api/broker/search?q=US 500        -> the markets IG finds
//   GET  /api/broker/market?epic=           -> one market's price and dealing rules
//   GET  /api/broker/quotes?epics=a,b       -> the prices of several markets (one request to IG)
//   GET  /api/broker/prices?epic=&res=MINUTE&max=300 -> IG's bars { candles, allowance } (kept on disk)
//   GET  /api/broker/lists[?id=]            -> IG's lists of markets (popular, indices, forex...), or one list's markets
//   POST /api/broker/order                  { epic, side, size, type, level?, stopDistance?, limitDistance? }
//   POST /api/broker/amend                  { dealId, sl, tp }   a position's stop / target (IG levels)
//   POST /api/broker/amend-order            { dealId, level, type, stopDistance, limitDistance }
//   POST /api/broker/close                  { dealId }
//   POST /api/broker/cancel                 { dealId }
// Every order waits for IG's confirmation of the deal and answers with it.

const IG_DEMO = 'https://demo-api.ig.com/gateway/deal'
const IG_LIVE = 'https://api.ig.com/gateway/deal'
// the demo login kept by "Rester connecté" (the live one never is)
const SAVED = join(homedir(), '.plateforme-maison', 'ig-demo.json')

// accountId: the CFD account to trade, when the login's default account is another kind (Turbo24...)
type Login = { apiKey: string; identifier: string; password: string; accountId?: string }
type Direction = 'BUY' | 'SELL'
type IgSession = { accounts?: { accountId: string; accountName: string; accountType: string }[]; currentAccountId?: string; currencyIsoCode?: string }
type IgAccount = { accountId: string; accountName: string; accountType?: string; currency?: string; balance?: { balance: number; profitLoss: number; available: number } }
type IgMarket = { epic: string; instrumentName: string; instrumentType: string; expiry: string; bid: number | null; offer: number | null; marketStatus: string; scalingFactor?: number }
type IgPosition = {
  position: { dealId: string; size: number; direction: Direction; level: number; stopLevel: number | null; limitLevel: number | null; currency: string; contractSize?: number; createdDateUTC?: string }
  market: IgMarket
}
type IgWorking = {
  workingOrderData: { dealId: string; direction: Direction; epic: string; orderSize: number; orderLevel: number; orderType: string; stopDistance: number | null; limitDistance: number | null; currencyCode: string; createdDateUTC?: string }
  marketData: IgMarket
}
type IgTransaction = { dateUtc?: string; openDateUtc?: string; instrumentName: string; profitAndLoss: string; reference: string; openLevel: string; closeLevel: string; size: string; currency: string }
type IgDetails = {
  instrument: { epic: string; name: string; currencies?: { code: string; isDefault: boolean }[]; contractSize?: string | number }
  dealingRules?: { minDealSize?: { value: number }; minNormalStopOrLimitDistance?: { unit: string; value: number } }
  snapshot?: { bid: number | null; offer: number | null; marketStatus: string; scalingFactor?: number; decimalPlacesFactor?: number; delayTime?: number }
}
// IG's bars (/prices, version 3) and the platform's (time in seconds, mid prices)
type IgPrice = { bid: number | null; ask: number | null; lastTraded: number | null }
type IgBar = { snapshotTimeUTC: string; openPrice: IgPrice; highPrice: IgPrice; lowPrice: IgPrice; closePrice: IgPrice; lastTradedVolume: number | null }
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number }
const IG_RES: Record<string, number> = {
  MINUTE: 60, MINUTE_2: 120, MINUTE_3: 180, MINUTE_5: 300, MINUTE_10: 600, MINUTE_15: 900, MINUTE_30: 1800,
  HOUR: 3600, HOUR_2: 7200, HOUR_3: 10800, HOUR_4: 14400, DAY: 86400, WEEK: 604800, MONTH: 2_592_000,
}
const PRICES_DIR = join(homedir(), '.plateforme-maison', 'ig-prices')
const mid = (p: IgPrice) => (p.bid != null && p.ask != null ? (p.bid + p.ask) / 2 : p.bid ?? p.ask)
function toBar(p: IgBar): Bar | null {
  const [o, h, l, c] = [mid(p.openPrice), mid(p.highPrice), mid(p.lowPrice), mid(p.closePrice)]
  if (o == null || h == null || l == null || c == null) return null
  return { time: Math.floor(Date.parse(`${p.snapshotTimeUTC}Z`) / 1000), open: o, high: h, low: l, close: c, volume: p.lastTradedVolume ?? 0 }
}
// IG's dates in its requests: 2026-10-30T13:05:00 (UTC)
const igTime = (t: number) => new Date(t * 1000).toISOString().slice(0, 19)
type IgConfirm = { dealStatus: 'ACCEPTED' | 'REJECTED'; reason: string; dealId: string; level: number | null; size: number | null; direction: Direction | null; epic: string }

// IG's error codes the user can act on; the others are shown as they come
const ERRORS: Record<string, string> = {
  'error.security.invalid-details': 'Identifiant ou mot de passe refusé par IG (les identifiants démo de l’API)',
  'error.security.api-key-invalid': 'Clé API refusée : elle doit venir de l’onglet « Compte de démo » des clés API',
  'error.security.api-key-missing': 'Clé API manquante',
  'error.security.api-key-disabled': 'Clé API désactivée chez IG',
  'error.security.account-suspended': 'Compte suspendu chez IG',
  'error.public-api.exceeded-api-key-allowance': 'Trop de requêtes vers IG : réessayez dans une minute',
  'error.public-api.exceeded-account-allowance': 'Trop de requêtes vers IG : réessayez dans une minute',
  'error.public-api.exceeded-account-trading-allowance': 'Trop d’ordres envoyés à IG : réessayez dans une minute',
  'error.public-api.exceeded-account-historical-data-allowance': 'Quota d’historique IG de la semaine atteint (10 000 bougies) : bougies déjà reçues seulement',
  'error.service.marketdata.position.details.null.error': 'Position introuvable chez IG',
  'error.public-api.failure.stockbroking-not-supported': 'IG refuse ce login : son compte par défaut est un compte Actions. Sur ig.com, compte démo, choisissez le compte CFD comme compte par défaut',
  'error.public-api.failure.product-code-not-allowed': 'IG refuse ce login : son compte par défaut n’est pas un compte CFD (Turbo24, Actions…). Indiquez le n° du compte CFD démo (Z…) dans la connexion, ou mettez-le par défaut sur ig.com',
}
// IG's API trades CFD (and spread bet) accounts only: a login whose default account is another kind
// (share dealing, IG Europe's Turbo24...) is refused by the older sign-in
const NOT_CFD = new Set(['error.public-api.failure.stockbroking-not-supported', 'error.public-api.failure.product-code-not-allowed'])
const NO_CFD = 'Aucun compte CFD sur ce login IG : ajoutez un compte CFD sur ig.com'
// which step of the sign-in failed, to know what to change at IG
const failed = (code: string, step: string) => new Error(`${igError(code)} (${step})`)
// why IG refused a deal
const REJECTS: Record<string, string> = {
  MARKET_CLOSED: 'marché fermé',
  MARKET_CLOSED_WITH_EDITS: 'marché fermé',
  MARKET_OFFLINE: 'marché hors ligne',
  INSUFFICIENT_FUNDS: 'fonds insuffisants',
  MINIMUM_ORDER_SIZE_ERROR: 'taille sous le minimum du marché',
  ATTACHED_ORDER_LEVEL_ERROR: 'stop ou objectif trop près du prix',
  WRONG_SIDE_OF_MARKET: 'niveau du mauvais côté du prix',
  POSITION_NOT_AVAILABLE_TO_CLOSE: 'position déjà clôturée',
  INSTRUMENT_NOT_TRADEABLE_IN_THIS_CURRENCY: 'devise refusée pour ce marché',
  REJECT_SPREADBET_ORDER_ON_CFD_ACCOUNT: 'marché de spread bet sur un compte CFD',
}
const igError = (code: string) => ERRORS[code] ?? `IG : ${code}`

const sideOf = (d: Direction) => (d === 'BUY' ? 'long' : 'short')
const sign = (d: Direction) => (d === 'BUY' ? 1 : -1)
// IG's UTC times come without the Z
const utc = (s?: string) => (s ? Date.parse(/Z$/.test(s) ? s : `${s}Z`) || 0 : 0)
// IG's amounts in history are texts with a currency sign ("E-12.50")
const amount = (s: string) => { const v = parseFloat(String(s).replace(/[^\d.-]/g, '')); return Number.isFinite(v) ? v : null }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

class IgClient {
  // IG's demo or live server
  private readonly base: string
  constructor(base: string) { this.base = base }
  private login: Login | null = null
  private tokens: { cst: string; xst: string } | null = null
  private signing: Promise<void> | null = null
  private cache = new Map<string, { at: number; data: Promise<unknown> }>()
  account: { id: string; name: string; currency: string } | null = null
  error: string | null = null

  async connect(login: Login) {
    this.disconnect()
    this.login = login
    try { await this.signIn() } catch (e) { this.disconnect(); throw e }
  }
  disconnect() { this.login = null; this.tokens = null; this.account = null; this.error = null; this.cache.clear() }

  // one sign-in at a time, shared by the requests that found the session expired
  private signIn() {
    this.signing ??= this.openSession().finally(() => { this.signing = null })
    return this.signing
  }
  private async openSession() {
    const login = this.login
    if (!login) throw new Error('Pas connecté à IG')
    this.tokens = null
    const r = await fetch(`${this.base}/session`, {
      method: 'POST', headers: this.headers(2, login.apiKey), body: JSON.stringify({ identifier: login.identifier, password: login.password }),
    })
    const body = await r.json().catch(() => ({})) as IgSession & { errorCode?: string }
    // a login whose default account is not a CFD one is refused by this sign-in: the newer one may open it
    if (!r.ok && NOT_CFD.has(body.errorCode ?? '')) return this.openSessionV3(login, body.errorCode!)
    if (!r.ok) throw failed(body.errorCode ?? `HTTP ${r.status}`, 'connexion')
    const cst = r.headers.get('cst'), xst = r.headers.get('x-security-token')
    if (!cst || !xst) throw new Error('IG n’a pas ouvert de session')
    this.tokens = { cst, xst }
    // the CFD account (a client in France has only that one); a spread bet account is never traded
    const cfd = body.accounts?.find((a) => a.accountId === login.accountId) ?? body.accounts?.find((a) => a.accountType === 'CFD')
    if (!cfd) throw new Error(NO_CFD)
    if (cfd.accountId !== body.currentAccountId) await this.call('PUT', '/session', 1, { accountId: cfd.accountId, defaultAccount: false })
    this.account = { id: cfd.accountId, name: cfd.accountName, currency: body.currencyIsoCode ?? 'EUR' }
    this.error = null
  }

  // IG's newer sign-in (version 3): a short-lived OAuth token on the default account, with which the
  // CFD account (named in the login, else found in the list of accounts) gets its session tokens; the
  // requests then go as above
  private async openSessionV3(login: Login, refused: string) {
    const r = await fetch(`${this.base}/session`, {
      method: 'POST', headers: this.headers(3, login.apiKey), body: JSON.stringify({ identifier: login.identifier, password: login.password }),
    })
    const body = await r.json().catch(() => ({})) as { accountId?: string; oauthToken?: { access_token: string }; errorCode?: string }
    if (!r.ok || !body.oauthToken || !body.accountId) throw failed(body.errorCode ?? refused, 'connexion v3')
    const token = body.oauthToken.access_token
    const auth = (accountId: string) => ({ ...this.headers(1, login.apiKey), Authorization: `Bearer ${token}`, 'IG-ACCOUNT-ID': accountId })
    // the CFD account named in the login: its session at once, no list needed
    const cfd = login.accountId ? { accountId: login.accountId, accountName: 'CFD', currency: undefined } : await this.cfdAccount(body.accountId, auth)
    const s = await fetch(`${this.base}/session?fetchSessionTokens=true`, { headers: auth(cfd.accountId) })
    const cst = s.headers.get('cst'), xst = s.headers.get('x-security-token')
    if (!s.ok || !cst || !xst) {
      const e = await s.json().catch(() => ({})) as { errorCode?: string }
      throw failed(e.errorCode ?? refused, 'session du compte CFD')
    }
    this.tokens = { cst, xst }
    this.account = { id: cfd.accountId, name: cfd.accountName, currency: cfd.currency ?? 'EUR' }
    this.error = null
  }

  // the login's CFD account, from the list of its accounts
  private async cfdAccount(defaultId: string, auth: (accountId: string) => Record<string, string>) {
    // the list asked on the default account, else (that account refused too) on none
    const listOn = async (headers: Record<string, string>) => {
      const res = await fetch(`${this.base}/accounts`, { headers })
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) as { accounts?: IgAccount[]; errorCode?: string } }
    }
    let list = await listOn(auth(defaultId))
    if (!list.ok && NOT_CFD.has(list.data.errorCode ?? '')) {
      const { 'IG-ACCOUNT-ID': _default, ...bare } = auth(defaultId)
      const again = await listOn(bare)
      if (again.ok) list = again
    }
    const accounts = list.data
    if (!list.ok) throw failed(accounts.errorCode ?? `HTTP ${list.status}`, 'liste des comptes')
    const found = accounts.accounts?.find((a) => a.accountType === 'CFD')
    if (!found) throw new Error(`${NO_CFD} (comptes vus : ${accounts.accounts?.map((a) => a.accountType ?? '?').join(', ') || 'aucun'})`)
    return found
  }

  private headers(version: number, apiKey: string): Record<string, string> {
    const h: Record<string, string> = {
      'X-IG-API-KEY': apiKey, 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json; charset=UTF-8', Version: String(version),
    }
    if (this.tokens) { h.CST = this.tokens.cst; h['X-SECURITY-TOKEN'] = this.tokens.xst }
    return h
  }

  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, version: number, body?: unknown, retry = true): Promise<T> {
    if (!this.login) throw new Error('Pas connecté à IG')
    if (!this.tokens) await this.signIn()
    const headers = this.headers(version, this.login.apiKey)
    // IG reads the body of a DELETE only when it comes as a POST marked _method: DELETE
    const send = method === 'DELETE' && body !== undefined ? 'POST' : method
    if (send !== method) headers._method = 'DELETE'
    const r = await fetch(this.base + path, { method: send, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const xst = r.headers.get('x-security-token')
    if (xst && this.tokens) this.tokens.xst = xst
    const raw = await r.text()
    let data = {} as T & { errorCode?: string }
    try { if (raw) data = JSON.parse(raw) } catch { /* not JSON: shown below */ }
    // the session ran out (hours without a request): signed in again, once
    if (r.status === 401 && retry && /token/.test(data.errorCode ?? '')) { this.tokens = null; return this.call(method, path, version, body, false) }
    if (!r.ok) throw new Error(igError(data.errorCode ?? `HTTP ${r.status} ${path.split('?')[0]}${raw ? ` ${raw.slice(0, 120)}` : ''}`))
    return data
  }

  // IG allows few requests a minute: what the windows ask again and again is shared for a while
  private cached<T>(key: string, ms: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < ms) return hit.data as Promise<T>
    const data = load()
    this.cache.set(key, { at: Date.now(), data })
    data.catch(() => this.cache.delete(key))
    return data
  }
  private changed() { for (const k of ['accounts', 'positions', 'orders', 'history']) this.cache.delete(k) }

  async snapshot(history: boolean) {
    if (!this.account) throw new Error('Pas connecté à IG')
    const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19)
    const [accounts, positions, orders, trades] = await Promise.all([
      this.cached('accounts', 30_000, () => this.call<{ accounts: IgAccount[] }>('GET', '/accounts', 1)),
      this.cached('positions', 10_000, () => this.call<{ positions: IgPosition[] }>('GET', '/positions', 2)),
      this.cached('orders', 10_000, () => this.call<{ workingOrders: IgWorking[] }>('GET', '/workingorders', 2)),
      history ? this.cached('history', 60_000, () => this.call<{ transactions: IgTransaction[] }>('GET', `/history/transactions?type=ALL_DEAL&from=${from}&pageSize=200`, 2)) : null,
    ])
    const a = accounts.accounts.find((x) => x.accountId === this.account?.id) ?? accounts.accounts[0]
    return {
      account: {
        id: a?.accountId ?? this.account.id, name: a?.accountName ?? this.account.name, currency: a?.currency ?? this.account.currency,
        balance: a?.balance?.balance ?? 0, pnl: a?.balance?.profitLoss ?? 0, available: a?.balance?.available ?? 0,
      },
      positions: positions.positions.map(({ position: p, market: m }) => {
        const exit = p.direction === 'BUY' ? m.bid : m.offer
        // in the position's currency, at the price IG would close it (the bid for a buy): what IG shows
        const perPoint = p.contractSize || 1
        const pnl = exit == null ? null : (exit - p.level) * sign(p.direction) * p.size * perPoint
        return {
          id: p.dealId, epic: m.epic, name: m.instrumentName, side: sideOf(p.direction), size: p.size, level: p.level,
          sl: p.stopLevel ?? null, tp: p.limitLevel ?? null, bid: m.bid, offer: m.offer, scale: m.scalingFactor ?? 1,
          pnl, perPoint, currency: p.currency, openedAt: utc(p.createdDateUTC),
        }
      }),
      orders: orders.workingOrders.map(({ workingOrderData: w, marketData: m }) => {
        // in IG's points: 10 000 to a forex rate's unit
        const points = (m.scalingFactor ?? 1) > 1 ? m.scalingFactor! : 1
        return {
        id: w.dealId, epic: w.epic, name: m.instrumentName, side: sideOf(w.direction), size: w.orderSize,
        type: w.orderType === 'STOP' ? 'stop' : 'limit', level: w.orderLevel,
        // IG keeps a pending order's stop and target as distances from its level
        sl: w.stopDistance ? w.orderLevel - sign(w.direction) * w.stopDistance / points : null,
        tp: w.limitDistance ? w.orderLevel + sign(w.direction) * w.limitDistance / points : null,
        bid: m.bid, offer: m.offer, scale: m.scalingFactor ?? 1, currency: w.currencyCode, createdAt: utc(w.createdDateUTC),
        }
      }),
      history: trades ? trades.transactions.map((t) => ({
        id: t.reference, name: t.instrumentName, side: String(t.size).trim().startsWith('-') ? 'short' : 'long',
        size: Math.abs(amount(t.size) ?? 0), entry: amount(t.openLevel), exit: amount(t.closeLevel), pnl: amount(t.profitAndLoss),
        currency: t.currency, openedAt: utc(t.openDateUtc), closedAt: utc(t.dateUtc),
      })) : null,
    }
  }

  search(q: string) {
    return this.cached(`search:${q}`, 300_000, async () => {
      const r = await this.call<{ markets: IgMarket[] }>('GET', `/markets?searchTerm=${encodeURIComponent(q)}`, 1)
      return r.markets.map((m) => ({ epic: m.epic, name: m.instrumentName, type: m.instrumentType, expiry: m.expiry, bid: m.bid, offer: m.offer, status: m.marketStatus }))
    })
  }

  // IG's lists of markets (its own: popular markets, indices, forex... and the user's), kept 10 minutes;
  // IG no longer serves its tree of markets (/marketnavigation answers 404)
  lists() {
    return this.cached('lists', 600_000, async () => {
      const r = await this.call<{ watchlists?: { id: string; name: string; defaultSystemWatchlist?: boolean }[] }>('GET', '/watchlists', 1)
      return (r.watchlists ?? []).map((w) => ({ id: w.id, name: w.name, ig: !!w.defaultSystemWatchlist }))
    })
  }
  list(id: string) {
    return this.cached(`list:${id}`, 60_000, async () => {
      const r = await this.call<{ markets?: IgMarket[] }>('GET', `/watchlists/${encodeURIComponent(id)}`, 1)
      return (r.markets ?? []).map((m) => ({ epic: m.epic, name: m.instrumentName, type: m.instrumentType, expiry: m.expiry, bid: m.bid, offer: m.offer, status: m.marketStatus }))
    })
  }

  market(epic: string) {
    return this.cached(`market:${epic}`, 5_000, async () => {
      const d = await this.call<IgDetails>('GET', `/markets/${encodeURIComponent(epic)}`, 3)
      const s = d.snapshot
      return {
        epic: d.instrument.epic, name: d.instrument.name, bid: s?.bid ?? null, offer: s?.offer ?? null, status: s?.marketStatus ?? '',
        scale: s?.scalingFactor ?? 1, decimals: s?.decimalPlacesFactor ?? 2, delay: s?.delayTime ?? 0,
        currency: d.instrument.currencies?.find((c) => c.isDefault)?.code ?? d.instrument.currencies?.[0]?.code ?? 'EUR',
        contractSize: Number(d.instrument.contractSize) || 1, minSize: d.dealingRules?.minDealSize?.value ?? null,
        minStop: d.dealingRules?.minNormalStopOrLimitDistance ?? null,
      }
    })
  }

  // the prices of several markets in one request (the "Marchés IG" panel, the IG symbols' quotes)
  quotes(epics: string[]) {
    return this.cached(`quotes:${epics.join(',')}`, 5_000, async () => {
      const r = await this.call<{ marketDetails?: (IgDetails & { snapshot?: { high?: number | null; low?: number | null; netChange?: number | null } })[] }>(
        'GET', `/markets?epics=${epics.map(encodeURIComponent).join(',')}`, 2)
      return (r.marketDetails ?? []).map((d) => ({
        epic: d.instrument.epic, bid: d.snapshot?.bid ?? null, offer: d.snapshot?.offer ?? null, status: d.snapshot?.marketStatus ?? '',
        high: d.snapshot?.high ?? null, low: d.snapshot?.low ?? null, change: d.snapshot?.netChange ?? null,
      }))
    })
  }

  // IG's own bars, at the middle of bid and offer like IG's charts. IG counts every bar it sends
  // (10 000 a week): those received are kept on disk (in the user's profile) and only the newer ones
  // asked again; the first time, the last `max`
  prices(epic: string, res: string, max: number) {
    return this.cached(`prices:${epic}:${res}`, 20_000, async () => {
      const step = IG_RES[res]
      if (!step) throw new Error(`Unité ${res} inconnue d’IG`)
      const file = join(PRICES_DIR, `${epic}_${res}.json`.replace(/[^\w.-]/g, '_'))
      let kept: Bar[] = []
      try { kept = JSON.parse(await readFile(file, 'utf8')) as Bar[] } catch { /* none yet */ }
      const now = Math.floor(Date.now() / 1000)
      const last = kept[kept.length - 1]?.time
      // from the last bar kept (it may have grown since), when that asks fewer bars than a fresh start
      const since = last != null && (now - last) / step < max * 2
      const query = since
        ? `from=${igTime(last)}&to=${igTime(now + step)}&pageSize=0`
        : `max=${max}&pageSize=0`
      let r: { prices: IgBar[]; metadata?: { allowance?: { remainingAllowance: number } } }
      try {
        r = await this.call('GET', `/prices/${encodeURIComponent(epic)}?resolution=${res}&${query}`, 3)
      } catch (e) {
        // the week's quota spent (or IG down): the bars kept, said so
        if (kept.length) return { candles: kept, allowance: 0, error: e instanceof Error ? e.message : String(e) }
        throw e
      }
      const fresh = r.prices.map(toBar).filter((b): b is Bar => b != null)
      // after a long pause, a gap between the bars kept and the fresh ones
      const first = fresh[0]?.time ?? Infinity
      const out = [...kept.filter((b) => b.time < first), ...fresh].slice(-5000)
      await mkdir(PRICES_DIR, { recursive: true })
      await writeFile(file, JSON.stringify(out))
      return { candles: out, allowance: r.metadata?.allowance?.remainingAllowance ?? null }
    })
  }

  // a deal is processed after IG answers the request: its outcome comes a moment later
  private async confirm(ref: string): Promise<IgConfirm> {
    this.changed()
    for (let i = 0; i < 12; i++) {
      let c: IgConfirm | null = null
      try { c = await this.call<IgConfirm>('GET', `/confirms/${encodeURIComponent(ref)}`, 1) } catch (e) {
        if (!/not-found/.test(String(e))) throw e
      }
      if (c) {
        if (c.dealStatus !== 'ACCEPTED') throw new Error(`IG a refusé : ${REJECTS[c.reason] ?? c.reason}`)
        return c
      }
      await wait(300)
    }
    throw new Error('IG n’a pas encore confirmé : vérifiez sur IG')
  }

  async order(o: { epic: string; side: 'long' | 'short'; size: number; type: 'market' | 'limit' | 'stop'; level?: number; stopDistance?: number; limitDistance?: number }) {
    const m = await this.market(o.epic)
    const round = (v: number) => Number(v.toFixed(m.decimals))
    const common = {
      epic: o.epic, expiry: '-', direction: o.side === 'long' ? 'BUY' : 'SELL', size: o.size, currencyCode: m.currency,
      guaranteedStop: false, forceOpen: true,
      ...(o.stopDistance ? { stopDistance: round(o.stopDistance) } : {}), ...(o.limitDistance ? { limitDistance: round(o.limitDistance) } : {}),
    }
    const r = o.type === 'market'
      ? await this.call<{ dealReference: string }>('POST', '/positions/otc', 2, { ...common, orderType: 'MARKET', trailingStop: false })
      : await this.call<{ dealReference: string }>('POST', '/workingorders/otc', 2, {
        ...common, level: round(o.level!), type: o.type === 'limit' ? 'LIMIT' : 'STOP', timeInForce: 'GOOD_TILL_CANCELLED',
      })
    return this.confirm(r.dealReference)
  }

  async amend(a: { dealId: string; sl: number | null; tp: number | null }) {
    const r = await this.call<{ dealReference: string }>('PUT', `/positions/otc/${encodeURIComponent(a.dealId)}`, 2, {
      stopLevel: a.sl, limitLevel: a.tp, trailingStop: false, guaranteedStop: false,
    })
    return this.confirm(r.dealReference)
  }

  async amendOrder(a: { dealId: string; level: number; type: 'limit' | 'stop'; stopDistance: number | null; limitDistance: number | null }) {
    const r = await this.call<{ dealReference: string }>('PUT', `/workingorders/otc/${encodeURIComponent(a.dealId)}`, 2, {
      level: a.level, type: a.type === 'limit' ? 'LIMIT' : 'STOP', timeInForce: 'GOOD_TILL_CANCELLED', guaranteedStop: false,
      stopDistance: a.stopDistance, limitDistance: a.limitDistance,
    })
    return this.confirm(r.dealReference)
  }

  async close(dealId: string) {
    const { positions } = await this.cached('positions', 10_000, () => this.call<{ positions: IgPosition[] }>('GET', '/positions', 2))
    const p = positions.find((x) => x.position.dealId === dealId)?.position
    if (!p) throw new Error('Position introuvable chez IG (déjà clôturée ?)')
    const r = await this.call<{ dealReference: string }>('DELETE', '/positions/otc', 1, {
      dealId, direction: p.direction === 'BUY' ? 'SELL' : 'BUY', size: p.size, orderType: 'MARKET',
    })
    return this.confirm(r.dealReference)
  }

  async cancel(dealId: string) {
    const r = await this.call<{ dealReference: string }>('DELETE', `/workingorders/otc/${encodeURIComponent(dealId)}`, 2)
    return this.confirm(r.dealReference)
  }
}

async function savedLogin(): Promise<Login | null> {
  try {
    const v = JSON.parse(await readFile(SAVED, 'utf8')) as Partial<Login>
    return v.apiKey && v.identifier && v.password ? { apiKey: v.apiKey, identifier: v.identifier, password: v.password, accountId: v.accountId || undefined } : null
  } catch { return null }
}

// only the platform's own pages may use it: no other machine, no other web site open in the browser
function fromPlatform(req: IncomingMessage) {
  const ip = req.socket.remoteAddress ?? ''
  if (!/^(::1$|127\.|::ffff:127\.)/.test(ip)) return false
  const origin = req.headers.origin
  return !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (c) => { s += c; if (s.length > 100_000) req.destroy() })
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
const levelOrNull = (v: unknown) => positive(v) ?? null

// one relay's requests: `live` for IG's real-money server
function relayFor(ig: IgClient, live: boolean): Connect.NextHandleFunction {
  // the demo login kept by "Rester connecté" is used once, on the first status asked
  let resumed = live
  const resume = async () => {
    if (resumed) return
    resumed = true
    const login = await savedLogin()
    if (login) await ig.connect(login).catch((e) => { ig.error = e instanceof Error ? e.message : String(e) })
  }
  const json = (res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  return async (req, res) => {
    if (!fromPlatform(req)) { json(res, 403, { error: 'réservé à la plateforme' }); return }
    const url = new URL(req.url ?? '', 'http://local')
    const q = url.searchParams
    const post = req.method === 'POST'
    try {
      const b = post ? await readBody(req) : {}
      switch (url.pathname) {
        case '/status':
          await resume()
          json(res, 200, { broker: 'ig', live, account: ig.account, error: ig.error })
          return
        case '/connect': {
          if (!post) break
          const accountId = text(b.accountId).toUpperCase()
          const login = { apiKey: text(b.apiKey), identifier: text(b.identifier), password: typeof b.password === 'string' ? b.password : '', ...(accountId ? { accountId } : {}) }
          if (!login.apiKey || !login.identifier || !login.password) { json(res, 400, { error: 'Clé API, identifiant et mot de passe sont nécessaires' }); return }
          if (live && b.realMoney !== true) { json(res, 400, { error: 'Cochez « argent réel » pour vous connecter au compte réel' }); return }
          resumed = true
          await ig.connect(login)
          if (!live && b.remember === true) {
            await mkdir(dirname(SAVED), { recursive: true })
            await writeFile(SAVED, JSON.stringify(login), { encoding: 'utf8', mode: 0o600 })
          } else if (!live) await rm(SAVED, { force: true })
          json(res, 200, { broker: 'ig', live, account: ig.account, error: null })
          return
        }
        case '/disconnect':
          if (!post) break
          ig.disconnect()
          if (!live) await rm(SAVED, { force: true })
          json(res, 200, { ok: true })
          return
        case '/snapshot': json(res, 200, await ig.snapshot(q.get('history') === '1')); return
        case '/search': json(res, 200, await ig.search(text(q.get('q')).slice(0, 60))); return
        case '/market': json(res, 200, await ig.market(text(q.get('epic')))); return
        case '/quotes': json(res, 200, await ig.quotes(text(q.get('epics')).split(',').filter(Boolean).slice(0, 50))); return
        case '/prices': json(res, 200, await ig.prices(text(q.get('epic')), text(q.get('res')), Math.min(1000, Math.max(10, Number(q.get('max')) || 300)))); return
        case '/lists': json(res, 200, q.get('id') ? await ig.list(text(q.get('id')).slice(0, 60)) : await ig.lists()); return
        case '/order': {
          if (!post) break
          const type = b.type === 'limit' || b.type === 'stop' ? b.type : 'market'
          const size = positive(b.size), level = positive(b.level)
          if (!text(b.epic) || !size || (b.side !== 'long' && b.side !== 'short')) { json(res, 400, { error: 'ordre incomplet' }); return }
          if (type !== 'market' && !level) { json(res, 400, { error: 'prix de l’ordre manquant' }); return }
          json(res, 200, await ig.order({ epic: text(b.epic), side: b.side, size, type, level, stopDistance: positive(b.stopDistance), limitDistance: positive(b.limitDistance) }))
          return
        }
        case '/amend':
          if (!post) break
          json(res, 200, await ig.amend({ dealId: text(b.dealId), sl: levelOrNull(b.sl), tp: levelOrNull(b.tp) }))
          return
        case '/amend-order': {
          if (!post) break
          const level = positive(b.level)
          if (!level) { json(res, 400, { error: 'prix de l’ordre manquant' }); return }
          json(res, 200, await ig.amendOrder({
            dealId: text(b.dealId), level, type: b.type === 'stop' ? 'stop' : 'limit', stopDistance: levelOrNull(b.stopDistance), limitDistance: levelOrNull(b.limitDistance),
          }))
          return
        }
        case '/close': if (!post) break; json(res, 200, await ig.close(text(b.dealId))); return
        case '/cancel': if (!post) break; json(res, 200, await ig.cancel(text(b.dealId))); return
      }
      json(res, 404, { error: 'inconnu' })
    } catch (e) {
      json(res, 503, { error: e instanceof Error ? e.message : String(e) })
    }
  }
}

export function brokerRelay(): Plugin {
  const demo = relayFor(new IgClient(IG_DEMO), false)
  const live = relayFor(new IgClient(IG_LIVE), true)
  // '/api/broker' does not match '/api/broker-live' (connect matches whole path segments)
  const mount = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use('/api/broker-live', live)
    server.middlewares.use('/api/broker', demo)
  }
  return { name: 'broker-relay', configureServer: mount, configurePreviewServer: mount }
}
