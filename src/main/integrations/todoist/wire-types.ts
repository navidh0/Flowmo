/**
 * Wire shapes for the Todoist Sync API v1 (`https://api.todoist.com/api/v1/sync`).
 *
 * These are intentionally a small subset of what the API actually returns — only the
 * fields this integration reads or writes. See `client.ts` for what was verified against
 * the live docs and what is a documented-but-unverified best effort.
 */

/** Raw `due` object as Todoist sends and accepts it. Stored verbatim as `remote_due`. */
export interface RemoteDue {
  /** 'YYYY-MM-DD', or a datetime — floating ('YYYY-MM-DDTHH:MM:SS') or zoned (has an
   *  offset or trailing 'Z'). Never trust this alone for "is this an instant"; check for
   *  an offset/'Z' first. */
  date: string
  /** Natural-language recurrence text ("every day"), present only when recurring. */
  string?: string
  /** IANA zone the due was authored in; null/absent for a floating datetime or date-only. */
  timezone?: string | null
  is_recurring?: boolean
  lang?: string
}

export interface RemoteItem {
  id: string
  content: string
  description?: string | null
  project_id: string
  parent_id: string | null
  priority: number
  due: RemoteDue | null
  checked?: boolean
  is_deleted?: boolean
  completed_at?: string | null
  added_at?: string
}

export interface RemoteProject {
  id: string
  name: string
  color?: string
  is_deleted?: boolean
  is_archived?: boolean
}

export interface SyncCommand {
  type: string
  uuid: string
  temp_id?: string
  args: Record<string, unknown>
}

export type CommandStatus = 'ok' | { error_tag?: string; error_code?: number; error: string; http_code?: number }

export interface SyncResponse {
  sync_token: string
  full_sync: boolean
  items?: RemoteItem[]
  projects?: RemoteProject[]
  temp_id_mapping?: Record<string, string>
  sync_status?: Record<string, CommandStatus>
}

export interface RemoteCompletedItem {
  id: string
  content: string
  project_id: string
  completed_at: string
}

export interface CompletedItemsResponse {
  items: RemoteCompletedItem[]
  next_cursor: string | null
}
