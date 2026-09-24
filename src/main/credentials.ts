/**
 * The only module in Flowdo that touches secrets: the Todoist API token and the per-feed
 * iCal secret addresses (an iCal feed URL usually embeds a capability token, so it is a
 * credential in its own right, not just a URL).
 *
 * Storage is the `credentials` table from migration v2 (`key`, `ciphertext BLOB`,
 * `updated_at`), reached through `getDb()`. Values are encrypted with Electron's
 * `safeStorage` (DPAPI on Windows, Keychain on macOS, a keyring — or nothing — on Linux)
 * before they ever reach SQLite. There is deliberately no plaintext fallback: a machine
 * without real OS-backed encryption simply cannot store a secret in Flowdo.
 *
 * `getDb()` and `safeStorage` are both imported lazily-by-call (not memoised here) so that
 * tests can swap the `electron` mock's `safeStorage` behaviour per-case without reaching
 * into module internals.
 */

import { safeStorage } from 'electron'
import { getDb, num, type Row } from './db'

export class SecureStorageUnavailableError extends Error {
  constructor(key: string) {
    super(`credentials: secure storage is unavailable, refusing to store '${key}'`)
    this.name = 'SecureStorageUnavailableError'
  }
}

/**
 * True only if secrets can be stored ENCRYPTED.
 *
 * `safeStorage.isEncryptionAvailable()` alone is not enough on Linux: without a keyring
 * running, Electron silently falls back to a `'basic_text'` backend, which is not
 * encryption at all — it round-trips the string through `safeStorage` unmodified. Any
 * backend other than `'basic_text'` (or the unrecognised `'unknown'`) is treated as real.
 *
 * `getSelectedStorageBackend` is Linux-only in intent and throws on some Electron versions
 * when called off-Linux, so it is only ever called when `process.platform === 'linux'`.
 */
export function isSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false

  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.()
    if (backend === 'basic_text' || backend === 'unknown') return false
  }

  return true
}

/** Encrypt and upsert. Throws `SecureStorageUnavailableError` rather than store plaintext. */
export function setSecret(key: string, value: string): void {
  if (!isSecureStorageAvailable()) {
    throw new SecureStorageUnavailableError(key)
  }

  const ciphertext = safeStorage.encryptString(value)
  getDb()
    .prepare(
      `INSERT INTO credentials (key, ciphertext, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`
    )
    .run(key, ciphertext, Date.now())
}

/**
 * Decrypted value, or `null` if absent OR undecryptable (e.g. the profile moved to another
 * machine — DPAPI/Keychain ciphertext does not travel). Never throws for a missing or
 * garbled row: a caller reading a secret at startup must never crash the app over it.
 */
export function getSecret(key: string): string | null {
  const row = getDb().prepare('SELECT ciphertext FROM credentials WHERE key = ?').get(key) as
    | Row
    | undefined
  if (!row) return null

  const ciphertext = row['ciphertext']
  if (!(ciphertext instanceof Uint8Array)) return null

  if (!safeStorage.isEncryptionAvailable()) return null

  try {
    const buffer = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext)
    return safeStorage.decryptString(buffer)
  } catch {
    return null
  }
}

export function hasSecret(key: string): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM credentials WHERE key = ?')
    .get(key) as Row | undefined
  if (!row) return false
  return num(row, 'c') > 0
}

export function deleteSecret(key: string): void {
  getDb().prepare('DELETE FROM credentials WHERE key = ?').run(key)
}

/**
 * Delete every key with the given prefix, e.g. `deleteSecretsWithPrefix('ical.')` when
 * wiping every feed URL.
 *
 * Deliberately not a `LIKE 'prefix%'` query: `%` and `_` are LIKE wildcards, and a key
 * (a feed id, say) could legitimately contain either. Comparing a literal prefix of the
 * stored key instead sidesteps escaping entirely.
 */
export function deleteSecretsWithPrefix(prefix: string): void {
  getDb()
    .prepare('DELETE FROM credentials WHERE substr(key, 1, ?) = ?')
    .run(prefix.length, prefix)
}
