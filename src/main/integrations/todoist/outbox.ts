/**
 * The public `onLocal*` hooks: called by the repos' write paths, inside the same
 * transaction as the local write, only when the affected row (or its target project) is
 * todoist-sourced. Nothing here touches the network — it only writes rows into
 * `sync_outbox` (and, for a newly-synced row, sets its `source`/`external_id`).
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Project, Subtask, SubtaskUpdate, Task, TaskUpdate } from '@shared/types'
import { num, str, strOrNull, type Row } from '../../db'
import { buildDueForDateChange, toRemotePriority } from './mapper'
import type { RemoteDue } from './wire-types'

export const TEMP_PREFIX = 'tmp:'

export function isTempId(id: string | null): boolean {
  return id !== null && id.startsWith(TEMP_PREFIX)
}

function newTempId(): string {
  return `${TEMP_PREFIX}${randomUUID()}`
}

/** Malformed/missing JSON degrades to "no prior due" rather than throwing — this runs on
 *  every due-date edit of a synced task. */
function parseRemoteDue(raw: string | null): RemoteDue | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as RemoteDue) : null
  } catch {
    return null
  }
}

function enqueue(
  db: DatabaseSync,
  type: string,
  args: Record<string, unknown>,
  tempId: string | null,
  now: number
): string {
  const uuid = randomUUID()
  db.prepare(
    `INSERT INTO sync_outbox (source, uuid, type, args, temp_id, created_at, attempts)
     VALUES ('todoist', ?, ?, ?, ?, ?, 0)`
  ).run(uuid, type, JSON.stringify(args), tempId, now)
  return uuid
}

/** Cancel every pending command that would have referenced an id that never made it
 *  upstream (a temp_id whose `item_add` has not been pushed yet). Deleting the row that
 *  owns it locally makes those commands moot — there's nothing left upstream to touch. */
function cancelPendingFor(db: DatabaseSync, tempId: string): void {
  db.prepare(
    "DELETE FROM sync_outbox WHERE source = 'todoist' AND (temp_id = ? OR args LIKE ?)"
  ).run(tempId, `%${tempId}%`)
}

function addArgsFor(task: Pick<Task, 'title' | 'notes' | 'priority' | 'dueDate'>, projectExternalId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    content: task.title,
    project_id: projectExternalId,
    priority: toRemotePriority(task.priority)
  }
  if (task.notes) args.description = task.notes
  if (task.dueDate) args.due = { date: task.dueDate }
  return args
}

// ── tasks ────────────────────────────────────────────────────────────────────────

export function onLocalTaskCreated(db: DatabaseSync, task: Task, project: Project): void {
  if (project.source !== 'todoist' || !project.externalId) return
  const now = Date.now()
  const tempId = newTempId()
  db.prepare("UPDATE tasks SET source = 'todoist', external_id = ? WHERE id = ?").run(tempId, task.id)
  enqueue(db, 'item_add', addArgsFor(task, project.externalId), tempId, now)
}

export function onLocalTaskUpdated(db: DatabaseSync, before: Task, patch: TaskUpdate): void {
  if (before.source !== 'todoist' || !before.externalId) return

  const args: Record<string, unknown> = { id: before.externalId }
  let any = false

  if (patch.title !== undefined && patch.title !== before.title) {
    args.content = patch.title
    any = true
  }
  if (patch.notes !== undefined && patch.notes !== before.notes) {
    args.description = patch.notes ?? ''
    any = true
  }
  if (patch.priority !== undefined && patch.priority !== before.priority) {
    args.priority = toRemotePriority(patch.priority)
    any = true
  }
  // A push that did not change dueDate must never send `due` at all — that would flatten
  // whatever time/recurrence Todoist has for it. A changed date preserves whatever the
  // stored `remote_due` had (recurrence rule, time of day, fixed zone) and only moves the
  // day — see `buildDueForDateChange`. Only clearing the due date entirely
  // (`dueDate: null`) is allowed to drop all of that, since the user asked for that.
  let nextRemoteDue: RemoteDue | null | undefined
  if (patch.dueDate !== undefined && patch.dueDate !== before.dueDate) {
    const row = db.prepare('SELECT remote_due FROM tasks WHERE id = ?').get(before.id) as Row | undefined
    const previous = row ? parseRemoteDue(strOrNull(row, 'remote_due')) : null
    nextRemoteDue = buildDueForDateChange(patch.dueDate, previous)
    args.due = nextRemoteDue
    any = true
  }

  if (!any) return
  enqueue(db, 'item_update', args, null, Date.now())

  // So a second edit made before this push goes out builds on what was just SENT, not on
  // the stale value still sitting in remote_due from the last pull.
  if (nextRemoteDue !== undefined) {
    db.prepare('UPDATE tasks SET remote_due = ? WHERE id = ?').run(
      nextRemoteDue === null ? null : JSON.stringify(nextRemoteDue),
      before.id
    )
  }
}

export function onLocalTaskCompleted(db: DatabaseSync, task: Task, completed: boolean): void {
  if (task.source !== 'todoist' || !task.externalId) return
  // `item_close`, never `item_complete`: it's the one documented to advance a recurring
  // task's due date and leave it open, rather than completing it for good.
  enqueue(db, completed ? 'item_close' : 'item_uncomplete', { id: task.externalId }, null, Date.now())
}

export function onLocalTaskMoved(db: DatabaseSync, task: Task, to: Project): void {
  if (to.source !== 'todoist' || !to.externalId) return
  const now = Date.now()

  if (task.source === 'todoist' && task.externalId) {
    if (isTempId(task.externalId)) {
      // Not pushed yet — rewrite the pending item_add's project_id in place instead of
      // enqueueing a second command for a row Todoist has never seen.
      const pending = db
        .prepare("SELECT id, args FROM sync_outbox WHERE source = 'todoist' AND temp_id = ? AND type = 'item_add'")
        .get(task.externalId) as Row | undefined
      if (pending) {
        const args = JSON.parse(str(pending, 'args')) as Record<string, unknown>
        args.project_id = to.externalId
        db.prepare('UPDATE sync_outbox SET args = ? WHERE id = ?').run(JSON.stringify(args), num(pending, 'id'))
        return
      }
    } else {
      enqueue(db, 'item_move', { id: task.externalId, project_id: to.externalId }, null, now)
      return
    }
  }

  // A local task moved into a synced project becomes synced from here.
  const tempId = newTempId()
  db.prepare("UPDATE tasks SET source = 'todoist', external_id = ? WHERE id = ?").run(tempId, task.id)
  enqueue(db, 'item_add', addArgsFor(task, to.externalId), tempId, now)
}

export function onLocalTaskRemoved(db: DatabaseSync, task: Task): void {
  if (task.source !== 'todoist' || !task.externalId) return
  if (task.remoteDeletedAt !== null) return // already gone upstream; nothing to send

  if (isTempId(task.externalId)) {
    cancelPendingFor(db, task.externalId)
    return
  }
  enqueue(db, 'item_delete', { id: task.externalId }, null, Date.now())
}

// ── subtasks ─────────────────────────────────────────────────────────────────────

export function onLocalSubtaskCreated(db: DatabaseSync, subtask: Subtask, parent: Task): void {
  if (parent.source !== 'todoist' || !parent.externalId) return
  const now = Date.now()
  const tempId = newTempId()
  db.prepare("UPDATE subtasks SET source = 'todoist', external_id = ? WHERE id = ?").run(tempId, subtask.id)
  enqueue(db, 'item_add', { content: subtask.title, parent_id: parent.externalId }, tempId, now)
}

export function onLocalSubtaskUpdated(db: DatabaseSync, before: Subtask, patch: SubtaskUpdate): void {
  if (before.source !== 'todoist' || !before.externalId) return
  const now = Date.now()

  if (patch.title !== undefined && patch.title !== before.title) {
    enqueue(db, 'item_update', { id: before.externalId, content: patch.title }, null, now)
  }
  if (patch.done !== undefined && patch.done !== before.done) {
    enqueue(db, patch.done ? 'item_close' : 'item_uncomplete', { id: before.externalId }, null, now)
  }
}

export function onLocalSubtaskRemoved(db: DatabaseSync, subtask: Subtask): void {
  if (subtask.source !== 'todoist' || !subtask.externalId) return

  if (isTempId(subtask.externalId)) {
    cancelPendingFor(db, subtask.externalId)
    return
  }
  enqueue(db, 'item_delete', { id: subtask.externalId }, null, Date.now())
}
