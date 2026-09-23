/**
 * Stats screen state.
 *
 * Mirrors the shape of `stores/tasks.ts`: every mutation (here, only `sessions.remove`)
 * re-reads from main rather than patching local state, because deleting a session moves
 * every aggregate above it (summary, daily buckets, project breakdown, streak) and there is
 * no cheap way to recompute those client-side without reimplementing the repo.
 *
 * `summary()`, `daily()`, and `byProject()` are independent IPC calls for the same range,
 * so they are fetched together and each can fail or succeed on its own; a partial failure
 * still surfaces as the shared `error` banner and leaves whatever data did load in place.
 */

import { create } from 'zustand'
import type {
  DailyBucket,
  FlowdoApi,
  ProjectBucket,
  Session,
  StatsRange,
  StatsSummary
} from '@shared/types'

const BRIDGE_MISSING = 'The app bridge is not available yet.'
/** Recent-history view, not a full log — matches the completed-tasks list's limit. */
const HISTORY_LIMIT = 50

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

/** Electron wraps a main-process throw; only the tail means anything to a user. */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker >= 0 ? raw.slice(marker + 'Error: '.length) : raw
}

export interface StatsState {
  range: StatsRange
  summary: StatsSummary | null
  daily: DailyBucket[]
  byProject: ProjectBucket[]
  history: Session[]
  /** True only for the initial load and a range switch, not for a session delete. */
  loading: boolean
  error: string | null
  ready: boolean
}

export interface StatsActions {
  init: () => Promise<void>
  dispose: () => void
  clearError: () => void
  setRange: (range: StatsRange) => Promise<void>
  /** Re-read everything for the current range, e.g. after a session finishes elsewhere. */
  refresh: () => Promise<void>
  removeSession: (id: number) => Promise<void>
}

export type StatsStore = StatsState & StatsActions

const INITIAL: StatsState = {
  range: 'week',
  summary: null,
  daily: [],
  byProject: [],
  history: [],
  loading: true,
  error: null,
  ready: false
}

/** Subscriptions are process-level resources, not state — see stores/tasks.ts. */
let unsubscribers: Array<() => void> = []
/** Bumped by dispose() so an in-flight load can tell it has been superseded. */
let generation = 0

export const useStatsStore = create<StatsStore>((set, get) => {
  async function load(range: StatsRange, mine: number): Promise<void> {
    const bridge = api()
    if (!bridge) {
      set({ error: BRIDGE_MISSING, loading: false })
      return
    }
    try {
      const [summary, daily, byProject, history] = await Promise.all([
        bridge.stats.summary(range),
        bridge.stats.daily(range),
        bridge.stats.byProject(range),
        bridge.sessions.recent(HISTORY_LIMIT)
      ])
      if (mine !== generation) return
      set({ summary, daily, byProject, history, loading: false })
    } catch (error) {
      if (mine !== generation) return
      set({ error: messageOf(error), loading: false })
    }
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

      // A focus session finishing anywhere in the app moves every aggregate here; refresh
      // rather than let the screen show pre-session numbers until the user re-opens it.
      unsubscribers.push(
        bridge.timer.onPhaseEnd((event) => {
          if (event.kind === 'focus') void get().refresh()
        })
      )

      set({ loading: true })
      await load(get().range, mine)
      if (mine !== generation) return
      set({ ready: true })
    },

    dispose() {
      generation += 1
      for (const off of unsubscribers) off()
      unsubscribers = []
      set({ ready: false })
    },

    clearError() {
      set({ error: null })
    },

    async setRange(range) {
      if (range === get().range) return
      const mine = ++generation
      set({ range, loading: true })
      await load(range, mine)
    },

    async refresh() {
      const mine = generation
      await load(get().range, mine)
    },

    async removeSession(id) {
      const bridge = api()
      if (!bridge) {
        set({ error: BRIDGE_MISSING })
        return
      }
      try {
        await bridge.sessions.remove(id)
      } catch (error) {
        set({ error: messageOf(error) })
      }
      // Deleting a session moves every aggregate above it; a full re-read is the only
      // correct outcome, same reasoning as attempt()/resync() in stores/tasks.ts.
      await get().refresh()
    }
  }
})
