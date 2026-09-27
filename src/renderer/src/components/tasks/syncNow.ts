/**
 * Pure decision logic behind the Today view's "Sync now" button.
 *
 * Kept out of `SyncNowButton.tsx` on purpose: vitest here runs with `environment: 'node'`
 * (see vitest.config.ts's own header — no DOM, no testing-library), so anything worth
 * unit-testing has to work as plain data in, data out. Everything React-specific (state,
 * effects, the actual `window.flowdo` calls) stays in the component; this module never
 * touches either.
 *
 * Two providers can be wired up independently — Todoist and calendar feeds — and either,
 * both, or neither may be connected at any moment (`connectedProviders`). `runSync` fires
 * only the ones that are, in parallel, via `Promise.allSettled`, so a Todoist failure can
 * never stall a calendar refresh or vice versa, and this module itself never throws.
 * `summarizeSync` turns whatever came back into the one line the button shows afterwards.
 *
 * A calendar refresh failing per-feed is NOT the same as the whole `refreshNow()` call
 * rejecting: main's `refreshNow()` resolves with the full feed list even when some enabled
 * feed individually failed (it just keeps that feed's own `lastError` — see
 * src/main/integrations/ical/index.ts's `refreshOne`/`refreshNow`), so the fulfilled path
 * below re-reads `lastError` off every enabled feed rather than treating "the promise
 * resolved" as "everything synced".
 */

import type { CalendarFeed, TodoistStatus } from '@shared/types'

export interface SyncProviders {
  todoist: boolean
  calendars: boolean
}

/** The slice of `window.flowdo.integrations` this module needs — narrow on purpose so a
 *  test can hand it a fake without building the whole preload bridge. */
export interface SyncApi {
  todoist: { syncNow(): Promise<TodoistStatus> }
  calendars: { refreshNow(): Promise<CalendarFeed[]> }
}

export type ProviderOutcome<T> = { ok: true; value: T } | { ok: false; error: string } | null

export interface SyncResult {
  /** `null` means "not connected, never called" — not "ran and was skipped". */
  todoist: ProviderOutcome<TodoistStatus>
  calendars: ProviderOutcome<CalendarFeed[]>
}

export interface SyncSummary {
  ok: boolean
  text: string
}

/**
 * Todoist counts as connected unless it was never set up (`disconnected`) or can't be
 * (`unavailable` — no usable OS secure storage). An `error` state (auth/network/rate-limit/
 * provider) still means there is a connection worth retrying, which is exactly when "Sync
 * now" earns its keep. Calendars count as connected the moment any one feed is enabled;
 * disabled feeds are already skipped by `refreshNow()` itself, so there's nothing to sync
 * when every feed is off.
 */
export function connectedProviders(status: TodoistStatus | null, feeds: CalendarFeed[]): SyncProviders {
  const state = status?.health.state
  return {
    todoist: state !== undefined && state !== 'disconnected' && state !== 'unavailable',
    calendars: feeds.some((f) => f.enabled)
  }
}

/** Electron wraps a main-process throw in its own message; only the tail means anything to
 *  a user. Same trim as `stores/integrations.ts`'s `messageOf`, duplicated rather than
 *  imported — this module deliberately has no dependency on that store (or any store: see
 *  this file's header, and `SyncNowButton.tsx`'s on why the button itself doesn't use it). */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker >= 0 ? raw.slice(marker + 'Error: '.length) : raw
}

/**
 * Runs only the connected providers, in parallel. A provider that isn't connected is never
 * called at all — its result is `null`, distinct from a provider that ran and failed.
 * `Promise.allSettled` (rather than `Promise.all`, or awaiting each separately) is what
 * guarantees one side rejecting can never affect the other's own result.
 */
export async function runSync(api: SyncApi, providers: SyncProviders): Promise<SyncResult> {
  const [todoistSettled, calendarsSettled] = await Promise.allSettled([
    providers.todoist ? api.todoist.syncNow() : Promise.resolve(null),
    providers.calendars ? api.calendars.refreshNow() : Promise.resolve(null)
  ])

  function toOutcome<T>(settled: PromiseSettledResult<T | null>, ran: boolean): ProviderOutcome<T> {
    if (!ran) return null
    if (settled.status === 'fulfilled') return { ok: true, value: settled.value as T }
    return { ok: false, error: messageOf(settled.reason) }
  }

  return {
    todoist: toOutcome<TodoistStatus>(todoistSettled, providers.todoist),
    calendars: toOutcome<CalendarFeed[]>(calendarsSettled, providers.calendars)
  }
}

/** "just now" below 45s, same threshold `relativeTime.ts`'s `formatRelativeTime` uses,
 *  otherwise whole minutes. Not imported from there: that helper lives under
 *  `settings/integrations/` and is tuned for a periodically-reread status line, not a
 *  one-shot summary computed once right as a sync finishes. */
function relativeTo(atMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - atMs)
  if (diffMs < 45_000) return 'just now'
  const minutes = Math.round(diffMs / 60_000)
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
}

/**
 * One line for the button's `title` and its `aria-live` region: "Synced <when>" when
 * everything that ran succeeded, otherwise the specific thing(s) that didn't — a Todoist
 * problem and/or which calendars failed, joined together when both happened. `now` anchors
 * the success wording to the freshest `lastOkAt` actually returned, rather than assuming
 * "just now" is always right (a slow provider, or a clock skew in a test, shouldn't lie).
 */
export function summarizeSync(result: SyncResult, now: number): SyncSummary {
  const problems: string[] = []
  const okAts: number[] = []

  if (result.todoist) {
    if (!result.todoist.ok) {
      problems.push(`Todoist: ${result.todoist.error}`)
    } else if (result.todoist.value.health.state === 'error') {
      problems.push(`Todoist: ${result.todoist.value.health.message}`)
    } else if (result.todoist.value.health.state === 'ok') {
      okAts.push(result.todoist.value.health.lastOkAt)
    }
  }

  if (result.calendars) {
    if (!result.calendars.ok) {
      problems.push(`Calendars: ${result.calendars.error}`)
    } else {
      const enabled = result.calendars.value.filter((f) => f.enabled)
      const failed = enabled.filter((f) => f.lastError)
      const [onlyFailed] = failed
      if (failed.length === 1 && onlyFailed) {
        problems.push(`Calendar "${onlyFailed.name}" failed`)
      } else if (failed.length > 1) {
        problems.push(`${failed.length} calendars failed`)
      }
      for (const f of enabled) {
        if (f.lastOkAt !== null) okAts.push(f.lastOkAt)
      }
    }
  }

  if (problems.length > 0) return { ok: false, text: problems.join('; ') }

  const latestOkAt = okAts.length > 0 ? Math.max(...okAts) : now
  return { ok: true, text: `Synced ${relativeTo(latestOkAt, now)}` }
}
