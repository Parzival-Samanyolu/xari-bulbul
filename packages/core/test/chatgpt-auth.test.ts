import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { ChatGptAuth, CHATGPT_SECRET_ID, PLAN_SCOPE } from '../src/auth/chatgpt.js'
import { tmpDir } from './helpers.js'

const ISSUER = 'https://auth.example'
const PLAN = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  const sign = (claims: Record<string, unknown>, aud: string, iss = ISSUER) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('1h').sign(privateKey)
  return { jwks: { keys: [jwk] }, sign }
}

function memorySecrets() {
  const store = new Map<string, string>()
  return {
    store,
    get: (id: string) => store.get(id),
    set: (id: string, v: string | null) => (v ? store.set(id, v) : store.delete(id)),
  }
}

interface Fake {
  token: (form: URLSearchParams) => Response | Promise<Response>
  revoke?: (form: URLSearchParams) => Response
}

function fakeFetch(f: Fake) {
  const calls: { url: string; form?: URLSearchParams }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const form = init?.body instanceof URLSearchParams ? init.body : undefined
    calls.push({ url, form })
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ revocation_endpoint: `${ISSUER}/oauth/revoke` })
    if (url.endsWith('/api/accounts/oauth/token')) return f.token(form!)
    if (url.endsWith('/oauth/revoke')) return f.revoke?.(form!) ?? new Response('', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

/** Plays the browser: reads the authorize URL, then hits the loopback callback with `reply(q)`. */
function browser(reply: (q: URLSearchParams) => Record<string, string>) {
  const opened: URL[] = []
  const open = async (u: string) => {
    const url = new URL(u)
    opened.push(url)
    const q = url.searchParams
    const cb = new URL(q.get('redirect_uri')!)
    for (const [k, v] of Object.entries(reply(q))) cb.searchParams.set(k, v)
    // Answer after the auth module has started waiting.
    setTimeout(() => void fetch(cb).catch(() => {}), 5)
  }
  return { open, opened }
}

async function setup(token: Fake['token'], opts: { now?: () => number } = {}) {
  const dir = tmpDir()
  const secrets = memorySecrets()
  const { jwks, sign } = await keys()
  const net = fakeFetch({ token })
  const auth = new ChatGptAuth({ dataDir: dir, secrets, appName: 'Xari Bulbul', issuer: ISSUER, fetch: net.fetch, jwks, port: 0, now: opts.now })
  return { dir, secrets, sign, net, auth }
}

describe('ChatGptAuth', () => {
  it('registers on first sign-in, checks the ID token and saves the session', async () => {
    let nonce = ''
    const s = await setup(async (form) => {
      expect(form.get('grant_type')).toBe('authorization_code')
      expect(form.get('client_id')).toBe('oaiapp_1')
      expect(form.get('code')).toBe('the-code')
      expect(form.get('resource')).toBe('https://api.openai.com/v1')
      expect(form.get('code_verifier')).toMatch(/^[\w-]{43,}$/)
      expect(form.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
      return Response.json({ access_token: 'at1', refresh_token: 'rt1', id_token: await s.sign({ sub: 'user-1', email: 'a@b.c', nonce }, 'oaiapp_1'), expires_in: 3600, scope: PLAN })
    })
    const b = browser((q) => {
      nonce = q.get('nonce')!
      return { code: 'the-code', state: q.get('state')!, client_id: 'oaiapp_1', scope: PLAN }
    })
    const status = await s.auth.signIn(b.open)
    expect(status).toEqual({ signedIn: true, email: 'a@b.c', planEnabled: true })

    const q = b.opened[0]!.searchParams
    expect(b.opened[0]!.origin + b.opened[0]!.pathname).toBe(`${ISSUER}/api/accounts/authorize`)
    expect(q.get('client_id')).toBe('dynamic_agent_client')
    expect(q.get('agent_name_hint')).toBe('Xari Bulbul')
    expect(q.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(q.get('scope')).toBe(PLAN)
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('resource')).toBe('https://api.openai.com/v1')
    expect(await s.auth.accessToken()).toBe('at1')

    // Stored in parts, base64, under an id env vars can't override; registration kept in a file.
    expect(s.secrets.get(CHATGPT_SECRET_ID)).toMatch(/^parts:\d+$/)
    expect([...s.secrets.store.values()].join('')).not.toContain('"')
    const account = JSON.parse(fs.readFileSync(path.join(s.dir, 'chatgpt-account.json'), 'utf8'))
    expect(account).toMatchObject({ clientId: 'oaiapp_1', email: 'a@b.c', subject: 'user-1' })

    // A fresh instance (app restart) reads the session back.
    const again = new ChatGptAuth({ dataDir: s.dir, secrets: s.secrets, appName: 'x', issuer: ISSUER, fetch: s.net.fetch })
    expect(again.status().signedIn).toBe(true)
    expect(await again.accessToken()).toBe('at1')
  })

  it('reuses the issued client id and the host id on a later sign-in', async () => {
    let nonce = ''
    const s = await setup(async () => Response.json({ access_token: 'at', refresh_token: 'rt', id_token: await s.sign({ sub: 'user-1', email: 'a@b.c', nonce }, 'oaiapp_1'), scope: PLAN }))
    const first = browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' }))
    await s.auth.signIn(first.open)
    await s.auth.signOut()
    const second = browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')! }))
    await s.auth.signIn(second.open)
    const q = second.opened[0]!.searchParams
    expect(q.get('client_id')).toBe('oaiapp_1')
    expect(q.get('agent_name_hint')).toBeNull()
    expect(q.get('login_hint')).toBe('a@b.c')
    expect(q.get('ext_agent_host_id')).toBe(first.opened[0]!.searchParams.get('ext_agent_host_id'))
  })

  it('rejects a reply for another attempt, a wrong nonce, or another audience', async () => {
    const wrongState = await setup(async () => Response.json({}))
    await expect(wrongState.auth.signIn(browser(() => ({ code: 'c', state: 'nope', client_id: 'oaiapp_1' })).open)).rejects.toThrow(/didn’t match/)
    expect(wrongState.auth.signingIn).toBe(false)

    const wrongNonce = await setup(async () => Response.json({ access_token: 'a', id_token: await wrongNonce.sign({ sub: 'u', nonce: 'other' }, 'oaiapp_1'), scope: PLAN }))
    await expect(wrongNonce.auth.signIn(browser((q) => ({ code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' })).open)).rejects.toThrow(/nonce/)

    let nonce = ''
    const wrongAud = await setup(async () => Response.json({ access_token: 'a', id_token: await wrongAud.sign({ sub: 'u', nonce }, 'someone-else'), scope: PLAN }))
    await expect(wrongAud.auth.signIn(browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' })).open)).rejects.toThrow(/didn’t check out/)
    expect(wrongAud.auth.status().signedIn).toBe(false)
  })

  it('reports a declined sign-in', async () => {
    const s = await setup(async () => Response.json({}))
    await expect(s.auth.signIn(browser((q) => ({ error: 'access_denied', state: q.get('state')! })).open)).rejects.toMatchObject({ kind: 'denied' })
  })

  it('keeps an identity-only sign-in but marks plan use off', async () => {
    let nonce = ''
    const s = await setup(async () => Response.json({ access_token: 'a', refresh_token: 'r', id_token: await s.sign({ sub: 'u', nonce }, 'oaiapp_1'), scope: 'openid profile email offline_access' }))
    await s.auth.signIn(browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' })).open)
    expect(s.auth.status()).toMatchObject({ signedIn: true, planEnabled: false })
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: 'sign_in_again' })
  })

  it('refreshes once for concurrent requests and saves the rotated refresh token', async () => {
    let now = Date.now()
    let nonce = ''
    let refreshes = 0
    const s = await setup(
      async (form) => {
        if (form.get('grant_type') === 'refresh_token') {
          refreshes++
          expect(form.get('refresh_token')).toBe('rt1')
          expect(form.get('client_id')).toBe('oaiapp_1')
          expect(form.get('resource')).toBe('https://api.openai.com/v1')
          expect(form.has('scope')).toBe(false)
          await new Promise((r) => setTimeout(r, 10))
          return Response.json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 })
        }
        return Response.json({ access_token: 'at1', refresh_token: 'rt1', id_token: await s.sign({ sub: 'u', nonce }, 'oaiapp_1'), expires_in: 3600, scope: PLAN })
      },
      { now: () => now },
    )
    await s.auth.signIn(browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' })).open)
    now += 3600_000 - 60_000 // a minute left
    const [a, b] = await Promise.all([s.auth.accessToken(), s.auth.accessToken()])
    expect([a, b]).toEqual(['at2', 'at2'])
    expect(refreshes).toBe(1)
    const restarted = new ChatGptAuth({ dataDir: s.dir, secrets: s.secrets, appName: 'x', issuer: ISSUER, fetch: s.net.fetch, now: () => now })
    expect(await restarted.accessToken()).toBe('at2')
  })

  it('clears the session when the refresh token is rejected, keeps it on a 5xx', async () => {
    let now = Date.now()
    let nonce = ''
    let mode: 'down' | 'gone' = 'down'
    const s = await setup(
      async (form) => {
        if (form.get('grant_type') === 'refresh_token')
          return mode === 'down' ? new Response('busy', { status: 503 }) : Response.json({ error: 'invalid_grant' }, { status: 400 })
        return Response.json({ access_token: 'at1', refresh_token: 'rt1', id_token: await s.sign({ sub: 'u', nonce }, 'oaiapp_1'), expires_in: 3600, scope: PLAN })
      },
      { now: () => now },
    )
    await s.auth.signIn(browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' })).open)
    now += 3600_000
    await expect(s.auth.accessToken()).rejects.toThrow(/Couldn’t renew/)
    expect(s.auth.status().signedIn).toBe(true)
    mode = 'gone'
    await expect(s.auth.accessToken()).rejects.toMatchObject({ kind: 'sign_in_again' })
    expect(s.auth.status().signedIn).toBe(false)
    expect(s.secrets.store.size).toBe(0)
  })

  it('revokes the refresh token on sign-out and says when it could not', async () => {
    let nonce = ''
    const s = await setup(async () => Response.json({ access_token: 'at', refresh_token: 'rt', id_token: await s.sign({ sub: 'u', nonce }, 'oaiapp_1'), scope: PLAN }))
    await s.auth.signIn(browser((q) => ((nonce = q.get('nonce')!), { code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' })).open)
    expect(await s.auth.signOut()).toEqual({ revoked: true })
    const revoke = s.net.calls.find((c) => c.url.endsWith('/oauth/revoke'))!
    expect(Object.fromEntries(revoke.form!)).toEqual({ token: 'rt', token_type_hint: 'refresh_token', client_id: 'oaiapp_1' })
    expect(s.auth.status().signedIn).toBe(false)
    expect(s.secrets.store.size).toBe(0)
  })

  it('can be cancelled while waiting for the browser', async () => {
    const s = await setup(async () => Response.json({}))
    const p = s.auth.signIn(() => {})
    await new Promise((r) => setTimeout(r, 10))
    expect(s.auth.signingIn).toBe(true)
    s.auth.cancel()
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
    expect(s.auth.signingIn).toBe(false)
  })
})
