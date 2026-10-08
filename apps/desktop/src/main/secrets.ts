import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { detectSecretBackend, KeyStore, type SecretBackend } from '@harness/core'

/**
 * Electron's safeStorage-encrypted JSON file. Used only when no OS keychain is reachable
 * (Linux without a Secret Service); the keys then stay desktop-only.
 */
class SafeStorageFile implements SecretBackend {
  readonly kind = 'file'
  private cache: Record<string, string> = {}

  constructor(private readonly file: string) {
    this.cache = readSafeStorageFile(file)
  }

  get(id: string) {
    return this.cache[id]
  }

  set(id: string, value: string) {
    this.cache[id] = value
    this.write()
  }

  delete(id: string) {
    delete this.cache[id]
    this.write()
  }

  private write() {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.cache)) out[k] = safeStorage.encryptString(v).toString('base64')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 })
  }
}

function readSafeStorageFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    for (const [id, b64] of Object.entries(raw)) {
      try {
        out[id] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
      } catch {
        /* unreadable (different machine/user) — treat as unset */
      }
    }
  } catch {
    /* no file */
  }
  return out
}

/**
 * API keys and MCP tokens, in the OS keychain (macOS Keychain, libsecret on Linux) shared with
 * the `xb` terminal app. Keys never leave the main process; the renderer only learns whether a
 * key is set. `<PROVIDER>_API_KEY` env vars win over stored keys.
 */
export class SecretStore {
  private readonly keys: KeyStore

  constructor(private readonly file: string) {
    const backend = detectSecretBackend(path.dirname(file))
    // If the keychain is missing or migration fails, keep using the old file so no key is lost.
    const keychain = backend.kind !== 'file' && this.migrate(backend)
    this.keys = new KeyStore(keychain ? backend : new SafeStorageFile(file))
  }

  /**
   * Moves keys from the old safeStorage file (≤ 0.1.x) into the keychain. The file is renamed only
   * after every readable key is stored and reads back identically, so nothing is lost on failure.
   */
  private migrate(backend: SecretBackend): boolean {
    if (!fs.existsSync(this.file)) return true
    const old = readSafeStorageFile(this.file)
    try {
      for (const [id, value] of Object.entries(old)) {
        if (backend.get(id) !== value) backend.set(id, value)
        if (backend.get(id) !== value) throw new Error(`could not verify ${id}`)
      }
      fs.renameSync(this.file, `${this.file}.migrated`)
      return true
    } catch (e) {
      console.error('Keeping secrets.json; keychain migration failed:', (e as Error).message)
      return false
    }
  }

  /** 'basic' means Linux had no keyring and Electron fell back to weak obfuscation. */
  get storage(): 'os' | 'basic' {
    if (this.keys.storage !== 'file') return 'os'
    if (process.platform !== 'linux') return 'os'
    try {
      return safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'basic' : 'os'
    } catch {
      return 'basic'
    }
  }

  get(id: string): string | undefined {
    return this.keys.get(id)
  }

  has(id: string): boolean {
    return this.keys.has(id)
  }

  set(id: string, key: string | null): void {
    this.keys.set(id, key)
  }
}
