/**
 * Entry points for the task surface.
 *
 * Two mounts rather than one, so the shell can lay the sidebar out as its own column
 * beside the timer instead of nesting it inside the list. Both call the same ref-counted
 * bootstrap, so either can mount alone, both can mount together, and the store is
 * initialised once either way.
 */

import { useEffect, useRef, useState } from 'react'
import { useTasksStore } from '@renderer/stores/tasks'
import { useTasksBootstrap } from './bootstrap'
import { ErrorBanner } from './ErrorBanner'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetail } from './TaskDetail'
import { TaskList } from './TaskList'

/**
 * Below this, the list (comfortable at ~14rem) and the detail panel (19rem) no longer both
 * fit, so the detail becomes a full-panel overlay instead of squeezing the list to nothing.
 * Kept in sync with the `@[34rem]` container-query variants below — same number, one in CSS
 * (rem, resolved against the panel's own width via `@container`) and one in JS (px, for the
 * focus-management `ResizeObserver` below, which has no container-query equivalent).
 */
const OVERLAY_BREAKPOINT_PX = 544

/** The list plus the detail panel. Pairs with `<ProjectSidebar />`. */
export function TasksPanel(): React.JSX.Element {
  useTasksBootstrap()
  const selectedTaskId = useTasksStore((s) => s.selectedTaskId)

  const rootRef = useRef<HTMLDivElement>(null)
  const [overlay, setOverlay] = useState(false)
  const prevSelectedRef = useRef<number | null>(null)

  // Track the panel's OWN width (not the window's) so the layout responds to this panel
  // shrinking, whether from a small window or from the user narrowing the shell's resizable
  // 'main' column around it (PANEL_MIN_WIDTH.main, src/shared/types.ts, can be narrower than
  // the detail panel's 19rem).
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      setOverlay(width < OVERLAY_BREAKPOINT_PX)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Closing the detail (Escape, the close button, or a delete) returns focus to the row that
  // opened it, so keyboard users don't land back at the top of the document.
  useEffect(() => {
    if (selectedTaskId !== null) {
      prevSelectedRef.current = selectedTaskId
      return
    }
    const id = prevSelectedRef.current
    prevSelectedRef.current = null
    if (id === null) return
    rootRef.current?.querySelector<HTMLElement>(`[data-task-row="${id}"]`)?.focus()
  }, [selectedTaskId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ErrorBanner />
      <div
        ref={rootRef}
        data-tasks-panel-root
        className="@container relative flex min-h-0 flex-1"
      >
        <div className="min-w-0 flex-1">
          <TaskList />
        </div>
        {/* Wide enough for both (@[34rem] and up): today's side-by-side layout, sized with a
            basis rather than a fixed width so the sweep's fixed-width rule needs no
            allowlist entry for it. Narrower: the detail becomes a full-panel overlay above
            the list instead of squeezing it to zero width. */}
        {selectedTaskId !== null ? (
          <div className="absolute inset-0 z-10 @[34rem]:static @[34rem]:z-auto @[34rem]:basis-[19rem] @[34rem]:shrink-0">
            <TaskDetail overlay={overlay} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Sidebar + panel, for mounting the whole surface as one block. */
export function TasksScreen(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0">
      <div className="w-52 shrink-0 border-r border-[var(--color-border)]">
        <ProjectSidebar />
      </div>
      <div className="min-w-0 flex-1">
        <TasksPanel />
      </div>
    </div>
  )
}

export { ProjectSidebar } from './ProjectSidebar'
export { ErrorBanner } from './ErrorBanner'
export { TaskList } from './TaskList'
export { TaskDetail } from './TaskDetail'
export { SubtaskList } from './SubtaskList'
export { TaskRow } from './TaskRow'
export { useTasksBootstrap } from './bootstrap'
