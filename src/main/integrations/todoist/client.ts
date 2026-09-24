/**
 * Thin HTTP client for the Todoist Sync API v1.
 *
 * Verified against https://developer.todoist.com/api/v1/ on 2026-09-24 (the docs are a
 * client-rendered SPA; the reference below quotes what the rendered page returned):
 *  - Base URL is `https://api.todoist.com/api/v1/sync` (unified v1 API; REST v2 returns
 *    410 Gone, Sync v9 is legacy). Auth is `Authorization: Bearer <token>`. Ids are strings.
 *  - Request: `sync_token` (string, `*` for a full sync), `resource_types` (JSON array,
 *    stringified), `commands` (JSON array of `{type, uuid, temp_id?, args}`, stringified).
 *  - Response: `sync_token`, `full_sync`, `items`, `projects`, `temp_id_mapping`
 *    (temp_id -> real id), `sync_status` (uuid -> `"ok"` | `{error_tag, error_code, error,
 *    http_code, error_extra}`).
 *  - `item_add`/`item_update` args confirmed: `content`, `description`, `project_id`,
 *    `priority` (1-4, 4 = urgent), `due` (`{date, string?, timezone?, is_recurring?,
 *    lang?}` — `date` is 'YYYY-MM-DD' or a datetime, floating or zoned), `parent_id`,
 *    `section_id`. State commands confirmed: `item_close`, `item_uncomplete`, `item_move`
 *    (`{id, project_id}`), `item_delete` (`{id}`). `item_close` (used here, never
 *    `item_complete`) is the one documented to advance a recurring task's due date and
 *    leave it open with the same id — using `item_complete` on a recurring task is the
 *    mistake flagged in the research notes (a Home Assistant integration bug), so it is
 *    deliberately not used anywhere in this module.
 *
 * NOT independently confirmed by a live call (no token was available while coding this;
 * only the rendered docs text, which is lossy for exact request encoding and for the
 * completed-tasks endpoint — flagged in the research notes as needing a re-check):
 *  - The exact request encoding: implemented here as `application/x-www-form-urlencoded`
 *    with `resource_types`/`commands` JSON-stringified into form fields, which matches
 *    every historical Sync API example (v8/v9) and the v1 migration guide says the sync
 *    command semantics carried over unchanged. If the real endpoint instead expects a
 *    JSON body, only `postSync` below needs to change — everything else in this module is
 *    agnostic to the wire encoding.
 *  - The completed-tasks endpoint path and its query parameter names (`since`, `until`,
 *    `cursor`, `limit`). Used only for the first-sync/post-outage completed backfill
 *    (`fetchCompletedSince`); a wrong parameter name there degrades to "no completed
 *    items found this cycle" rather than breaking the rest of sync, since the sync engine
 *    treats a fetch failure from it as non-fatal.
 *  - Concrete rate-limit numbers; only that a 429 carries `Retry-After` (standard HTTP,
 *    also asserted by the research notes) — `syncNow` reads that header when present.
 *
 * Anyone wiring this against a real account should re-verify the two "not confirmed"
 * points above with one real POST before relying on them in production.
 */

import type { CompletedItemsResponse, SyncCommand, SyncResponse } from './wire-types'

const BASE_URL = 'https://api.todoist.com/api/v1'

export class TodoistHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null
  ) {
    super(message)
    this.name = 'TodoistHttpError'
  }
}

export class TodoistNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TodoistNetworkError'
  }
}

export interface TodoistClientOptions {
  fetch: typeof fetch
  token: string
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (raw === null) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  // Retry-After MAY be an HTTP-date; best effort, never throw on a header we can't parse.
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * `fetch`/`token` are captured once per client — the token never appears in a thrown
 * error or a log line anywhere in this file.
 */
export class TodoistClient {
  private readonly fetchFn: typeof fetch
  private readonly token: string

  constructor(options: TodoistClientOptions) {
    this.fetchFn = options.fetch
    this.token = options.token
  }

  async sync(syncToken: string, commands: SyncCommand[] = []): Promise<SyncResponse> {
    const body = new URLSearchParams()
    body.set('sync_token', syncToken)
    body.set('resource_types', JSON.stringify(['projects', 'items']))
    if (commands.length > 0) body.set('commands', JSON.stringify(commands))

    let response: Response
    try {
      response = await this.fetchFn(`${BASE_URL}/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      })
    } catch {
      throw new TodoistNetworkError('todoist: network request failed')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new TodoistHttpError(
        `todoist: sync failed with status ${response.status}${text ? `: ${text}` : ''}`,
        response.status,
        retryAfterMs(response.headers)
      )
    }

    return (await response.json()) as SyncResponse
  }

  /**
   * Recently completed items, for the first sync and the post-outage backfill. See the
   * header comment — the endpoint shape here is a documented best effort, not confirmed
   * live. A caller treats any failure from this as non-fatal.
   */
  async fetchCompletedSince(sinceIso: string, cursor: string | null = null): Promise<CompletedItemsResponse> {
    const params = new URLSearchParams({ since: sinceIso, limit: '200' })
    if (cursor) params.set('cursor', cursor)

    let response: Response
    try {
      response = await this.fetchFn(`${BASE_URL}/tasks/completed/by_completion_date?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` }
      })
    } catch {
      throw new TodoistNetworkError('todoist: network request failed')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new TodoistHttpError(
        `todoist: completed-tasks fetch failed with status ${response.status}${text ? `: ${text}` : ''}`,
        response.status,
        retryAfterMs(response.headers)
      )
    }

    return (await response.json()) as CompletedItemsResponse
  }
}
