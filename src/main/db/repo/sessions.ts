import type { Session, SessionCreate, SessionKind, TimerMode } from '@shared/types'
import { bool, getDb, num, numOrNull, rowId, str, strOrNull, toInt, type Row } from '../index'

const COLUMNS = `
  id, task_id, project_id, mode, kind, started_at, ended_at,
  planned_ms, actual_ms, completed, interrupted, notes
`

/** Unrecognised text in the file falls back rather than escaping as an invalid union. */
function toMode(value: string): TimerMode {
  return value === 'pomodoro' ? 'pomodoro' : 'flowmodoro'
}

function toKind(value: string): SessionKind {
  if (value === 'focus' || value === 'short_break' || value === 'long_break') return value
  return 'focus'
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

/**
 * Append the row and read it back, rather than returning the input with an id bolted on:
 * the round trip is what proves the write landed and applies the column defaults.
 */
export function create(input: SessionCreate): Session {
  const db = getDb()
  const result = db
    .prepare(
      `INSERT INTO sessions
         (task_id, project_id, mode, kind, started_at, ended_at,
          planned_ms, actual_ms, completed, interrupted, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.taskId,
      input.projectId,
      input.mode,
      input.kind,
      input.startedAt,
      input.endedAt,
      input.plannedMs,
      input.actualMs,
      toInt(input.completed),
      toInt(input.interrupted),
      input.notes
    )

  const row = db
    .prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`)
    .get(rowId(result.lastInsertRowid))
  if (!row) throw new Error('sessions: insert did not produce a readable row')
  return mapSession(row)
}

/**
 * Bounds are inclusive and match on `started_at`.
 *
 * A session belongs to the day it began, so one that runs through midnight stays on the
 * evening it was actually worked, and no session is ever counted in two ranges.
 */
export function listRange(fromMs: number, toMs: number): Session[] {
  return getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM sessions
       WHERE started_at >= ? AND started_at <= ?
       ORDER BY started_at`
    )
    .all(fromMs, toMs)
    .map((row) => mapSession(row))
}

export function recent(limit = 20): Session[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.trunc(limit)))
    .map((row) => mapSession(row))
}

/**
 * Delete one logged session.
 *
 * The only destructive operation on this table, and the reason it exists is that a
 * mis-logged session silently skews every statistic above it. Deleting by id only —
 * there is deliberately no bulk delete, because "remove everything in this range" is
 * how a user loses a month by fencepost error.
 */
export function remove(id: number): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
}
