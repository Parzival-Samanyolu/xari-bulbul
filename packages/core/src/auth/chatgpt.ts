import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'

// "Sign in with ChatGPT" for open-source apps: the user's ChatGPT plan pays for Responses API
// requests. Docs: https://developers.openai.com/siwc/token-sharing-open-source
// Flow: loopback OAuth with PKCE and dynamic client registration → ID-token check → tokens in
// the keychain → access token refreshed (single-flight, rotating refresh token) before requests.

export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
/** Required for plan usage; a sign-in without it is identity only. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE]
const FIRST_CLIENT = 'dynamic_agent_client'
const CALLBACK_PATH = '/auth/callback'
const PREFERRED_PORT = 1455
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 5 * 60_000
/** Keychain id; long records are split into `#1`, `#2`… parts (the macOS stdin path holds ~4 KB). */
export const CHATGPT_SECRET_ID = 'oauth:chatgpt'
const CHUNK = 2500

/** Refresh errors that mean the session is gone and the user must sign in again. */
const TERMINAL_REFRESH = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']

export interface SecretAccess {
  get(id: string): string | undefined
  set(id: string, value: string | null): void
}

export interface ChatGptAuthOptions {
  /** Where the host id and the (non-secret) account registration are kept. */
  dataDir: string
  secrets: SecretAccess
  /** Shown to the user when they name the agent on first sign-in. */
  appName: string
  issuer?: string
  fetch?: typeof fetch
  now?: () => number
  /** For tests: keys to check ID tokens against instead of the issuer's JWKS. */
  jwks?: JSONWebKeySet
  /** For tests: listen on this port instead of 1455 (0 = any free port). */
  port?: number
  /**
   * Borrow the stored access token and never refresh it. For tools that run beside the app (the
   * bench): refresh tokens rotate, so a refresh here would end the app's sign-in.
   */
  readOnly?: boolean
}

/** What the UI needs; no tokens. */
export interface ChatGptStatus {
  signedIn: boolean
  email?: string
  /** False when the user signed in but didn't allow plan usage. */
  planEnabled: boolean
}

interface Credentials {
  email?: string
  subject: string
  client_id: string
  id_token?: string
  access_token: string
  refresh_token?: string
  /** Unix ms. */
  expires_at: number
  scopes: string[]
  saved_at: string
}

/** Non-secret, survives sign-out so the next sign-in reuses the same registration. */
interface AccountFile {
  hostId: string
  clientId?: string
  email?: string
  subject?: string
  /** The one-time "You're using your ChatGPT plan" note was dismissed. */
  welcomeSeen?: boolean
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

export class ChatGptAuthError extends Error {
  constructor(
    message: string,
    /** `sign_in_again`: tokens are unusable; `denied`: the user said no in the browser; `cancelled`. */
    readonly kind: 'sign_in_again' | 'denied' | 'cancelled' | 'failed' = 'failed',
  ) {
    super(message)
    this.name = 'ChatGptAuthError'
  }
}

export class ChatGptAuth {
  private readonly issuer: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly file: string
  private creds: Credentials | undefined
  private refreshing: Promise<string> | undefined
  private discovery: Promise<{ jwks_uri?: string; revocation_endpoint?: string }> | undefined
  private remoteJwks: JWTVerifyGetKey | undefined
  private pending: AbortController | undefined

  constructor(private readonly o: ChatGptAuthOptions) {
    this.issuer = (o.issuer ?? CHATGPT_ISSUER).replace(/\/+$/, '')
    this.fetchImpl = o.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = o.now ?? Date.now
    this.file = path.join(o.dataDir, 'chatgpt-account.json')
    this.creds = this.loadCreds()
  }

  status(): ChatGptStatus {
    const c = this.creds
    return { signedIn: !!c, email: c?.email ?? this.account().email, planEnabled: !!c?.scopes.includes(PLAN_SCOPE) }
  }

  /** A sign-in is waiting for the browser. */
  get signingIn(): boolean {
    return !!this.pending
  }

  get welcomeSeen(): boolean {
    return !!this.account().welcomeSeen
  }

  dismissWelcome(): void {
    this.saveAccount({ ...this.account(), welcomeSeen: true })
  }

  /** Stop a sign-in that's waiting for the browser. */
  cancel(): void {
    this.pending?.abort(new ChatGptAuthError('Sign-in cancelled.', 'cancelled'))
  }

  /**
   * Opens the browser for sign-in (first time: registers this app and asks to allow plan use)
   * and resolves once tokens are saved. `consent` asks again for plan use after a decline.
   */
  async signIn(openUrl: (url: string) => void | Promise<void>, opts: { consent?: boolean } = {}): Promise<ChatGptStatus> {
    this.cancel()
    const ctrl = new AbortController()
    this.pending = ctrl
    const timer = setTimeout(() => ctrl.abort(new ChatGptAuthError('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT_MS)
    const server = await listen(this.o.port ?? PREFERRED_PORT)
    try {
      const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}${CALLBACK_PATH}`
      const account = this.account()
      const state = random()
      const nonce = random()
      const verifier = random(48)
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
      const known = account.clientId
      const q = new URLSearchParams({
        client_id: known ?? FIRST_CLIENT,
        ext_agent_host_id: account.hostId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES.join(' '),
        resource: CHATGPT_RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      })
      if (!known) q.set('agent_name_hint', this.o.appName)
      if (known && this.creds?.id_token) q.set('id_token_hint', this.creds.id_token)
      if (known && account.email) q.set('login_hint', account.email)
      if (opts.consent) q.set('prompt', 'consent')

      const callback = waitForCallback(server, ctrl.signal)
      await openUrl(`${this.issuer}/api/accounts/authorize?${q}`)
      const { params, respond } = await callback
      try {
        if (params.get('state') !== state) throw new ChatGptAuthError('The sign-in reply didn’t match this attempt. Try again.')
        const error = params.get('error')
        if (error === 'access_denied') throw new ChatGptAuthError('Sign-in was declined in the browser.', 'denied')
        if (error) throw new ChatGptAuthError(`ChatGPT sign-in failed: ${params.get('error_description') || error}`)
        const code = params.get('code')
        if (!code) throw new ChatGptAuthError('The sign-in reply had no authorization code.')
        const issued = params.get('client_id') ?? undefined
        if (known && issued && issued !== known) throw new ChatGptAuthError('ChatGPT returned a different app registration. Sign out, then sign in again.')
        const clientId = known ?? issued
        if (!clientId || clientId === FIRST_CLIENT) throw new ChatGptAuthError('ChatGPT didn’t finish registering this app. Try again.')

        const tokens = await this.token({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: CHATGPT_RESOURCE,
        })
        if (!tokens.access_token || !tokens.id_token) throw new ChatGptAuthError('ChatGPT’s token reply was incomplete. Try again.')
        const claims = await this.verifyIdToken(tokens.id_token, clientId, nonce)
        if (known && account.subject && claims.sub !== account.subject) throw new ChatGptAuthError('That’s a different ChatGPT account than the one this app is registered with. Sign out first to switch.')
        const scopes = (tokens.scope ?? params.get('scope') ?? '').split(/\s+/).filter(Boolean)
        this.saveCreds({
          email: typeof claims.email === 'string' ? claims.email : undefined,
          subject: claims.sub,
          client_id: clientId,
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: this.now() + (tokens.expires_in ?? 3600) * 1000,
          scopes,
          saved_at: new Date(this.now()).toISOString(),
        })
        respond(true)
        return this.status()
      } catch (e) {
        respond(false)
        throw e
      }
    } finally {
      clearTimeout(timer)
      server.close()
      if (this.pending === ctrl) this.pending = undefined
    }
  }

  /** A valid access token for plan usage, refreshed when it's about to expire. */
  async accessToken(): Promise<string> {
    const c = this.creds
    if (!c) throw new ChatGptAuthError('Sign in to ChatGPT in Settings › Providers.', 'sign_in_again')
    if (!c.scopes.includes(PLAN_SCOPE)) throw new ChatGptAuthError('ChatGPT plan use isn’t turned on. Turn it on in Settings › Providers.', 'sign_in_again')
    if (c.expires_at - this.now() > REFRESH_EARLY_MS) return c.access_token
    if (this.o.readOnly) {
      if (c.expires_at > this.now()) return c.access_token
      throw new ChatGptAuthError('The ChatGPT access token expired (they last an hour). Send one message with a ChatGPT model in the app to renew it, or close the app, then try again.', 'sign_in_again')
    }
    // Refresh tokens rotate: two refreshes at once would invalidate each other.
    this.refreshing ??= this.refresh(c).finally(() => (this.refreshing = undefined))
    return this.refreshing
  }

  private async refresh(c: Credentials): Promise<string> {
    if (!c.refresh_token) {
      this.clearCreds()
      throw new ChatGptAuthError('Your ChatGPT sign-in expired. Sign in again in Settings › Providers.', 'sign_in_again')
    }
    let tokens: TokenResponse
    try {
      tokens = await this.token({ grant_type: 'refresh_token', client_id: c.client_id, refresh_token: c.refresh_token, resource: CHATGPT_RESOURCE })
    } catch (e) {
      if (e instanceof TokenError && (TERMINAL_REFRESH.includes(e.code) || e.code === 'invalid_client')) {
        this.clearCreds()
        throw new ChatGptAuthError('Your ChatGPT sign-in ended. Sign in again in Settings › Providers.', 'sign_in_again')
      }
      // Network trouble or a 5xx: keep the session and let the request fail for now.
      throw e instanceof TokenError ? new Error(`Couldn’t renew the ChatGPT sign-in: ${e.message}`) : e
    }
    if (!tokens.access_token) throw new Error('Couldn’t renew the ChatGPT sign-in: the reply had no access token.')
    const next: Credentials = {
      ...c,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? c.refresh_token,
      id_token: tokens.id_token ?? c.id_token,
      expires_at: this.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : c.scopes,
      saved_at: new Date(this.now()).toISOString(),
    }
    this.saveCreds(next)
    return next.access_token
  }

  /** Revokes the session and clears the tokens. `revoked: false` means only the local copy is gone. */
  async signOut(): Promise<{ revoked: boolean }> {
    this.cancel()
    const c = this.creds
    if (!c) return { revoked: true }
    let revoked = !c.refresh_token
    if (c.refresh_token) {
      try {
        const { revocation_endpoint } = await this.discover()
        const url = revocation_endpoint ?? `${this.issuer}/oauth/revoke`
        for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: c.refresh_token, token_type_hint: 'refresh_token', client_id: c.client_id }),
          }).catch(() => undefined)
          if (res?.ok) revoked = true
          else if (res && res.status < 500) break
        }
      } catch {
        revoked = false
      }
    }
    this.clearCreds()
    return { revoked }
  }

  private async token(form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchImpl(`${this.issuer}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
    })
    const json = (await res.json().catch(() => ({}))) as TokenResponse
    if (!res.ok || json.error) {
      const requestId = res.headers.get('openai-request-id') ?? res.headers.get('x-request-id')
      throw new TokenError(json.error ?? `http_${res.status}`, `${json.error_description || json.error || `HTTP ${res.status}`}${requestId ? ` (request ${requestId})` : ''}`)
    }
    return json
  }

  private discover(): Promise<{ jwks_uri?: string; revocation_endpoint?: string }> {
    this.discovery ??= this.fetchImpl(`${this.issuer}/.well-known/openid-configuration`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => {
        this.discovery = undefined
        return {}
      }) as Promise<{ jwks_uri?: string; revocation_endpoint?: string }>
    return this.discovery
  }

  private async verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<{ sub: string; email?: unknown }> {
    let keys: JWTVerifyGetKey
    if (this.o.jwks) keys = createLocalJWKSet(this.o.jwks)
    else {
      if (!this.remoteJwks) {
        const { jwks_uri } = await this.discover()
        this.remoteJwks = createRemoteJWKSet(new URL(jwks_uri ?? `${this.issuer}/.well-known/jwks.json`))
      }
      keys = this.remoteJwks
    }
    try {
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: this.issuer,
        audience: clientId,
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
        currentDate: new Date(this.now()),
      })
      if (payload.nonce !== nonce) throw new Error('nonce mismatch')
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no subject')
      return payload as { sub: string; email?: unknown }
    } catch (e) {
      throw new ChatGptAuthError(`ChatGPT’s sign-in token didn’t check out (${(e as Error).message}). Try again.`)
    }
  }

  // ── storage ──

  private account(): AccountFile {
    try {
      const a = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AccountFile
      if (a.hostId) return a
    } catch {
      // first run
    }
    // One opaque id per installation, made before the first sign-in and kept for good.
    const a: AccountFile = { hostId: `urn:uuid:${crypto.randomUUID()}` }
    this.saveAccount(a)
    return a
  }

  private saveAccount(a: AccountFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(a, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  private loadCreds(): Credentials | undefined {
    try {
      const head = this.o.secrets.get(CHATGPT_SECRET_ID)
      if (!head) return undefined
      const m = /^parts:(\d+)$/.exec(head)
      let encoded = head
      if (m) {
        encoded = ''
        for (let i = 1; i <= Number(m[1]); i++) {
          const part = this.o.secrets.get(`${CHATGPT_SECRET_ID}#${i}`)
          if (!part) return undefined
          encoded += part
        }
      }
      const c = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Credentials
      return c.access_token && c.client_id ? c : undefined
    } catch {
      return undefined
    }
  }

  private saveCreds(c: Credentials): void {
    // Base64 keeps quotes out of the value, so macOS writes go through stdin rather than argv (visible in `ps`).
    const encoded = Buffer.from(JSON.stringify(c), 'utf8').toString('base64')
    const parts: string[] = []
    for (let i = 0; i < encoded.length; i += CHUNK) parts.push(encoded.slice(i, i + CHUNK))
    const old = this.partCount()
    parts.forEach((p, i) => this.o.secrets.set(`${CHATGPT_SECRET_ID}#${i + 1}`, p))
    this.o.secrets.set(CHATGPT_SECRET_ID, `parts:${parts.length}`)
    for (let i = parts.length + 1; i <= old; i++) this.o.secrets.set(`${CHATGPT_SECRET_ID}#${i}`, null)
    this.creds = c
    this.saveAccount({ ...this.account(), clientId: c.client_id, email: c.email, subject: c.subject })
  }

  private partCount(): number {
    const m = /^parts:(\d+)$/.exec(this.o.secrets.get(CHATGPT_SECRET_ID) ?? '')
    return m ? Number(m[1]) : 0
  }

  private clearCreds(): void {
    const n = this.partCount()
    for (let i = 1; i <= n; i++) this.o.secrets.set(`${CHATGPT_SECRET_ID}#${i}`, null)
    this.o.secrets.set(CHATGPT_SECRET_ID, null)
    this.creds = undefined
  }
}

class TokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

/** Listens on 127.0.0.1 (never `localhost`), on `port` if free, else any free port. */
function listen(port: number): Promise<http.Server> {
  const attempt = (p: number) =>
    new Promise<http.Server>((resolve, reject) => {
      const server = http.createServer()
      server.once('error', reject)
      server.listen(p, '127.0.0.1', () => resolve(server))
    })
  return attempt(port).catch(() => attempt(0))
}

const PAGE = (ok: boolean) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Xari Bulbul</title>
<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">
<h1 style="font-size:1.25rem">${ok ? 'Signed in to ChatGPT' : 'Sign-in didn’t finish'}</h1>
<p>${ok ? 'You can close this tab and go back to Xarı Bülbül.' : 'Go back to Xarı Bülbül to see what happened and try again.'}</p></body></html>`

function waitForCallback(server: http.Server, signal: AbortSignal): Promise<{ params: URLSearchParams; respond: (ok: boolean) => void }> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new ChatGptAuthError('Sign-in cancelled.', 'cancelled'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    let done = false
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH || done) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
        return
      }
      done = true
      signal.removeEventListener('abort', onAbort)
      resolve({
        params: url.searchParams,
        respond: (ok) => res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(PAGE(ok)),
      })
    })
  })
}
