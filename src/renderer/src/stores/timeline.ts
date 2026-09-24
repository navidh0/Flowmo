/**
 * Timeline state for Day/Week/Month: sessions and calendar events for whatever range the
 * current view needs, plus project/feed colours and a small task-title cache for the
 * hover/focus card.
 *
 * One fetch per range (not one per day) — `load()` always asks for `viewRangeBounds(view,
 * anchorMs)`, which for Week is 7 days and for Month is the full leading/trailing grid, so
 * switching views or paging never fans out into per-day IPC calls.
 *
 * `calendar.eventsRange` is wired next wave and rejects until then (see integration
 * contract). That must never blank the page — sessions still load and render, and the
 * calendar failure surfaces as a quiet, dismissable note rather than the shared error
 * banner treatment stats/tasks use for a real failure. Separately, the contract's
 * `CALENDAR_CACHE_DAYS` bounds how far the cache actually reaches — a range partly or
 * wholly outside that window gets its own quiet note naming the window, rather than
 * looking like an empty calendar (see `calendarWindowNote`).
 *
 * `view` lives here, not in settings: switching Day/Week/Month is a per-session choice
 * (CLAUDE.md's settings module is for durable preferences, not view state), so it resets to
 * 'day' on every fresh load and is never written anywhere.
 *
 * Mirrors `stores/stats.ts`'s generation-counter pattern so a range change or a refresh that
 * starts after a newer one cannot resolve fetch handlers set the store back a step.
 */

import { create } from 'zustand'
import { CALENDAR_CACHE_DAYS } from '@shared/types'
import type { CalendarEvent, CalendarFeed, FlowdoApi, Project, Session, TaskWithStats } from '@shared/types'
import { type DayBounds } from '../components/timeline/layout'
import { calendarWindowNote, shiftView, viewRangeBounds, type ViewMode } from '../components/timeline/views'

function api(): FlowdoApi | null {
  if (typeof window === 'undefined') return null
  return (window as Partial<Window>).flowdo ?? null
}

async function waitForApi(timeoutMs = 3000): Promise<FlowdoApi | null> {
  const deadline = Date.now() + timeoutMs
  let bridge = api()
  while (!bridge && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    bridge = api()
  }
  return bridge
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker >= 0 ? raw.slice(marker + 'Error: '.length) : raw
}

export interface TimelineState {
  view: ViewMode
  /** Any instant within the range currently shown; the range itself is derived from it via
   *  `viewRangeBounds(view, anchorMs)`. */
  anchorMs: number
  sessions: Session[]
  calendarEvents: CalendarEvent[]
  /** Non-null when `calendar.eventsRange` failed outright, OR when the visible range lies
   *  partly/wholly outside the calendar cache window — either way, a quiet note, never a
   *  blank calendar. Sessions render regardless. */
  calendarNote: string | null
  /** feedId -> the feed's colour, for painting events by their source calendar. Empty (not
   *  missing) when the feed list failed to load — callers fall back to the shared accent. */
  feedColors: Map<number, string>
  projects: Project[]
  /** True only for the initial load and a range/view change, not for a background refresh. */
  loading: boolean
  /** A real failure loading sessions — unlike `calendarNote`, this is worth a retry action. */
  error: string | null
  ready: boolean
  taskTitles: Map<number, string | null>
}

export interface TimelineActions {
  init: () => Promise<void>
  dispose: () => void
  setView: (view: ViewMode) => Promise<void>
  /** Switches to Day view anchored on `dayMs` in one step — what clicking a day in Week or
   *  Month view does. Two separate `setView`/anchor updates would fetch the wrong range
   *  once, for the view being left, before fetching again for Day. */
  goToDay: (dayMs: number) => Promise<void>
  goToday: () => Promise<void>
  goPrev: () => Promise<void>
  goNext: () => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void
  /** Cached lookup of a task's title for the hover card; fetches once per id. */
  getTaskTitle: (taskId: number) => string | null
}

export type TimelineStore = TimelineState & TimelineActions

const INITIAL: TimelineState = {
  view: 'day',
  anchorMs: Date.now(),
  sessions: [],
  calendarEvents: [],
  calendarNote: null,
  feedColors: new Map(),
  projects: [],
  loading: true,
  error: null,
  ready: false,
  taskTitles: new Map()
}

/** Subscriptions are process-level resources, not state — see stores/tasks.ts. */
let unsubscribers: Array<() => void> = []
/** Bumped by dispose()/range changes so a superseded in-flight load is a no-op on arrival. */
let generation = 0

export const useTimelineStore = create<TimelineStore>((set, get) => {
  async function load(view: ViewMode, anchorMs: number, mine: number): Promise<void> {
    const bridge = api()
    if (!bridge) {
      set({ error: 'The app bridge is not available yet.', loading: false })
      return
    }
    const range: DayBounds = viewRangeBounds(view, anchorMs)

    const [sessionsResult, eventsResult, projectsResult, feedsResult] = await Promise.allSettled([
      bridge.sessions.listRange(range.start, range.end),
      bridge.calendar.eventsRange(range.start, range.end),
      bridge.projects.list(),
      bridge.integrations.calendars.list()
    ])

    if (mine !== generation) return

    const patch: Partial<TimelineState> = { loading: false }

    if (sessionsResult.status === 'fulfilled') {
      patch.sessions = sessionsResult.value
      patch.error = null
    } else {
      patch.error = messageOf(sessionsResult.reason)
    }

    if (eventsResult.status === 'fulfilled') {
      patch.calendarEvents = eventsResult.value
      // The fetch succeeded — the only reason to still say something is the visible range
      // reaching outside what the cache actually covers (a month scrolled far away must not
      // read as "nothing scheduled" just because the cache never fetched that far).
      patch.calendarNote = calendarWindowNote(range, Date.now(), CALENDAR_CACHE_DAYS)
    } else {
      patch.calendarEvents = []
      patch.calendarNote = 'Calendars unavailable'
    }

    if (projectsResult.status === 'fulfilled') {
      patch.projects = projectsResult.value
    }

    // A rejection here (not yet wired, or a real failure) just means events fall back to the
    // shared accent color — never blanks the page, same reasoning as calendarNote above.
    if (feedsResult.status === 'fulfilled') {
      patch.feedColors = new Map(feedsResult.value.map((f: CalendarFeed) => [f.id, f.color]))
    }

    set(patch)
  }

  async function go(nextView: ViewMode, nextAnchorMs: number): Promise<void> {
    const mine = ++generation
    set({ view: nextView, anchorMs: nextAnchorMs, loading: true, taskTitles: new Map() })
    await load(nextView, nextAnchorMs, mine)
  }

  return {
    ...INITIAL,

    async init() {
      const mine = ++generation
      const bridge = await waitForApi()
      if (mine !== generation) return
      if (!bridge) {
        set({ loading: false, error: 'Could not reach the app bridge.' })
        return
      }

      // A phase ending anywhere logs or updates a session; a calendar/project change comes
      // from a background sync or refresh. Either way this screen re-reads rather than
      // patches, same reasoning as stores/stats.ts — a logged session carries fields
      // (completed/interrupted/actualMs) a local guess would get wrong.
      unsubscribers.push(bridge.timer.onPhaseEnd(() => void get().refresh()))
      unsubscribers.push(
        bridge.events.onDataChanged((scope) => {
          if (scope === 'calendar' || scope === 'projects') void get().refresh()
        })
      )

      set({ loading: true })
      await load(get().view, get().anchorMs, mine)
      if (mine !== generation) return
      set({ ready: true })
    },

    dispose() {
      generation += 1
      for (const off of unsubscribers) off()
      unsubscribers = []
      set({ ready: false })
    },

    async setView(view) {
      if (view === get().view) return
      await go(view, get().anchorMs)
    },

    async goToDay(dayMs) {
      await go('day', dayMs)
    },

    async goToday() {
      await go(get().view, Date.now())
    },

    async goPrev() {
      await go(get().view, shiftView(get().view, get().anchorMs, -1))
    },

    async goNext() {
      await go(get().view, shiftView(get().view, get().anchorMs, 1))
    },

    async refresh() {
      const mine = generation
      await load(get().view, get().anchorMs, mine)
    },

    clearError() {
      set({ error: null })
    },

    getTaskTitle(taskId) {
      const cached = get().taskTitles.get(taskId)
      if (cached !== undefined) return cached

      // Seed a pending marker synchronously so a rapid re-render (e.g. hovering the same
      // block twice) doesn't fire a second IPC call while the first is still in flight.
      const pending = new Map(get().taskTitles)
      pending.set(taskId, null)
      set({ taskTitles: pending })

      const bridge = api()
      if (!bridge) return null

      void bridge.tasks
        .get(taskId)
        .then((task: TaskWithStats | null) => {
          const next = new Map(get().taskTitles)
          next.set(taskId, task?.title ?? null)
          set({ taskTitles: next })
        })
        .catch(() => {
          // Leave it cached as null — a missing/deleted task is a normal outcome here, not
          // worth surfacing as an error on top of the block's own title.
        })

      return null
    }
  }
})
