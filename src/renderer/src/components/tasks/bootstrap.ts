/**
 * Store lifecycle for this surface.
 *
 * Ref-counted at module scope because the sidebar and the task panel mount as two
 * independent columns — whichever arrives first initialises, and the store is only torn
 * down once both are gone. Tying `init()` to a single component would mean the sidebar
 * unmounting kills the list's IPC subscriptions, and StrictMode's double mount would
 * dispose a store the other column is still reading.
 */

import { useEffect } from 'react'
import { useTasksStore } from '@renderer/stores/tasks'

let consumers = 0

export function useTasksBootstrap(): void {
  useEffect(() => {
    consumers += 1
    if (consumers === 1) void useTasksStore.getState().init()
    return () => {
      consumers -= 1
      if (consumers === 0) useTasksStore.getState().dispose()
    }
  }, [])
}
