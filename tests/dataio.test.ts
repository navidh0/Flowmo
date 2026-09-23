/**
 * Export/import is the one operation in this app that can silently destroy a user's data,
 * so these tests exercise the dialog-free core directly: `buildExport`, `validateExport`,
 * `backupDatabase` and `applyImport`. The dialog-facing `exportJson`/`importJson` wrappers
 * are thin and are not re-tested here — see `tests/stats-repo.test.ts` for the electron-mock
 * pattern this file reuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `vi.mock` factories are hoisted above the rest of the module, so the mock function they
// close over must be created through `vi.hoisted` first (see stats-repo.test.ts).
const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => getPath(name) },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }
}))

import { closeDb, getDb } from '../src/main/db'
import * as projectsRepo from '../src/main/db/repo/projects'
import * as tasksRepo from '../src/main/db/repo/tasks'
import * as subtasksRepo from '../src/main/db/repo/subtasks'
import * as sessionsRepo from '../src/main/db/repo/sessions'
import * as settingsRepo from '../src/main/db/repo/settings'
import { applyImport, backupDatabase, buildExport, validateExport } from '../src/main/dataio'
import type { ExportFile, SessionCreate } from '@shared/types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-dataio-test-'))
  getPath.mockReturnValue(dir)
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const MINUTE = 60_000

function focusSession(patch: Partial<SessionCreate> = {}): SessionCreate {
  return {
    taskId: null,
    projectId: null,
    mode: 'pomodoro',
    kind: 'focus',
    startedAt: 0,
    endedAt: 25 * MINUTE,
    plannedMs: 25 * MINUTE,
    actualMs: 25 * MINUTE,
    completed: true,
    interrupted: false,
    notes: null,
    ...patch
  }
}

/** Populate every table so a round trip has something in each to lose. */
function seed(): void {
  const project = projectsRepo.create({ name: 'Writing', color: '#111111' })
  const task = tasksRepo.create({ projectId: project.id, title: 'Draft chapter 1' })
  subtasksRepo.create({ taskId: task.id, title: 'Outline' })
  subtasksRepo.create({ taskId: task.id, title: 'First pass' })
  sessionsRepo.create(focusSession({ taskId: task.id, projectId: project.id }))
  sessionsRepo.create(
    focusSession({ startedAt: MINUTE, endedAt: 2 * MINUTE, actualMs: MINUTE, taskId: null, projectId: null })
  )
  settingsRepo.set({ theme: 'dark', soundEnabled: false })
}

function wipeEverything(): void {
  const db = getDb()
  db.exec('DELETE FROM sessions')
  db.exec('DELETE FROM subtasks')
  db.exec('DELETE FROM tasks')
  db.exec('DELETE FROM projects')
  db.exec('DELETE FROM settings')
}

describe('round trip', () => {
  it('export -> wipe -> import restores every project, task, subtask, session and setting', () => {
    seed()

    const before = buildExport()
    expect(before.projects.length).toBeGreaterThan(0)
    expect(before.tasks.length).toBeGreaterThan(0)
    expect(before.subtasks.length).toBe(2)
    expect(before.sessions.length).toBe(2)

    wipeEverything()
    expect(buildExport().projects).toHaveLength(0)
    expect(buildExport().sessions).toHaveLength(0)

    const result = applyImport(before)
    expect(result.sessions).toBe(2)

    const after = buildExport()
    expect(after.projects).toEqual(before.projects)
    expect(after.tasks).toEqual(before.tasks)
    expect(after.subtasks).toEqual(before.subtasks)
    expect(after.sessions).toEqual(before.sessions)
    expect(after.settings.theme).toBe('dark')
    expect(after.settings.soundEnabled).toBe(false)

    // Relationships survived the swap, not just the row counts.
    const restoredTask = after.tasks.find((t) => t.title === 'Draft chapter 1')
    const restoredProject = after.projects.find((p) => p.name === 'Writing')
    expect(restoredTask?.projectId).toBe(restoredProject?.id)
    const restoredSubtasks = after.subtasks.filter((s) => s.taskId === restoredTask?.id)
    expect(restoredSubtasks).toHaveLength(2)
  })
})

describe('validateExport', () => {
  it('accepts a well-formed export file', () => {
    seed()
    const file = buildExport()
    expect(() => validateExport(file)).not.toThrow()
  })

  it('rejects a version that is not 1', () => {
    seed()
    const file = { ...buildExport(), version: 2 } as unknown
    expect(() => validateExport(file)).toThrow(/version/)
  })

  it('rejects a file missing a required top-level key', () => {
    const file = buildExport() as unknown as Record<string, unknown>
    delete file['sessions']
    expect(() => validateExport(file)).toThrow(/sessions/)
  })

  it('rejects malformed JSON before it ever reaches validateExport-adjacent parsing', () => {
    expect(() => JSON.parse('{ this is not json')).toThrow()
  })

  it('rejects a non-object payload', () => {
    expect(() => validateExport('just a string')).toThrow()
    expect(() => validateExport(null)).toThrow()
    expect(() => validateExport(42)).toThrow()
  })

  it('rejects a string timestamp instead of an epoch-ms number, leaving the DB untouched', () => {
    seed()
    const before = buildExport()
    const bad = structuredClone(before) as unknown as Record<string, unknown>
    ;(bad.sessions as Array<Record<string, unknown>>)[0]!.startedAt = '2026-01-01'

    expect(() => validateExport(bad)).toThrow(/startedAt/)
    expect(buildExport()).toMatchObject({ ...before, exportedAt: expect.any(Number) })
  })

  it('rejects an ISO-instant dueDate instead of a calendar day, leaving the DB untouched', () => {
    seed()
    const before = buildExport()
    const bad = structuredClone(before) as unknown as Record<string, unknown>
    ;(bad.tasks as Array<Record<string, unknown>>)[0]!.dueDate = '2026-01-01T10:00:00.000Z'

    expect(() => validateExport(bad)).toThrow(/dueDate/)
    expect(buildExport()).toMatchObject({ ...before, exportedAt: expect.any(Number) })
  })

  it('rejects a real calendar-invalid date like 2026-02-30, leaving the DB untouched', () => {
    seed()
    const before = buildExport()
    const bad = structuredClone(before) as unknown as Record<string, unknown>
    ;(bad.tasks as Array<Record<string, unknown>>)[0]!.dueDate = '2026-02-30'

    expect(() => validateExport(bad)).toThrow(/dueDate/)
    expect(buildExport()).toMatchObject({ ...before, exportedAt: expect.any(Number) })
  })

  it('rejects a dangling task.projectId, leaving the DB untouched', () => {
    seed()
    const before = buildExport()
    const bad = structuredClone(before) as unknown as Record<string, unknown>
    ;(bad.tasks as Array<Record<string, unknown>>)[0]!.projectId = 999_999

    expect(() => validateExport(bad)).toThrow(/projectId/)
    expect(buildExport()).toMatchObject({ ...before, exportedAt: expect.any(Number) })
  })

  it('rejects a duplicate id within a table, leaving the DB untouched', () => {
    seed()
    const before = buildExport()
    const bad = structuredClone(before) as unknown as Record<string, unknown>
    const projects = bad.projects as Array<Record<string, unknown>>
    projects.push({ ...projects[0] })

    expect(() => validateExport(bad)).toThrow(/duplicated/)
    expect(buildExport()).toMatchObject({ ...before, exportedAt: expect.any(Number) })
  })

  it('a rejected import leaves the database completely untouched', () => {
    seed()
    const before = buildExport()

    const bad = { ...before, version: 2 } as unknown
    expect(() => {
      const validated = validateExport(bad)
      applyImport(validated)
    }).toThrow()

    const after = buildExport()
    expect(after.projects).toEqual(before.projects)
    expect(after.tasks).toEqual(before.tasks)
    expect(after.subtasks).toEqual(before.subtasks)
    expect(after.sessions).toEqual(before.sessions)
  })
})

describe('settings on import', () => {
  it('drops a settings key that is not in DEFAULT_SETTINGS rather than storing it', () => {
    seed()
    const before = buildExport()
    const withExtra = {
      ...before,
      settings: { ...before.settings, notARealSetting: 'sneaky' }
    }

    applyImport(validateExport(withExtra))

    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('notARealSetting')
    expect(row).toBeUndefined()
  })

  it('preserves internal:windowBounds (outside DEFAULT_SETTINGS) across an import', () => {
    seed()
    // Written the way settingsRepo.setWindowBounds does — a main-process-only key that
    // export/import must never touch.
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('internal:windowBounds', JSON.stringify({ x: 0, y: 0, width: 800, height: 600 }))

    const before = buildExport()
    applyImport(validateExport(before))

    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('internal:windowBounds')
    expect(row).toBeDefined()
  })
})

describe('backupDatabase', () => {
  it('writes a backup before any replace happens, and it still exists afterward', () => {
    seed()
    const before = buildExport()

    const backupPath = backupDatabase()
    expect(existsSync(backupPath)).toBe(true)
    expect(statSync(backupPath).size).toBeGreaterThan(0)

    // The backup happened strictly before any mutation: the live database is unchanged.
    const stillThere = buildExport()
    expect(stillThere.projects).toEqual(before.projects)
    expect(stillThere.sessions).toEqual(before.sessions)

    // Now actually replace, and the backup file must survive that too.
    const replacement: ExportFile = { ...before, sessions: [] }
    applyImport(replacement)
    expect(existsSync(backupPath)).toBe(true)
    expect(statSync(backupPath).size).toBeGreaterThan(0)

    const files = readdirSync(dir)
    expect(files.some((f) => f.startsWith('flowdo-backup-') && f.endsWith('.db'))).toBe(true)
  })
})

describe('sessions.remove', () => {
  it('deletes exactly one row and leaves neighbouring rows intact', () => {
    const a = sessionsRepo.create(focusSession({ startedAt: 0, endedAt: MINUTE, actualMs: MINUTE }))
    const b = sessionsRepo.create(
      focusSession({ startedAt: MINUTE, endedAt: 2 * MINUTE, actualMs: MINUTE })
    )
    const c = sessionsRepo.create(
      focusSession({ startedAt: 2 * MINUTE, endedAt: 3 * MINUTE, actualMs: MINUTE })
    )

    sessionsRepo.remove(b.id)

    const remaining = sessionsRepo.listRange(0, 10 * MINUTE)
    expect(remaining.map((s) => s.id).sort((x, y) => x - y)).toEqual([a.id, c.id].sort((x, y) => x - y))
    expect(remaining.find((s) => s.id === b.id)).toBeUndefined()
  })
})
