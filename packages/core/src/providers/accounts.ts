import type { ProviderAccount, ProviderConfig } from '../settings/schema.js'
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from './types.js'

// Several accounts (API keys) per provider. Settings hold the account list; keys live in the
// keychain under `accountKeyId()`. When an account hits a rate limit, runs out of credits or has
// its key rejected, `RotatingProvider` cools it down and retries the request on the next one.

/** The account every provider has before the user adds more. Its key is stored under the plain provider id. */
export const DEFAULT_ACCOUNT_ID = 'default'

/** Statuses that move a request to the next account: rate limit, payment/quota, key rejected. */
export const ROTATE_STATUSES = [401, 402, 403, 429] as const

/** Where an account's key is stored: `<providerId>` for the default account, else `<providerId>#<accountId>`. */
export function accountKeyId(providerId: string, accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? providerId : `${providerId}#${accountId}`
}

/** The provider's accounts in order. Without any configured, the implicit default account (the single key). */
export function providerAccounts(config: Pick<ProviderConfig, 'accounts'>): ProviderAccount[] {
  return config.accounts?.length ? config.accounts : [{ id: DEFAULT_ACCOUNT_ID, label: 'Default', enabled: true }]
}

/** Enabled accounts in the order they're tried: the active one first, then the rest in list order. */
export function accountOrder(config: Pick<ProviderConfig, 'accounts' | 'activeAccount'>): ProviderAccount[] {
  const on = providerAccounts(config).filter((a) => a.enabled)
  const i = on.findIndex((a) => a.id === config.activeAccount)
  return i > 0 ? [on[i], ...on.slice(0, i), ...on.slice(i + 1)] : on
}

/** True when any enabled account has a key. */
export function hasAccountKey(config: ProviderConfig, has: (keyId: string) => boolean): boolean {
  return accountOrder(config).some((a) => has(accountKeyId(config.id, a.id)))
}

/** Key of the account tried first (the active one, skipping keyless and cooling-down ones when another can serve). */
export function activeAccountKey(config: ProviderConfig, getKey: (keyId: string) => string | undefined, cooldowns?: AccountCooldowns): string | undefined {
  const keyed = accountOrder(config).filter((a) => getKey(accountKeyId(config.id, a.id)))
  const pick = keyed.find((a) => !cooldowns?.get(config.id, a.id)) ?? keyed[0]
  return pick ? getKey(accountKeyId(config.id, pick.id)) : undefined
}

export interface Cooldown {
  /** Epoch ms when the account is tried again. */
  until: number
  /** Why, as a phrase after the account name: "hit a rate limit". */
  reason: string
}

const MINUTE = 60_000

/**
 * How long an account rests after this error, or null when the error isn't the account's fault
 * (bad request, outage, network) and another account wouldn't help.
 */
export function cooldownFor(err: unknown): { ms: number; reason: string } | null {
  if (!(err instanceof ProviderError) || err.status == null) return null
  const longQuota = /quota|credit|billing|balance|per[- ]day|daily/i.test(err.message)
  switch (err.status) {
    case 429:
      if (longQuota) return { ms: 30 * MINUTE, reason: 'ran out of quota' }
      return { ms: Math.min(Math.max(err.retryAfterMs ?? MINUTE, 5_000), 60 * MINUTE), reason: 'hit a rate limit' }
    case 402:
      return { ms: 30 * MINUTE, reason: 'ran out of credits' }
    case 401:
    case 403:
      return { ms: 30 * MINUTE, reason: 'had its key rejected' }
    default:
      return null
  }
}

/** Accounts resting after a failure. Shared across registry rebuilds so a settings change doesn't forget them. */
export class AccountCooldowns {
  private map = new Map<string, Cooldown>()

  constructor(private readonly now: () => number = Date.now) {}

  private key(providerId: string, accountId: string) {
    return `${providerId}\u0000${accountId}`
  }

  cool(providerId: string, accountId: string, ms: number, reason: string): void {
    this.map.set(this.key(providerId, accountId), { until: this.now() + ms, reason })
  }

  /** The active cooldown, if any. */
  get(providerId: string, accountId: string): Cooldown | undefined {
    const k = this.key(providerId, accountId)
    const c = this.map.get(k)
    if (c && c.until <= this.now()) this.map.delete(k)
    return c && c.until > this.now() ? c : undefined
  }

  /** Forget one account's cooldown (its key changed), or all of a provider's. */
  clear(providerId: string, accountId?: string): void {
    if (accountId != null) this.map.delete(this.key(providerId, accountId))
    else for (const k of [...this.map.keys()]) if (k.startsWith(`${providerId}\u0000`)) this.map.delete(k)
  }
}

export interface AccountProvider {
  account: ProviderAccount
  provider: Provider
}

/**
 * One provider over several accounts. Requests go to the first account that isn't cooling down;
 * a rate-limit, quota or key error before any output cools that account and retries on the next,
 * with a status line saying so. When every account is resting, the one free soonest is tried, so
 * the real error surfaces and fallback models can take over.
 */
export class RotatingProvider implements Provider {
  readonly id: string
  readonly name: string

  constructor(
    config: ProviderConfig,
    private readonly accounts: AccountProvider[],
    private readonly cooldowns: AccountCooldowns,
  ) {
    if (!accounts.length) throw new Error(`${config.name} has no accounts`)
    this.id = config.id
    this.name = config.name
  }

  unavailable(modelId: string): boolean {
    return !!this.accounts[0].provider.unavailable?.(modelId)
  }

  private candidates(): AccountProvider[] {
    const ready = this.accounts.filter((a) => !this.cooldowns.get(this.id, a.account.id))
    if (ready.length) return ready
    const until = (a: AccountProvider) => this.cooldowns.get(this.id, a.account.id)?.until ?? 0
    return [...this.accounts].sort((a, b) => until(a) - until(b)).slice(0, 1)
  }

  private fail(a: AccountProvider, err: unknown): { ms: number; reason: string } | null {
    const c = cooldownFor(err)
    if (c) this.cooldowns.cool(this.id, a.account.id, c.ms, c.reason)
    return c
  }

  async listModels(signal?: AbortSignal) {
    const list = this.candidates()
    for (let i = 0; ; i++) {
      try {
        return await list[i].provider.listModels(signal)
      } catch (e) {
        if (!this.fail(list[i], e) || signal?.aborted || i === list.length - 1) throw e
      }
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const list = this.candidates()
    let prev: { label: string; reason: string } | undefined
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      const last = i === list.length - 1
      if (prev) yield { type: 'status', text: `Switched to account ${a.account.label} (${prev.label} ${prev.reason}).` }
      let started = false
      try {
        for await (const ev of a.provider.chat(last ? req : { ...req, failFast: true })) {
          if (ev.type !== 'status') started = true
          yield ev
        }
        this.cooldowns.clear(this.id, a.account.id)
        return
      } catch (e) {
        if (req.signal?.aborted) throw e
        const c = this.fail(a, e)
        if (!c || started || last) throw e
        prev = { label: a.account.label, reason: c.reason }
      }
    }
  }
}
