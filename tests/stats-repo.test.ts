/**
 * First tests over the data layer: `db/repo/stats.ts` (plus the one assertion about
 * `actualPomodoros` in `db/repo/tasks.ts` that the same "focusMs vs completed count"
 * invariant depends on).
 *
 * These repos reach SQLite through `getDb()` in `src/main/db/index.ts`, which is the only
 * file under `db/` that imports Electron (for `app.getPath('userData')`). To exercise the
 * repos without booting Electron, `electron` is mocked so `app.getPath` returns a fresh
 * temp directory per test; `getDb()` then opens a real `node:sqlite` file there and runs
 * the real migrations, so what's under test is the real schema and the real SQL, not a
 * stand-in.
 *
 * TZ is set to a non-UTC, DST-observing zone BEFORE any `Date` is constructed anywhere in
 * this file (including by imports), specifically so that a bug where calendar-day
 * boundaries were computed with SQL `date()`/`strftime()` (which treat an epoch value as
 * UTC) would show up as a failing test regardless of the machine running it.
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

// `vi.mock` factories are hoisted above the rest of the module, so the mock function they
// close over must be created through `vi.hoisted` — a plain `const getPath = vi.fn()`
// above this line would still run AFTER the hoisted `vi.mock` call and crash with a
// "Cannot access before initialization" error.
const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }))

import { closeDb } from '../src/main/db'
import * as sessionsRepo from '../src/main/db/repo/sessions'
import * as projectsRepo from '../src/main/db/repo/projects'
import * as tasksRepo from '../src/main/db/repo/tasks'
import * as stats from '../src/main/db/repo/stats'
import type { SessionCreate } from '@shared/types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-stats-test-'))
  getPath.mockReturnValue(dir)
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const MINUTE = 60_000

/** Local wall-clock instant — never an ISO string, which would be UTC. */
function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m, d, h, min).getTime()
}

function focusSession(patch: Partial<SessionCreate> = {}): SessionCreate {
  return {
    taskId: null,
    projectId: null,
    mode: 'pomodoro',
    kind: 'focus',
    startedAt: 0,
    endedAt: 0,
    plannedMs: 25 * MINUTE,
    actualMs: 25 * MINUTE,
    completed: true,
    interrupted: false,
    notes: null,
    ...patch
  }
}

describe('local-day bucketing', () => {
  it('files a 22:00 local session under that day, not tomorrow', () => {
    const day = local(2026, 5, 15) // June 15 2026, no DST edge nearby
    const startedAt = local(2026, 5, 15, 22, 0)
    sessionsRepo.create(
      focusSession({ startedAt, endedAt: startedAt + 10 * MINUTE, actualMs: 10 * MINUTE })
    )

    const now = local(2026, 5, 15, 23, 30)
    const buckets = stats.daily('today', now)

    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ date: '2026-06-15', focusMs: 10 * MINUTE, sessions: 1 })
    expect(day).toBeDefined()
  })

  it('files a 22:30 local session under that day too', () => {
    const startedAt = local(2026, 5, 15, 22, 30)
    sessionsRepo.create(
      focusSession({ startedAt, endedAt: startedAt + 5 * MINUTE, actualMs: 5 * MINUTE })
    )

    const now = local(2026, 5, 15, 23, 45)
    const buckets = stats.daily('today', now)

    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.date).toBe('2026-06-15')
  })

  it('keeps a late-night session out of the summary for the next day', () => {
    const startedAt = local(2026, 5, 15, 22, 30)
    sessionsRepo.create(
      focusSession({ startedAt, endedAt: startedAt + 5 * MINUTE, actualMs: 5 * MINUTE })
    )

    // "today" from the perspective of the next morning: the session must not appear.
    const nextMorning = local(2026, 5, 16, 8, 0)
    const summary = stats.summary('today', nextMorning)
    expect(summary.focusMs).toBe(0)
    expect(summary.focusSessions).toBe(0)
  })
})

describe('focusMs vs completed pomodoros — deliberate disagreement', () => {
  it('counts an abandoned session toward focusMs but not toward actualPomodoros', () => {
    const project = projectsRepo.create({ name: 'Writing' })
    const task = tasksRepo.create({ projectId: project.id, title: 'Draft' })

    const startedAt = local(2026, 5, 15, 10, 0)
    sessionsRepo.create(
      focusSession({
        taskId: task.id,
        projectId: project.id,
        startedAt,
        endedAt: startedAt + 20 * MINUTE,
        actualMs: 20 * MINUTE,
        completed: false // abandoned: stopped short of the plan
      })
    )

    const now = local(2026, 5, 15, 12, 0)
    const summary = stats.summary('today', now)
    expect(summary.focusMs).toBe(20 * MINUTE)
    expect(summary.focusSessions).toBe(1)

    const withStats = tasksRepo.get(task.id)
    expect(withStats?.focusMs).toBe(20 * MINUTE)
    // The disagreement is the point: real time spent, zero pomodoros finished.
    expect(withStats?.actualPomodoros).toBe(0)
  })

  it('counts a completed session toward both', () => {
    const project = projectsRepo.create({ name: 'Writing' })
    const task = tasksRepo.create({ projectId: project.id, title: 'Draft' })

    const startedAt = local(2026, 5, 15, 10, 0)
    sessionsRepo.create(
      focusSession({
        taskId: task.id,
        projectId: project.id,
        startedAt,
        endedAt: startedAt + 25 * MINUTE,
        actualMs: 25 * MINUTE,
        completed: true
      })
    )

    const withStats = tasksRepo.get(task.id)
    expect(withStats?.focusMs).toBe(25 * MINUTE)
    expect(withStats?.actualPomodoros).toBe(1)
  })
})

describe('avgFocusMs — completed focus sessions only', () => {
  it('is 0 when the only focus session is abandoned, even though focusMs is nonzero', () => {
    const startedAt = local(2026, 5, 15, 10, 0)
    sessionsRepo.create(
      focusSession({
        startedAt,
        endedAt: startedAt + 8_000,
        actualMs: 8_000,
        completed: false
      })
    )

    const now = local(2026, 5, 15, 12, 0)
    const summary = stats.summary('today', now)

    expect(summary.avgFocusMs).toBe(0)
    expect(summary.focusMs).toBeGreaterThan(0)
  })

  it('averages only the completed session, while focusMs/focusSessions include the abandoned one', () => {
    const completedStart = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({
        startedAt: completedStart,
        endedAt: completedStart + 25 * MINUTE,
        actualMs: 25 * MINUTE,
        completed: true
      })
    )

    const abandonedStart = local(2026, 5, 15, 10, 0)
    sessionsRepo.create(
      focusSession({
        startedAt: abandonedStart,
        endedAt: abandonedStart + 5 * MINUTE,
        actualMs: 5 * MINUTE,
        completed: false
      })
    )

    const now = local(2026, 5, 15, 12, 0)
    const summary = stats.summary('today', now)

    expect(summary.avgFocusMs).toBe(25 * MINUTE)
    expect(summary.focusMs).toBe(30 * MINUTE)
    expect(summary.focusSessions).toBe(2)
  })
})

describe('byProject', () => {
  it('buckets sessions with no project under projectId 0', () => {
    const startedAt = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({ projectId: null, startedAt, endedAt: startedAt + 25 * MINUTE })
    )

    const now = local(2026, 5, 15, 12, 0)
    const rows = stats.byProject('today', now)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ projectId: 0, projectName: 'No project' })
  })

  it('buckets sessions whose project was deleted under projectId 0', () => {
    const project = projectsRepo.create({ name: 'Temp' })
    const startedAt = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({ projectId: project.id, startedAt, endedAt: startedAt + 25 * MINUTE })
    )

    projectsRepo.remove(project.id) // ON DELETE SET NULL: the session survives, orphaned

    const now = local(2026, 5, 15, 12, 0)
    const rows = stats.byProject('today', now)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ projectId: 0, projectName: 'No project', focusMs: 25 * MINUTE })
  })

  it('keeps a real project distinct from the unassigned bucket', () => {
    const project = projectsRepo.create({ name: 'Real', color: '#111111' })
    const startedAt = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({ projectId: project.id, startedAt, endedAt: startedAt + 25 * MINUTE })
    )
    sessionsRepo.create(
      focusSession({
        projectId: null,
        startedAt: startedAt + MINUTE,
        endedAt: startedAt + 2 * MINUTE,
        actualMs: MINUTE
      })
    )

    const now = local(2026, 5, 15, 12, 0)
    const rows = stats.byProject('today', now)

    expect(rows).toHaveLength(2)
    const real = rows.find((r) => r.projectId === project.id)
    const unassigned = rows.find((r) => r.projectId === 0)
    expect(real).toMatchObject({ projectName: 'Real', color: '#111111', focusMs: 25 * MINUTE })
    expect(unassigned).toMatchObject({ projectName: 'No project', focusMs: MINUTE })
  })
})

describe('empty database', () => {
  it('returns a zero summary without throwing', () => {
    const now = local(2026, 5, 15, 12, 0)
    const summary = stats.summary('today', now)

    expect(summary).toMatchObject({
      focusMs: 0,
      focusSessions: 0,
      breakMs: 0,
      completedTasks: 0,
      avgFocusMs: 0,
      streakDays: 0
    })
    expect(summary.byMode.pomodoro).toEqual({ focusMs: 0, sessions: 0 })
    expect(summary.byMode.flowmodoro).toEqual({ focusMs: 0, sessions: 0 })
  })

  it('returns an empty daily series for "all" with no data', () => {
    expect(stats.daily('all', local(2026, 5, 15, 12, 0))).toEqual([])
  })

  it('still emits zero-days for a bounded range with no data', () => {
    const now = local(2026, 5, 3, 12, 0) // Wednesday, 3 days into the week (Mon start)
    const buckets = stats.daily('week', now)

    expect(buckets.length).toBeGreaterThan(0)
    for (const bucket of buckets) {
      expect(bucket.focusMs).toBe(0)
      expect(bucket.sessions).toBe(0)
    }
  })

  it('returns no project rows', () => {
    expect(stats.byProject('today', local(2026, 5, 15, 12, 0))).toEqual([])
  })
})

describe('daily() range coverage', () => {
  it('emits one bucket per day in order with local YYYY-MM-DD keys, including zero-days', () => {
    // Monday 2026-06-08 through Sunday 2026-06-14, "now" mid-week on the Thursday.
    const monday = local(2026, 5, 8)
    const now = local(2026, 5, 11, 15, 0) // Thursday afternoon

    const mondaySession = local(2026, 5, 8, 9, 0)
    sessionsRepo.create(
      focusSession({
        startedAt: mondaySession,
        endedAt: mondaySession + 30 * MINUTE,
        actualMs: 30 * MINUTE
      })
    )
    const thursdaySession = local(2026, 5, 11, 9, 0)
    sessionsRepo.create(
      focusSession({
        startedAt: thursdaySession,
        endedAt: thursdaySession + 40 * MINUTE,
        actualMs: 40 * MINUTE
      })
    )

    const buckets = stats.daily('week', now)
    expect(buckets.map((b) => b.date)).toEqual([
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11'
    ])
    expect(buckets[0]).toMatchObject({ focusMs: 30 * MINUTE, sessions: 1 })
    expect(buckets[1]).toMatchObject({ focusMs: 0, sessions: 0 })
    expect(buckets[2]).toMatchObject({ focusMs: 0, sessions: 0 })
    expect(buckets[3]).toMatchObject({ focusMs: 40 * MINUTE, sessions: 1 })
    expect(monday).toBeDefined()
  })

  it('does not drop or duplicate a bucket across a spring-forward DST transition', () => {
    // America/Los_Angeles springs forward on 2026-03-08. Range: 2026-03-05..2026-03-10.
    const from = local(2026, 2, 5)
    const now = local(2026, 2, 10, 20, 0)

    // One session on each side of the transition, plus one on the transition day itself.
    for (const [d, h] of [
      [5, 9],
      [7, 23],
      [8, 3],
      [10, 9]
    ] as const) {
      const startedAt = local(2026, 2, d, h, 0)
      sessionsRepo.create(
        focusSession({ startedAt, endedAt: startedAt + MINUTE, actualMs: MINUTE })
      )
    }

    const buckets = stats.daily('all', now)
    // Guard the boundaries manually against `now`/`from` so a future refactor of the
    // fixture can't silently make this assertion vacuous.
    expect(from).toBeLessThan(now)

    const dates = buckets.map((b) => b.date)
    expect(dates).toEqual([
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10'
    ])
    // No duplicate keys, and exactly six calendar days — the DST-shortened 23-hour day on
    // the 8th must be neither skipped nor split into two buckets.
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('does not drop or duplicate a bucket across a fall-back DST transition', () => {
    // America/Los_Angeles falls back on 2026-11-01.
    const now = local(2026, 10, 3, 20, 0)

    for (const [d, h] of [
      [29, 9],
      [31, 23],
      [1, 3],
      [3, 9]
    ] as const) {
      const month = d === 29 || d === 31 ? 9 : 10 // Oct 29/31, then Nov 1/3
      const startedAt = local(2026, month, d, h, 0)
      sessionsRepo.create(
        focusSession({ startedAt, endedAt: startedAt + MINUTE, actualMs: MINUTE })
      )
    }

    const buckets = stats.daily('all', now)
    const dates = buckets.map((b) => b.date)

    expect(dates).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03'
    ])
    expect(new Set(dates).size).toBe(dates.length)
  })
})

describe('streakDays', () => {
  it('is zero with no sessions at all', () => {
    expect(stats.streakDays(local(2026, 5, 15, 12, 0))).toBe(0)
  })

  it('counts today if a completed focus session already landed today', () => {
    const now = local(2026, 5, 15, 12, 0)
    const startedAt = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({ startedAt, endedAt: startedAt + 25 * MINUTE, completed: true })
    )
    expect(stats.streakDays(now)).toBe(1)
  })

  it('counts a run ending yesterday when today has nothing yet', () => {
    const now = local(2026, 5, 15, 8, 0) // early morning, nothing logged today

    for (const d of [13, 14]) {
      const startedAt = local(2026, 5, d, 9, 0)
      sessionsRepo.create(
        focusSession({ startedAt, endedAt: startedAt + 25 * MINUTE, completed: true })
      )
    }

    expect(stats.streakDays(now)).toBe(2)
  })

  it('stops at a gap day rather than counting through it', () => {
    const now = local(2026, 5, 15, 12, 0)

    // Sessions on the 15th and 13th, but a gap on the 14th.
    for (const d of [13, 15]) {
      const startedAt = local(2026, 5, d, 9, 0)
      sessionsRepo.create(
        focusSession({ startedAt, endedAt: startedAt + 25 * MINUTE, completed: true })
      )
    }

    expect(stats.streakDays(now)).toBe(1)
  })

  it('does not extend the streak for an abandoned (incomplete) focus session', () => {
    const now = local(2026, 5, 15, 12, 0)
    const startedAt = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({
        startedAt,
        endedAt: startedAt + 5 * MINUTE,
        actualMs: 5 * MINUTE,
        completed: false
      })
    )
    expect(stats.streakDays(now)).toBe(0)
  })

  it('a session present but not a completed focus kind does not extend the streak', () => {
    // streakDays requires kind = 'focus' AND completed = 1 — a break-only day should NOT
    // count regardless of the completed flag. Verify with a break.
    const now = local(2026, 5, 15, 12, 0)
    const startedAt = local(2026, 5, 15, 9, 0)
    sessionsRepo.create(
      focusSession({
        kind: 'short_break',
        startedAt,
        endedAt: startedAt + 5 * MINUTE,
        actualMs: 5 * MINUTE
      })
    )
    expect(stats.streakDays(now)).toBe(0)
  })
})

describe('week range follows weekStartsOn', () => {
  // Thursday 2026-06-11, mid-afternoon.
  const thursday = local(2026, 5, 11, 15, 0)

  it('defaults to a Monday start', () => {
    expect(stats.rangeBounds('week', thursday).fromMs).toBe(local(2026, 5, 8))
  })

  it('starts on Sunday when weekStartsOn is 0', () => {
    expect(stats.rangeBounds('week', thursday, 0).fromMs).toBe(local(2026, 5, 7))
  })

  it('starts on Saturday when weekStartsOn is 6', () => {
    expect(stats.rangeBounds('week', thursday, 6).fromMs).toBe(local(2026, 5, 6))
  })

  it('is today when today is the first day of the week', () => {
    const sunday = local(2026, 5, 14, 9, 0)
    expect(stats.rangeBounds('week', sunday, 0).fromMs).toBe(local(2026, 5, 14))
  })

  it('crosses a DST change on local midnights, not 24-hour steps', () => {
    // 2026-03-08 is the US spring-forward Sunday. Tuesday 10 March with a Saturday start
    // reaches back across it to Saturday 7 March 00:00 local.
    const tuesday = local(2026, 2, 10, 12, 0)
    expect(stats.rangeBounds('week', tuesday, 6).fromMs).toBe(local(2026, 2, 7))
  })

  it('daily() emits buckets from the configured first day', () => {
    const buckets = stats.daily('week', thursday, 0)
    expect(buckets[0]?.date).toBe('2026-06-07')
    expect(buckets.at(-1)?.date).toBe('2026-06-11')
  })
})
