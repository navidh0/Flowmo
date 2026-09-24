/**
 * `dueTimeFromRemoteDue` (src/main/db/index.ts) and the tasks-repo mapper that uses it.
 *
 * TZ is set to a non-UTC, DST-observing zone BEFORE any `Date` is constructed anywhere in
 * this file (including by imports) — same pattern as tests/stats-repo.test.ts — so a bug
 * where the zoned-due conversion silently assumed UTC would fail regardless of the machine
 * running the suite.
 */
process.env.TZ = 'America/Los_Angeles'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Verify the TZ override actually took effect before trusting any test below. If Node
// picked this up as UTC, `getTimezoneOffset()` on a summer date would be 0.
if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }))

import { closeDb, dueTimeFromRemoteDue, getDb, wallClockInZone } from '../src/main/db'
import * as projectsRepo from '../src/main/db/repo/projects'
import * as tasksRepo from '../src/main/db/repo/tasks'

describe('dueTimeFromRemoteDue', () => {
  it('returns null for a date-only due (no time component)', () => {
    expect(dueTimeFromRemoteDue(JSON.stringify({ date: '2026-06-15', string: 'Jun 15' }))).toBeNull()
  })

  it('takes a floating datetime verbatim, with no zone conversion', () => {
    expect(
      dueTimeFromRemoteDue(JSON.stringify({ date: '2026-06-15T19:00:00', string: 'Jun 15 7pm' }))
    ).toBe('19:00')
  })

  it('converts a zoned (Z) due to the host local time', () => {
    // 2026-06-15T19:00:00Z in America/Los_Angeles (PDT, UTC-7) is 12:00 local.
    expect(
      dueTimeFromRemoteDue(JSON.stringify({ date: '2026-06-15T19:00:00Z', string: 'Jun 15' }))
    ).toBe('12:00')
  })

  it('handles a zoned due that crosses midnight into the previous local day', () => {
    // 2026-06-15T03:00:00Z in America/Los_Angeles (PDT, UTC-7) is 2026-06-14T20:00 local.
    const result = dueTimeFromRemoteDue(
      JSON.stringify({ date: '2026-06-15T03:00:00Z', string: 'Jun 15' })
    )
    expect(result).toBe('20:00')
  })

  it('returns null for malformed JSON', () => {
    expect(dueTimeFromRemoteDue('{not json')).toBeNull()
  })

  it('returns null for an object with no usable date field', () => {
    expect(dueTimeFromRemoteDue(JSON.stringify({ string: 'no date field' }))).toBeNull()
  })

  it('returns null for null input', () => {
    expect(dueTimeFromRemoteDue(null)).toBeNull()
  })

  describe('due.timezone takes priority over the host zone', () => {
    const originalTz = process.env.TZ

    afterEach(() => {
      process.env.TZ = originalTz
    })

    it('the real case: Tehran-authored due read on a Dubai host stays 07:00, not 07:30', () => {
      // Host is Asia/Dubai (+4:00); the due was authored in Asia/Tehran (+3:30). Todoist's
      // own `string` says "every day at 7:00" — that must be what comes back, not the
      // host-local 07:30 that ignoring `timezone` would have produced.
      process.env.TZ = 'Asia/Dubai'
      const remoteDue = JSON.stringify({
        date: '2026-09-24T03:30:00Z',
        string: 'every day at 7:00',
        is_recurring: true,
        timezone: 'Asia/Tehran'
      })
      expect(dueTimeFromRemoteDue(remoteDue)).toBe('07:00')
    })

    it('converts a zoned due to the wall time in due.timezone, not the host zone', () => {
      process.env.TZ = 'Asia/Dubai'
      // 2026-09-24T16:00:00Z in Asia/Tehran (+3:30) is 19:30.
      const remoteDue = JSON.stringify({
        date: '2026-09-24T16:00:00Z',
        string: '7:30pm',
        timezone: 'Asia/Tehran'
      })
      expect(dueTimeFromRemoteDue(remoteDue)).toBe('19:30')
    })

    it('falls back to host-local when due.timezone is not a valid IANA name', () => {
      process.env.TZ = 'America/Los_Angeles'
      // 2026-06-15T19:00:00Z in America/Los_Angeles (PDT, UTC-7) is 12:00 local.
      const remoteDue = JSON.stringify({
        date: '2026-06-15T19:00:00Z',
        string: 'Jun 15',
        timezone: 'Not/AZone'
      })
      expect(dueTimeFromRemoteDue(remoteDue)).toBe('12:00')
    })
  })
})

describe('wallClockInZone', () => {
  it('reads the wall date and time in the given zone, independent of host TZ', () => {
    // 2026-09-24T03:30:00Z is 07:00 in Asia/Tehran (+3:30).
    const ms = Date.parse('2026-09-24T03:30:00Z')
    expect(wallClockInZone(ms, 'Asia/Tehran')).toEqual({ dateKey: '2026-09-24', hhmm: '07:00' })
  })

  it('a due at 23:45 Tehran whose instant already reads as tomorrow in Dubai stays on the Tehran date', () => {
    // 2026-09-24T23:45 in Asia/Tehran (+3:30) is 2026-09-24T20:15:00Z, which is
    // 2026-09-25T00:15 in Asia/Dubai (+4:00) — the next calendar day there.
    const ms = Date.parse('2026-09-24T20:15:00Z')
    expect(wallClockInZone(ms, 'Asia/Dubai')).toEqual({ dateKey: '2026-09-25', hhmm: '00:15' })
    expect(wallClockInZone(ms, 'Asia/Tehran')).toEqual({ dateKey: '2026-09-24', hhmm: '23:45' })
  })

  it('returns null for an invalid IANA zone name, never throws', () => {
    expect(wallClockInZone(Date.now(), 'Not/AZone')).toBeNull()
  })
})

describe('tasks repo: dueTime on the mapped task', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowdo-duetime-test-'))
    getPath.mockReturnValue(dir)
  })

  afterEach(() => {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads back the local HH:MM for a task with a zoned remote_due', () => {
    const project = projectsRepo.create({ name: 'Synced project' })
    const task = tasksRepo.create({ projectId: project.id, title: 'Synced task' })

    getDb()
      .prepare('UPDATE tasks SET remote_due = ? WHERE id = ?')
      .run(JSON.stringify({ date: '2026-06-15T19:00:00Z', string: 'Jun 15' }), task.id)

    const reread = tasksRepo.get(task.id)
    expect(reread?.dueTime).toBe('12:00')
  })

  it('reads null dueTime for a purely local task', () => {
    const project = projectsRepo.create({ name: 'Local project' })
    const task = tasksRepo.create({ projectId: project.id, title: 'Local task' })

    expect(task.dueTime).toBeNull()
    expect(tasksRepo.get(task.id)?.dueTime).toBeNull()
  })
})
