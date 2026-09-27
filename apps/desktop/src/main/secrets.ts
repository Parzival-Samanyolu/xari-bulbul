import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

/**
 * API keys, encrypted with the OS keychain (macOS Keychain, Windows DPAPI, libsecret/kwallet on Linux).
 * Keys never leave the main process; the renderer only learns whether a key is set.
 */
export class SecretStore {
  private cache: Record<string, string> = {}

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
      for (const [id, b64] of Object.entries(raw)) {
        try {
          this.cache[id] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
        } catch {
          /* unreadable (different machine/user) — treat as unset */
        }
      }
    } catch {
      /* no file yet */
    }
  }

  /** 'basic' means Linux had no keyring and Electron fell back to weak obfuscation. */
  get storage(): 'os' | 'basic' {
    if (process.platform !== 'linux') return 'os'
    try {
      return safeStorage.getSelectedStorageBackend() === 'basic_text' ? 'basic' : 'os'
    } catch {
      return 'basic'
    }
  }

  get(id: string): string | undefined {
    return this.cache[id] || process.env[`${id.toUpperCase().replace(/-/g, '_')}_API_KEY`] || undefined
  }

  has(id: string): boolean {
    return !!this.get(id)
  }

  set(id: string, key: string | null): void {
    if (key && key.trim()) this.cache[id] = key.trim()
    else delete this.cache[id]
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.cache)) out[k] = safeStorage.encryptString(v).toString('base64')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 })
  }
}
