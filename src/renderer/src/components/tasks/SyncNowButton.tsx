/**
 * "Sync now" for the Today smart view: pulls Todoist and refreshes calendar feeds without a
 * trip to Settings → Integrations.
 *
 * Talks to `window.flowdo.integrations` directly, the same way `UpdatesSection.tsx` talks to
 * `window.flowdo.updates` — NOT through `useIntegrationsStore`. That store's `init()`/
 * `dispose()` is a reference-counted lifecycle owned by the Settings screen's
 * IntegrationsSection; this button mounts and unmounts far more often (every time the Today
 * view opens) and has no business joining a lifecycle meant for a screen that opens rarely
 * and stays open. It keeps its own small, unshared state instead: a status read and a feed
 * list on mount, kept current via `todoist.onStatus` and `onDataChanged('calendar')`.
 *
 * The decision logic (which providers are connected, running them in parallel, turning the
 * result into one line of text) lives in `syncNow.ts`, kept pure and out of this file so it
 * can be unit-tested without React or Electron — see that file's own header. This component
 * is just the wiring: read state in, one click out, the summary back onto the button.
 *
 * Renders nothing when neither provider is connected — a button that would always do
 * nothing is worse than no button at all. The task list and timeline already reload off
 * `onDataChanged` on their own, so a successful sync here needs no further plumbing to show
 * fresh data; this only has to trigger it and report on it.
 */

import { useEffect, useRef, useState } from 'react'
import type { CalendarFeed, TodoistStatus } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { SyncIcon } from './icons'
import { connectedProviders, runSync, summarizeSync, type SyncSummary } from './syncNow'

export interface SyncNowButtonProps {
  /** Layout only — this button has no opinion on where it sits in its header; the caller
   *  (TaskList's smart-view header) decides that. */
  className?: string
}

export function SyncNowButton({ className = '' }: SyncNowButtonProps): React.JSX.Element | null {
  const [todoist, setTodoist] = useState<TodoistStatus | null>(null)
  const [feeds, setFeeds] = useState<CalendarFeed[]>([])
  const [syncing, setSyncing] = useState(false)
  // Sticks around across syncs on purpose: a failure's text (and its danger-tinted icon)
  // should stay visible until the NEXT sync actually succeeds, not vanish the moment a new
  // one starts.
  const [summary, setSummary] = useState<SyncSummary | null>(null)

  // Guards the state updates a click's async work makes after it resolves — the button can
  // legitimately unmount mid-sync (switching to Upcoming, or away from the task panel
  // entirely) and that sync should still be allowed to finish server-side without trying to
  // setState on a gone component.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    function refresh(): void {
      window.flowdo.integrations.todoist
        .status()
        .then((s) => {
          if (!cancelled) setTodoist(s)
        })
        .catch(() => {
          // Left at whatever it last was. A failed read of the status itself isn't a sync
          // failure, and there's nothing actionable to show for it here.
        })
      window.flowdo.integrations.calendars
        .list()
        .then((f) => {
          if (!cancelled) setFeeds(f)
        })
        .catch(() => {})
    }

    refresh()

    const unsubStatus = window.flowdo.integrations.todoist.onStatus((s) => {
      if (!cancelled) setTodoist(s)
    })
    // Feed enable/disable and background refreshes both land here; re-reading the whole list
    // is simpler than trying to patch one feed in and is cheap (it's already in memory on
    // main's side).
    const unsubData = window.flowdo.events.onDataChanged((scope) => {
      if (scope === 'calendar') refresh()
    })

    return () => {
      cancelled = true
      unsubStatus()
      unsubData()
    }
  }, [])

  const providers = connectedProviders(todoist, feeds)
  const connected = providers.todoist || providers.calendars

  async function handleClick(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    const result = await runSync(window.flowdo.integrations, providers)
    if (!mountedRef.current) return
    // Apply the sync's own result immediately rather than waiting on the subscriptions
    // above: `todoist.onStatus` always fires (main's engine calls `emitStatus()` on every
    // path), but calendars' `onDataChanged('calendar')` only fires when a feed's EVENTS
    // changed — a feed that merely failed (or was simply up to date already) fires neither,
    // and this button would otherwise show a stale "connected" feed list forever.
    if (result.todoist?.ok) setTodoist(result.todoist.value)
    if (result.calendars?.ok) setFeeds(result.calendars.value)
    setSummary(summarizeSync(result, Date.now()))
    setSyncing(false)
  }

  if (!connected) return null

  const failed = summary !== null && !summary.ok

  // No aria-label: the visible "Sync now" / "Syncing…" is the accessible name, so what a
  // screen reader announces matches what a voice-control user says. The live region sits
  // beside the button, not inside it, or its text would become part of that name.
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={className}
        data-testid="sync-now"
        aria-busy={syncing}
        disabled={syncing}
        title={summary?.text ?? 'Pull Todoist and refresh calendar feeds'}
        onClick={() => void handleClick()}
      >
        <SyncIcon
          className={`h-3.5 w-3.5 ${syncing ? 'motion-safe:animate-spin' : ''} ${
            failed ? 'text-[var(--color-danger)]' : ''
          }`}
        />
        {syncing ? 'Syncing…' : 'Sync now'}
      </Button>
      <span className="sr-only" aria-live="polite">
        {summary?.text ?? ''}
      </span>
    </>
  )
}
