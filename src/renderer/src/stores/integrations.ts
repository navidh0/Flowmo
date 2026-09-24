/**
 * Integrations screen state: Todoist sync status and calendar feeds.
 *
 * Mirrors `stores/stats.ts`: mutations re-read rather than optimistically patch, because the
 * shapes here (`TodoistStatus`, `CalendarFeed[]`) are exactly what main computed and there is
 * nothing to gain from guessing the result client-side.
 *
 * NEVER put a secret in this store. `connect(token)` and `add({ url })` hand a credential to
 * main exactly once, over the args of the call itself; nothing here keeps a copy afterwards,
 * before or after the call resolves, on success or failure.
 */

import { create } from 'zustand'
import type { CalendarFeed, CalendarFeedCreate, CalendarFeedUpdate, FlowdoApi, TodoistStatus } from '@shared/types'

const BRIDGE_MISSING = 'The app bridge is not available yet.'

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

export interface IntegrationsState {
  todoist: TodoistStatus | null
  todoistLoading: boolean
  /** Set only for actions the user just triggered (connect/disconnect/syncNow), not the
   *  background status push — that already has its own `health` states for that. */
  todoistError: string | null

  feeds: CalendarFeed[]
  feedsLoading: boolean
  feedsError: string | null
  secureStorageAvailable: boolean

  ready: boolean
}

export interface IntegrationsActions {
  init: () => Promise<void>
  dispose: () => void
  clearTodoistError: () => void
  clearFeedsError: () => void

  connectTodoist: (token: string) => Promise<boolean>
  disconnectTodoist: () => Promise<void>
  syncNow: () => Promise<void>

  refreshFeeds: () => Promise<void>
  addFeed: (input: CalendarFeedCreate) => Promise<boolean>
  updateFeed: (id: number, patch: CalendarFeedUpdate) => Promise<void>
  removeFeed: (id: number) => Promise<void>
  refreshFeedsNow: () => Promise<void>
}

export type IntegrationsStore = IntegrationsState & IntegrationsActions

const INITIAL: IntegrationsState = {
  todoist: null,
  todoistLoading: true,
  todoistError: null,
  feeds: [],
  feedsLoading: true,
  feedsError: null,
  secureStorageAvailable: true,
  ready: false
}

/** Subscriptions are process-level resources, not state — see stores/tasks.ts. */
let unsubscribers: Array<() => void> = []
/** Bumped by dispose() so an in-flight load can tell it has been superseded. */
let generation = 0

export const useIntegrationsStore = create<IntegrationsStore>((set, get) => {
  async function loadFeeds(mine: number): Promise<void> {
    const bridge = api()
    if (!bridge) {
      set({ feedsError: BRIDGE_MISSING, feedsLoading: false })
      return
    }
    try {
      const [feeds, secureStorageAvailable] = await Promise.all([
        bridge.integrations.calendars.list(),
        bridge.integrations.calendars.secureStorageAvailable()
      ])
      if (mine !== generation) return
      set({ feeds, secureStorageAvailable, feedsLoading: false })
    } catch (error) {
      if (mine !== generation) return
      set({ feedsError: messageOf(error), feedsLoading: false })
    }
  }

  return {
    ...INITIAL,

    async init() {
      const mine = ++generation
      const bridge = await waitForApi()
      if (mine !== generation) return
      if (!bridge) {
        set({ todoistLoading: false, feedsLoading: false, todoistError: BRIDGE_MISSING, feedsError: BRIDGE_MISSING })
        return
      }

      unsubscribers.push(bridge.integrations.todoist.onStatus((status) => set({ todoist: status })))

      set({ todoistLoading: true, feedsLoading: true })
      try {
        const status = await bridge.integrations.todoist.status()
        if (mine !== generation) return
        set({ todoist: status, todoistLoading: false })
      } catch (error) {
        if (mine !== generation) return
        set({ todoistError: messageOf(error), todoistLoading: false })
      }
      await loadFeeds(mine)
      if (mine !== generation) return
      set({ ready: true })
    },

    dispose() {
      generation += 1
      for (const off of unsubscribers) off()
      unsubscribers = []
      set({ ready: false })
    },

    clearTodoistError() {
      set({ todoistError: null })
    },

    clearFeedsError() {
      set({ feedsError: null })
    },

    async connectTodoist(token) {
      const bridge = api()
      if (!bridge) {
        set({ todoistError: BRIDGE_MISSING })
        return false
      }
      set({ todoistError: null })
      try {
        const status = await bridge.integrations.todoist.connect(token)
        set({ todoist: status })
        return status.health.state !== 'error'
      } catch (error) {
        set({ todoistError: messageOf(error) })
        return false
      }
    },

    async disconnectTodoist() {
      const bridge = api()
      if (!bridge) {
        set({ todoistError: BRIDGE_MISSING })
        return
      }
      try {
        await bridge.integrations.todoist.disconnect()
        set({ todoist: { health: { state: 'disconnected' }, pendingChanges: 0, rejectedChanges: [] } })
      } catch (error) {
        set({ todoistError: messageOf(error) })
      }
    },

    async syncNow() {
      const bridge = api()
      if (!bridge) {
        set({ todoistError: BRIDGE_MISSING })
        return
      }
      try {
        const status = await bridge.integrations.todoist.syncNow()
        set({ todoist: status })
      } catch (error) {
        set({ todoistError: messageOf(error) })
      }
    },

    async refreshFeeds() {
      const mine = generation
      await loadFeeds(mine)
    },

    async addFeed(input) {
      const bridge = api()
      if (!bridge) {
        set({ feedsError: BRIDGE_MISSING })
        return false
      }
      set({ feedsError: null })
      try {
        const feed = await bridge.integrations.calendars.add(input)
        set({ feeds: [...get().feeds, feed] })
        return true
      } catch (error) {
        set({ feedsError: messageOf(error) })
        return false
      }
    },

    async updateFeed(id, patch) {
      const bridge = api()
      if (!bridge) {
        set({ feedsError: BRIDGE_MISSING })
        return
      }
      try {
        const feed = await bridge.integrations.calendars.update(id, patch)
        set({ feeds: get().feeds.map((f) => (f.id === id ? feed : f)) })
      } catch (error) {
        set({ feedsError: messageOf(error) })
      }
    },

    async removeFeed(id) {
      const bridge = api()
      if (!bridge) {
        set({ feedsError: BRIDGE_MISSING })
        return
      }
      try {
        await bridge.integrations.calendars.remove(id)
        set({ feeds: get().feeds.filter((f) => f.id !== id) })
      } catch (error) {
        set({ feedsError: messageOf(error) })
      }
    },

    async refreshFeedsNow() {
      const bridge = api()
      if (!bridge) {
        set({ feedsError: BRIDGE_MISSING })
        return
      }
      try {
        const feeds = await bridge.integrations.calendars.refreshNow()
        set({ feeds })
      } catch (error) {
        set({ feedsError: messageOf(error) })
      }
    }
  }
})
