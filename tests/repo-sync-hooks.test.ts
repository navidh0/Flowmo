/**
 * The `onLocal*` Todoist hooks (src/main/integrations/todoist/outbox.ts) are called from
 * inside the same transaction as the local write, only when a todoist-sourced row (or its
 * target project/parent) is involved. This file is about the REPO side of that contract:
 * do tasks.ts/subtasks.ts call the right hook at the right time, with the write and the
 * hook committing or rolling back together?
 *
 * Same throwaway-DB pattern as tests/stats-repo.test.ts: `electron` is mocked so `getDb()`
 * opens a real `node:sqlite` file in a temp dir and runs the real migrations, so what's
 * under test is the real schema (including the partial unique index on
 * `(source, external_id)`), not a stand-in.
 *
 * Synced rows are seeded with direct SQL rather than through a (nonexistent) sync-pull path
 * — there is no pull path to seed through here, and doing it by hand keeps this file
 * decoupled from however main-todoist's engine ends up shaped.
 */
process.env.TZ = 'America/Los_Angeles'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { getPath, hookOverrides } = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  // A single mutable slot the rollback test can point at a throwing implementation. Real
  // module behaviour otherwise, via `importOriginal` below — every other describe block in
  // this file exercises the genuine hooks, not a stand-in for them.
  hookOverrides: { onLocalTaskUpdated: null as ((...args: unknown[]) => void) | null }
}))
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }))
vi.mock('../src/main/integrations/todoist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/integrations/todoist')>()
  return {
    ...actual,
    onLocalTaskUpdated: (...args: Parameters<typeof actual.onLocalTaskUpdated>) => {
      if (hookOverrides.onLocalTaskUpdated) {
        hookOverrides.onLocalTaskUpdated(...args)
        return
      }
      actual.onLocalTaskUpdated(...args)
    }
  }
})

import { closeDb, getDb } from '../src/main/db'
import * as projectsRepo from '../src/main/db/repo/projects'
import * as tasksRepo from '../src/main/db/repo/tasks'
import * as subtasksRepo from '../src/main/db/repo/subtasks'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-sync-hooks-test-'))
  getPath.mockReturnValue(dir)
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

// ── seed helpers ────────────────────────────────────────────────────────────────────

function outboxRows(): { type: string; args: Record<string, unknown>; temp_id: string | null }[] {
  return (getDb().prepare('SELECT type, args, temp_id FROM sync_outbox ORDER BY id').all() as {
    type: string
    args: string
    temp_id: string | null
  }[]).map((row) => ({ type: row.type, args: JSON.parse(row.args), temp_id: row.temp_id }))
}

function outboxCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as { c: number }).c
}

/** A project mirrored from Todoist, synced from the start. */
function syncedProject(externalId: string): number {
  const project = projectsRepo.create({ name: `Todoist ${externalId}` })
  getDb()
    .prepare("UPDATE projects SET source = 'todoist', external_id = ? WHERE id = ?")
    .run(externalId, project.id)
  return project.id
}

function localProject(): number {
  return projectsRepo.create({ name: 'Local project' }).id
}

/** A task already synced (pushed and acknowledged — a real, non-temp external id). */
function syncedTask(
  projectId: number,
  externalId: string,
  patch: { recurring?: boolean; remoteDeletedAt?: number | null } = {}
): number {
  const task = tasksRepo.create({ projectId: localProject(), title: 'seed' })
  // Re-home it under the synced project directly via SQL rather than through update(),
  // so seeding never itself enqueues an outbox row.
  const remoteDue = patch.recurring ? JSON.stringify({ is_recurring: true }) : null
  getDb()
    .prepare(
      `UPDATE tasks
       SET project_id = ?, source = 'todoist', external_id = ?, remote_due = ?, remote_deleted_at = ?
       WHERE id = ?`
    )
    .run(projectId, externalId, remoteDue, patch.remoteDeletedAt ?? null, task.id)
  return task.id
}

// ── local rows behave exactly as before ─────────────────────────────────────────────

describe('local rows: no hooks, no outbox', () => {
  it('creating, updating, completing and removing a local task creates zero outbox rows', () => {
    const projectId = localProject()
    const task = tasksRepo.create({ projectId, title: 'Write report' })
    tasksRepo.update(task.id, { title: 'Write report v2' })
    tasksRepo.setCompleted(task.id, true)
    tasksRepo.setCompleted(task.id, false)
    tasksRepo.remove(task.id)

    expect(outboxCount()).toBe(0)
  })

  it('creating, updating and removing a local subtask creates zero outbox rows', () => {
    const projectId = localProject()
    const task = tasksRepo.create({ projectId, title: 'Parent' })
    const subtask = subtasksRepo.create({ taskId: task.id, title: 'Step 1' })
    subtasksRepo.update(subtask.id, { done: true })
    subtasksRepo.remove(subtask.id)

    expect(outboxCount()).toBe(0)
  })

  it('reordering local tasks creates zero outbox rows', () => {
    const projectId = localProject()
    const a = tasksRepo.create({ projectId, title: 'A' })
    const b = tasksRepo.create({ projectId, title: 'B' })
    tasksRepo.reorder([b.id, a.id])

    expect(outboxCount()).toBe(0)
  })

  it('a local task moving to another local project creates zero outbox rows', () => {
    const from = localProject()
    const to = localProject()
    const task = tasksRepo.create({ projectId: from, title: 'Movable' })
    tasksRepo.update(task.id, { projectId: to })

    expect(outboxCount()).toBe(0)
    expect(tasksRepo.get(task.id)?.projectId).toBe(to)
  })
})

// ── create ───────────────────────────────────────────────────────────────────────────

describe('tasks.create in a synced project', () => {
  it('enqueues item_add with a tmp id and marks the task todoist-sourced', () => {
    const projectId = syncedProject('proj-1')
    const task = tasksRepo.create({ projectId, title: 'New synced task' })

    expect(task.source).toBe('todoist')
    expect(task.externalId).not.toBeNull()
    expect(task.externalId?.startsWith('tmp:')).toBe(true)

    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_add')
    expect(rows[0]?.temp_id).toBe(task.externalId)
    expect(rows[0]?.args).toMatchObject({ content: 'New synced task', project_id: 'proj-1' })
  })
})

describe('subtasks.create under a synced parent', () => {
  it('enqueues item_add with a tmp id and marks the subtask todoist-sourced', () => {
    const projectId = syncedProject('proj-2')
    const parentId = tasksRepo.create({ projectId, title: 'Parent' }).id
    // The parent's own create already enqueued an item_add; clear it so this test is only
    // about the subtask.
    getDb().exec('DELETE FROM sync_outbox')

    const subtask = subtasksRepo.create({ taskId: parentId, title: 'Child step' })

    expect(subtask.source).toBe('todoist')
    expect(subtask.externalId?.startsWith('tmp:')).toBe(true)

    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_add')
    expect(rows[0]?.args).toMatchObject({ content: 'Child step' })
  })
})

// ── update ───────────────────────────────────────────────────────────────────────────

describe('tasks.update on a synced task', () => {
  it('enqueues item_update with only the changed fields', () => {
    const projectId = syncedProject('proj-3')
    const taskId = syncedTask(projectId, 'task-3')

    const updated = tasksRepo.update(taskId, { title: 'Renamed', notes: 'unchanged? no, set' })

    expect(updated.title).toBe('Renamed')
    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_update')
    expect(rows[0]?.args).toMatchObject({
      id: 'task-3',
      content: 'Renamed',
      description: 'unchanged? no, set'
    })
    expect(rows[0]?.args).not.toHaveProperty('priority')
    expect(rows[0]?.args).not.toHaveProperty('due')
  })

  it('enqueues nothing when the patch does not actually change any pushed field', () => {
    const projectId = syncedProject('proj-3b')
    const taskId = syncedTask(projectId, 'task-3b')
    const before = tasksRepo.get(taskId)!

    tasksRepo.update(taskId, { title: before.title })

    expect(outboxCount()).toBe(0)
  })
})

describe('tasks.update — move rules', () => {
  it('moving a synced task to a local project throws and changes nothing', () => {
    const syncedProjectId = syncedProject('proj-4')
    const taskId = syncedTask(syncedProjectId, 'task-4')
    const localProjectId = localProject()

    expect(() => tasksRepo.update(taskId, { projectId: localProjectId })).toThrow()

    const after = tasksRepo.get(taskId)!
    expect(after.projectId).toBe(syncedProjectId)
    expect(after.source).toBe('todoist')
    expect(after.externalId).toBe('task-4')
    expect(outboxCount()).toBe(0)
  })

  it('moving a local task into a synced project enqueues item_add', () => {
    const from = localProject()
    const to = syncedProject('proj-5')
    const task = tasksRepo.create({ projectId: from, title: 'Going synced' })

    const moved = tasksRepo.update(task.id, { projectId: to })

    expect(moved.projectId).toBe(to)
    expect(moved.source).toBe('todoist')
    expect(moved.externalId?.startsWith('tmp:')).toBe(true)

    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_add')
    expect(rows[0]?.args).toMatchObject({ content: 'Going synced', project_id: 'proj-5' })
  })

  it('moving a synced task between two synced projects enqueues item_move', () => {
    const from = syncedProject('proj-6a')
    const to = syncedProject('proj-6b')
    const taskId = syncedTask(from, 'task-6')

    const moved = tasksRepo.update(taskId, { projectId: to })

    expect(moved.projectId).toBe(to)
    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_move')
    expect(rows[0]?.args).toMatchObject({ id: 'task-6', project_id: 'proj-6b' })
  })
})

// ── completion ───────────────────────────────────────────────────────────────────────

describe('tasks.setCompleted on a synced task', () => {
  it('completing a recurring synced task leaves completed_at null and enqueues item_close', () => {
    const projectId = syncedProject('proj-7')
    const taskId = syncedTask(projectId, 'task-7', { recurring: true })

    const result = tasksRepo.setCompleted(taskId, true)

    expect(result.completedAt).toBeNull()
    expect(result.recurring).toBe(true)
    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_close')
    expect(rows[0]?.args).toMatchObject({ id: 'task-7' })
  })

  it('completing a non-recurring synced task sets completed_at and enqueues item_close', () => {
    const projectId = syncedProject('proj-8')
    const taskId = syncedTask(projectId, 'task-8')

    const result = tasksRepo.setCompleted(taskId, true)

    expect(result.completedAt).not.toBeNull()
    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_close')
  })

  it('uncompleting behaves as normal and enqueues item_uncomplete', () => {
    const projectId = syncedProject('proj-9')
    const taskId = syncedTask(projectId, 'task-9', { recurring: true })
    getDb().prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(Date.now(), taskId)

    const result = tasksRepo.setCompleted(taskId, false)

    expect(result.completedAt).toBeNull()
    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_uncomplete')
  })
})

// ── remove ───────────────────────────────────────────────────────────────────────────

describe('tasks.remove', () => {
  it('removing a synced task enqueues item_delete and keeps its sessions with task_id NULL', () => {
    const projectId = syncedProject('proj-10')
    const taskId = syncedTask(projectId, 'task-10')

    getDb()
      .prepare(
        `INSERT INTO sessions
           (task_id, project_id, mode, kind, started_at, ended_at, planned_ms, actual_ms, completed, interrupted, notes)
         VALUES (?, NULL, 'pomodoro', 'focus', 0, 1500000, 1500000, 1500000, 1, 0, NULL)`
      )
      .run(taskId)

    tasksRepo.remove(taskId)

    const rows = outboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item_delete')
    expect(rows[0]?.args).toMatchObject({ id: 'task-10' })

    const session = getDb().prepare('SELECT task_id FROM sessions').get() as { task_id: number | null }
    expect(session.task_id).toBeNull()
    expect(tasksRepo.get(taskId)).toBeNull()
  })

  it('removing a task already deleted upstream enqueues nothing', () => {
    const projectId = syncedProject('proj-11')
    const taskId = syncedTask(projectId, 'task-11', { remoteDeletedAt: Date.now() })

    tasksRepo.remove(taskId)

    expect(outboxCount()).toBe(0)
  })

  it('removing a synced task whose item_add never pushed cancels the pending command instead', () => {
    const projectId = syncedProject('proj-12')
    const task = tasksRepo.create({ projectId, title: 'Never pushed' })
    expect(outboxCount()).toBe(1)

    tasksRepo.remove(task.id)

    expect(outboxCount()).toBe(0)
  })
})

// ── keepLocal ────────────────────────────────────────────────────────────────────────

describe('tasks.keepLocal', () => {
  it('clears sync fields on the task and its subtasks and removes pending outbox rows', () => {
    const projectId = syncedProject('proj-13')
    const taskId = syncedTask(projectId, 'task-13', { recurring: true })

    const subtask = subtasksRepo.create({ taskId, title: 'Sub' })
    getDb()
      .prepare("UPDATE subtasks SET source = 'todoist', external_id = 'sub-13' WHERE id = ?")
      .run(subtask.id)
    // The subtask's own create() call above ran before it was marked synced (parent was
    // already synced though, so it did enqueue) — flush the slate so we only assert on
    // what keepLocal itself removes.
    getDb()
      .prepare(
        "INSERT INTO sync_outbox (source, uuid, type, args, temp_id, created_at, attempts) VALUES ('todoist', 'uuid-a', 'item_update', ?, NULL, ?, 0)"
      )
      .run(JSON.stringify({ id: 'task-13' }), Date.now())
    getDb()
      .prepare(
        "INSERT INTO sync_outbox (source, uuid, type, args, temp_id, created_at, attempts) VALUES ('todoist', 'uuid-b', 'item_add', ?, 'tmp:sub-pending', ?, 0)"
      )
      .run(JSON.stringify({ content: 'x', parent_id: 'task-13' }), Date.now())

    const result = tasksRepo.keepLocal(taskId)

    expect(result.source).toBeNull()
    expect(result.externalId).toBeNull()
    expect(result.recurring).toBe(false)
    expect(result.remoteDeletedAt).toBeNull()

    const subtaskRow = getDb()
      .prepare('SELECT source, external_id FROM subtasks WHERE id = ?')
      .get(subtask.id) as { source: string | null; external_id: string | null }
    expect(subtaskRow.source).toBeNull()
    expect(subtaskRow.external_id).toBeNull()

    // Both the direct-id row and the args-substring row referencing task-13 are gone.
    expect(outboxCount()).toBe(0)
  })

  it('does not push anything', () => {
    const projectId = syncedProject('proj-14')
    const taskId = syncedTask(projectId, 'task-14')

    tasksRepo.keepLocal(taskId)

    expect(outboxCount()).toBe(0)
  })
})

// ── rollback ─────────────────────────────────────────────────────────────────────────

describe('a thrown hook rolls back the local write', () => {
  afterEach(() => {
    hookOverrides.onLocalTaskUpdated = null
  })

  it('leaves the task and the outbox untouched when the update hook throws', () => {
    const projectId = syncedProject('proj-15')
    const taskId = syncedTask(projectId, 'task-15')
    const before = tasksRepo.get(taskId)!

    hookOverrides.onLocalTaskUpdated = () => {
      throw new Error('boom')
    }

    expect(() => tasksRepo.update(taskId, { title: 'Should not stick' })).toThrow('boom')

    const after = tasksRepo.get(taskId)!
    expect(after.title).toBe(before.title)
    expect(outboxCount()).toBe(0)
  })
})
