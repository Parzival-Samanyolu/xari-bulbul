import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { envKey, resolveDataDir } from './paths.js'

// API keys and MCP tokens, shared by the desktop app and `xb`. Stored in the OS keychain
// through its command-line tools (no native modules, so a single-file binary still works):
// macOS `security`, Linux `secret-tool` (libsecret). Without a keychain, a 0600 file.

export const KEYCHAIN_SERVICE = 'xari-bulbul'

/**
 * The keychain service for a data dir. The default profile uses `xari-bulbul`; a separate
 * profile (HARNESS_DATA_DIR) gets its own service so test profiles never see real keys.
 */
export function keychainService(dataDir: string, defaultDir = resolveDataDir({})): string {
  const norm = (p: string) => path.resolve(p).normalize('NFC')
  if (norm(dataDir) === norm(defaultDir)) return KEYCHAIN_SERVICE
  return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(norm(dataDir)).digest('hex').slice(0, 8)}`
}

export interface ExecResult {
  status: number | null
  stdout: string
  stderr: string
  /** Set when the program could not be started (e.g. not installed). */
  error?: Error
}
export type Exec = (cmd: string, args: string[], input?: string) => ExecResult

export const defaultExec: Exec = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 15_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

export type SecretBackendKind = 'keychain' | 'libsecret' | 'file'

export interface SecretBackend {
  readonly kind: SecretBackendKind
  get(id: string): string | undefined
  set(id: string, value: string): void
  delete(id: string): void
}

/** macOS Keychain via /usr/bin/security. Writes go through `security -i` on stdin so the key never appears in `ps`. */
export class MacKeychain implements SecretBackend {
  readonly kind = 'keychain'
  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly service = KEYCHAIN_SERVICE,
  ) {}

  get(id: string): string | undefined {
    const r = this.exec('security', ['find-generic-password', '-s', this.service, '-a', id, '-w'])
    if (r.status !== 0) return undefined
    return r.stdout.replace(/\n$/, '') || undefined
  }

  set(id: string, value: string): void {
    const label = `Xari Bulbul (${id})`
    // `security -i` tokenizes like a shell; values with quotes or newlines go through argv instead.
    const safe = (s: string) => !/["\\\n\r]/.test(s)
    const r =
      safe(value) && safe(id)
        ? this.exec('security', ['-i'], `add-generic-password -U -s ${this.service} -a "${id}" -l "${label}" -w "${value}"\n`)
        : this.exec('security', ['add-generic-password', '-U', '-s', this.service, '-a', id, '-l', label, '-w', value])
    if (r.error || r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`Keychain write failed: ${(r.stderr || r.error?.message || '').trim()}`)
  }

  delete(id: string): void {
    this.exec('security', ['delete-generic-password', '-s', this.service, '-a', id])
  }
}

/** libsecret (GNOME Keyring, KWallet's Secret Service) via `secret-tool`. The secret goes in on stdin. */
export class LinuxSecretTool implements SecretBackend {
  readonly kind = 'libsecret'
  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly service = KEYCHAIN_SERVICE,
  ) {}

  get(id: string): string | undefined {
    const r = this.exec('secret-tool', ['lookup', 'service', this.service, 'id', id])
    if (r.status !== 0) return undefined
    return r.stdout.replace(/\n$/, '') || undefined
  }

  set(id: string, value: string): void {
    const r = this.exec('secret-tool', ['store', `--label=Xari Bulbul (${id})`, 'service', this.service, 'id', id], value)
    if (r.error || r.status !== 0) throw new Error(`Keyring write failed: ${(r.stderr || r.error?.message || '').trim()}`)
  }

  delete(id: string): void {
    this.exec('secret-tool', ['clear', 'service', this.service, 'id', id])
  }

  /** Installed and able to reach a Secret Service (a missing key exits 1 with no stderr). */
  static available(exec: Exec = defaultExec): boolean {
    const r = exec('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'id', '__probe__'])
    return !r.error && (r.status === 0 || r.status === 1) && !r.stderr.trim()
  }
}

/** Last resort when no keychain is reachable: plain JSON readable only by the user. */
export class FileSecrets implements SecretBackend {
  readonly kind = 'file'
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  private write(data: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.chmodSync(this.file, 0o600)
  }

  get(id: string): string | undefined {
    return this.read()[id] || undefined
  }

  set(id: string, value: string): void {
    this.write({ ...this.read(), [id]: value })
  }

  delete(id: string): void {
    const data = this.read()
    delete data[id]
    this.write(data)
  }
}

export const FALLBACK_SECRETS_FILE = 'xb-secrets.json'

/** The best backend on this machine. */
export function detectSecretBackend(dataDir: string, opts: { platform?: NodeJS.Platform; exec?: Exec; defaultDir?: string } = {}): SecretBackend {
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? defaultExec
  const service = keychainService(dataDir, opts.defaultDir)
  if (platform === 'darwin') return new MacKeychain(exec, service)
  if (platform === 'linux' && LinuxSecretTool.available(exec)) return new LinuxSecretTool(exec, service)
  return new FileSecrets(path.join(dataDir, FALLBACK_SECRETS_FILE))
}

/** Is `id` an MCP token (`mcp:<server>`) rather than a provider key? */
const isMcp = (id: string) => id.startsWith('mcp:')

/**
 * Cached access to secrets. Provider keys from `<PROVIDER>_API_KEY` env vars win over stored ones,
 * so CI and one-off runs never touch the keychain.
 */
export class KeyStore {
  private cache = new Map<string, string | undefined>()

  constructor(
    readonly backend: SecretBackend,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get storage(): SecretBackendKind {
    return this.backend.kind
  }

  /** Where the key for `id` comes from right now. */
  source(id: string): 'env' | 'stored' | null {
    if (!isMcp(id) && envKey(id, this.env)) return 'env'
    return this.stored(id) ? 'stored' : null
  }

  get(id: string): string | undefined {
    return (!isMcp(id) && envKey(id, this.env)) || this.stored(id)
  }

  has(id: string): boolean {
    return !!this.get(id)
  }

  private stored(id: string): string | undefined {
    if (!this.cache.has(id)) {
      let v: string | undefined
      try {
        v = this.backend.get(id)
      } catch {
        v = undefined
      }
      this.cache.set(id, v)
    }
    return this.cache.get(id)
  }

  /** Stores (or with null/empty, removes) a secret. Throws if the keychain refuses. */
  set(id: string, value: string | null): void {
    const v = value?.trim()
    if (v) this.backend.set(id, v)
    else this.backend.delete(id)
    this.cache.set(id, v || undefined)
  }
}
