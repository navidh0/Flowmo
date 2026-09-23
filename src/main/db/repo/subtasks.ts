import type { Subtask, SubtaskCreate, SubtaskUpdate } from '@shared/types'
import {
  bool,
  getDb,
  num,
  rowId,
  scalarNum,
  str,
  strOrNull,
  syncSourceOrNull,
  toInt,
  type Row
} from '../index'

const COLUMNS = 'id, task_id, title, done, sort_order, source, external_id'

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

function requireSubtask(id: number): Subtask {
  const row = getDb().prepare(`SELECT ${COLUMNS} FROM subtasks WHERE id = ?`).get(id)
  if (!row) throw new Error(`subtasks: no subtask with id ${id}`)
  return mapSubtask(row)
}

export function list(taskId: number): Subtask[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM subtasks WHERE task_id = ? ORDER BY sort_order, id`)
    .all(taskId)
    .map((row) => mapSubtask(row))
}

export function create(input: SubtaskCreate): Subtask {
  const next = scalarNum(
    'SELECT COALESCE(MAX(sort_order) + 1, 0) AS value FROM subtasks WHERE task_id = ?',
    [input.taskId]
  )

  const result = getDb()
    .prepare('INSERT INTO subtasks (task_id, title, done, sort_order) VALUES (?, ?, 0, ?)')
    .run(input.taskId, input.title, next)

  return requireSubtask(rowId(result.lastInsertRowid))
}

export function update(id: number, patch: SubtaskUpdate): Subtask {
  const sets: string[] = []
  const values: Array<string | number> = []

  if (patch.title !== undefined) {
    sets.push('title = ?')
    values.push(patch.title)
  }
  if (patch.done !== undefined) {
    sets.push('done = ?')
    values.push(toInt(patch.done))
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?')
    values.push(patch.sortOrder)
  }

  if (sets.length > 0) {
    getDb()
      .prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id)
  }

  return requireSubtask(id)
}

export function remove(id: number): void {
  getDb().prepare('DELETE FROM subtasks WHERE id = ?').run(id)
}
