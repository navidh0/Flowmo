/**
 * The `onLocal*` hooks: pure SQLite writes against a real (throwaway) `node:sqlite`
 * database, exercised the same way `tests/migrations.test.ts` does — no Electron, no
 * network, since these hooks are documented to never touch either.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from '../src/main/db/migrations'
import {
  isTempId,
  onLocalSubtaskCreated,
  onLocalSubtaskRemoved,
  onLocalSubtaskUpdated,
  onLocalTaskCompleted,
  onLocalTaskCreated,
  onLocalTaskMoved,
  onLocalTaskRemoved,
  onLocalTaskUpdated
} from '../src/main/integrations/todoist/outbox'
import type { Project, Subtask, Task } from '@shared/types'

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-todoist-outbox-test-'))
  db = new DatabaseSync(join(dir, 'test.db'))
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function row(sql: string, ...params: (string | number | null)[]): Record<string, unknown> | undefined {
  return db.prepare(sql).get(...params) as Record<string, unknown> | undefined
}

function outboxRows(): { type: string; args: Record<string, unknown>; temp_id: unknown }[] {
  return (db.prepare('SELECT type, args, temp_id FROM sync_outbox ORDER BY id').all() as Record<string, unknown>[]).map(
    (r) => ({ type: String(r.type), args: JSON.parse(String(r.args)) as Record<string, unknown>, temp_id: r.temp_id })
  )
}

const syncedProject: Project = {
  id: 1,
  name: 'Work',
  color: '#000',
  archived: false,
  sortOrder: 0,
  createdAt: 0,
  source: 'todoist',
  externalId: 'proj_1'
}

const localProject: Project = { ...syncedProject, id: 2, source: null, externalId: null }

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 10,
    projectId: 1,
    title: 'Write report',
    notes: null,
    priority: 3,
    dueDate: null,
    estimatedPomodoros: null,
    sortOrder: 0,
    completedAt: null,
    createdAt: 0,
    recurring: false,
    remoteDeletedAt: null,
    source: null,
    externalId: null,
    ...overrides
  }
}

function insertRawTask(task: Task, remoteDue: Record<string, unknown> | null = null): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, notes, priority, due_date, sort_order, completed_at, created_at, source, external_id, remote_due)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    task.projectId,
    task.title,
    task.notes,
    task.priority,
    task.dueDate,
    task.sortOrder,
    task.completedAt,
    task.createdAt,
    task.source,
    task.externalId,
    remoteDue ? JSON.stringify(remoteDue) : null
  )
}

function storedRemoteDue(id: number): Record<string, unknown> | null {
  const raw = row('SELECT remote_due FROM tasks WHERE id = ?', id)?.remote_due
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
}

describe('onLocalTaskCreated', () => {
  it('does nothing for a project that is not todoist-sourced', () => {
    const task = makeTask()
    insertRawTask(task)
    onLocalTaskCreated(db, task, localProject)
    expect(outboxRows()).toHaveLength(0)
  })

  it('stamps the task with a tmp: external id and enqueues item_add', () => {
    const task = makeTask({ title: 'Ship v0.3', priority: 1, dueDate: '2026-05-01', notes: 'careful' })
    insertRawTask(task)
    onLocalTaskCreated(db, task, syncedProject)

    const stored = row('SELECT source, external_id FROM tasks WHERE id = ?', task.id)
    expect(stored?.source).toBe('todoist')
    expect(isTempId(stored?.external_id as string)).toBe(true)

    const [command] = outboxRows()
    expect(command?.type).toBe('item_add')
    expect(command?.temp_id).toBe(stored?.external_id)
    expect(command?.args).toEqual({
      content: 'Ship v0.3',
      project_id: 'proj_1',
      priority: 4, // Flowdo 1 (highest) -> Todoist 4 (urgent)
      description: 'careful',
      due: { date: '2026-05-01' }
    })
  })
})

describe('onLocalTaskUpdated', () => {
  it('is a no-op for a local task', () => {
    onLocalTaskUpdated(db, makeTask(), { title: 'x' })
    expect(outboxRows()).toHaveLength(0)
  })

  it('sends only the fields that actually changed', () => {
    const before = makeTask({ source: 'todoist', externalId: 'item_1', title: 'Old' })
    onLocalTaskUpdated(db, before, { title: 'New' })
    expect(outboxRows()).toEqual([{ type: 'item_update', temp_id: null, args: { id: 'item_1', content: 'New' } }])
  })

  it('never sends `due` when dueDate did not change', () => {
    const before = makeTask({ source: 'todoist', externalId: 'item_1', dueDate: '2026-01-01' })
    onLocalTaskUpdated(db, before, { title: 'New', dueDate: '2026-01-01' })
    const [command] = outboxRows()
    expect(command?.args).not.toHaveProperty('due')
  })

  it('sends a bare { date } when a date-only due changed', () => {
    const before = makeTask({ id: 30, source: 'todoist', externalId: 'item_1', dueDate: '2026-01-01' })
    insertRawTask(before, { date: '2026-01-01', is_recurring: false })
    onLocalTaskUpdated(db, before, { dueDate: '2026-02-02' })
    const [command] = outboxRows()
    expect(command?.args).toEqual({ id: 'item_1', due: { date: '2026-02-02' } })
  })

  it('clears the due date with due: null, dropping recurrence — the one case allowed to', () => {
    const before = makeTask({ id: 31, source: 'todoist', externalId: 'item_1', dueDate: '2026-01-01' })
    insertRawTask(before, { date: '2026-01-01', string: 'every day', is_recurring: true })
    onLocalTaskUpdated(db, before, { dueDate: null })
    const [command] = outboxRows()
    expect(command?.args).toEqual({ id: 'item_1', due: null })
    expect(storedRemoteDue(before.id)).toBeNull()
  })

  it('keeps the recurrence rule when a recurring task is rescheduled by day', () => {
    const before = makeTask({ id: 32, source: 'todoist', externalId: 'item_1', dueDate: '2026-01-01' })
    insertRawTask(before, { date: '2026-01-01', string: 'every monday', lang: 'en', is_recurring: true, timezone: null })
    onLocalTaskUpdated(db, before, { dueDate: '2026-01-08' })
    const [command] = outboxRows()
    expect(command?.args).toEqual({
      id: 'item_1',
      due: { date: '2026-01-08', string: 'every monday', is_recurring: true, lang: 'en' }
    })
    // A follow-up edit before this push goes out must build on the just-sent value.
    expect(storedRemoteDue(before.id)).toEqual({ date: '2026-01-08', string: 'every monday', is_recurring: true, lang: 'en' })
  })

  it('keeps the time of day when a floating timed due is rescheduled by day', () => {
    const before = makeTask({ id: 33, source: 'todoist', externalId: 'item_1', dueDate: '2026-01-01' })
    insertRawTask(before, { date: '2026-01-01T09:30:00', timezone: null, is_recurring: false })
    onLocalTaskUpdated(db, before, { dueDate: '2026-10-02' })
    const [command] = outboxRows()
    expect(command?.args).toEqual({ id: 'item_1', due: { date: '2026-10-02T09:30:00' } })
  })

  it('builds the second of two consecutive edits on the value the first one just sent', () => {
    const initial = makeTask({ id: 34, source: 'todoist', externalId: 'item_1', dueDate: '2026-01-01' })
    insertRawTask(initial, { date: '2026-01-01', string: 'every monday', lang: 'en', is_recurring: true })

    onLocalTaskUpdated(db, initial, { dueDate: '2026-01-08' })
    // Re-read the task the way a real caller would before the second edit — remote_due
    // must already reflect what the first edit sent, not what was there before it.
    const afterFirst = makeTask({ ...initial, dueDate: '2026-01-08' })
    onLocalTaskUpdated(db, afterFirst, { dueDate: '2026-01-15' })

    const commands = outboxRows()
    expect(commands).toHaveLength(2)
    expect(commands[1]?.args).toEqual({
      id: 'item_1',
      due: { date: '2026-01-15', string: 'every monday', is_recurring: true, lang: 'en' }
    })
  })

  it('enqueues nothing when the patch does not actually change anything', () => {
    const before = makeTask({ source: 'todoist', externalId: 'item_1', title: 'Same' })
    onLocalTaskUpdated(db, before, { title: 'Same' })
    expect(outboxRows()).toHaveLength(0)
  })
})

describe('onLocalTaskCompleted', () => {
  it('enqueues item_close on completion (never item_complete, so recurrence survives)', () => {
    const task = makeTask({ source: 'todoist', externalId: 'item_1' })
    onLocalTaskCompleted(db, task, true)
    expect(outboxRows()).toEqual([{ type: 'item_close', temp_id: null, args: { id: 'item_1' } }])
  })

  it('enqueues item_uncomplete on reopen', () => {
    const task = makeTask({ source: 'todoist', externalId: 'item_1' })
    onLocalTaskCompleted(db, task, false)
    expect(outboxRows()).toEqual([{ type: 'item_uncomplete', temp_id: null, args: { id: 'item_1' } }])
  })
})

describe('onLocalTaskMoved', () => {
  it('enqueues item_move for an already-synced task moving to another synced project', () => {
    const task = makeTask({ source: 'todoist', externalId: 'item_1' })
    const to: Project = { ...syncedProject, id: 3, externalId: 'proj_3' }
    onLocalTaskMoved(db, task, to)
    expect(outboxRows()).toEqual([
      { type: 'item_move', temp_id: null, args: { id: 'item_1', project_id: 'proj_3' } }
    ])
  })

  it('turns a local task into a synced one (item_add) when moved into a synced project', () => {
    const task = makeTask({ source: null, externalId: null })
    insertRawTask(task)
    onLocalTaskMoved(db, task, syncedProject)

    const stored = row('SELECT source, external_id FROM tasks WHERE id = ?', task.id)
    expect(stored?.source).toBe('todoist')
    const [command] = outboxRows()
    expect(command?.type).toBe('item_add')
    expect(command?.args.project_id).toBe('proj_1')
  })

  it('rewrites the pending item_add in place when an unpushed task is moved again', () => {
    const task = makeTask({ source: null, externalId: null })
    insertRawTask(task)
    onLocalTaskMoved(db, task, syncedProject)
    const tempId = row('SELECT external_id FROM tasks WHERE id = ?', task.id)?.external_id as string
    const movedAgainTask = makeTask({ ...task, source: 'todoist', externalId: tempId })

    const to2: Project = { ...syncedProject, id: 4, externalId: 'proj_4' }
    onLocalTaskMoved(db, movedAgainTask, to2)

    expect(outboxRows()).toHaveLength(1) // still just the one item_add, not a second command
    expect(outboxRows()[0]?.args.project_id).toBe('proj_4')
  })
})

describe('onLocalTaskRemoved', () => {
  it('enqueues item_delete for a pushed synced task', () => {
    const task = makeTask({ source: 'todoist', externalId: 'item_1' })
    onLocalTaskRemoved(db, task)
    expect(outboxRows()).toEqual([{ type: 'item_delete', temp_id: null, args: { id: 'item_1' } }])
  })

  it('does nothing for a task already marked deleted upstream', () => {
    const task = makeTask({ source: 'todoist', externalId: 'item_1', remoteDeletedAt: 123 })
    onLocalTaskRemoved(db, task)
    expect(outboxRows()).toHaveLength(0)
  })

  it('cancels the pending item_add (and any follow-up commands) for a never-pushed task', () => {
    const task = makeTask({ source: null, externalId: null })
    insertRawTask(task)
    onLocalTaskMoved(db, task, syncedProject)
    const tempId = row('SELECT external_id FROM tasks WHERE id = ?', task.id)?.external_id as string
    const synced = makeTask({ ...task, source: 'todoist', externalId: tempId })
    onLocalTaskUpdated(db, synced, { title: 'Renamed before push' })
    expect(outboxRows()).toHaveLength(2)

    onLocalTaskRemoved(db, synced)
    expect(outboxRows()).toHaveLength(0)
  })
})

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return { id: 20, taskId: 10, title: 'Outline', done: false, sortOrder: 0, source: null, externalId: null, ...overrides }
}

describe('subtask hooks', () => {
  it('onLocalSubtaskCreated enqueues item_add with parent_id', () => {
    const subtask = makeSubtask()
    const parent = makeTask({ source: 'todoist', externalId: 'item_1' })
    onLocalSubtaskCreated(db, subtask, parent)
    expect(outboxRows()).toEqual([
      { type: 'item_add', temp_id: expect.stringMatching(/^tmp:/), args: { content: 'Outline', parent_id: 'item_1' } }
    ])
  })

  it('onLocalSubtaskCreated is a no-op under a local parent task', () => {
    onLocalSubtaskCreated(db, makeSubtask(), makeTask())
    expect(outboxRows()).toHaveLength(0)
  })

  it('onLocalSubtaskUpdated maps title to content and done to item_close/item_uncomplete', () => {
    const before = makeSubtask({ source: 'todoist', externalId: 'sub_1', title: 'Old', done: false })
    onLocalSubtaskUpdated(db, before, { title: 'New' })
    onLocalSubtaskUpdated(db, before, { done: true })
    expect(outboxRows()).toEqual([
      { type: 'item_update', temp_id: null, args: { id: 'sub_1', content: 'New' } },
      { type: 'item_close', temp_id: null, args: { id: 'sub_1' } }
    ])
  })

  it('onLocalSubtaskRemoved enqueues item_delete for a pushed subtask', () => {
    const subtask = makeSubtask({ source: 'todoist', externalId: 'sub_1' })
    onLocalSubtaskRemoved(db, subtask)
    expect(outboxRows()).toEqual([{ type: 'item_delete', temp_id: null, args: { id: 'sub_1' } }])
  })
})
