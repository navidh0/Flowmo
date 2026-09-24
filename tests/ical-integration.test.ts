/**
 * End-to-end behaviour of `createCalendarIntegration`, against a real `node:sqlite` file
 * (through the mocked-`electron` `getDb()` pattern — see `tests/stats-repo.test.ts`) and a
 * mocked `src/main/credentials.ts` (an in-memory secret store standing in for the real
 * safeStorage-backed module, which is a concurrent agent's frozen API).
 *
 * TZ is pinned to a DST-observing zone for the same reason as `tests/ical-parse.test.ts`.
 */
process.env.TZ = 'America/Los_Angeles'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => getPath(name) }
}))

const { secrets, secureAvailable } = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  secureAvailable: { value: true }
}))
vi.mock('../src/main/credentials', () => ({
  isSecureStorageAvailable: () => secureAvailable.value,
  setSecret: (key: string, value: string) => {
    if (!secureAvailable.value) throw new Error('secure storage unavailable')
    secrets.set(key, value)
  },
  getSecret: (key: string) => secrets.get(key) ?? null,
  hasSecret: (key: string) => secrets.has(key),
  deleteSecret: (key: string) => {
    secrets.delete(key)
  },
  deleteSecretsWithPrefix: (prefix: string) => {
    for (const key of Array.from(secrets.keys())) {
      if (key.startsWith(prefix)) secrets.delete(key)
    }
  },
  SecureStorageUnavailableError: class SecureStorageUnavailableError extends Error {}
}))

import { closeDb, getDb } from '../src/main/db'
import { createCalendarIntegration, type CalendarIntegration } from '../src/main/integrations/ical'
import type { DataChangedScope } from '@shared/types'

const fixture = readFileSync(join(__dirname, 'fixtures/basic.ics'), 'utf8')

let dir: string
let onDataChanged: ReturnType<typeof vi.fn<(scope: DataChangedScope) => void>>
let nowMs: number
let fetchMock: ReturnType<typeof vi.fn>
let integration: CalendarIntegration

// 2026-06-01 local noon: the refresh window [today-14, today+60] then covers every date used
// in the fixture (2026-06-01 .. 2026-07-06).
const FIXED_NOW = new Date(2026, 5, 1, 12, 0, 0).getTime()

function icsResponse(
  body: string,
  init: { status?: number; etag?: string; lastModified?: string } = {}
): Response {
  const headers: Record<string, string> = { 'content-type': 'text/calendar' }
  if (init.etag) headers['etag'] = init.etag
  if (init.lastModified) headers['last-modified'] = init.lastModified
  const status = init.status ?? 200
  // A 304 (or any 204/205) response must not carry a body, or the Response constructor throws.
  return new Response(status === 304 ? null : body, { status, headers })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-ical-test-'))
  getPath.mockReturnValue(dir)
  secrets.clear()
  secureAvailable.value = true
  nowMs = FIXED_NOW
  onDataChanged = vi.fn<(scope: DataChangedScope) => void>()
  fetchMock = vi.fn()
  integration = createCalendarIntegration({
    fetch: fetchMock as unknown as typeof fetch,
    now: () => nowMs,
    onDataChanged
  })
})

afterEach(() => {
  integration.stop()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function countEventRows(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM calendar_events').get() as
    | Record<string, unknown>
    | undefined
  return row ? Number(row['c']) : 0
}

function countFeedRows(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM calendar_feeds').get() as
    | Record<string, unknown>
    | undefined
  return row ? Number(row['c']) : 0
}

describe('add', () => {
  it('fetches and parses before inserting, stores the URL secret, and caches events', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture, { etag: '"v1"' }))

    const feed = await integration.add({ name: 'Work', url: 'https://example.com/private-token/basic.ics' })

    expect(feed.id).toBeGreaterThan(0)
    expect(feed.name).toBe('Work')
    expect(feed.lastError).toBeNull()
    expect(secrets.get(`ical.${feed.id}.url`)).toBe('https://example.com/private-token/basic.ics')
    expect(countEventRows()).toBeGreaterThan(0)
  })

  it('rewrites webcal:// to https://', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))

    const feed = await integration.add({ name: 'Cal', url: 'webcal://example.com/feed.ics' })

    expect(secrets.get(`ical.${feed.id}.url`)).toBe('https://example.com/feed.ics')
    const [calledUrl] = fetchMock.mock.calls[0] as [string, unknown]
    expect(calledUrl).toBe('https://example.com/feed.ics')
  })

  it('leaves no row and no secret when the URL is bad', async () => {
    await expect(integration.add({ name: 'Bad', url: 'not a url' })).rejects.toThrow()

    expect(countFeedRows()).toBe(0)
    expect(secrets.size).toBe(0)
    // fetch must never even be attempted against an invalid URL.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves no row and no secret when the body does not parse', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse('not a calendar'))

    await expect(integration.add({ name: 'Bad body', url: 'https://example.com/x.ics' })).rejects.toThrow()

    expect(countFeedRows()).toBe(0)
    expect(secrets.size).toBe(0)
  })

  it('leaves no row and no secret on a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'))

    await expect(integration.add({ name: 'Down', url: 'https://example.com/x.ics' })).rejects.toThrow()

    expect(countFeedRows()).toBe(0)
    expect(secrets.size).toBe(0)
  })

  it('refuses when secure storage is unavailable, before ever fetching', async () => {
    secureAvailable.value = false

    await expect(integration.add({ name: 'X', url: 'https://example.com/x.ics' })).rejects.toThrow()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(countFeedRows()).toBe(0)
  })
})

describe('eventsRange', () => {
  async function addFixtureFeed(): Promise<number> {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))
    const feed = await integration.add({ name: 'Fixture', url: 'https://example.com/x.ics' })
    return feed.id
  }

  it('shows a single-day all-day event on its local day and not the day before or after', async () => {
    await addFixtureFeed()

    const day = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getTime()

    const onThe3rd = integration.eventsRange(day(2026, 6, 3), day(2026, 6, 4))
    expect(onThe3rd.some((e) => e.title === 'Single all-day event')).toBe(true)

    const onThe2nd = integration.eventsRange(day(2026, 6, 2), day(2026, 6, 3))
    expect(onThe2nd.some((e) => e.title === 'Single all-day event')).toBe(false)

    const onThe4th = integration.eventsRange(day(2026, 6, 4), day(2026, 6, 5))
    expect(onThe4th.some((e) => e.title === 'Single all-day event')).toBe(false)
  })

  it('returns the moved override at its moved time and not the original slot', async () => {
    await addFixtureFeed()

    const events = integration.eventsRange(Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 10))
    const moved = events.find((e) => e.title === 'Weekly standup (moved)')
    expect(moved).toBeDefined()
    if (!moved || moved.allDay) throw new Error('expected a timed event')
    expect(moved.startMs).toBe(Date.UTC(2026, 5, 15, 20, 30))

    // The original 14:00-local slot on the same day must be gone.
    expect(events.some((e) => !e.allDay && e.startMs === Date.UTC(2026, 5, 15, 18, 0))).toBe(false)
  })

  it('omits the EXDATE and the cancelled instance', async () => {
    await addFixtureFeed()

    const events = integration.eventsRange(Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 10))
    expect(events.some((e) => !e.allDay && e.startMs === Date.UTC(2026, 5, 8, 18, 0))).toBe(false)
    expect(events.some((e) => !e.allDay && e.startMs === Date.UTC(2026, 5, 22, 18, 0))).toBe(false)
  })

  it('excludes events from a disabled feed', async () => {
    const feedId = await addFixtureFeed()
    integration.update(feedId, { enabled: false })

    const events = integration.eventsRange(Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 10))
    expect(events).toHaveLength(0)
  })

  it('sorts results by start', async () => {
    await addFixtureFeed()

    const events = integration.eventsRange(Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 10))
    const keys = events.map((e) =>
      e.allDay ? new Date(e.startDate).getTime() : e.startMs
    )
    const sorted = [...keys].sort((a, b) => a - b)
    expect(keys).toEqual(sorted)
  })
})

describe('refreshNow', () => {
  it('sends conditional headers and keeps the cache on 304, updating lastOkAt', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture, { etag: '"v1"' }))
    const feed = await integration.add({ name: 'Fixture', url: 'https://example.com/x.ics' })
    const before = integration.eventsRange(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))

    fetchMock.mockResolvedValueOnce(icsResponse('', { status: 304 }))
    nowMs = FIXED_NOW + 60_000
    const [updated] = await integration.refreshNow()

    const [, options] = fetchMock.mock.calls[1] as [string, RequestInit]
    const headers = options.headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('"v1"')

    expect(updated?.id).toBe(feed.id)
    expect(updated?.lastOkAt).toBe(nowMs)
    const after = integration.eventsRange(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))
    expect(after).toEqual(before)
    // Nothing changed on a 304, so no redundant data:changed broadcast.
    expect(onDataChanged).not.toHaveBeenCalled()
  })

  it('keeps the previous cached events and records lastError on a failed refresh', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))
    const feed = await integration.add({ name: 'Fixture', url: 'https://example.com/x.ics' })
    const before = integration.eventsRange(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))

    fetchMock.mockRejectedValueOnce(new Error('network is down'))
    const [updated] = await integration.refreshNow()

    expect(updated?.id).toBe(feed.id)
    expect(updated?.lastError).toBeTruthy()
    const after = integration.eventsRange(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31))
    expect(after).toEqual(before)
  })

  it('clears a previous lastError on the next successful refresh and emits data:changed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    await expect(integration.add({ name: 'X', url: 'https://example.com/x.ics' })).rejects.toThrow()

    // Add succeeds once the feed is reachable.
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))
    const feed = await integration.add({ name: 'X', url: 'https://example.com/x.ics' })
    expect(feed.lastError).toBeNull()

    onDataChanged.mockClear()
    // A second refresh with a change (different ETag/body) should broadcast.
    fetchMock.mockResolvedValueOnce(
      icsResponse(fixture.replace('Single all-day event', 'Renamed all-day event'))
    )
    await integration.refreshNow()
    expect(onDataChanged).toHaveBeenCalledWith('calendar')
  })

  it('refreshes multiple enabled feeds independently', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))
    const feedA = await integration.add({ name: 'A', url: 'https://example.com/a.ics' })
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))
    const feedB = await integration.add({ name: 'B', url: 'https://example.com/b.ics' })

    fetchMock.mockResolvedValueOnce(icsResponse('', { status: 304 }))
    fetchMock.mockRejectedValueOnce(new Error('down'))

    const feeds = await integration.refreshNow()
    const a = feeds.find((f) => f.id === feedA.id)
    const b = feeds.find((f) => f.id === feedB.id)
    expect(a?.lastError).toBeNull()
    expect(b?.lastError).toBeTruthy()
  })
})

describe('remove', () => {
  it('deletes the feed row, its cached events, and its stored secret', async () => {
    fetchMock.mockResolvedValueOnce(icsResponse(fixture))
    const feed = await integration.add({ name: 'Fixture', url: 'https://example.com/x.ics' })
    expect(countEventRows()).toBeGreaterThan(0)

    integration.remove(feed.id)

    expect(countFeedRows()).toBe(0)
    expect(countEventRows()).toBe(0)
    expect(secrets.has(`ical.${feed.id}.url`)).toBe(false)
  })
})

describe('secureStorageAvailable', () => {
  it('reflects the credentials module', () => {
    secureAvailable.value = false
    expect(integration.secureStorageAvailable()).toBe(false)
    secureAvailable.value = true
    expect(integration.secureStorageAvailable()).toBe(true)
  })
})
