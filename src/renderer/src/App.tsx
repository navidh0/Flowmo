/**
 * Shell and routing. Owned by the integration layer — the feature agents own everything
 * under `components/`, this file only composes them and connects the two surfaces.
 */

import { useEffect, useState } from 'react'
import { MiniWidget } from './components/mini'
import { ProjectSidebar, TasksPanel } from './components/tasks'
import { TimerPanel } from './components/timer'
import { useTasksStore } from './stores/tasks'
import { useTimerStore, useTimerSync } from './stores/timer'

/**
 * The mini widget is a second BrowserWindow loading the same bundle at `#/mini`
 * (see `main/windows.ts`). Reading the hash is enough of a router for two routes; pulling
 * in react-router to distinguish them would be a dependency for nothing.
 */
function useIsMiniRoute(): boolean {
  const [isMini, setIsMini] = useState(() => window.location.hash.startsWith('#/mini'))

  useEffect(() => {
    const onHashChange = (): void => setIsMini(window.location.hash.startsWith('#/mini'))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return isMini
}

/**
 * A finished focus session changes `actualPomodoros` and `focusMs` server-side, and the
 * task list has no way to know. Without this the row you just worked against keeps showing
 * its pre-session counts until something else happens to refresh it.
 */
function useRefreshTasksOnPhaseEnd(): void {
  const lastPhaseEnd = useTimerStore((s) => s.lastPhaseEnd)

  useEffect(() => {
    if (lastPhaseEnd?.kind !== 'focus') return
    void useTasksStore.getState().refreshTasks()
  }, [lastPhaseEnd])
}

export default function App(): React.JSX.Element {
  const isMini = useIsMiniRoute()
  useTimerSync()

  if (isMini) return <MiniWidget />
  return <MainShell />
}

function MainShell(): React.JSX.Element {
  useRefreshTasksOnPhaseEnd()

  return (
    <div className="flex h-full min-h-0 bg-[var(--color-surface)]">
      <aside className="w-52 shrink-0 border-r border-[var(--color-border)]">
        <ProjectSidebar />
      </aside>

      {/* The timer is the centrepiece, so it gets a fixed, generous column rather than
          competing with the task list for width as the window resizes. */}
      <section className="flex w-[23rem] shrink-0 flex-col border-r border-[var(--color-border)]">
        <TimerPanel />
      </section>

      <main className="min-w-0 flex-1">
        <TasksPanel />
      </main>
    </div>
  )
}
