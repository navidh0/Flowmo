/**
 * Shell and routing. Owned by the integration layer — the feature agents own everything
 * under `components/`, this file only composes them and connects the two surfaces.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { LayoutSettings } from '@shared/types'
import { MiniWidget } from './components/mini'
import { NavBar, ResizableShell, type Screen } from './components/shell'
import { ProjectSidebar, TasksPanel } from './components/tasks'
import { TimerPanel } from './components/timer'
import { initPhaseSounds } from './lib/sounds'
import { useTasksStore } from './stores/tasks'
import { useTimerStore, useTimerSync } from './stores/timer'

// Off the startup path: recharts is the heaviest thing in the bundle and the Focus screen,
// which is what opens every time, never needs it.
const StatsPage = lazy(() => import('./components/stats'))
const SettingsPage = lazy(() => import('./components/settings/SettingsPage'))
const TimelinePage = lazy(() => import('./components/timeline'))

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

  // On <html>, so index.css can rescale the spacing base for everything under it — in both
  // windows, since they share this component and the same settings broadcast.
  const density = useTimerStore((s) => s.settings.density)
  useEffect(() => {
    document.documentElement.dataset.density = density
  }, [density])

  if (isMini) return <MiniWidget />
  return <MainShell />
}

function MainShell(): React.JSX.Element {
  useRefreshTasksOnPhaseEnd()

  // Chimes play from the main window only: the mini widget loads this same bundle and
  // receives the same phase-end event, so wiring it there too would play every chime twice.
  // The main renderer stays alive while hidden to the tray, so it can still play then.
  useEffect(() => initPhaseSounds(() => useTimerStore.getState().settings), [])

  // Which screen is open is not a setting: the app should always reopen on Focus.
  const [screen, setScreen] = useState<Screen>('focus')
  const layout = useTimerStore((s) => s.settings.layout)

  // The shell only calls this on release, never per drag frame — each call is a SQLite
  // write, a broadcast to both windows and a tray refresh in main.
  const commitLayout = useCallback((next: LayoutSettings) => {
    void window.flowdo.settings.set({ layout: next })
  }, [])

  const secondary =
    screen === 'day' ? <TimelinePage /> : screen === 'stats' ? <StatsPage /> : <SettingsPage />

  return (
    <div className="flex h-full min-h-0 bg-[var(--color-surface)]">
      <NavBar current={screen} onNavigate={setScreen} />

      {/* The timer column is pinned on every screen: the thing you are timing should not
          disappear because you went to look at last week's numbers. The project list only
          means something next to the task list, so it is hidden elsewhere. */}
      <ResizableShell
        layout={layout}
        onLayoutCommit={commitLayout}
        panels={{
          projects: screen === 'focus' ? <ProjectSidebar /> : null,
          timer: <TimerPanel />,
          main:
            screen === 'focus' ? (
              <TasksPanel />
            ) : (
              <Suspense fallback={null}>{secondary}</Suspense>
            )
        }}
      />
    </div>
  )
}
