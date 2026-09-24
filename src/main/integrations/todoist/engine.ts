/**
 * The sync engine: one push-then-pull cycle, scheduling, and the public
 * `createTodoistIntegration`. See `client.ts` for what was verified against the live API
 * docs.
 */

import type { DatabaseSync } from 'node:sqlite'
import type { DataChangedScope, IntegrationHealth, TodoistStatus } from '@shared/types'
import {
  deleteSecret,
  getSecret,
  isSecureStorageAvailable,
  setSecret
} from '../../credentials'
import { getDb, num, numOrNull, str, strOrNull, type Row } from '../../db'
import { TodoistClient, TodoistHttpError, TodoistNetworkError } from './client'
import {
  applyCompletedBackfill,
  convertAllToLocal,
  pullItems,
  pullProjects
} from './store'
import type { CommandStatus, SyncCommand, SyncResponse } from './wire-types'

const TOKEN_KEY = 'todoist.token'
const FIVE_MINUTES_MS = 5 * 60_000
const NUDGE_THRESHOLD_MS = 60_000
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000
const MAX_NETWORK_BACKOFF_MS = 15 * 60_000

export interface TodoistDeps {
  fetch?: typeof fetch
  now?: () => number
  onStatus(status: TodoistStatus): void
  onDataChanged(scope: DataChangedScope): void
}

export interface TodoistIntegration {
  status(): TodoistStatus
  connect(token: string): Promise<TodoistStatus>
  disconnect(): void
  syncNow(): Promise<TodoistStatus>
  start(): void
  stop(): void
  nudge(): void
}

interface StoredSyncState {
  syncToken: string | null
  lastOkAt: number | null
  lastError: string | null
}

function readSyncState(db: DatabaseSync): StoredSyncState | null {
  const row = db
    .prepare("SELECT sync_token, last_ok_at, last_error FROM sync_state WHERE source = 'todoist'")
    .get() as Row | undefined
  if (!row) return null
  return {
    syncToken: strOrNull(row, 'sync_token'),
    lastOkAt: numOrNull(row, 'last_ok_at'),
    lastError: strOrNull(row, 'last_error')
  }
}

function persistSyncState(
  db: DatabaseSync,
  syncToken: string | null,
  lastOkAt: number | null,
  lastError: string | null,
  lastErrorAt: number | null
): void {
  db.prepare(
    `INSERT INTO sync_state (source, sync_token, last_ok_at, last_error, last_error_at)
     VALUES ('todoist', ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       sync_token = excluded.sync_token,
       last_ok_at = COALESCE(excluded.last_ok_at, sync_state.last_ok_at),
       last_error = excluded.last_error,
       last_error_at = excluded.last_error_at`
  ).run(syncToken, lastOkAt, lastError, lastErrorAt)
}

function countPendingChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE source = 'todoist'").get() as Row
  return num(row, 'c')
}

interface OutboxRow {
  id: number
  uuid: string
  type: string
  args: string
  tempId: string | null
}

function readOutboxBatch(db: DatabaseSync, limit: number): OutboxRow[] {
  return (
    db
      .prepare('SELECT id, uuid, type, args, temp_id FROM sync_outbox WHERE source = \'todoist\' ORDER BY id LIMIT ?')
      .all(limit) as Row[]
  ).map((row) => ({
    id: num(row, 'id'),
    uuid: str(row, 'uuid'),
    type: str(row, 'type'),
    args: str(row, 'args'),
    tempId: strOrNull(row, 'temp_id')
  }))
}

function buildCommands(rows: OutboxRow[]): SyncCommand[] {
  return rows.map((row) => {
    const command: SyncCommand = { type: row.type, uuid: row.uuid, args: JSON.parse(row.args) as Record<string, unknown> }
    if (row.tempId) command.temp_id = row.tempId
    return command
  })
}

function deleteOutboxRow(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM sync_outbox WHERE id = ?').run(id)
}

function bumpAttempts(db: DatabaseSync, id: number, error: string): void {
  db.prepare('UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id)
}

/** Rewrite every remaining outbox row (and the live tasks/subtasks tables) that still
 *  reference a just-resolved temp_id, so a queued follow-up edit made before the create
 *  was pushed ends up targeting the real id. */
function applyTempIdMapping(db: DatabaseSync, mapping: Record<string, string>): void {
  for (const [tempId, realId] of Object.entries(mapping)) {
    db.prepare("UPDATE tasks SET external_id = ? WHERE source = 'todoist' AND external_id = ?").run(realId, tempId)
    db.prepare("UPDATE subtasks SET external_id = ? WHERE source = 'todoist' AND external_id = ?").run(realId, tempId)

    const referencing = db
      .prepare("SELECT id, args FROM sync_outbox WHERE source = 'todoist' AND args LIKE ?")
      .all(`%${tempId}%`) as Row[]
    for (const row of referencing) {
      const rewritten = str(row, 'args').split(tempId).join(realId)
      db.prepare('UPDATE sync_outbox SET args = ? WHERE id = ?').run(rewritten, num(row, 'id'))
    }
  }
}

interface PullOutcome {
  tasksChanged: boolean
  projectsChanged: boolean
}

function applyPullResponse(db: DatabaseSync, response: SyncResponse, now: number): PullOutcome {
  const projectResult = pullProjects(db, response.projects ?? [], now)
  const itemResult = pullItems(db, response.items ?? [], projectResult.idByExternalId, now)
  return { tasksChanged: itemResult.tasksChanged, projectsChanged: projectResult.changed }
}

type ErrorKind = 'auth' | 'network' | 'rate-limit' | 'provider'

function classifyError(error: unknown): { kind: ErrorKind; message: string; retryAfterMs: number | null } {
  if (error instanceof TodoistHttpError) {
    if (error.status === 401 || error.status === 403) {
      return { kind: 'auth', message: 'todoist: token was rejected', retryAfterMs: null }
    }
    if (error.status === 429) {
      return { kind: 'rate-limit', message: 'todoist: rate limited', retryAfterMs: error.retryAfterMs }
    }
    return { kind: 'provider', message: error.message, retryAfterMs: null }
  }
  if (error instanceof TodoistNetworkError) {
    return { kind: 'network', message: error.message, retryAfterMs: null }
  }
  return { kind: 'provider', message: error instanceof Error ? error.message : String(error), retryAfterMs: null }
}

export function createTodoistIntegration(deps: TodoistDeps): TodoistIntegration {
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? (() => Date.now())

  function hasStoredToken(): boolean {
    try {
      return getSecret(TOKEN_KEY) !== null
    } catch {
      return false
    }
  }

  let health: IntegrationHealth = hasStoredToken() ? { state: 'ok', lastOkAt: now() } : { state: 'disconnected' }
  let rejectedChanges: { at: number; message: string }[] = []
  let lastOkAt: number | null = health.state === 'ok' ? health.lastOkAt : null
  let nextAllowedAt = 0
  let lastCycleStartedAt = 0
  let networkFailureStreak = 0

  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<TodoistStatus> | null = null
  let rerunRequested = false

  function status(): TodoistStatus {
    let pendingChanges = 0
    try {
      pendingChanges = countPendingChanges(getDb())
    } catch {
      pendingChanges = 0
    }
    return { health, pendingChanges, rejectedChanges: [...rejectedChanges] }
  }

  function emitStatus(): void {
    deps.onStatus(status())
  }

  function client(token: string): TodoistClient {
    return new TodoistClient({ fetch: fetchFn, token })
  }

  function finishDataChanges(outcome: PullOutcome): void {
    if (outcome.tasksChanged) deps.onDataChanged('tasks')
    if (outcome.projectsChanged) deps.onDataChanged('projects')
  }

  async function runOnce(): Promise<TodoistStatus> {
    lastCycleStartedAt = now()
    const token = getSecret(TOKEN_KEY)
    if (!token) {
      health = { state: 'disconnected' }
      emitStatus()
      return status()
    }

    health = { state: 'syncing', lastOkAt }
    emitStatus()

    const db = getDb()
    const stored = readSyncState(db)
    let syncToken = stored?.syncToken ?? '*'
    const isFirstOrPostOutage = stored === null || stored.lastError !== null
    const c = client(token)
    let tasksChanged = false
    let projectsChanged = false

    const outboxRows = readOutboxBatch(db, 100)
    if (outboxRows.length > 0) {
      let response: SyncResponse
      try {
        response = await c.sync(syncToken, buildCommands(outboxRows))
      } catch (error) {
        return fail(error, syncToken)
      }

      syncToken = response.sync_token
      applyTempIdMapping(db, response.temp_id_mapping ?? {})

      let hadTransient = false
      for (const row of outboxRows) {
        const s: CommandStatus | undefined = response.sync_status?.[row.uuid]
        if (s === 'ok') {
          deleteOutboxRow(db, row.id)
        } else if (s === undefined) {
          hadTransient = true
          bumpAttempts(db, row.id, 'todoist: no sync_status returned for this command')
        } else {
          const httpCode = s.http_code ?? 400
          const permanent = httpCode >= 400 && httpCode < 500 && httpCode !== 429
          if (permanent) {
            rejectedChanges.push({ at: now(), message: s.error })
            deleteOutboxRow(db, row.id)
          } else {
            hadTransient = true
            bumpAttempts(db, row.id, s.error)
          }
        }
      }

      const outcome = applyPullResponse(db, response, now())
      tasksChanged ||= outcome.tasksChanged
      projectsChanged ||= outcome.projectsChanged

      if (hadTransient) {
        const message = 'todoist: some changes could not be applied yet'
        persistSyncState(db, syncToken, null, message, now())
        networkFailureStreak = 0
        health = { state: 'error', kind: 'provider', message, lastOkAt, at: now() }
        finishDataChanges({ tasksChanged, projectsChanged })
        emitStatus()
        return status()
      }
    }

    let pullResponse: SyncResponse
    try {
      pullResponse = await c.sync(syncToken, [])
    } catch (error) {
      return fail(error, syncToken)
    }
    syncToken = pullResponse.sync_token
    const pulled = applyPullResponse(db, pullResponse, now())
    tasksChanged ||= pulled.tasksChanged
    projectsChanged ||= pulled.projectsChanged

    if (isFirstOrPostOutage) {
      try {
        const sinceIso = new Date(now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const completed = await c.fetchCompletedSince(sinceIso)
        if (applyCompletedBackfill(db, completed.items, now())) tasksChanged = true
      } catch {
        // Non-fatal: the endpoint shape is a documented best effort (see client.ts); a
        // failure here must not fail the whole cycle, which already made real progress.
      }
    }

    const at = now()
    lastOkAt = at
    networkFailureStreak = 0
    nextAllowedAt = 0
    persistSyncState(db, syncToken, at, null, null)
    health = { state: 'ok', lastOkAt: at }
    finishDataChanges({ tasksChanged, projectsChanged })
    emitStatus()
    return status()

    function fail(error: unknown, tokenAtFailure: string): TodoistStatus {
      const { kind, message, retryAfterMs } = classifyError(error)
      const at = now()
      if (kind === 'network') {
        networkFailureStreak += 1
        nextAllowedAt = at + Math.min(MAX_NETWORK_BACKOFF_MS, 1000 * 2 ** networkFailureStreak)
      } else if (kind === 'rate-limit') {
        nextAllowedAt = at + (retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS)
      }
      persistSyncState(db, tokenAtFailure, null, message, at)
      health = { state: 'error', kind, message, lastOkAt, at }
      finishDataChanges({ tasksChanged, projectsChanged })
      emitStatus()
      return status()
    }
  }

  async function syncNow(): Promise<TodoistStatus> {
    if (inFlight) {
      rerunRequested = true
      return inFlight
    }
    inFlight = (async () => {
      let result = await runOnce()
      while (rerunRequested) {
        rerunRequested = false
        result = await runOnce()
      }
      return result
    })()
    try {
      return await inFlight
    } finally {
      inFlight = null
    }
  }

  async function connect(token: string): Promise<TodoistStatus> {
    if (!isSecureStorageAvailable()) {
      health = { state: 'unavailable', reason: 'no-secure-storage' }
      emitStatus()
      return status()
    }

    const c = client(token)
    let response: SyncResponse
    try {
      response = await c.sync('*', [])
    } catch (error) {
      const { kind, message } = classifyError(error)
      health = { state: 'error', kind, message, lastOkAt: null, at: now() }
      emitStatus()
      return status()
    }

    setSecret(TOKEN_KEY, token)
    const db = getDb()
    const at = now()
    const outcome = applyPullResponse(db, response, at)
    persistSyncState(db, response.sync_token, at, null, null)
    lastOkAt = at
    nextAllowedAt = 0
    networkFailureStreak = 0
    health = { state: 'ok', lastOkAt: at }
    finishDataChanges(outcome)
    emitStatus()
    return status()
  }

  function disconnect(): void {
    deleteSecret(TOKEN_KEY)
    convertAllToLocal(getDb())
    rejectedChanges = []
    lastOkAt = null
    nextAllowedAt = 0
    health = { state: 'disconnected' }
    emitStatus()
    deps.onDataChanged('tasks')
    deps.onDataChanged('projects')
  }

  function triggerAutomatic(): void {
    if (health.state === 'error' && health.kind === 'auth') return // no retry loop on a rejected token
    if (now() < nextAllowedAt) return
    void syncNow()
  }

  function start(): void {
    if (timer) return
    timer = setInterval(triggerAutomatic, FIVE_MINUTES_MS)
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref()
    }
  }

  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  function nudge(): void {
    if (!hasStoredToken()) return
    if (now() - lastCycleStartedAt < NUDGE_THRESHOLD_MS) return
    triggerAutomatic()
  }

  return { status, connect, disconnect, syncNow, start, stop, nudge }
}
