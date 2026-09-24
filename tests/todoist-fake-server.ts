/**
 * An in-memory model of the Todoist Sync API v1, used as the injected `fetch` for the
 * `main-todoist` test suite. Not a test file itself — imported by `tests/todoist-*.test.ts`.
 *
 * Modeled on what `client.ts` actually sends (form-encoded `sync_token`/`resource_types`/
 * `commands`) and what it expects back (`sync_token`, `items`, `projects`,
 * `temp_id_mapping`, `sync_status`). Incremental sync is modeled with a per-row version
 * counter: a pull with `sync_token = N` returns every row whose version is `> N`.
 */

import type {
  CommandStatus,
  RemoteCompletedItem,
  RemoteDue,
  RemoteItem,
  RemoteProject,
  SyncCommand,
  SyncResponse
} from '../src/main/integrations/todoist/wire-types'

interface FakeItem extends RemoteItem {
  version: number
}

interface FakeProject extends RemoteProject {
  version: number
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

export class FakeTodoistServer {
  token = 'valid-token'

  private items = new Map<string, FakeItem>()
  private projects = new Map<string, FakeProject>()
  private version = 0
  private appliedUuids = new Set<string>()
  private itemSeq = 1
  private projectSeq = 1

  /** Consumed one at a time: the next N requests throw as if offline. */
  networkFailNext = 0
  /** Consumed one at a time: the request applies commands normally (committing them
   *  server-side) but the response never makes it back — models an ack lost in transit,
   *  so a retry must resend the same uuid and see it already applied. */
  dropResponseAfterApplyNext = 0
  /** Consumed once: the next request returns this top-level HTTP error instead of 200. */
  httpErrorNext: { status: number; retryAfterSeconds?: number } | null = null
  /** Per-command override, e.g. to force a permanent 4xx or simulate a dropped response
   *  (return undefined so the client sees no sync_status entry for that uuid at all). */
  commandStatusOverride: ((command: SyncCommand) => CommandStatus | 'omit' | undefined) | null = null

  completedItems: RemoteCompletedItem[] = []

  requestsInFlight = 0
  maxConcurrentRequests = 0
  requestLog: { syncToken: string; commandCount: number }[] = []

  addProject(input: { id?: string; name: string; color?: string; isDeleted?: boolean; isArchived?: boolean }): FakeProject {
    const id = input.id ?? `project_${this.projectSeq++}`
    const project: FakeProject = {
      id,
      name: input.name,
      color: input.color ?? '#6366f1',
      is_deleted: input.isDeleted ?? false,
      is_archived: input.isArchived ?? false,
      version: ++this.version
    }
    this.projects.set(id, project)
    return project
  }

  addItem(input: {
    id?: string
    content: string
    projectId: string
    parentId?: string | null
    priority?: number
    due?: RemoteDue | null
    checked?: boolean
    description?: string | null
  }): FakeItem {
    const id = input.id ?? `item_${this.itemSeq++}`
    const item: FakeItem = {
      id,
      content: input.content,
      description: input.description ?? null,
      project_id: input.projectId,
      parent_id: input.parentId ?? null,
      priority: input.priority ?? 1,
      due: input.due ?? null,
      checked: input.checked ?? false,
      is_deleted: false,
      completed_at: null,
      version: ++this.version
    }
    this.items.set(id, item)
    return item
  }

  /** Mutate a row as if it changed on Todoist directly (not through a command), bumping
   *  its version so the next incremental pull reports it. */
  mutateItem(id: string, patch: Partial<FakeItem>): void {
    const item = this.items.get(id)
    if (!item) throw new Error(`fake server: no item ${id}`)
    Object.assign(item, patch, { version: ++this.version })
  }

  deleteItemUpstream(id: string): void {
    this.mutateItem(id, { is_deleted: true })
  }

  getItem(id: string): FakeItem | undefined {
    return this.items.get(id)
  }

  private resolveId(id: string, mapping: Record<string, string>): string {
    return mapping[id] ?? id
  }

  private applyCommand(command: SyncCommand, mapping: Record<string, string>): void {
    const args = command.args
    switch (command.type) {
      case 'item_add': {
        const id = `item_${this.itemSeq++}`
        const projectIdRaw = typeof args.project_id === 'string' ? args.project_id : undefined
        const parentIdRaw = typeof args.parent_id === 'string' ? args.parent_id : undefined
        const parentId = parentIdRaw ? this.resolveId(parentIdRaw, mapping) : null
        const projectId = projectIdRaw
          ? this.resolveId(projectIdRaw, mapping)
          : parentId
            ? (this.items.get(parentId)?.project_id ?? '')
            : ''
        const item: FakeItem = {
          id,
          content: String(args.content ?? ''),
          description: (args.description as string | undefined) ?? null,
          project_id: projectId,
          parent_id: parentId,
          priority: typeof args.priority === 'number' ? args.priority : 1,
          due: (args.due as RemoteDue | null | undefined) ?? null,
          checked: false,
          is_deleted: false,
          completed_at: null,
          version: ++this.version
        }
        this.items.set(id, item)
        if (command.temp_id) mapping[command.temp_id] = id
        break
      }
      case 'item_update': {
        const id = this.resolveId(String(args.id), mapping)
        const item = this.items.get(id)
        if (!item) break
        if ('content' in args) item.content = String(args.content)
        if ('description' in args) item.description = args.description as string
        if ('priority' in args) item.priority = Number(args.priority)
        if ('due' in args) item.due = (args.due as RemoteDue | null) ?? null
        item.version = ++this.version
        break
      }
      case 'item_close': {
        const id = this.resolveId(String(args.id), mapping)
        const item = this.items.get(id)
        if (!item) break
        if (item.due?.is_recurring) {
          const day = item.due.date.slice(0, 10)
          const d = new Date(`${day}T00:00:00`)
          d.setDate(d.getDate() + 1)
          const y = d.getFullYear()
          const m = String(d.getMonth() + 1).padStart(2, '0')
          const dd = String(d.getDate()).padStart(2, '0')
          item.due = { ...item.due, date: `${y}-${m}-${dd}` }
          item.checked = false
          item.completed_at = null
        } else {
          item.checked = true
          item.completed_at = new Date().toISOString()
        }
        item.version = ++this.version
        break
      }
      case 'item_uncomplete': {
        const id = this.resolveId(String(args.id), mapping)
        const item = this.items.get(id)
        if (!item) break
        item.checked = false
        item.completed_at = null
        item.version = ++this.version
        break
      }
      case 'item_move': {
        const id = this.resolveId(String(args.id), mapping)
        const item = this.items.get(id)
        if (!item) break
        item.project_id = this.resolveId(String(args.project_id), mapping)
        item.version = ++this.version
        break
      }
      case 'item_delete': {
        const id = this.resolveId(String(args.id), mapping)
        const item = this.items.get(id)
        if (!item) break
        item.is_deleted = true
        item.version = ++this.version
        break
      }
      default:
        break
    }
  }

  fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.requestsInFlight++
    this.maxConcurrentRequests = Math.max(this.maxConcurrentRequests, this.requestsInFlight)
    try {
      if (this.networkFailNext > 0) {
        this.networkFailNext--
        throw new TypeError('fake network failure')
      }

      const url = String(input)
      const headers = new Headers(init?.headers)
      const auth = headers.get('Authorization') ?? ''

      if (url.includes('/tasks/completed/')) {
        if (auth !== `Bearer ${this.token}`) return jsonResponse(401, { error: 'invalid token' })
        return jsonResponse(200, { items: this.completedItems, next_cursor: null })
      }

      if (auth !== `Bearer ${this.token}`) {
        return jsonResponse(401, { error: 'invalid token' })
      }

      if (this.httpErrorNext) {
        const { status, retryAfterSeconds } = this.httpErrorNext
        this.httpErrorNext = null
        const headerInit: Record<string, string> =
          retryAfterSeconds !== undefined ? { 'Retry-After': String(retryAfterSeconds) } : {}
        return jsonResponse(status, { error: 'error' }, headerInit)
      }

      const body = new URLSearchParams(String(init?.body ?? ''))
      const syncToken = body.get('sync_token') ?? '*'
      const commandsRaw = body.get('commands')
      const commands: SyncCommand[] = commandsRaw ? (JSON.parse(commandsRaw) as SyncCommand[]) : []
      this.requestLog.push({ syncToken, commandCount: commands.length })

      const sync_status: Record<string, CommandStatus> = {}
      const temp_id_mapping: Record<string, string> = {}

      for (const command of commands) {
        if (this.appliedUuids.has(command.uuid)) {
          sync_status[command.uuid] = 'ok'
          continue
        }

        const override = this.commandStatusOverride?.(command)
        if (override === 'omit') continue // simulate a response that never mentions this uuid
        if (override && override !== 'ok') {
          sync_status[command.uuid] = override
          continue
        }

        this.appliedUuids.add(command.uuid)
        this.applyCommand(command, temp_id_mapping)
        sync_status[command.uuid] = 'ok'
      }

      if (this.dropResponseAfterApplyNext > 0) {
        this.dropResponseAfterApplyNext--
        throw new TypeError('fake network failure (response lost after apply)')
      }

      const sinceVersion = syncToken === '*' ? 0 : Number(syncToken)
      const items = [...this.items.values()]
        .filter((i) => i.version > sinceVersion)
        .map(({ version: _v, ...rest }) => rest)
      const projects = [...this.projects.values()]
        .filter((p) => p.version > sinceVersion)
        .map(({ version: _v, ...rest }) => rest)

      const response: SyncResponse = {
        sync_token: String(this.version),
        full_sync: syncToken === '*',
        items,
        projects,
        temp_id_mapping,
        sync_status
      }
      return jsonResponse(200, response)
    } finally {
      this.requestsInFlight--
    }
  }) as unknown as typeof fetch
}
