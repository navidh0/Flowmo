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
  tx,
  type Row
} from '../index'
import {
  onLocalSubtaskCreated,
  onLocalSubtaskRemoved,
  onLocalSubtaskUpdated
} from '../../integrations/todoist'
import * as tasksRepo from './tasks'

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
  return tx((db) => {
    const next = scalarNum(
      'SELECT COALESCE(MAX(sort_order) + 1, 0) AS value FROM subtasks WHERE task_id = ?',
      [input.taskId]
    )

    const result = db
      .prepare('INSERT INTO subtasks (task_id, title, done, sort_order) VALUES (?, ?, 0, ?)')
      .run(input.taskId, input.title, next)

    const id = rowId(result.lastInsertRowid)
    // A FK ties every subtask to an existing task, so this can only be null if the parent
    // vanished mid-transaction — in which case there is nothing to sync against anyway.
    const parent = tasksRepo.get(input.taskId)
    if (parent) {
      // Self-guarded on `parent.source`: a no-op under a local parent task.
      onLocalSubtaskCreated(db, requireSubtask(id), parent)
    }

    return requireSubtask(id)
  })
}

export function update(id: number, patch: SubtaskUpdate): Subtask {
  return tx((db) => {
    const before = requireSubtask(id)

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
      db.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }

    // Self-guarded on `before.source`.
    onLocalSubtaskUpdated(db, before, patch)

    return requireSubtask(id)
  })
}

export function remove(id: number): void {
  tx((db) => {
    const subtask = requireSubtask(id)
    // Self-guarded on `subtask.source`; must run before the row is gone.
    onLocalSubtaskRemoved(db, subtask)
    db.prepare('DELETE FROM subtasks WHERE id = ?').run(id)
  })
}
