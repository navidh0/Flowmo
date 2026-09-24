import type { Priority, Project, TaskCreate, TaskUpdate, TaskWithStats } from '@shared/types'
import {
  dueTimeFromRemoteDue,
  getDb,
  isRecurring,
  num,
  numOrNull,
  rowId,
  scalarNum,
  str,
  strOrNull,
  syncSourceOrNull,
  tx,
  type Row
} from '../index'
import {
  onLocalTaskCompleted,
  onLocalTaskCreated,
  onLocalTaskMoved,
  onLocalTaskRemoved,
  onLocalTaskUpdated
} from '../../integrations/todoist'
import * as projectsRepo from './projects'

/**
 * Tasks are always read with their derived counts attached, via two pre-grouped
 * subqueries rather than a per-task follow-up query. The task list is the app's busiest
 * screen and an N+1 there would mean one SQL round trip per row on every keystroke.
 *
 * `actualPomodoros` and `focusMs` deliberately disagree about abandoned sessions — see
 * the conditional aggregation below.
 */
const SELECT_TASKS = `
  SELECT
    t.id, t.project_id, t.title, t.notes, t.priority, t.due_date,
    t.estimated_pomodoros, t.sort_order, t.completed_at, t.created_at,
    t.source, t.external_id, t.remote_due, t.remote_deleted_at,
    COALESCE(f.session_count, 0) AS actual_pomodoros,
    COALESCE(f.focus_ms, 0)      AS focus_ms,
    COALESCE(s.subtask_total, 0) AS subtask_total,
    COALESCE(s.subtask_done, 0)  AS subtask_done
  FROM tasks t
  LEFT JOIN (
    -- Conditional aggregation, because the two numbers count different things:
    -- a pomodoro you abandoned is not a completed pomodoro, but the minutes you spent
    -- on it are still minutes spent. Counting both off one filter would either hide
    -- real time or inflate the estimate progress.
    SELECT task_id,
           SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS session_count,
           SUM(actual_ms)                                 AS focus_ms
    FROM sessions
    WHERE kind = 'focus' AND task_id IS NOT NULL
    GROUP BY task_id
  ) f ON f.task_id = t.id
  LEFT JOIN (
    SELECT task_id,
           COUNT(*)              AS subtask_total,
           SUM(done)             AS subtask_done
    FROM subtasks
    GROUP BY task_id
  ) s ON s.task_id = t.id
`

/** Anything outside 1..4 in the file is coerced rather than trusted. */
function toPriority(value: number): Priority {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value
  return 3
}

function mapTask(row: Row): TaskWithStats {
  return {
    id: num(row, 'id'),
    projectId: num(row, 'project_id'),
    title: str(row, 'title'),
    notes: strOrNull(row, 'notes'),
    priority: toPriority(num(row, 'priority')),
    dueDate: strOrNull(row, 'due_date'),
    dueTime: dueTimeFromRemoteDue(strOrNull(row, 'remote_due')),
    estimatedPomodoros: numOrNull(row, 'estimated_pomodoros'),
    sortOrder: num(row, 'sort_order'),
    completedAt: numOrNull(row, 'completed_at'),
    createdAt: num(row, 'created_at'),
    source: syncSourceOrNull(row, 'source'),
    externalId: strOrNull(row, 'external_id'),
    recurring: isRecurring(strOrNull(row, 'remote_due')),
    remoteDeletedAt: numOrNull(row, 'remote_deleted_at'),
    actualPomodoros: num(row, 'actual_pomodoros'),
    focusMs: num(row, 'focus_ms'),
    subtaskTotal: num(row, 'subtask_total'),
    subtaskDone: num(row, 'subtask_done')
  }
}

function query(tail: string, params: ReadonlyArray<string | number | null>): TaskWithStats[] {
  return getDb()
    .prepare(`${SELECT_TASKS} ${tail}`)
    .all(...params)
    .map((row) => mapTask(row))
}

/**
 * Open tasks, optionally narrowed to one project.
 *
 * `? IS NULL OR project_id = ?` keeps this a single prepared statement for both cases
 * instead of concatenating a WHERE clause per call.
 */
export function list(projectId?: number | null): TaskWithStats[] {
  const scope = projectId ?? null
  return query(
    'WHERE t.completed_at IS NULL AND (? IS NULL OR t.project_id = ?) ORDER BY t.sort_order, t.id',
    [scope, scope]
  )
}

export function listCompleted(projectId?: number | null, limit = 50): TaskWithStats[] {
  const scope = projectId ?? null
  return query(
    'WHERE t.completed_at IS NOT NULL AND (? IS NULL OR t.project_id = ?) ORDER BY t.completed_at DESC LIMIT ?',
    [scope, scope, Math.max(1, Math.trunc(limit))]
  )
}

export function get(id: number): TaskWithStats | null {
  return query('WHERE t.id = ?', [id])[0] ?? null
}

function requireTask(id: number): TaskWithStats {
  const task = get(id)
  if (!task) throw new Error(`tasks: no task with id ${id}`)
  return task
}

function requireProject(id: number): Project {
  const project = projectsRepo.get(id)
  if (!project) throw new Error(`tasks: no project with id ${id}`)
  return project
}

export function create(input: TaskCreate): TaskWithStats {
  return tx((db) => {
    // New tasks land at the bottom of their own project's list, not of the global list.
    const next = scalarNum(
      'SELECT COALESCE(MAX(sort_order) + 1, 0) AS value FROM tasks WHERE project_id = ?',
      [input.projectId]
    )

    const result = db
      .prepare(
        `INSERT INTO tasks
           (project_id, title, notes, priority, due_date, estimated_pomodoros, sort_order, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        input.projectId,
        input.title,
        input.notes ?? null,
        input.priority ?? 3,
        input.dueDate ?? null,
        input.estimatedPomodoros ?? null,
        next,
        Date.now()
      )

    const id = rowId(result.lastInsertRowid)
    const project = requireProject(input.projectId)
    // Self-guarded: a no-op unless `project` is todoist-sourced.
    onLocalTaskCreated(db, requireTask(id), project)

    return requireTask(id)
  })
}

export function update(id: number, patch: TaskUpdate): TaskWithStats {
  return tx((db) => {
    const before = requireTask(id)

    if (patch.projectId !== undefined && patch.projectId !== before.projectId) {
      const toProject = requireProject(patch.projectId)
      // A todoist-sourced task may only move between projects of the same source — Todoist
      // has no concept of "moved out to a local list", so the repo rejects it outright rather
      // than silently detaching the task from sync.
      if (before.source === 'todoist' && toProject.source !== before.source) {
        throw new Error('A Todoist task can only move to another Todoist project.')
      }
      // Self-guarded on `toProject.source`: a local->local move is a no-op here.
      onLocalTaskMoved(db, before, toProject)
    }

    const sets: string[] = []
    const values: Array<string | number | null> = []

    if (patch.projectId !== undefined) {
      sets.push('project_id = ?')
      values.push(patch.projectId)
    }
    if (patch.title !== undefined) {
      sets.push('title = ?')
      values.push(patch.title)
    }
    if (patch.notes !== undefined) {
      sets.push('notes = ?')
      values.push(patch.notes)
    }
    if (patch.priority !== undefined) {
      sets.push('priority = ?')
      values.push(patch.priority)
    }
    if (patch.dueDate !== undefined) {
      sets.push('due_date = ?')
      values.push(patch.dueDate)
    }
    if (patch.estimatedPomodoros !== undefined) {
      sets.push('estimated_pomodoros = ?')
      values.push(patch.estimatedPomodoros)
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = ?')
      values.push(patch.sortOrder)
    }
    if (patch.completedAt !== undefined) {
      sets.push('completed_at = ?')
      values.push(patch.completedAt)
    }

    if (sets.length > 0) {
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }

    // Self-guarded on `before.source`: pushes only title/notes/priority/dueDate, and only
    // whatever of those actually changed.
    onLocalTaskUpdated(db, before, patch)

    return requireTask(id)
  })
}

/** Completion is stored as the instant it happened, so "done today" is answerable. */
export function setCompleted(id: number, completed: boolean): TaskWithStats {
  return tx((db) => {
    const before = requireTask(id)

    // A recurring synced task never gets a local completed_at: `item_close` advances its
    // due date upstream and leaves it open, and the next pull brings that date back. Setting
    // completed_at here would show it as done locally while Todoist still considers it live.
    const staysOpen = completed && before.source === 'todoist' && before.recurring
    if (!staysOpen) {
      db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(completed ? Date.now() : null, id)
    }

    // Self-guarded on `before.source`.
    onLocalTaskCompleted(db, before, completed)

    return requireTask(id)
  })
}

/** One transaction: a drag that half-applies would leave two tasks claiming one slot. */
export function reorder(ids: number[]): void {
  tx((db) => {
    const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?')
    ids.forEach((id, index) => {
      stmt.run(index, id)
    })
  })
}

export function remove(id: number): void {
  tx((db) => {
    const task = requireTask(id)
    // Self-guarded on `task.source`/`remoteDeletedAt`; must run before the row is gone.
    onLocalTaskRemoved(db, task)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  })
}

/**
 * Turn a synced task (and its subtasks) into purely local ones: drop every sync-owned field
 * and cancel whatever was still queued to push for it, without sending anything upstream.
 * This is the "keep it" answer to a task Todoist deleted out from under the user.
 */
export function keepLocal(id: number): TaskWithStats {
  return tx((db) => {
    const task = requireTask(id)

    const subtaskExternalIds = db
      .prepare('SELECT external_id FROM subtasks WHERE task_id = ? AND external_id IS NOT NULL')
      .all(id) as Row[]

    const externalIds = [
      task.externalId,
      ...subtaskExternalIds.map((row) => str(row, 'external_id'))
    ].filter((value): value is string => value !== null)

    // Cancels pending commands by temp_id (not-yet-pushed rows) and by a plain-text scan of
    // `args` (a pushed row's real id may still be referenced by a later queued command) —
    // the same pattern the outbox itself uses to retract a temp id.
    for (const externalId of externalIds) {
      db.prepare(
        "DELETE FROM sync_outbox WHERE source = 'todoist' AND (temp_id = ? OR args LIKE ?)"
      ).run(externalId, `%${externalId}%`)
    }

    db.prepare(
      `UPDATE tasks
       SET source = NULL, external_id = NULL, remote_due = NULL,
           remote_updated_at = NULL, remote_deleted_at = NULL
       WHERE id = ?`
    ).run(id)
    db.prepare('UPDATE subtasks SET source = NULL, external_id = NULL WHERE task_id = ?').run(id)

    return requireTask(id)
  })
}
