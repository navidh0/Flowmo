/**
 * Entry points for the task surface.
 *
 * Two mounts rather than one, so the shell can lay the sidebar out as its own column
 * beside the timer instead of nesting it inside the list. Both call the same ref-counted
 * bootstrap, so either can mount alone, both can mount together, and the store is
 * initialised once either way.
 */

import { useTasksStore } from '@renderer/stores/tasks'
import { useTasksBootstrap } from './bootstrap'
import { ErrorBanner } from './ErrorBanner'
import { ProjectSidebar } from './ProjectSidebar'
import { TaskDetail } from './TaskDetail'
import { TaskList } from './TaskList'

/** The list plus the detail panel. Pairs with `<ProjectSidebar />`. */
export function TasksPanel(): React.JSX.Element {
  useTasksBootstrap()
  const selectedTaskId = useTasksStore((s) => s.selectedTaskId)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ErrorBanner />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <TaskList />
        </div>
        {/* Fixed width: the detail panel is a form, and a form that grows with the window
            just stretches its inputs. */}
        {selectedTaskId !== null ? (
          <div className="w-[19rem] shrink-0">
            <TaskDetail />
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
