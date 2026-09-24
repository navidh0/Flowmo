/**
 * Migration tests, over a throwaway `node:sqlite` file rather than the mocked-Electron
 * `getDb()` path — `runMigrations` takes a `DatabaseSync` directly and has no dependency on
 * Electron, so these construct one by hand (see `tests/stats-repo.test.ts` for the
 * alternative "mock electron, go through getDb()" pattern used by the repo tests).
 *
 * `runMigrations` always applies from `MIGRATIONS` (the real, exported list) rather than
 * taking a migration list as a parameter, so test (e) from the task brief — a failing
 * migration rolling back entirely — cannot be exercised by injecting a throwing v3: there is
 * no seam to inject it through without editing `runMigrations` itself, which is out of
 * scope (migrations.ts is part of the frozen v0.3 contract). Skipped; noted in the report.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, runMigrations } from '../src/main/db/migrations'

let dir: string
let db: DatabaseSync | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-migrations-test-'))
})

afterEach(() => {
  db?.close()
  db = null
  rmSync(dir, { recursive: true, force: true })
})

function openDb(): DatabaseSync {
  db = new DatabaseSync(join(dir, 'test.db'))
  return db
}

function userVersion(handle: DatabaseSync): number {
  const row = handle.prepare('PRAGMA user_version').get() as Record<string, unknown>
  const value = row['user_version']
  return typeof value === 'bigint' ? Number(value) : (value as number)
}

function tableNames(handle: DatabaseSync): string[] {
  return (handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<
    Record<string, unknown>
  >).map((r) => String(r.name))
}

function columnNames(handle: DatabaseSync, table: string): string[] {
  return (handle.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map(
    (r) => String(r.name)
  )
}

describe('a fresh database', () => {
  it('ends at user_version 3 with every v1/v2/v3 table and column present', () => {
    const handle = openDb()
    runMigrations(handle)

    expect(userVersion(handle)).toBe(3)

    const tables = tableNames(handle)
    for (const table of [
      'projects',
      'tasks',
      'subtasks',
      'sessions',
      'settings',
      'credentials',
      'sync_outbox',
      'sync_state',
      'calendar_feeds',
      'calendar_events'
    ]) {
      expect(tables).toContain(table)
    }

    expect(columnNames(handle, 'projects')).toEqual(
      expect.arrayContaining(['source', 'external_id'])
    )
    expect(columnNames(handle, 'tasks')).toEqual(
      expect.arrayContaining([
        'source',
        'external_id',
        'remote_due',
        'remote_updated_at',
        'remote_deleted_at'
      ])
    )
    expect(columnNames(handle, 'subtasks')).toEqual(
      expect.arrayContaining(['source', 'external_id'])
    )
    expect(columnNames(handle, 'calendar_events')).toContain('tzid')

    // The seeded 'Inbox' project from migration v1 must still be there.
    const inbox = handle.prepare('SELECT name FROM projects').get() as Record<string, unknown>
    expect(inbox.name).toBe('Inbox')
  })
})

describe('upgrading a v1-only database', () => {
  function seedV1(handle: DatabaseSync): { projectId: number; taskId: number } {
    MIGRATIONS[0]!.up(handle)
    handle.exec('PRAGMA user_version = 1')

    handle
      .prepare(
        'INSERT INTO projects (name, color, archived, sort_order, created_at) VALUES (?, ?, 0, 1, ?)'
      )
      .run('Personal', '#22c55e', Date.now())
    const projectId = Number(handle.prepare('SELECT id FROM projects WHERE name = ?').get('Personal')!['id'])

    handle
      .prepare(
        `INSERT INTO tasks (project_id, title, notes, priority, due_date, estimated_pomodoros, sort_order, completed_at, created_at)
         VALUES (?, 'Write report', NULL, 2, '2026-01-01', 3, 0, NULL, ?)`
      )
      .run(projectId, Date.now())
    const taskId = Number(handle.prepare('SELECT id FROM tasks WHERE title = ?').get('Write report')!['id'])

    handle
      .prepare(`INSERT INTO subtasks (task_id, title, done, sort_order) VALUES (?, 'Outline', 0, 0)`)
      .run(taskId)

    handle
      .prepare(
        `INSERT INTO sessions (task_id, project_id, mode, kind, started_at, ended_at, planned_ms, actual_ms, completed, interrupted, notes)
         VALUES (?, ?, 'pomodoro', 'focus', 0, 1500000, 1500000, 1500000, 1, 0, NULL)`
      )
      .run(taskId, projectId)

    return { projectId, taskId }
  }

  it('preserves every row and leaves the new columns NULL, ending at the latest version', () => {
    const handle = openDb()
    const { projectId, taskId } = seedV1(handle)

    const projectsBefore = handle.prepare('SELECT COUNT(*) AS n FROM projects').get() as Record<
      string,
      unknown
    >
    const tasksBefore = handle.prepare('SELECT COUNT(*) AS n FROM tasks').get() as Record<string, unknown>
    const subtasksBefore = handle.prepare('SELECT COUNT(*) AS n FROM subtasks').get() as Record<
      string,
      unknown
    >
    const sessionsBefore = handle.prepare('SELECT COUNT(*) AS n FROM sessions').get() as Record<
      string,
      unknown
    >

    runMigrations(handle)

    expect(userVersion(handle)).toBe(3)
    expect(handle.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual(projectsBefore)
    expect(handle.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual(tasksBefore)
    expect(handle.prepare('SELECT COUNT(*) AS n FROM subtasks').get()).toEqual(subtasksBefore)
    expect(handle.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual(sessionsBefore)

    const project = handle.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<
      string,
      unknown
    >
    expect(project.name).toBe('Personal')
    expect(project.source).toBeNull()
    expect(project.external_id).toBeNull()

    const task = handle.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>
    expect(task.title).toBe('Write report')
    expect(task.source).toBeNull()
    expect(task.external_id).toBeNull()
    expect(task.remote_due).toBeNull()
    expect(task.remote_updated_at).toBeNull()
    expect(task.remote_deleted_at).toBeNull()

    const subtask = handle.prepare('SELECT * FROM subtasks WHERE task_id = ?').get(taskId) as Record<
      string,
      unknown
    >
    expect(subtask.title).toBe('Outline')
    expect(subtask.source).toBeNull()
    expect(subtask.external_id).toBeNull()
  })
})

describe('upgrading a v2 database', () => {
  function seedV2(handle: DatabaseSync): { feedId: number; eventId: number } {
    MIGRATIONS[0]!.up(handle)
    MIGRATIONS[1]!.up(handle)
    handle.exec('PRAGMA user_version = 2')

    handle
      .prepare(
        `INSERT INTO calendar_feeds (name, color, enabled, etag, last_modified, last_ok_at, last_error, created_at)
         VALUES ('Work', '#22c55e', 1, NULL, NULL, NULL, NULL, ?)`
      )
      .run(Date.now())
    const feedId = Number(
      handle.prepare('SELECT id FROM calendar_feeds WHERE name = ?').get('Work')!['id']
    )

    handle
      .prepare(
        `INSERT INTO calendar_events (feed_id, uid, title, location, all_day, start_ms, end_ms, start_date, end_date)
         VALUES (?, 'evt-1@example.com', 'Standup', NULL, 0, 1000, 2000, NULL, NULL)`
      )
      .run(feedId)
    const eventId = Number(
      handle.prepare('SELECT id FROM calendar_events WHERE uid = ?').get('evt-1@example.com')!['id']
    )

    return { feedId, eventId }
  }

  it('adds calendar_events.tzid as NULL and preserves the existing row, ending at user_version 3', () => {
    const handle = openDb()
    const { feedId, eventId } = seedV2(handle)

    expect(columnNames(handle, 'calendar_events')).not.toContain('tzid')

    runMigrations(handle)

    expect(userVersion(handle)).toBe(3)
    expect(columnNames(handle, 'calendar_events')).toContain('tzid')

    const feed = handle.prepare('SELECT * FROM calendar_feeds WHERE id = ?').get(feedId) as Record<
      string,
      unknown
    >
    expect(feed.name).toBe('Work')

    const event = handle.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId) as Record<
      string,
      unknown
    >
    expect(event.uid).toBe('evt-1@example.com')
    expect(event.title).toBe('Standup')
    expect(event.tzid).toBeNull()
  })
})

describe('partial unique indexes on (source, external_id)', () => {
  it('lets any number of local (NULL source) rows coexist but rejects a duplicate synced pair', () => {
    const handle = openDb()
    runMigrations(handle)

    const insertLocalTask = handle.prepare(
      `INSERT INTO tasks (project_id, title, priority, sort_order, created_at)
       VALUES (1, ?, 3, 0, 0)`
    )
    // Many local tasks, all with NULL source/external_id — must not collide with each other.
    for (let i = 0; i < 5; i++) {
      expect(() => insertLocalTask.run(`Local task ${i}`)).not.toThrow()
    }

    const insertSyncedTask = handle.prepare(
      `INSERT INTO tasks (project_id, title, priority, sort_order, created_at, source, external_id)
       VALUES (1, ?, 3, 0, 0, 'todoist', ?)`
    )
    expect(() => insertSyncedTask.run('Synced task', '123')).not.toThrow()
    expect(() => insertSyncedTask.run('Synced task again', '123')).toThrow()
    // A different external_id under the same source is fine.
    expect(() => insertSyncedTask.run('Different synced task', '456')).not.toThrow()

    const projectsInsertLocal = handle.prepare(
      `INSERT INTO projects (name, color, archived, sort_order, created_at) VALUES (?, '#000000', 0, 0, 0)`
    )
    for (let i = 0; i < 3; i++) {
      expect(() => projectsInsertLocal.run(`Local project ${i}`)).not.toThrow()
    }
    const projectsInsertSynced = handle.prepare(
      `INSERT INTO projects (name, color, archived, sort_order, created_at, source, external_id)
       VALUES (?, '#000000', 0, 0, 0, 'todoist', ?)`
    )
    expect(() => projectsInsertSynced.run('Synced project', 'p1')).not.toThrow()
    expect(() => projectsInsertSynced.run('Synced project dupe', 'p1')).toThrow()

    const subtasksInsertLocal = handle.prepare(
      `INSERT INTO subtasks (task_id, title, done, sort_order) VALUES (1, ?, 0, 0)`
    )
    for (let i = 0; i < 3; i++) {
      expect(() => subtasksInsertLocal.run(`Local subtask ${i}`)).not.toThrow()
    }
    const subtasksInsertSynced = handle.prepare(
      `INSERT INTO subtasks (task_id, title, done, sort_order, source, external_id)
       VALUES (1, ?, 0, 0, 'todoist', ?)`
    )
    expect(() => subtasksInsertSynced.run('Synced subtask', 's1')).not.toThrow()
    expect(() => subtasksInsertSynced.run('Synced subtask dupe', 's1')).toThrow()
  })
})

describe('idempotency', () => {
  it('running migrations twice is a no-op the second time', () => {
    const handle = openDb()
    runMigrations(handle)
    expect(userVersion(handle)).toBe(3)

    const tablesBefore = tableNames(handle).sort()
    expect(() => runMigrations(handle)).not.toThrow()
    expect(userVersion(handle)).toBe(3)
    expect(tableNames(handle).sort()).toEqual(tablesBefore)
  })
})
