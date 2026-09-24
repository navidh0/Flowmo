/**
 * Pull-side SQL. Writes straight to SQLite, never through `db/repo/*` — those repos are
 * where the outbox hooks (`onLocal*`) are wired in by the write paths, so routing a pull
 * through them would echo every remote change straight back upstream as a local edit.
 *
 * "Local intent wins until pushed": a row with a pending outbox command touching a given
 * field is left alone on that field for this pull; the next pull after the command is
 * pushed (and removed from the outbox) picks up the server's value normally.
 */

import type { DatabaseSync } from 'node:sqlite'
import { bool, num, numOrNull, rowId, str, strOrNull, toInt, type Row } from '../../db'
import { calendarDayFromDue, dueDateFromRemote, toLocalPriority, toProjectColorHex } from './mapper'
import type { RemoteCompletedItem, RemoteDue, RemoteItem, RemoteProject } from './wire-types'

function parseIsoMs(iso: string | null | undefined, fallback: number): number {
  if (!iso) return fallback
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : fallback
}

function isRecurringDue(due: RemoteDue | null): boolean {
  return due?.is_recurring === true
}

// ── protected-field bookkeeping ─────────────────────────────────────────────────

type FieldSet = Set<'title' | 'notes' | 'priority' | 'dueDate' | 'completed' | 'projectId' | 'deleted'>

function fieldsFromCommand(type: string, args: Record<string, unknown>): FieldSet {
  const fields: FieldSet = new Set()
  if (type === 'item_update') {
    if ('content' in args) fields.add('title')
    if ('description' in args) fields.add('notes')
    if ('priority' in args) fields.add('priority')
    if ('due' in args) fields.add('dueDate')
  } else if (type === 'item_close' || type === 'item_uncomplete') {
    fields.add('completed')
  } else if (type === 'item_move') {
    fields.add('projectId')
  } else if (type === 'item_delete') {
    fields.add('deleted')
  }
  return fields
}

/** external_id -> fields a pending outbox command has already claimed. */
function buildProtectedFields(db: DatabaseSync): Map<string, FieldSet> {
  const rows = db.prepare("SELECT type, args FROM sync_outbox WHERE source = 'todoist'").all() as Row[]
  const map = new Map<string, FieldSet>()
  for (const row of rows) {
    const type = str(row, 'type')
    let args: Record<string, unknown>
    try {
      args = JSON.parse(str(row, 'args')) as Record<string, unknown>
    } catch {
      continue
    }
    const id = args['id']
    if (typeof id !== 'string') continue
    const fields = fieldsFromCommand(type, args)
    if (fields.size === 0) continue
    const existing = map.get(id)
    if (existing) {
      fields.forEach((f) => existing.add(f))
    } else {
      map.set(id, new Set(fields))
    }
  }
  return map
}

/**
 * Recompute `due_date` from the stored `remote_due` for every todoist-sourced task, in
 * place — no network involved.
 *
 * Necessary for the same reason as `healProjectColors`: an *incremental* pull only
 * reports rows that changed upstream, and existing rows whose `due_date` was computed
 * with the host-local-only version of `calendarDayFromDue` (before it honoured the due's
 * own `timezone`) would otherwise never come back through `pullItems` and never heal.
 * Skips a row with a pending outbox command touching `dueDate` — local intent still wins
 * until that command is pushed, same as during a normal pull.
 */
export function healTaskDueDates(db: DatabaseSync): boolean {
  const rows = db
    .prepare("SELECT id, due_date, remote_due, external_id FROM tasks WHERE source = 'todoist'")
    .all() as Row[]
  if (rows.length === 0) return false

  const protectedFields = buildProtectedFields(db)
  const updateStmt = db.prepare('UPDATE tasks SET due_date = ? WHERE id = ?')
  let changed = false

  for (const row of rows) {
    const externalId = strOrNull(row, 'external_id')
    if (externalId && protectedFields.get(externalId)?.has('dueDate')) continue

    let due: RemoteDue | null = null
    const raw = strOrNull(row, 'remote_due')
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        due = parsed && typeof parsed === 'object' ? (parsed as RemoteDue) : null
      } catch {
        due = null
      }
    }

    const recomputed = dueDateFromRemote(due)
    const current = strOrNull(row, 'due_date')
    if (recomputed !== current) {
      updateStmt.run(recomputed, num(row, 'id'))
      changed = true
    }
  }

  return changed
}

// ── projects ─────────────────────────────────────────────────────────────────────

/**
 * Rewrite any todoist-sourced project still holding a stored colour NAME (rows written
 * before `toProjectColorHex` existed) to hex, in place — no network involved.
 *
 * Necessary because an *incremental* pull only reports projects that changed upstream:
 * an existing project the user never touches again would otherwise never come back
 * through `pullProjects` and never heal. This runs at the start of every cycle instead,
 * which is cheap (a handful of rows, at most) and idempotent (`toProjectColorHex` on an
 * already-valid hex value is a no-op, so nothing is rewritten a second time).
 */
export function healProjectColors(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT id, color FROM projects WHERE source = 'todoist'").all() as Row[]
  if (rows.length === 0) return false

  const updateStmt = db.prepare('UPDATE projects SET color = ? WHERE id = ?')
  let changed = false
  for (const row of rows) {
    const current = str(row, 'color')
    const healed = toProjectColorHex(current)
    if (healed !== current) {
      updateStmt.run(healed, num(row, 'id'))
      changed = true
    }
  }
  return changed
}

export interface ProjectPullResult {
  changed: boolean
  /** external_id -> local id, for resolving items' project_id. Includes untouched rows too. */
  idByExternalId: Map<string, number>
}

export function pullProjects(db: DatabaseSync, projects: RemoteProject[], now: number): ProjectPullResult {
  const idByExternalId = new Map<string, number>()
  let changed = false

  const findStmt = db.prepare("SELECT id, name, color, archived FROM projects WHERE source = 'todoist' AND external_id = ?")
  const insertStmt = db.prepare(
    `INSERT INTO projects (name, color, archived, sort_order, created_at, source, external_id)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM projects), ?, 'todoist', ?)`
  )
  const updateStmt = db.prepare('UPDATE projects SET name = ?, color = ?, archived = ? WHERE id = ?')

  // Pre-load every already-synced project so items can resolve a project this response
  // didn't happen to touch (incremental sync only sends what changed).
  for (const row of db.prepare("SELECT id, external_id FROM projects WHERE source = 'todoist'").all() as Row[]) {
    const extId = strOrNull(row, 'external_id')
    if (extId) idByExternalId.set(extId, num(row, 'id'))
  }

  for (const project of projects) {
    const archived = toInt(project.is_archived === true || project.is_deleted === true)
    // Todoist sends a colour NAME ('charcoal', 'berry_red', ...), never hex — map it here
    // so `sameColor` below compares like with like and a name that slipped into an older
    // row (before this mapping existed) heals to hex on its next pull.
    const color = toProjectColorHex(project.color)
    const existing = findStmt.get(project.id) as Row | undefined

    if (!existing) {
      const result = insertStmt.run(project.name, color, archived, now, project.id)
      idByExternalId.set(project.id, rowId(result.lastInsertRowid))
      changed = true
      continue
    }

    const localId = num(existing, 'id')
    idByExternalId.set(project.id, localId)
    const sameName = str(existing, 'name') === project.name
    const sameColor = str(existing, 'color') === color
    const sameArchived = num(existing, 'archived') === archived
    if (sameName && sameColor && sameArchived) continue

    updateStmt.run(project.name, color, archived, localId)
    changed = true
  }

  return { idByExternalId, changed }
}

// ── tasks ────────────────────────────────────────────────────────────────────────

interface ExistingTask {
  id: number
  projectId: number
  title: string
  notes: string | null
  priority: number
  dueDate: string | null
  remoteDue: string | null
  completedAt: number | null
  remoteDeletedAt: number | null
}

function findTaskByExternalId(db: DatabaseSync, externalId: string): ExistingTask | null {
  const row = db
    .prepare(
      `SELECT id, project_id, title, notes, priority, due_date, remote_due, completed_at, remote_deleted_at
       FROM tasks WHERE source = 'todoist' AND external_id = ?`
    )
    .get(externalId) as Row | undefined
  if (!row) return null
  return {
    id: num(row, 'id'),
    projectId: num(row, 'project_id'),
    title: str(row, 'title'),
    notes: strOrNull(row, 'notes'),
    priority: num(row, 'priority'),
    dueDate: strOrNull(row, 'due_date'),
    remoteDue: strOrNull(row, 'remote_due'),
    completedAt: numOrNull(row, 'completed_at'),
    remoteDeletedAt: numOrNull(row, 'remote_deleted_at')
  }
}

export function findLocalTaskIdByExternalId(db: DatabaseSync, externalId: string): number | null {
  const row = db
    .prepare("SELECT id FROM tasks WHERE source = 'todoist' AND external_id = ?")
    .get(externalId) as Row | undefined
  return row ? num(row, 'id') : null
}

function findSubtaskAncestorTaskId(db: DatabaseSync, externalId: string): number | null {
  const row = db
    .prepare("SELECT task_id FROM subtasks WHERE source = 'todoist' AND external_id = ?")
    .get(externalId) as Row | undefined
  return row ? num(row, 'task_id') : null
}

/**
 * Top-level ancestor of a possibly-nested item, per the hierarchy rule: a subtask of a
 * top-level item stays a subtask; anything nested deeper flattens onto that same
 * top-level ancestor. Returns null when the chain cannot be resolved yet (an ancestor
 * outside this batch and not yet known locally) — the item is left for a later pull.
 */
function resolveAncestorTaskId(
  db: DatabaseSync,
  parentExternalId: string,
  itemsById: Map<string, RemoteItem>
): number | null {
  let current: string | null = parentExternalId
  for (let depth = 0; depth < 32 && current !== null; depth++) {
    const asTask = findLocalTaskIdByExternalId(db, current)
    if (asTask !== null) return asTask
    const asSubtaskAncestor = findSubtaskAncestorTaskId(db, current)
    if (asSubtaskAncestor !== null) return asSubtaskAncestor
    const item = itemsById.get(current)
    if (!item) return null
    current = item.parent_id
  }
  return null
}

export interface ItemPullResult {
  tasksChanged: boolean
}

export function pullItems(
  db: DatabaseSync,
  items: RemoteItem[],
  projectIdByExternalId: Map<string, number>,
  now: number
): ItemPullResult {
  const protectedFields = buildProtectedFields(db)
  const itemsById = new Map(items.map((i) => [i.id, i]))
  let tasksChanged = false

  const insertTaskStmt = db.prepare(
    `INSERT INTO tasks
       (project_id, title, notes, priority, due_date, estimated_pomodoros, sort_order,
        completed_at, created_at, source, external_id, remote_due, remote_updated_at, remote_deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM tasks WHERE project_id = ?),
             ?, ?, 'todoist', ?, ?, ?, NULL)`
  )

  const topLevel = items.filter((i) => i.parent_id === null)
  const nested = items.filter((i) => i.parent_id !== null)

  for (const item of topLevel) {
    const projectId = projectIdByExternalId.get(item.project_id)
    if (projectId === undefined) continue // project not pulled yet; retried next cycle

    const existing = findTaskByExternalId(db, item.id)
    const protectedSet = protectedFields.get(item.id) ?? new Set()

    if (item.is_deleted) {
      if (existing && existing.remoteDeletedAt === null) {
        db.prepare('UPDATE tasks SET remote_deleted_at = ? WHERE id = ?').run(now, existing.id)
        tasksChanged = true
      }
      continue
    }

    const title = item.content
    const notes = item.description ?? null
    const priority = toLocalPriority(item.priority)
    const dueDate = dueDateFromRemote(item.due)
    const remoteDue = item.due ? JSON.stringify(item.due) : null
    const recurring = isRecurringDue(item.due)
    // A recurring item_close never completes the task locally — it stays open with an
    // advanced due date, which `checked` already reflects (Todoist leaves it false).
    const completedAt = item.checked && !recurring ? parseIsoMs(item.completed_at, now) : null

    if (!existing) {
      insertTaskStmt.run(
        projectId,
        title,
        notes,
        priority,
        dueDate,
        projectId,
        completedAt,
        now,
        item.id,
        remoteDue,
        now
      )
      tasksChanged = true
      continue
    }

    const sets: string[] = []
    const values: Array<string | number | null> = []

    if (!protectedSet.has('projectId') && existing.projectId !== projectId) {
      sets.push('project_id = ?')
      values.push(projectId)
    }
    if (!protectedSet.has('title') && existing.title !== title) {
      sets.push('title = ?')
      values.push(title)
    }
    if (!protectedSet.has('notes') && existing.notes !== notes) {
      sets.push('notes = ?')
      values.push(notes)
    }
    if (!protectedSet.has('priority') && existing.priority !== priority) {
      sets.push('priority = ?')
      values.push(priority)
    }
    if (!protectedSet.has('dueDate') && existing.dueDate !== dueDate) {
      sets.push('due_date = ?')
      values.push(dueDate)
    }
    if (!protectedSet.has('dueDate') && existing.remoteDue !== remoteDue) {
      sets.push('remote_due = ?')
      values.push(remoteDue)
    }
    if (!protectedSet.has('completed') && existing.completedAt !== completedAt) {
      sets.push('completed_at = ?')
      values.push(completedAt)
    }

    if (sets.length > 0) {
      sets.push('remote_updated_at = ?')
      values.push(now)
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, existing.id)
      tasksChanged = true
    }
  }

  // Nested items: resolve to a top-level ancestor task (flattening anything deeper),
  // then upsert as a subtask. Order doesn't matter beyond top-level having gone first —
  // resolveAncestorTaskId falls back to itemsById for chains within this same batch.
  const findSubtaskStmt = db.prepare(
    "SELECT id, title, done FROM subtasks WHERE source = 'todoist' AND external_id = ?"
  )
  const insertSubtaskStmt = db.prepare(
    `INSERT INTO subtasks (task_id, title, done, sort_order, source, external_id)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM subtasks WHERE task_id = ?), 'todoist', ?)`
  )

  for (const item of nested) {
    if (item.is_deleted) {
      db.prepare("DELETE FROM subtasks WHERE source = 'todoist' AND external_id = ?").run(item.id)
      continue
    }
    if (item.parent_id === null) continue // unreachable, filtered above; keeps TS happy
    const ancestorTaskId = resolveAncestorTaskId(db, item.parent_id, itemsById)
    if (ancestorTaskId === null) continue // parent unknown yet; retried next pull

    const protectedSet = protectedFields.get(item.id) ?? new Set()
    const existing = findSubtaskStmt.get(item.id) as Row | undefined
    const title = item.content
    const done = toInt(item.checked === true)

    if (!existing) {
      insertSubtaskStmt.run(ancestorTaskId, title, done, ancestorTaskId, item.id)
      tasksChanged = true
      continue
    }

    const sets: string[] = []
    const values: Array<string | number> = []
    if (!protectedSet.has('title') && str(existing, 'title') !== title) {
      sets.push('title = ?')
      values.push(title)
    }
    if (!protectedSet.has('completed') && bool(existing, 'done') !== (done === 1)) {
      sets.push('done = ?')
      values.push(done)
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, num(existing, 'id'))
      tasksChanged = true
    }
  }

  return { tasksChanged }
}

/** First-sync / post-outage backfill: tasks completed elsewhere that already left the
 *  active item set, so the regular pull above never saw them. */
export function applyCompletedBackfill(db: DatabaseSync, items: RemoteCompletedItem[], now: number): boolean {
  const protectedFields = buildProtectedFields(db)
  let changed = false
  for (const item of items) {
    const protectedSet = protectedFields.get(item.id)
    if (protectedSet?.has('completed')) continue
    const existing = findTaskByExternalId(db, item.id)
    if (!existing || existing.completedAt !== null) continue
    db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(parseIsoMs(item.completed_at, now), existing.id)
    changed = true
  }
  return changed
}

/** Disconnect: convert every todoist-sourced row to local, and clear the outbox/sync
 *  state. Sessions are untouched — they only ever reference task/project ids, never
 *  source/external_id. */
export function convertAllToLocal(db: DatabaseSync): void {
  db.exec(`
    UPDATE projects SET source = NULL, external_id = NULL WHERE source = 'todoist';
    UPDATE tasks SET source = NULL, external_id = NULL, remote_due = NULL,
      remote_updated_at = NULL, remote_deleted_at = NULL WHERE source = 'todoist';
    UPDATE subtasks SET source = NULL, external_id = NULL WHERE source = 'todoist';
    DELETE FROM sync_outbox WHERE source = 'todoist';
    DELETE FROM sync_state WHERE source = 'todoist';
  `)
}

export { calendarDayFromDue }
