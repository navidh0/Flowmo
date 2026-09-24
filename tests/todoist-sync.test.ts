/**
 * End-to-end sync engine tests against `FakeTodoistServer` (an in-memory model of the
 * real Sync API, see `tests/todoist-fake-server.ts`) and a fake `credentials` module
 * (per the brief: the real one belongs to another agent and is mocked here).
 *
 * `electron` is mocked the same way `tests/stats-repo.test.ts` does it, so `getDb()` opens
 * a real throwaway `node:sqlite` file and runs the real migrations — what's under test is
 * the real schema and real SQL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DataChangedScope, TodoistStatus } from '@shared/types'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }))

const { fakeCredentials } = vi.hoisted(() => {
  // Inlined rather than imported: vi.mock factories are hoisted above imports, so a
  // factory that imports another test helper module risks the same "used before
  // initialization" trap `vi.hoisted` exists to avoid.
  const store = new Map<string, string>()
  let available = true
  return {
    fakeCredentials: {
      store,
      setAvailable: (value: boolean) => {
        available = value
      },
      isSecureStorageAvailable: (): boolean => available,
      setSecret: (key: string, value: string): void => {
        if (!available) throw new Error('unavailable')
        store.set(key, value)
      },
      getSecret: (key: string): string | null => store.get(key) ?? null,
      hasSecret: (key: string): boolean => store.has(key),
      deleteSecret: (key: string): void => {
        store.delete(key)
      }
    }
  }
})
vi.mock('../src/main/credentials', () => ({
  isSecureStorageAvailable: fakeCredentials.isSecureStorageAvailable,
  setSecret: fakeCredentials.setSecret,
  getSecret: fakeCredentials.getSecret,
  hasSecret: fakeCredentials.hasSecret,
  deleteSecret: fakeCredentials.deleteSecret
}))

import { closeDb, getDb } from '../src/main/db'
import * as projectsRepo from '../src/main/db/repo/projects'
import * as tasksRepo from '../src/main/db/repo/tasks'
import * as subtasksRepo from '../src/main/db/repo/subtasks'
import * as sessionsRepo from '../src/main/db/repo/sessions'
import { createTodoistIntegration, type TodoistIntegration } from '../src/main/integrations/todoist/engine'
import { FakeTodoistServer } from './todoist-fake-server'

let dir: string
let server: FakeTodoistServer
let statuses: TodoistStatus[]
let changed: DataChangedScope[]
let integration: TodoistIntegration

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-todoist-sync-test-'))
  getPath.mockReturnValue(dir)
  fakeCredentials.store.clear()
  fakeCredentials.setAvailable(true)
  server = new FakeTodoistServer()
  statuses = []
  changed = []
  integration = createTodoistIntegration({
    fetch: server.fetch,
    onStatus: (s) => statuses.push(s),
    onDataChanged: (scope) => changed.push(scope)
  })
})

afterEach(() => {
  integration.stop()
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function rawTask(externalId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT * FROM tasks WHERE external_id = ?').get(externalId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`no task with external_id ${externalId}`)
  return row
}

describe('connect', () => {
  it('validates with a real sync call before storing the token; an invalid token stores nothing', async () => {
    server.token = 'the-real-token'
    const status = await integration.connect('wrong-token')
    expect(status.health).toMatchObject({ state: 'error', kind: 'auth' })
    expect(fakeCredentials.store.has('todoist.token')).toBe(false)
  })

  it('stores the token and pulls on success', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'Ship it', projectId: project.id })
    const status = await integration.connect('valid-token')
    expect(status.health.state).toBe('ok')
    expect(fakeCredentials.store.get('todoist.token')).toBe('valid-token')
    expect(changed).toContain('projects')
    expect(changed).toContain('tasks')
  })

  it('refuses to store when secure storage is unavailable, and stores nothing', async () => {
    fakeCredentials.setAvailable(false)
    const status = await integration.connect('valid-token')
    expect(status.health).toEqual({ state: 'unavailable', reason: 'no-secure-storage' })
    expect(fakeCredentials.store.has('todoist.token')).toBe(false)
  })
})

describe('initial full sync', () => {
  it('creates projects/tasks/subtasks with correct priority, due-date and recurring mapping', async () => {
    const project = server.addProject({ name: 'Work', color: '#22c55e' })
    server.addItem({ content: 'Date only', projectId: project.id, priority: 4, due: { date: '2026-03-10' } })
    server.addItem({
      content: 'Zoned datetime',
      projectId: project.id,
      due: { date: '2026-03-02T06:30:00Z', timezone: 'America/Los_Angeles' }
    })
    server.addItem({
      content: 'Recurring',
      projectId: project.id,
      due: { date: '2026-03-01', string: 'every day', is_recurring: true }
    })
    const parent = server.addItem({ content: 'Parent task', projectId: project.id })
    server.addItem({ content: 'Child subtask', projectId: project.id, parentId: parent.id })

    process.env.TZ = 'America/Los_Angeles'
    await integration.connect('valid-token')

    const projects = projectsRepo.list()
    expect(projects.some((p) => p.name === 'Work' && p.source === 'todoist')).toBe(true)

    const dateOnly = rawTask(
      (getDb().prepare("SELECT external_id FROM tasks WHERE title = 'Date only'").get() as Record<string, unknown>)
        .external_id as string
    )
    expect(dateOnly.priority).toBe(1) // Todoist 4 (urgent) -> Flowdo 1 (highest)
    expect(dateOnly.due_date).toBe('2026-03-10')

    const zoned = getDb().prepare("SELECT due_date FROM tasks WHERE title = 'Zoned datetime'").get() as Record<
      string,
      unknown
    >
    expect(zoned.due_date).toBe('2026-03-01') // rolls back a day in America/Los_Angeles

    const recurringTask = tasksRepo.list().find((t) => t.title === 'Recurring')
    expect(recurringTask?.recurring).toBe(true)

    const parentTask = tasksRepo.list().find((t) => t.title === 'Parent task')
    expect(parentTask).toBeTruthy()
    const subtasks = subtasksRepo.list(parentTask!.id)
    expect(subtasks).toHaveLength(1)
    expect(subtasks[0]?.title).toBe('Child subtask')
    expect(subtasks[0]?.source).toBe('todoist')
  })

  it('flattens a grandchild item onto its top-level ancestor task (Flowdo has one subtask level)', async () => {
    const project = server.addProject({ name: 'Work' })
    const grandparent = server.addItem({ content: 'Top-level task', projectId: project.id })
    const parent = server.addItem({ content: 'Nested once', projectId: project.id, parentId: grandparent.id })
    server.addItem({ content: 'Nested twice', projectId: project.id, parentId: parent.id })

    await integration.connect('valid-token')

    const topLevel = tasksRepo.list().find((t) => t.title === 'Top-level task')!
    expect(topLevel).toBeTruthy()
    // "Nested once" never became its own task row — it flattened onto the same ancestor.
    expect(tasksRepo.list().find((t) => t.title === 'Nested once')).toBeUndefined()

    const subtasks = subtasksRepo.list(topLevel.id)
    expect(subtasks.map((s) => s.title).sort()).toEqual(['Nested once', 'Nested twice'])
  })
})

describe('incremental sync', () => {
  it('updates only the rows that changed upstream', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'Stable', projectId: project.id })
    const changing = server.addItem({ content: 'Will change', projectId: project.id })
    await integration.connect('valid-token')

    const stableBefore = tasksRepo.list().find((t) => t.title === 'Stable')!
    server.mutateItem(changing.id, { content: 'Changed title' })

    await integration.syncNow()

    const stableAfter = tasksRepo.list().find((t) => t.id === stableBefore.id)!
    expect(stableAfter.title).toBe('Stable')
    const changedTask = tasksRepo.list().find((t) => t.title === 'Changed title')
    expect(changedTask).toBeTruthy()
  })

  it('heals a project colour stored as a Todoist NAME (pre-fix row) with NO upstream change', async () => {
    const project = server.addProject({ name: 'Work', color: 'charcoal' })
    await integration.connect('valid-token')

    // Simulate a row written before the name -> hex mapping existed. Deliberately no
    // `server.addProject`/`mutateItem` call after this: an incremental pull would never
    // report this project again on its own, since nothing changed upstream — the healing
    // pass has to run locally, independent of what the server sends back.
    getDb().prepare("UPDATE projects SET color = 'charcoal' WHERE source = 'todoist' AND external_id = ?").run(project.id)

    changed.length = 0 // connect() above already emitted 'projects' once; isolate this cycle's emission
    const status = await integration.syncNow()
    expect(status.health.state).toBe('ok')
    expect(changed).toContain('projects')

    const healed = projectsRepo.list().find((p) => p.name === 'Work')!
    expect(healed.color).toBe('#808080')
  })
})

describe('healing task due dates', () => {
  it('recomputes due_date from remote_due locally when nothing changed upstream', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({
      content: 'Tehran task',
      projectId: project.id,
      due: { date: '2026-06-15T20:15:00Z', timezone: 'Asia/Tehran', string: 'tomorrow at 11:45pm' }
    })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Tehran task')!
    expect(task.dueDate).toBe('2026-06-15') // correct from the start, with the fix in place

    // Simulate a row `due_date` computed by the old host-local-only logic (the account is
    // Asia/Tehran, the host in this scenario would have been a zone that reads this UTC
    // instant a day later — see tests/todoist-mapper.test.ts for the exact arithmetic).
    getDb().prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run('2026-06-16', task.id)

    changed.length = 0 // isolate this cycle's onDataChanged emission from connect()'s
    const status = await integration.syncNow()
    expect(status.health.state).toBe('ok')
    expect(changed).toContain('tasks')

    const healed = tasksRepo.list().find((t) => t.id === task.id)!
    expect(healed.dueDate).toBe('2026-06-15')
  })

  it('does not overwrite due_date while an outbox command is still pending for it', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({
      content: 'Tehran task',
      projectId: project.id,
      due: { date: '2026-06-15T20:15:00Z', timezone: 'Asia/Tehran' }
    })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Tehran task')!
    // A local edit to dueDate queued but not yet pushed.
    tasksRepo.update(task.id, { dueDate: '2026-08-01' })
    // Corrupt the stored value the way a legacy row might read, to prove the healing pass
    // would otherwise have touched it.
    getDb().prepare('UPDATE tasks SET due_date = ? WHERE id = ?').run('2026-06-16', task.id)

    server.commandStatusOverride = () => ({ error: 'temporarily unavailable', http_code: 500 })
    await integration.syncNow()

    const after = tasksRepo.list().find((t) => t.id === task.id)!
    expect(after.dueDate).toBe('2026-06-16') // untouched — protected by the pending command
  })
})

describe('upstream delete', () => {
  it('marks remote_deleted_at rather than deleting the row', async () => {
    const project = server.addProject({ name: 'Work' })
    const item = server.addItem({ content: 'Doomed', projectId: project.id })
    await integration.connect('valid-token')

    server.deleteItemUpstream(item.id)
    await integration.syncNow()

    const row = rawTask(item.id)
    expect(row.remote_deleted_at).not.toBeNull()
    expect(row.title).toBe('Doomed')
  })
})

describe('local edit -> outbox -> push -> ack', () => {
  it('pushes a local update and clears it from the outbox once acked', async () => {
    const project = server.addProject({ name: 'Work' })
    const item = server.addItem({ content: 'Original', projectId: project.id })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Original')!
    tasksRepo.update(task.id, { title: 'Edited locally' })
    expect((await integration.syncNow()).pendingChanges).toBe(0)

    expect(server.getItem(item.id)?.content).toBe('Edited locally')
    const count = getDb().prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as { c: number }
    expect(count.c).toBe(0)
  })
})

describe('offline push', () => {
  it('keeps the outbox and reports a network error; the next cycle pushes it', async () => {
    const project = server.addProject({ name: 'Work' })
    const item = server.addItem({ content: 'Original', projectId: project.id })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Original')!
    tasksRepo.update(task.id, { title: 'Edited while offline' })

    server.networkFailNext = 1
    const offlineStatus = await integration.syncNow()
    expect(offlineStatus.health).toMatchObject({ kind: 'network' })
    expect(offlineStatus.pendingChanges).toBe(1)
    expect(server.getItem(item.id)?.content).toBe('Original') // never reached the server

    const onlineStatus = await integration.syncNow()
    expect(onlineStatus.health.state).toBe('ok')
    expect(onlineStatus.pendingChanges).toBe(0)
    expect(server.getItem(item.id)?.content).toBe('Edited while offline')
  })
})

describe('retry after a lost response', () => {
  it('re-sends the same uuid and the fake server applies it exactly once', async () => {
    const project = server.addProject({ name: 'Work' })
    const item = server.addItem({ content: 'Original', projectId: project.id })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Original')!
    tasksRepo.update(task.id, { title: 'Edited once' })

    server.dropResponseAfterApplyNext = 1
    const lostStatus = await integration.syncNow()
    expect(lostStatus.health).toMatchObject({ kind: 'network' })
    // Applied server-side despite the lost response.
    expect(server.getItem(item.id)?.content).toBe('Edited once')
    expect(lostStatus.pendingChanges).toBe(1) // the client doesn't know that yet

    const retryStatus = await integration.syncNow()
    expect(retryStatus.health.state).toBe('ok')
    expect(retryStatus.pendingChanges).toBe(0)
    expect(server.getItem(item.id)?.content).toBe('Edited once') // not double-applied
  })
})

describe('temp_id mapping', () => {
  it('resolves a locally created task, including a follow-up update queued before the push', async () => {
    server.addProject({ name: 'Work' })
    await integration.connect('valid-token')

    const localProject = projectsRepo.list().find((p) => p.name === 'Work')!
    // `tasksRepo.create` under a synced project stamps a tmp: external id and enqueues
    // item_add itself (see db/repo/tasks.ts). A follow-up edit queued before that create
    // has even been pushed must still resolve once the temp id is mapped.
    const task = tasksRepo.create({ projectId: localProject.id, title: 'New task' })
    tasksRepo.update(task.id, { title: 'New task, edited' })

    const status = await integration.syncNow()
    expect(status.pendingChanges).toBe(0)
    expect(status.health.state).toBe('ok')

    const stored = getDb().prepare('SELECT external_id, title FROM tasks WHERE id = ?').get(task.id) as Record<
      string,
      unknown
    >
    expect(String(stored.external_id).startsWith('tmp:')).toBe(false)
    const remoteItem = server.getItem(stored.external_id as string)
    expect(remoteItem?.content).toBe('New task, edited')
  })
})

describe('local-intent-wins during pull', () => {
  it('does not overwrite a field with a pending outbox command for it', async () => {
    const project = server.addProject({ name: 'Work' })
    const item = server.addItem({ content: 'Original', projectId: project.id })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Original')!
    // Local edit queued but not yet pushed — the write path applies the local row change
    // AND enqueues the outbox command in the same transaction (db/repo/tasks.ts).
    tasksRepo.update(task.id, { title: 'Local edit pending' })
    // Meanwhile the server has a completely different (stale, from the client's point of
    // view) title AND a changed priority.
    server.mutateItem(item.id, { content: 'Server-side edit', priority: 4 })

    // A pull-only cycle (no push) must never fire here in isolation, so drive it through
    // syncNow which pushes first — but disable actually applying the pending command by
    // forcing a transient failure that still lets the pull happen.
    server.commandStatusOverride = () => ({ error: 'temporarily unavailable', http_code: 500 })
    const status = await integration.syncNow()
    expect(status.pendingChanges).toBe(1) // still queued, protected the field

    const after = getDb().prepare('SELECT title, priority FROM tasks WHERE id = ?').get(task.id) as Record<
      string,
      unknown
    >
    expect(after.title).toBe('Local edit pending') // local intent wins
    expect(after.priority).toBe(1) // unprotected field still picks up the server's change
  })
})

describe('recurring close', () => {
  it('keeps the task open locally with the advanced due date', async () => {
    const project = server.addProject({ name: 'Work' })
    const item = server.addItem({
      content: 'Daily standup',
      projectId: project.id,
      due: { date: '2026-04-01', string: 'every day', is_recurring: true }
    })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Daily standup')!
    tasksRepo.setCompleted(task.id, true)
    const status = await integration.syncNow()
    expect(status.health.state).toBe('ok')

    const after = tasksRepo.list().find((t) => t.id === task.id)
    expect(after).toBeTruthy() // still open (not in the completed list)
    expect(after?.completedAt).toBeNull()
    expect(after?.dueDate).toBe('2026-04-02')
    expect(server.getItem(item.id)?.checked).toBe(false)
  })
})

describe('errors', () => {
  it('401 maps to error/auth and does not loop retrying automatically', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'x', projectId: project.id })
    await integration.connect('valid-token')

    server.httpErrorNext = { status: 401 }
    const status = await integration.syncNow()
    expect(status.health).toMatchObject({ state: 'error', kind: 'auth' })

    // An automatic trigger (what the 5-minute timer/nudge would fire) must not hit the
    // network again while the token is known-bad.
    const before = server.requestLog.length
    integration.nudge()
    await Promise.resolve()
    expect(server.requestLog.length).toBe(before)
  })

  it('429 with Retry-After maps to rate-limit', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'x', projectId: project.id })
    await integration.connect('valid-token')

    server.httpErrorNext = { status: 429, retryAfterSeconds: 30 }
    const status = await integration.syncNow()
    expect(status.health).toMatchObject({ state: 'error', kind: 'rate-limit' })
  })

  it('a permanent 4xx rejects the change and removes it from the queue', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'Original', projectId: project.id })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Original')!
    tasksRepo.update(task.id, { title: 'Doomed edit' })

    server.commandStatusOverride = () => ({ error: 'item not found', http_code: 404 })
    const status = await integration.syncNow()
    expect(status.pendingChanges).toBe(0)
    expect(status.rejectedChanges).toHaveLength(1)
    expect(status.rejectedChanges[0]?.message).toBe('item not found')
  })
})

describe('disconnect', () => {
  it('converts synced rows to local and leaves sessions intact', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'Task A', projectId: project.id })
    await integration.connect('valid-token')

    const task = tasksRepo.list().find((t) => t.title === 'Task A')!
    sessionsRepo.recent // touch import to keep it referenced across edits
    const session = {
      taskId: task.id,
      projectId: task.projectId,
      mode: 'pomodoro' as const,
      kind: 'focus' as const,
      startedAt: 0,
      endedAt: 1500000,
      plannedMs: 1500000,
      actualMs: 1500000,
      completed: true,
      interrupted: false,
      notes: null
    }
    const created = getDb()
      .prepare(
        `INSERT INTO sessions (task_id, project_id, mode, kind, started_at, ended_at, planned_ms, actual_ms, completed, interrupted, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.taskId,
        session.projectId,
        session.mode,
        session.kind,
        session.startedAt,
        session.endedAt,
        session.plannedMs,
        session.actualMs,
        1,
        0,
        null
      )

    integration.disconnect()

    const convertedTask = tasksRepo.list().find((t) => t.id === task.id)
    expect(convertedTask?.source).toBeNull()
    expect(convertedTask?.externalId).toBeNull()
    const convertedProject = projectsRepo.list().find((p) => p.id === task.projectId)
    expect(convertedProject?.source).toBeNull()

    const sessionRow = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(created.lastInsertRowid) as Record<
      string,
      unknown
    >
    expect(sessionRow.task_id).toBe(task.id)

    expect(fakeCredentials.store.has('todoist.token')).toBe(false)
    const outboxCount = getDb().prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as { c: number }
    expect(outboxCount.c).toBe(0)
    const stateCount = getDb().prepare('SELECT COUNT(*) AS c FROM sync_state').get() as { c: number }
    expect(stateCount.c).toBe(0)
  })
})

describe('concurrency', () => {
  it('never runs two syncNow() cycles at once', async () => {
    const project = server.addProject({ name: 'Work' })
    server.addItem({ content: 'x', projectId: project.id })
    await integration.connect('valid-token')

    const [a, b] = await Promise.all([integration.syncNow(), integration.syncNow()])
    expect(a.health.state).toBe('ok')
    expect(b.health.state).toBe('ok')
    expect(server.maxConcurrentRequests).toBe(1)
  })
})
