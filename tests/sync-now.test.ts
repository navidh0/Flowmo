/**
 * `components/tasks/syncNow.ts` — the pure decision logic behind the Today view's
 * "Sync now" button: which providers count as connected, running only those in parallel
 * without one side's failure blocking the other, and summarizing whatever came back into
 * one line of text.
 */

import { describe, expect, it } from 'vitest'
import type { CalendarFeed, TodoistStatus } from '@shared/types'
import {
  connectedProviders,
  runSync,
  summarizeSync,
  type SyncApi,
  type SyncResult
} from '../src/renderer/src/components/tasks/syncNow'

function todoist(overrides: Partial<TodoistStatus> = {}): TodoistStatus {
  return {
    health: { state: 'ok', lastOkAt: 1000 },
    pendingChanges: 0,
    rejectedChanges: [],
    ...overrides
  }
}

let nextFeedId = 1
function feed(overrides: Partial<CalendarFeed> = {}): CalendarFeed {
  const id = nextFeedId++
  return {
    id,
    name: `Feed ${id}`,
    color: '#22c55e',
    enabled: true,
    lastOkAt: 1000,
    lastError: null,
    ...overrides
  }
}

describe('connectedProviders', () => {
  it('is disconnected for both when there is no status and no feeds', () => {
    expect(connectedProviders(null, [])).toEqual({ todoist: false, calendars: false })
  })

  it('todoist: disconnected health is not connected', () => {
    const status = todoist({ health: { state: 'disconnected' } })
    expect(connectedProviders(status, []).todoist).toBe(false)
  })

  it('todoist: unavailable (no secure storage) is not connected', () => {
    const status = todoist({ health: { state: 'unavailable', reason: 'no-secure-storage' } })
    expect(connectedProviders(status, []).todoist).toBe(false)
  })

  it('todoist: ok is connected', () => {
    const status = todoist({ health: { state: 'ok', lastOkAt: 1000 } })
    expect(connectedProviders(status, []).todoist).toBe(true)
  })

  it('todoist: an error state still counts as connected — there is a connection to retry', () => {
    const status = todoist({
      health: { state: 'error', kind: 'network', message: 'offline', lastOkAt: null, at: 500 }
    })
    expect(connectedProviders(status, []).todoist).toBe(true)
  })

  it('todoist: syncing counts as connected', () => {
    const status = todoist({ health: { state: 'syncing', lastOkAt: null } })
    expect(connectedProviders(status, []).todoist).toBe(true)
  })

  it('calendars: all feeds disabled is not connected', () => {
    const feeds = [feed({ enabled: false }), feed({ enabled: false })]
    expect(connectedProviders(null, feeds).calendars).toBe(false)
  })

  it('calendars: any one enabled feed is connected', () => {
    const feeds = [feed({ enabled: false }), feed({ enabled: true })]
    expect(connectedProviders(null, feeds).calendars).toBe(true)
  })

  it('none connected when todoist is disconnected and no feeds are enabled', () => {
    const status = todoist({ health: { state: 'disconnected' } })
    const feeds = [feed({ enabled: false })]
    expect(connectedProviders(status, feeds)).toEqual({ todoist: false, calendars: false })
  })
})

describe('runSync', () => {
  it('calls only the connected providers', async () => {
    let todoistCalls = 0
    let calendarCalls = 0
    const api: SyncApi = {
      todoist: {
        syncNow: async () => {
          todoistCalls += 1
          return todoist()
        }
      },
      calendars: {
        refreshNow: async () => {
          calendarCalls += 1
          return []
        }
      }
    }

    const result = await runSync(api, { todoist: true, calendars: false })
    expect(todoistCalls).toBe(1)
    expect(calendarCalls).toBe(0)
    expect(result.calendars).toBeNull()
    expect(result.todoist?.ok).toBe(true)
  })

  it('calls neither provider when neither is connected', async () => {
    let calls = 0
    const api: SyncApi = {
      todoist: {
        syncNow: async () => {
          calls += 1
          return todoist()
        }
      },
      calendars: {
        refreshNow: async () => {
          calls += 1
          return []
        }
      }
    }

    const result = await runSync(api, { todoist: false, calendars: false })
    expect(calls).toBe(0)
    expect(result).toEqual({ todoist: null, calendars: null })
  })

  it('one side rejecting never blocks or fails the other', async () => {
    const api: SyncApi = {
      todoist: {
        syncNow: async () => {
          throw new Error('Error: network unreachable')
        }
      },
      calendars: {
        refreshNow: async () => [feed({ name: 'Work' })]
      }
    }

    const result = await runSync(api, { todoist: true, calendars: true })
    expect(result.todoist).toEqual({ ok: false, error: 'network unreachable' })
    expect(result.calendars?.ok).toBe(true)
    if (result.calendars?.ok) {
      expect(result.calendars.value).toHaveLength(1)
    }
  })

  it('the other side rejecting (calendars) never blocks todoist succeeding', async () => {
    const api: SyncApi = {
      todoist: {
        syncNow: async () => todoist()
      },
      calendars: {
        refreshNow: async () => {
          throw new Error('boom')
        }
      }
    }

    const result = await runSync(api, { todoist: true, calendars: true })
    expect(result.todoist?.ok).toBe(true)
    expect(result.calendars).toEqual({ ok: false, error: 'boom' })
  })
})

describe('summarizeSync', () => {
  it('success: "Synced just now" when everything that ran succeeded', () => {
    const now = 100_000
    const result: SyncResult = {
      todoist: { ok: true, value: todoist({ health: { state: 'ok', lastOkAt: now - 1000 } }) },
      calendars: { ok: true, value: [feed({ lastOkAt: now - 1000, lastError: null })] }
    }
    const summary = summarizeSync(result, now)
    expect(summary.ok).toBe(true)
    expect(summary.text).toBe('Synced just now')
  })

  it('success with nothing run (both null) still reports synced', () => {
    const result: SyncResult = { todoist: null, calendars: null }
    const summary = summarizeSync(result, 100_000)
    expect(summary.ok).toBe(true)
    expect(summary.text).toBe('Synced just now')
  })

  it('todoist error health surfaces its message', () => {
    const result: SyncResult = {
      todoist: {
        ok: true,
        value: todoist({
          health: { state: 'error', kind: 'auth', message: 'Todoist rejected the token', lastOkAt: null, at: 900 }
        })
      },
      calendars: null
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(false)
    expect(summary.text).toBe('Todoist: Todoist rejected the token')
  })

  it('a rejected todoist promise counts as a failure with its message', () => {
    const result: SyncResult = {
      todoist: { ok: false, error: 'network unreachable' },
      calendars: null
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(false)
    expect(summary.text).toBe('Todoist: network unreachable')
  })

  it('a single failed enabled feed names it', () => {
    const result: SyncResult = {
      todoist: null,
      calendars: {
        ok: true,
        value: [feed({ name: 'Work', lastError: 'DNS lookup failed' }), feed({ name: 'Personal', lastError: null })]
      }
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(false)
    expect(summary.text).toBe('Calendar "Work" failed')
  })

  it('multiple failed enabled feeds report a count instead of naming each', () => {
    const result: SyncResult = {
      todoist: null,
      calendars: {
        ok: true,
        value: [
          feed({ name: 'Work', lastError: 'boom' }),
          feed({ name: 'Personal', lastError: 'boom' }),
          feed({ name: 'Fine', lastError: null })
        ]
      }
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(false)
    expect(summary.text).toBe('2 calendars failed')
  })

  it('a disabled feed with a stale lastError is not counted as a failure', () => {
    const result: SyncResult = {
      todoist: null,
      calendars: {
        ok: true,
        value: [feed({ name: 'Off', enabled: false, lastError: 'old failure' })]
      }
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(true)
  })

  it('a rejected calendars promise counts as a failure with its message', () => {
    const result: SyncResult = {
      todoist: null,
      calendars: { ok: false, error: 'feed server unreachable' }
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(false)
    expect(summary.text).toBe('Calendars: feed server unreachable')
  })

  it('both providers failing joins both messages', () => {
    const result: SyncResult = {
      todoist: { ok: false, error: 'oops' },
      calendars: {
        ok: true,
        value: [feed({ name: 'Work', lastError: 'boom' })]
      }
    }
    const summary = summarizeSync(result, 1000)
    expect(summary.ok).toBe(false)
    expect(summary.text).toBe('Todoist: oops; Calendar "Work" failed')
  })
})
