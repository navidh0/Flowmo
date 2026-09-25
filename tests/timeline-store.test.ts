/**
 * `stores/timeline.ts` mount bookkeeping. The store's `init()` awaits the preload bridge
 * before subscribing, so two orderings can go wrong around that await:
 *
 * - StrictMode (and a fast tab switch) runs init → dispose → init. Only the second mount
 *   may register subscriptions; a stale first `init()` resuming must not add a duplicate set.
 * - `setWeekStartsOn` arriving during `init()`'s wait (settings resolving after the page
 *   mounted) supersedes the initial fetch, but the mount must still subscribe and go ready.
 *
 * A fake bridge on `globalThis.window` stands in for the preload; nothing here needs React.
 */
process.env.TZ = 'America/Los_Angeles'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowdoApi, Weekday } from '@shared/types'

interface Fake {
  bridge: FlowdoApi
  subscriptions: () => number
  ranges: Array<[number, number]>
}

function fakeBridge(): Fake {
  let live = 0
  const ranges: Array<[number, number]> = []
  const subscribe = (): (() => void) => {
    live += 1
    return () => {
      live -= 1
    }
  }
  const bridge = {
    sessions: {
      listRange: vi.fn(async (from: number, to: number) => {
        ranges.push([from, to])
        return []
      })
    },
    calendar: { eventsRange: vi.fn(async () => []) },
    projects: { list: vi.fn(async () => []) },
    integrations: { calendars: { list: vi.fn(async () => []) } },
    timer: { onPhaseEnd: vi.fn(subscribe) },
    events: { onDataChanged: vi.fn(subscribe) }
  } as unknown as FlowdoApi
  return { bridge, subscriptions: () => live, ranges }
}

/** Let every pending microtask and the 0-delay awaits inside the store settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

let fake: Fake
let store: typeof import('../src/renderer/src/stores/timeline').useTimelineStore

beforeEach(async () => {
  vi.resetModules()
  fake = fakeBridge()
  ;(globalThis as { window?: unknown }).window = { flowdo: fake.bridge }
  store = (await import('../src/renderer/src/stores/timeline')).useTimelineStore
})

describe('timeline store mounts', () => {
  it('registers exactly one set of subscriptions under StrictMode init → dispose → init', async () => {
    const s = store.getState()
    const first = s.init()
    s.dispose()
    const second = s.init()
    await Promise.all([first, second])
    await settle()

    // onPhaseEnd + onDataChanged, once.
    expect(fake.subscriptions()).toBe(2)
    expect(store.getState().ready).toBe(true)
  })

  it('dispose after init removes every subscription', async () => {
    await store.getState().init()
    expect(fake.subscriptions()).toBe(2)
    store.getState().dispose()
    expect(fake.subscriptions()).toBe(0)
    expect(store.getState().ready).toBe(false)
  })

  it('a week-start change during init still leaves the page subscribed and ready', async () => {
    const s = store.getState()
    const init = s.init()
    const change = s.setWeekStartsOn(0 as Weekday)
    await Promise.all([init, change])
    await settle()

    expect(fake.subscriptions()).toBe(2)
    expect(store.getState().ready).toBe(true)
    expect(store.getState().weekStartsOn).toBe(0)
  })

  it('setWeekStartsOn reloads a Week view from the new first day, and is a no-op when unchanged', async () => {
    // Thursday 11 June 2026.
    const thursday = new Date(2026, 5, 11, 12).getTime()
    await store.getState().init()
    await store.getState().setView('week')
    await store.getState().goToDay(thursday)
    await store.getState().setView('week')

    const before = fake.ranges.length
    await store.getState().setWeekStartsOn(1 as Weekday) // unchanged (Monday)
    expect(fake.ranges.length).toBe(before)

    await store.getState().setWeekStartsOn(0 as Weekday)
    const [from] = fake.ranges.at(-1)!
    expect(new Date(from).getDay()).toBe(0)
    expect(from).toBe(new Date(2026, 5, 7).getTime())
  })
})
