/**
 * Day-timeline state: one local calendar day's sessions and calendar events, plus project
 * colours and a small task-title cache for the hover/focus card.
 *
 * `calendar.eventsRange` is wired next wave and rejects until then (see integration
 * contract). That must never blank the page — sessions still load and render, and the
 * calendar failure surfaces as a quiet, dismissable note rather than the shared error
 * banner treatment stats/tasks use for a real failure.
 *
 * Mirrors `stores/stats.ts`'s generation-counter pattern so a day change or a refresh that
 * starts after a newer one cannot resolve fetch handlers set the store back a day.
 */

import { create } from 'zustand'
import type { CalendarEvent, CalendarFeed, FlowdoApi, Project, Session, TaskWithStats } from '@shared/types'
import { localDayBounds, shiftLocalDay, type DayBounds } from '../components/timeline/layout'

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
  /** Any instant within the day currently shown; bounds are derived from it. */
  dayMs: number
  sessions: Session[]
  calendarEvents: CalendarEvent[]
  /** Non-null when `calendar.eventsRange` failed — shown as a quiet note, not a blank page. */
  calendarNote: string | null
  /** feedId -> the feed's colour, for painting events by their source calendar. Empty (not
   *  missing) when the feed list failed to load — callers fall back to the shared accent. */
  feedColors: Map<number, string>
  projects: Project[]
  /** True only for the initial load and a day change, not for a background refresh. */
  loading: boolean
  /** A real failure loading sessions — unlike `calendarNote`, this is worth a retry action. */
  error: string | null
  ready: boolean
  taskTitles: Map<number, string | null>
}

export interface TimelineActions {
  init: () => Promise<void>
  dispose: () => void
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
  dayMs: Date.now(),
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
/** Bumped by dispose()/day changes so a superseded in-flight load is a no-op on arrival. */
let generation = 0

function bounds(dayMs: number): DayBounds {
  return localDayBounds(dayMs)
}

export const useTimelineStore = create<TimelineStore>((set, get) => {
  async function load(dayMs: number, mine: number): Promise<void> {
    const bridge = api()
    if (!bridge) {
      set({ error: 'The app bridge is not available yet.', loading: false })
      return
    }
    const { start, end } = bounds(dayMs)

    const [sessionsResult, eventsResult, projectsResult, feedsResult] = await Promise.allSettled([
      bridge.sessions.listRange(start, end),
      bridge.calendar.eventsRange(start, end),
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
      patch.calendarNote = null
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
      await load(get().dayMs, mine)
      if (mine !== generation) return
      set({ ready: true })
    },

    dispose() {
      generation += 1
      for (const off of unsubscribers) off()
      unsubscribers = []
      set({ ready: false })
    },

    async goToday() {
      const mine = ++generation
      set({ dayMs: Date.now(), loading: true, taskTitles: new Map() })
      await load(get().dayMs, mine)
    },

    async goPrev() {
      const mine = ++generation
      const dayMs = shiftLocalDay(get().dayMs, -1)
      set({ dayMs, loading: true, taskTitles: new Map() })
      await load(dayMs, mine)
    },

    async goNext() {
      const mine = ++generation
      const dayMs = shiftLocalDay(get().dayMs, 1)
      set({ dayMs, loading: true, taskTitles: new Map() })
      await load(dayMs, mine)
    },

    async refresh() {
      const mine = generation
      await load(get().dayMs, mine)
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
