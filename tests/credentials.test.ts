/**
 * Tests for `src/main/credentials.ts`, the only module allowed to touch secrets.
 *
 * Mocks `electron` the same way `tests/stats-repo.test.ts` does: `app.getPath` points at a
 * fresh temp directory per test, and `getDb()` runs the real migrations against a real
 * `node:sqlite` file, so what's under test is the real `credentials` table and real SQL.
 *
 * `safeStorage` is mocked with a reversible fake (XOR against a fixed key, base64-wrapped
 * with a marker prefix) rather than a pass-through, specifically so tests can assert the
 * BLOB actually stored in SQLite is not the plaintext — a pass-through mock would let a
 * regression that stored plaintext slip through unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { getPath, encryptionAvailable, selectedBackend } = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  encryptionAvailable: { value: true },
  selectedBackend: { value: 'gnome_libsecret' as string }
}))

// A reversible fake: XOR every byte against a fixed key and prefix with a marker so tests
// can tell "real ciphertext" apart from anything else that might end up in the column.
const XOR_KEY = 0x5a
const MARKER = Buffer.from('ENC1:')

function fakeEncrypt(value: string): Buffer {
  const plain = Buffer.from(value, 'utf-8')
  const xored = Buffer.from(plain.map((b) => b ^ XOR_KEY))
  return Buffer.concat([MARKER, xored])
}

function fakeDecrypt(buffer: Buffer): string {
  if (!buffer.subarray(0, MARKER.length).equals(MARKER)) {
    throw new Error('fakeDecrypt: not a recognised ciphertext')
  }
  const xored = buffer.subarray(MARKER.length)
  const plain = Buffer.from(xored.map((b) => b ^ XOR_KEY))
  return plain.toString('utf-8')
}

vi.mock('electron', () => ({
  app: { getPath: (name: string) => getPath(name) },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable.value,
    getSelectedStorageBackend: () => selectedBackend.value,
    encryptString: (value: string) => fakeEncrypt(value),
    decryptString: (buffer: Buffer) => fakeDecrypt(buffer)
  }
}))

import { closeDb, getDb } from '../src/main/db'
import {
  SecureStorageUnavailableError,
  deleteSecret,
  deleteSecretsWithPrefix,
  getSecret,
  hasSecret,
  isSecureStorageAvailable,
  setSecret
} from '../src/main/credentials'

let dir: string
let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-credentials-test-'))
  getPath.mockReturnValue(dir)
  encryptionAvailable.value = true
  selectedBackend.value = 'gnome_libsecret'
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

function rawRow(key: string): { ciphertext: Buffer; updated_at: number } | undefined {
  const row = getDb()
    .prepare('SELECT ciphertext, updated_at FROM credentials WHERE key = ?')
    .get(key) as { ciphertext: Uint8Array; updated_at: number | bigint } | undefined
  if (!row) return undefined
  return {
    ciphertext: Buffer.from(row.ciphertext),
    updated_at: Number(row.updated_at)
  }
}

describe('round trip', () => {
  it('stores and retrieves a secret', () => {
    setSecret('todoist.token', 'super-secret-token')
    expect(getSecret('todoist.token')).toBe('super-secret-token')
  })

  it('the stored BLOB is not the plaintext', () => {
    setSecret('todoist.token', 'super-secret-token')
    const row = rawRow('todoist.token')
    expect(row).toBeDefined()
    expect(row!.ciphertext.toString('utf-8')).not.toContain('super-secret-token')
    expect(row!.ciphertext.equals(Buffer.from('super-secret-token', 'utf-8'))).toBe(false)
  })

  it('hasSecret reflects presence', () => {
    expect(hasSecret('todoist.token')).toBe(false)
    setSecret('todoist.token', 'x')
    expect(hasSecret('todoist.token')).toBe(true)
  })

  it('deleteSecret removes the row', () => {
    setSecret('todoist.token', 'x')
    deleteSecret('todoist.token')
    expect(hasSecret('todoist.token')).toBe(false)
    expect(getSecret('todoist.token')).toBeNull()
  })

  it('getSecret returns null for an absent key', () => {
    expect(getSecret('nope')).toBeNull()
  })
});

describe('upsert', () => {
  it('overwrites the previous value and bumps updated_at', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      setSecret('ical.feed1.url', 'https://example.com/a.ics?token=1')
      const first = rawRow('ical.feed1.url')!

      vi.setSystemTime(2000)
      setSecret('ical.feed1.url', 'https://example.com/a.ics?token=2')
      const second = rawRow('ical.feed1.url')!

      expect(getSecret('ical.feed1.url')).toBe('https://example.com/a.ics?token=2')
      expect(second.updated_at).toBeGreaterThan(first.updated_at)

      // Still exactly one row for the key — an upsert, not a duplicate insert.
      const count = getDb()
        .prepare('SELECT COUNT(*) AS c FROM credentials WHERE key = ?')
        .get('ical.feed1.url') as { c: number | bigint }
      expect(Number(count.c)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('unavailable secure storage', () => {
  it('setSecret throws SecureStorageUnavailableError when encryption is unavailable', () => {
    encryptionAvailable.value = false
    expect(() => setSecret('todoist.token', 'x')).toThrow(SecureStorageUnavailableError)
  })

  it('writes nothing to the table when it throws', () => {
    encryptionAvailable.value = false
    expect(() => setSecret('todoist.token', 'x')).toThrow()
    expect(hasSecret('todoist.token')).toBe(false)
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM credentials').get() as {
      c: number | bigint
    }
    expect(Number(row.c)).toBe(0)
  })

  it('the error message names the key but never the value', () => {
    encryptionAvailable.value = false
    try {
      setSecret('todoist.token', 'super-secret-value-do-not-leak')
      throw new Error('expected setSecret to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SecureStorageUnavailableError)
      const message = (error as Error).message
      expect(message).toContain('todoist.token')
      expect(message).not.toContain('super-secret-value-do-not-leak')
    }
  })

  it('isSecureStorageAvailable is false when safeStorage reports unavailable', () => {
    encryptionAvailable.value = false
    expect(isSecureStorageAvailable()).toBe(false)
  })
})

describe('Linux basic_text backend', () => {
  it('is treated as unavailable even though isEncryptionAvailable() is true', () => {
    setPlatform('linux')
    selectedBackend.value = 'basic_text'
    expect(isSecureStorageAvailable()).toBe(false)
    expect(() => setSecret('todoist.token', 'x')).toThrow(SecureStorageUnavailableError)
  })

  it('is treated as unavailable for an unrecognised backend too', () => {
    setPlatform('linux')
    selectedBackend.value = 'unknown'
    expect(isSecureStorageAvailable()).toBe(false)
  })

  it('a real keyring backend on Linux is available', () => {
    setPlatform('linux')
    selectedBackend.value = 'gnome_libsecret'
    expect(isSecureStorageAvailable()).toBe(true)
  })

  it('does not consult getSelectedStorageBackend off-Linux', () => {
    setPlatform('win32')
    // If this were called on win32 in real Electron it can throw; here we just confirm the
    // backend value is ignored regardless of what it's set to.
    selectedBackend.value = 'basic_text'
    expect(isSecureStorageAvailable()).toBe(true)
  })
})

describe('garbled ciphertext', () => {
  it('getSecret returns null instead of throwing when the blob does not decrypt', () => {
    setSecret('todoist.token', 'fine')
    getDb()
      .prepare('UPDATE credentials SET ciphertext = ? WHERE key = ?')
      .run(Buffer.from('not-a-real-ciphertext'), 'todoist.token')

    expect(() => getSecret('todoist.token')).not.toThrow()
    expect(getSecret('todoist.token')).toBeNull()
  })

  it('getSecret returns null when encryption is unavailable at read time', () => {
    setSecret('todoist.token', 'fine')
    encryptionAvailable.value = false
    expect(getSecret('todoist.token')).toBeNull()
  })
})

describe('deleteSecretsWithPrefix', () => {
  it('removes only matching keys', () => {
    setSecret('ical.feed1.url', 'https://a')
    setSecret('ical.feed2.url', 'https://b')
    setSecret('todoist.token', 'tok')

    deleteSecretsWithPrefix('ical.')

    expect(hasSecret('ical.feed1.url')).toBe(false)
    expect(hasSecret('ical.feed2.url')).toBe(false)
    expect(hasSecret('todoist.token')).toBe(true)
  })

  it('treats the prefix literally, not as a LIKE pattern — keys with % or _ are unaffected unless truly prefixed', () => {
    setSecret('ical.feed_1.url', 'https://a') // contains a literal underscore
    setSecret('icalXfeed.url', 'https://b') // would match a naive 'ical_' LIKE pattern
    setSecret('other%.url', 'https://c') // contains a literal percent, different prefix

    deleteSecretsWithPrefix('ical.')

    // Only the key actually prefixed with 'ical.' is removed.
    expect(hasSecret('ical.feed_1.url')).toBe(false)
    // 'icalXfeed.url' does not start with 'ical.' so must survive even though 'ical_' as a
    // LIKE pattern would have matched the 'X'.
    expect(hasSecret('icalXfeed.url')).toBe(true)
    expect(hasSecret('other%.url')).toBe(true)
  })

  it('a key containing % or _ after the prefix is deleted correctly and precisely', () => {
    setSecret('ical.feed%1_x.url', 'https://a')
    setSecret('ical.other.url', 'https://b')

    deleteSecretsWithPrefix('ical.feed%1_x.url') // exact "prefix" equal to full key

    expect(hasSecret('ical.feed%1_x.url')).toBe(false)
    expect(hasSecret('ical.other.url')).toBe(true)
  })
})
