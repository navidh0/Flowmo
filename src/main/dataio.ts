/**
 * Whole-database export/import.
 *
 * This is the one place in the app that can silently destroy a user's data, so the rules
 * are deliberate:
 *
 *  - Export always writes a `version`. Once files exist in the wild, a format with no
 *    version is guesswork to parse — and it is what will let a later release exclude
 *    integration credentials from the payload without breaking older readers.
 *  - Export selects explicit columns from explicit tables, never `SELECT *` over
 *    "everything". A future secrets table must never leak into an export just because it
 *    exists in the same database.
 *  - Import REPLACES, never merges — merging invites duplicate sessions with no stable
 *    identity to deduplicate on.
 *  - Import validates the whole file BEFORE touching the database, then writes a
 *    timestamped backup of `flowdo.db`, confirms it landed and is non-empty, and only
 *    then replaces the data inside a single transaction. If the backup step fails, the
 *    replace never happens and the existing database is untouched.
 *
 * The dialog-facing functions (`exportJson`, `importJson`) are thin: all destructive and
 * validating logic lives in `buildExport`, `validateExport`, `backupDatabase` and
 * `applyImport`, which take no Electron dialog and are exercised directly in tests.
 */

import { app, dialog, type BrowserWindow } from 'electron'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ExportFile,
  ExportResult,
  ImportResult,
  Priority,
  Project,
  Session,
  SessionKind,
  Settings,
  Subtask,
  SyncSource,
  Task,
  TimerMode
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  bool,
  getDb,
  num,
  numOrNull,
  str,
  strOrNull,
  syncSourceOrNull,
  toInt,
  tx,
  type Row
} from './db'
import * as settingsRepo from './db/repo/settings'

// ─────────────────────────────────────────────────────────────────────────────
// Column lists — explicit and named, never `SELECT *`. See module doc.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECTS_COLUMNS = 'id, name, color, archived, sort_order, created_at, source, external_id'
const TASKS_COLUMNS =
  'id, project_id, title, notes, priority, due_date, estimated_pomodoros, sort_order, completed_at, created_at, source, external_id'
const SUBTASKS_COLUMNS = 'id, task_id, title, done, sort_order, source, external_id'
const SESSIONS_COLUMNS = `
  id, task_id, project_id, mode, kind, started_at, ended_at,
  planned_ms, actual_ms, completed, interrupted, notes
`

/** Only these keys are ever written by `settingsRepo.set()` — see its own comment on why
 *  main-process-only keys (e.g. `internal:windowBounds`) deliberately live outside it. */
const SETTINGS_KEYS: readonly string[] = Object.keys(DEFAULT_SETTINGS)

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Local calendar day as 'YYYY-MM-DD', for filenames.
 *
 * Deliberately not `toISOString()`, which reports UTC: exporting at 01:00 in a zone ahead
 * of UTC would name the file for the day before, per the same local-vs-instant distinction
 * CLAUDE.md draws for `tasks.due_date`.
 */
function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local date and time as 'YYYY-MM-DD_HH-mm-ss', for the backup filename. Hyphens and
 *  underscores only — colons are illegal in a Windows filename. */
function localStamp(date: Date): string {
  return `${localDateKey(date)}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function toPriority(value: number): Priority {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value
  return 3
}

function toMode(value: string): TimerMode {
  return value === 'pomodoro' ? 'pomodoro' : 'flowmodoro'
}

function toKind(value: string): SessionKind {
  if (value === 'focus' || value === 'short_break' || value === 'long_break') return value
  return 'focus'
}

function mapProject(row: Row): Project {
  return {
    id: num(row, 'id'),
    name: str(row, 'name'),
    color: str(row, 'color'),
    archived: bool(row, 'archived'),
    sortOrder: num(row, 'sort_order'),
    createdAt: num(row, 'created_at'),
    source: syncSourceOrNull(row, 'source'),
    externalId: strOrNull(row, 'external_id')
  }
}

/**
 * `recurring`, `remoteDeletedAt` and `dueTime` are fixed placeholders here, never read off
 * `remote_due`/`remote_deleted_at` — those sync-bookkeeping columns deliberately never
 * appear in an export (see module doc). The fields exist only so this object satisfies the
 * `Task` shape; `validateExport` does not require them on the way back in.
 */
function mapTask(row: Row): Task {
  return {
    id: num(row, 'id'),
    projectId: num(row, 'project_id'),
    title: str(row, 'title'),
    notes: strOrNull(row, 'notes'),
    priority: toPriority(num(row, 'priority')),
    dueDate: strOrNull(row, 'due_date'),
    dueTime: null,
    estimatedPomodoros: numOrNull(row, 'estimated_pomodoros'),
    sortOrder: num(row, 'sort_order'),
    completedAt: numOrNull(row, 'completed_at'),
    createdAt: num(row, 'created_at'),
    source: syncSourceOrNull(row, 'source'),
    externalId: strOrNull(row, 'external_id'),
    recurring: false,
    remoteDeletedAt: null
  }
}

function mapSubtask(row: Row): Subtask {
  return {
    id: num(row, 'id'),
    taskId: num(row, 'task_id'),
    title: str(row, 'title'),
    done: bool(row, 'done'),
    sortOrder: num(row, 'sort_order'),
    source: syncSourceOrNull(row, 'source'),
    externalId: strOrNull(row, 'external_id')
  }
}

function mapSession(row: Row): Session {
  return {
    id: num(row, 'id'),
    taskId: numOrNull(row, 'task_id'),
    projectId: numOrNull(row, 'project_id'),
    mode: toMode(str(row, 'mode')),
    kind: toKind(str(row, 'kind')),
    startedAt: num(row, 'started_at'),
    endedAt: num(row, 'ended_at'),
    plannedMs: numOrNull(row, 'planned_ms'),
    actualMs: num(row, 'actual_ms'),
    completed: bool(row, 'completed'),
    interrupted: bool(row, 'interrupted'),
    notes: strOrNull(row, 'notes')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog-free core — this is what tests exercise directly.
// ─────────────────────────────────────────────────────────────────────────────

/** Read the whole database into the versioned export shape. No dialog, no file I/O. */
export function buildExport(): ExportFile {
  const db = getDb()

  const projects = db
    .prepare(`SELECT ${PROJECTS_COLUMNS} FROM projects ORDER BY sort_order, id`)
    .all()
    .map((row) => mapProject(row))

  const tasks = db
    .prepare(`SELECT ${TASKS_COLUMNS} FROM tasks ORDER BY id`)
    .all()
    .map((row) => mapTask(row))

  const subtasks = db
    .prepare(`SELECT ${SUBTASKS_COLUMNS} FROM subtasks ORDER BY id`)
    .all()
    .map((row) => mapSubtask(row))

  const sessions = db
    .prepare(`SELECT ${SESSIONS_COLUMNS} FROM sessions ORDER BY id`)
    .all()
    .map((row) => mapSession(row))

  // Layered over DEFAULT_SETTINGS and field-validated already, so the export always holds
  // a coherent settings object rather than whatever partial junk happens to be stored.
  const settings: Partial<Settings> = settingsRepo.get()

  return { version: 1, exportedAt: Date.now(), projects, tasks, subtasks, sessions, settings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep row validation.
//
// SQLite is dynamically typed: a session with `startedAt: "2026-01-01"` or a task with
// `priority: "high"` would INSERT successfully as TEXT and silently corrupt every
// statistic downstream. Every row of every array is checked field by field, by hand
// (no schema library), before `applyImport` ever runs — errors name the table, the row's
// index in the file, and the offending field so a bad export is diagnosable.
// ─────────────────────────────────────────────────────────────────────────────

function fail(table: string, index: number, message: string): never {
  throw new Error(`dataio: ${table}[${index}] ${message}`)
}

function checkFiniteInt(value: unknown, table: string, index: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail(table, index, `'${field}' must be a finite integer, got ${JSON.stringify(value)}`)
  }
}

function checkNullableFiniteInt(value: unknown, table: string, index: number, field: string): void {
  if (value === null) return
  checkFiniteInt(value, table, index, field)
}

function checkString(value: unknown, table: string, index: number, field: string): void {
  if (typeof value !== 'string') {
    fail(table, index, `'${field}' must be a string, got ${JSON.stringify(value)}`)
  }
}

function checkNullableString(value: unknown, table: string, index: number, field: string): void {
  if (value === null) return
  checkString(value, table, index, field)
}

function checkBoolean(value: unknown, table: string, index: number, field: string): void {
  if (typeof value !== 'boolean') {
    fail(table, index, `'${field}' must be a boolean, got ${JSON.stringify(value)}`)
  }
}

/** 'YYYY-MM-DD' AND a calendar date that actually exists — '2026-02-30' is rejected, and
 *  so is an ISO instant like '2026-02-30T10:00:00Z': due dates are calendar days with no
 *  time component, never instants, per CLAUDE.md. */
function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, yStr, mStr, dStr] = match
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

function checkDueDate(value: unknown, table: string, index: number, field: string): void {
  if (value === null) return
  if (typeof value !== 'string' || !isValidCalendarDate(value)) {
    fail(
      table,
      index,
      `'${field}' must be null or a real calendar date 'YYYY-MM-DD', got ${JSON.stringify(value)}`
    )
  }
}

const SYNC_SOURCES: readonly SyncSource[] = ['todoist']

/**
 * `source`/`externalId` are optional in the file — a v0.2.0 export predates them entirely,
 * so their absence must import cleanly as `null`/`null`. When present, both validate
 * strictly: an import file is user-editable in a way the live DB is not, so an unknown
 * source here is rejected outright rather than degraded to `null` the way a corrupted
 * stored value is in the repos (`syncSourceOrNull`). Never both set for the same
 * (source, externalId) twice within a table — that would mean two rows claiming to mirror
 * the same upstream item.
 */
function checkSyncOrigin(
  r: Record<string, unknown>,
  table: string,
  index: number,
  seenPairs: Set<string>
): { source: SyncSource | null; externalId: string | null } {
  const rawSource = r.source ?? null
  const rawExternalId = r.externalId ?? null

  let source: SyncSource | null = null
  if (rawSource !== null) {
    if (typeof rawSource !== 'string' || !SYNC_SOURCES.includes(rawSource as SyncSource)) {
      fail(
        table,
        index,
        `'source' must be null or one of ${SYNC_SOURCES.join(', ')}, got ${JSON.stringify(rawSource)}`
      )
    }
    source = rawSource as SyncSource
  }

  let externalId: string | null = null
  if (rawExternalId !== null) {
    checkString(rawExternalId, table, index, 'externalId')
    externalId = rawExternalId as string
  }

  if ((source === null) !== (externalId === null)) {
    fail(table, index, `'source' and 'externalId' must both be null or both be non-null`)
  }

  if (source !== null && externalId !== null) {
    const key = `${source}\u0000${externalId}`
    if (seenPairs.has(key)) {
      fail(
        table,
        index,
        `(source, externalId) pair (${source}, ${externalId}) is duplicated within ${table}`
      )
    }
    seenPairs.add(key)
  }

  return { source, externalId }
}

function validateProjectRow(
  row: unknown,
  index: number,
  seenIds: Set<number>,
  seenSyncPairs: Set<string>
): Project {
  if (!isRecord(row)) fail('projects', index, 'must be an object')
  const r = row as Record<string, unknown>

  checkFiniteInt(r.id, 'projects', index, 'id')
  const id = r.id as number
  if (seenIds.has(id)) fail('projects', index, `'id' ${id} is duplicated within projects`)
  seenIds.add(id)

  checkString(r.name, 'projects', index, 'name')
  checkString(r.color, 'projects', index, 'color')
  checkBoolean(r.archived, 'projects', index, 'archived')
  checkFiniteInt(r.sortOrder, 'projects', index, 'sortOrder')
  checkFiniteInt(r.createdAt, 'projects', index, 'createdAt')

  const { source, externalId } = checkSyncOrigin(r, 'projects', index, seenSyncPairs)

  return { ...(r as unknown as Project), source, externalId }
}

const PRIORITIES: readonly Priority[] = [1, 2, 3, 4]

function validateTaskRow(
  row: unknown,
  index: number,
  seenIds: Set<number>,
  projectIds: ReadonlySet<number>,
  seenSyncPairs: Set<string>
): Task {
  if (!isRecord(row)) fail('tasks', index, 'must be an object')
  const r = row as Record<string, unknown>

  checkFiniteInt(r.id, 'tasks', index, 'id')
  const id = r.id as number
  if (seenIds.has(id)) fail('tasks', index, `'id' ${id} is duplicated within tasks`)
  seenIds.add(id)

  checkFiniteInt(r.projectId, 'tasks', index, 'projectId')
  if (!projectIds.has(r.projectId as number)) {
    fail('tasks', index, `'projectId' ${String(r.projectId)} does not exist in projects`)
  }

  checkString(r.title, 'tasks', index, 'title')
  checkNullableString(r.notes, 'tasks', index, 'notes')
  if (typeof r.priority !== 'number' || !PRIORITIES.includes(r.priority as Priority)) {
    fail('tasks', index, `'priority' must be one of 1,2,3,4, got ${JSON.stringify(r.priority)}`)
  }
  checkDueDate(r.dueDate, 'tasks', index, 'dueDate')
  checkNullableFiniteInt(r.estimatedPomodoros, 'tasks', index, 'estimatedPomodoros')
  checkFiniteInt(r.sortOrder, 'tasks', index, 'sortOrder')
  checkNullableFiniteInt(r.completedAt, 'tasks', index, 'completedAt')
  checkFiniteInt(r.createdAt, 'tasks', index, 'createdAt')

  const { source, externalId } = checkSyncOrigin(r, 'tasks', index, seenSyncPairs)

  // `recurring`/`remoteDeletedAt`/`dueTime` are never trusted from the file — see mapTask's
  // doc. Whatever the file carries for shape compatibility is discarded here, not validated.
  return {
    ...(r as unknown as Task),
    source,
    externalId,
    recurring: false,
    remoteDeletedAt: null,
    dueTime: null
  }
}

function validateSubtaskRow(
  row: unknown,
  index: number,
  seenIds: Set<number>,
  taskIds: ReadonlySet<number>,
  seenSyncPairs: Set<string>
): Subtask {
  if (!isRecord(row)) fail('subtasks', index, 'must be an object')
  const r = row as Record<string, unknown>

  checkFiniteInt(r.id, 'subtasks', index, 'id')
  const id = r.id as number
  if (seenIds.has(id)) fail('subtasks', index, `'id' ${id} is duplicated within subtasks`)
  seenIds.add(id)

  checkFiniteInt(r.taskId, 'subtasks', index, 'taskId')
  if (!taskIds.has(r.taskId as number)) {
    fail('subtasks', index, `'taskId' ${String(r.taskId)} does not exist in tasks`)
  }

  checkString(r.title, 'subtasks', index, 'title')
  checkBoolean(r.done, 'subtasks', index, 'done')
  checkFiniteInt(r.sortOrder, 'subtasks', index, 'sortOrder')

  const { source, externalId } = checkSyncOrigin(r, 'subtasks', index, seenSyncPairs)

  return { ...(r as unknown as Subtask), source, externalId }
}

const MODES: readonly TimerMode[] = ['pomodoro', 'flowmodoro']
const KINDS: readonly SessionKind[] = ['focus', 'short_break', 'long_break']

function validateSessionRow(
  row: unknown,
  index: number,
  seenIds: Set<number>,
  taskIds: ReadonlySet<number>,
  projectIds: ReadonlySet<number>
): Session {
  if (!isRecord(row)) fail('sessions', index, 'must be an object')
  const r = row as Record<string, unknown>

  checkFiniteInt(r.id, 'sessions', index, 'id')
  const id = r.id as number
  if (seenIds.has(id)) fail('sessions', index, `'id' ${id} is duplicated within sessions`)
  seenIds.add(id)

  checkNullableFiniteInt(r.taskId, 'sessions', index, 'taskId')
  if (r.taskId !== null && !taskIds.has(r.taskId as number)) {
    fail('sessions', index, `'taskId' ${String(r.taskId)} does not exist in tasks`)
  }
  checkNullableFiniteInt(r.projectId, 'sessions', index, 'projectId')
  if (r.projectId !== null && !projectIds.has(r.projectId as number)) {
    fail('sessions', index, `'projectId' ${String(r.projectId)} does not exist in projects`)
  }

  if (typeof r.mode !== 'string' || !MODES.includes(r.mode as TimerMode)) {
    fail('sessions', index, `'mode' must be one of ${MODES.join(', ')}, got ${JSON.stringify(r.mode)}`)
  }
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind as SessionKind)) {
    fail('sessions', index, `'kind' must be one of ${KINDS.join(', ')}, got ${JSON.stringify(r.kind)}`)
  }

  checkFiniteInt(r.startedAt, 'sessions', index, 'startedAt')
  checkFiniteInt(r.endedAt, 'sessions', index, 'endedAt')
  if ((r.endedAt as number) < (r.startedAt as number)) {
    fail('sessions', index, `'endedAt' must be >= 'startedAt'`)
  }
  checkNullableFiniteInt(r.plannedMs, 'sessions', index, 'plannedMs')
  if (typeof r.plannedMs === 'number' && r.plannedMs < 0) {
    fail('sessions', index, `'plannedMs' must be >= 0`)
  }
  checkFiniteInt(r.actualMs, 'sessions', index, 'actualMs')
  if ((r.actualMs as number) < 0) {
    fail('sessions', index, `'actualMs' must be >= 0`)
  }
  checkBoolean(r.completed, 'sessions', index, 'completed')
  checkBoolean(r.interrupted, 'sessions', index, 'interrupted')
  checkNullableString(r.notes, 'sessions', index, 'notes')

  return r as unknown as Session
}

/**
 * Validate an unknown parsed JSON value as an `ExportFile`, throwing on anything wrong.
 *
 * Runs BEFORE any database access — the whole point is that a rejected file must never
 * get anywhere near `applyImport`. Checks top-level shape first, then every row of every
 * array, then referential integrity across arrays (a task's `projectId` must name a
 * project actually present in the same file, etc).
 */
export function validateExport(data: unknown): ExportFile {
  if (!isRecord(data)) {
    throw new Error('dataio: import file is not a JSON object')
  }
  if (data.version !== 1) {
    throw new Error(`dataio: unsupported export version ${JSON.stringify(data.version)}`)
  }

  const REQUIRED = ['exportedAt', 'projects', 'tasks', 'subtasks', 'sessions', 'settings'] as const
  for (const key of REQUIRED) {
    if (!(key in data)) {
      throw new Error(`dataio: import file is missing '${key}'`)
    }
  }

  if (typeof data.exportedAt !== 'number') {
    throw new Error("dataio: 'exportedAt' must be a number")
  }
  if (!Array.isArray(data.projects) || !Array.isArray(data.tasks)) {
    throw new Error('dataio: projects/tasks must be arrays')
  }
  if (!Array.isArray(data.subtasks) || !Array.isArray(data.sessions)) {
    throw new Error('dataio: subtasks/sessions must be arrays')
  }
  if (!isRecord(data.settings)) {
    throw new Error("dataio: 'settings' must be an object")
  }

  const projectIds = new Set<number>()
  const projectSyncPairs = new Set<string>()
  const projects = data.projects.map((row, i) =>
    validateProjectRow(row, i, projectIds, projectSyncPairs)
  )

  const taskIds = new Set<number>()
  const taskSyncPairs = new Set<string>()
  const tasks = data.tasks.map((row, i) =>
    validateTaskRow(row, i, taskIds, projectIds, taskSyncPairs)
  )

  const subtaskIds = new Set<number>()
  const subtaskSyncPairs = new Set<string>()
  const subtasks = data.subtasks.map((row, i) =>
    validateSubtaskRow(row, i, subtaskIds, taskIds, subtaskSyncPairs)
  )

  const sessionIds = new Set<number>()
  const sessions = data.sessions.map((row, i) =>
    validateSessionRow(row, i, sessionIds, taskIds, projectIds)
  )

  return {
    version: 1,
    exportedAt: data.exportedAt,
    projects,
    tasks,
    subtasks,
    sessions,
    settings: data.settings as Partial<Settings>
  }
}

function dbPath(): string {
  return join(app.getPath('userData'), 'flowdo.db')
}

/**
 * Write a timestamped copy of `flowdo.db` next to itself and confirm it landed.
 *
 * Checkpointing WAL first means the copy is a complete, self-contained snapshot rather
 * than a main file missing whatever is still sitting in `-wal`.
 */
export function backupDatabase(): string {
  const db = getDb()
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

  const dest = join(app.getPath('userData'), `flowdo-backup-${localStamp(new Date())}.db`)

  copyFileSync(dbPath(), dest)

  if (!existsSync(dest) || statSync(dest).size === 0) {
    throw new Error('dataio: backup file was not written correctly')
  }
  return dest
}

/**
 * Replace every row in the database with the contents of `file`, inside one transaction.
 *
 * Deletes leaf tables first (sessions, subtasks, tasks) and projects last so foreign-key
 * checks never fail mid-wipe; inserts in the opposite order so every reference a child row
 * makes already exists. Ids from the file are preserved rather than reassigned, since that
 * is the only thing keeping a task's sessions attached to the right task after the swap.
 *
 * Settings are replaced key by key, restricted to `SETTINGS_KEYS` — never a blanket
 * `DELETE FROM settings` — so a main-process-only row like `internal:windowBounds`
 * (outside `DEFAULT_SETTINGS`, never round-tripped through export) survives an import
 * untouched, and an import file cannot smuggle an arbitrary key into the table.
 */
export function applyImport(file: ExportFile): { sessions: number } {
  tx((db) => {
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM subtasks')
    db.exec('DELETE FROM tasks')
    db.exec('DELETE FROM projects')

    const deleteSetting = db.prepare('DELETE FROM settings WHERE key = ?')
    for (const key of SETTINGS_KEYS) deleteSetting.run(key)

    const insertProject = db.prepare(
      `INSERT INTO projects (id, name, color, archived, sort_order, created_at, source, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const p of file.projects) {
      insertProject.run(
        p.id,
        p.name,
        p.color,
        toInt(p.archived),
        p.sortOrder,
        p.createdAt,
        p.source,
        p.externalId
      )
    }

    // `remote_due`/`remote_updated_at`/`remote_deleted_at` are never written here: import
    // ignores those fields on the incoming file even when present (see mapTask's doc), so
    // every imported task starts with no sync bookkeeping beyond its identity.
    const insertTask = db.prepare(
      `INSERT INTO tasks
         (id, project_id, title, notes, priority, due_date, estimated_pomodoros, sort_order, completed_at, created_at, source, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const t of file.tasks) {
      insertTask.run(
        t.id,
        t.projectId,
        t.title,
        t.notes,
        t.priority,
        t.dueDate,
        t.estimatedPomodoros,
        t.sortOrder,
        t.completedAt,
        t.createdAt,
        t.source,
        t.externalId
      )
    }

    const insertSubtask = db.prepare(
      `INSERT INTO subtasks (id, task_id, title, done, sort_order, source, external_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of file.subtasks) {
      insertSubtask.run(s.id, s.taskId, s.title, toInt(s.done), s.sortOrder, s.source, s.externalId)
    }

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (id, task_id, project_id, mode, kind, started_at, ended_at, planned_ms, actual_ms, completed, interrupted, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of file.sessions) {
      insertSession.run(
        s.id,
        s.taskId,
        s.projectId,
        s.mode,
        s.kind,
        s.startedAt,
        s.endedAt,
        s.plannedMs,
        s.actualMs,
        toInt(s.completed),
        toInt(s.interrupted),
        s.notes
      )
    }

    const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(file.settings)) {
      if (value === undefined) continue
      // Only known settings keys go in — an unrecognised key in the file is dropped
      // rather than stored, same policy as settingsRepo.set().
      if (!SETTINGS_KEYS.includes(key)) continue
      insertSetting.run(key, JSON.stringify(value))
    }
  })

  return { sessions: file.sessions.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dialog-facing entry points — called directly by the IPC handlers.
// ─────────────────────────────────────────────────────────────────────────────

export async function exportJson(win?: BrowserWindow): Promise<ExportResult> {
  const data = buildExport()
  const defaultPath = `flowdo-export-${localDateKey(new Date())}.json`
  const options = { defaultPath, filters: [{ name: 'JSON', extensions: ['json'] }] }

  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)

  if (result.canceled || !result.filePath) {
    return { path: null, sessions: 0 }
  }

  writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8')
  return { path: result.filePath, sessions: data.sessions.length }
}

export interface ImportOptions {
  /**
   * Called after the file is chosen and validated, immediately before the backup and
   * replace. Throw to abort. It exists because the open dialog can sit on screen for as
   * long as the user likes, and a global hotkey can start the timer behind it — so a check
   * made before the dialog opened proves nothing by the time the data is swapped.
   */
  beforeApply?: () => void
}

export async function importJson(win?: BrowserWindow, opts: ImportOptions = {}): Promise<ImportResult> {
  const options = { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile' as const] }

  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) {
    return { path: null, sessions: 0, backupPath: '' }
  }

  const filePath = result.filePaths[0]
  if (!filePath) {
    return { path: null, sessions: 0, backupPath: '' }
  }

  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
  // Validate BEFORE touching the database — see module doc.
  const file = validateExport(raw)

  opts.beforeApply?.()

  const backupPath = backupDatabase()
  const { sessions } = applyImport(file)

  return { path: filePath, sessions, backupPath }
}
