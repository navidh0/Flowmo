/**
 * `src/main/integrations/ical/timezone.ts` in isolation: node-ical already resolves the
 * ordinary cases (VTIMEZONE blocks, bare IANA TZIDs — see `tests/ical-parse.test.ts`), so
 * this covers the fallback path directly: a raw Windows display name, an invalid/garbage
 * value, and the UTC aliases the contract wants folded to `null`.
 */
import { describe, expect, it } from 'vitest'
import { resolveTimeZone } from '../src/main/integrations/ical/timezone'

describe('resolveTimeZone', () => {
  it('returns null for a missing or empty value', () => {
    expect(resolveTimeZone(null)).toBeNull()
    expect(resolveTimeZone(undefined)).toBeNull()
    expect(resolveTimeZone('')).toBeNull()
    expect(resolveTimeZone('   ')).toBeNull()
  })

  it('returns null for UTC and its aliases rather than an "Etc/UTC" label', () => {
    expect(resolveTimeZone('UTC')).toBeNull()
    expect(resolveTimeZone('Etc/UTC')).toBeNull()
    expect(resolveTimeZone('GMT')).toBeNull()
  })

  it('passes a valid IANA zone through unchanged', () => {
    expect(resolveTimeZone('Asia/Tehran')).toBe('Asia/Tehran')
    expect(resolveTimeZone('Europe/Berlin')).toBe('Europe/Berlin')
  })

  it('maps a raw Windows display name to its IANA equivalent', () => {
    expect(resolveTimeZone('(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna')).toBe(
      'Europe/Berlin'
    )
  })

  it('returns null for a value that resolves to nothing real', () => {
    expect(resolveTimeZone('not a real zone')).toBeNull()
    expect(resolveTimeZone('tzone://Microsoft/Custom')).toBeNull()
  })
})
