import type { Priority, TaskCreate, TaskUpdate, TaskWithStats } from '@shared/types'
import { getDb, num, numOrNull, rowId, scalarNum, str, strOrNull, tx, type Row } from '../index'

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
    estimatedPomodoros: numOrNull(row, 'estimated_pomodoros'),
    sortOrder: num(row, 'sort_order'),
    completedAt: numOrNull(row, 'completed_at'),
    createdAt: num(row, 'created_at'),
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

export function create(input: TaskCreate): TaskWithStats {
  // New tasks land at the bottom of their own project's list, not of the global list.
  const next = scalarNum(
    'SELECT COALESCE(MAX(sort_order) + 1, 0) AS value FROM tasks WHERE project_id = ?',
    [input.projectId]
  )

  const result = getDb()
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

  return requireTask(rowId(result.lastInsertRowid))
}

export function update(id: number, patch: TaskUpdate): TaskWithStats {
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
    getDb()
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id)
  }

  return requireTask(id)
}

/** Completion is stored as the instant it happened, so "done today" is answerable. */
export function setCompleted(id: number, completed: boolean): TaskWithStats {
  getDb()
    .prepare('UPDATE tasks SET completed_at = ? WHERE id = ?')
    .run(completed ? Date.now() : null, id)
  return requireTask(id)
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
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id)
}
