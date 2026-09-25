/**
 * Every IPC handler in the app. Owned by the integration layer — this is where the three
 * Wave 1 modules converge, which is why no feature module registers its own channels.
 *
 * Handlers are thin on purpose: they translate a channel call into exactly one repo or
 * timer call. Any policy that spans modules (persisting a mode change, re-registering
 * hotkeys) lives in `index.ts` and reaches this file through `IpcContext`.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { CH } from '@shared/channels'
import type {
  CalendarFeedCreate,
  CalendarFeedUpdate,
  OnRunningSession,
  ProjectCreate,
  ProjectUpdate,
  Settings,
  StatsRange,
  SubtaskCreate,
  SubtaskUpdate,
  TaskCreate,
  TaskUpdate,
  TimerMode,
  Weekday
} from '@shared/types'
import type { TimerService } from './timer'
import { getHotkeyFailures, probeHotkey, setHotkeysSuspended } from './hotkeys'
import type { TodoistIntegration } from './integrations/todoist'
import type { CalendarIntegration } from './integrations/ical'
import { exportJson, importJson } from './dataio'
import * as projectsRepo from './db/repo/projects'
import * as tasksRepo from './db/repo/tasks'
import * as subtasksRepo from './db/repo/subtasks'
import * as sessionsRepo from './db/repo/sessions'
import * as statsRepo from './db/repo/stats'
import { isMiniWebContents, setMiniWidget, setQuitting } from './windows'

export interface IpcContext {
  timer: TimerService
  getSettings(): Settings
  /** Persists, updates the cache, and applies side effects (hotkeys, login item, mode). */
  applySettingsPatch(patch: Partial<Settings>): Settings
  /**
   * Re-derive everything main caches from the database after an import replaced it:
   * settings, hotkeys, login item, mini widget, and the renderers' own stores.
   */
  reloadAfterImport(): void
  todoist: TodoistIntegration
  calendars: CalendarIntegration
}

/**
 * Synced projects mirror Todoist and are never pushed back (pull-only, decided at the v0.3
 * freeze). The UI hides these actions, but a renamed synced project would silently revert
 * on the next pull, so main refuses them too rather than trusting the button being hidden.
 */
function assertProjectEditable(id: number, patch?: ProjectUpdate): void {
  const project = projectsRepo.get(id)
  if (!project || project.source === null) return
  if (patch && patch.name === undefined && patch.archived === undefined) return
  throw new Error('This project comes from Todoist — rename, archive or delete it there.')
}

export function registerIpcHandlers(ctx: IpcContext): void {
  /**
   * Local edits to synced rows are queued in the outbox by the repos, but the periodic
   * cycle is minutes apart — completing a recurring task would leave it sitting in Today
   * until the next one brought back its advanced due date. Push shortly after the last
   * write instead; debounced so a burst of edits (typing a title, ticking subtasks) goes
   * up as one request. syncNow() already serialises against a running cycle.
   */
  let pushTimer: NodeJS.Timeout | null = null
  const pushSoon = <T>(result: T): T => {
    if (ctx.todoist.status().pendingChanges > 0) {
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = setTimeout(() => {
        pushTimer = null
        void ctx.todoist.syncNow()
      }, 1500)
    }
    return result
  }

  // ── timer ──
  ipcMain.handle(CH.timer.getState, () => ctx.timer.getState())
  // Deliberately `number | null | undefined`: an omitted argument keeps the current task,
  // an explicit null clears it. Widening this to `number | null` would erase the
  // distinction the timer service depends on.
  ipcMain.handle(CH.timer.start, (_e, taskId?: number | null) => ctx.timer.start(taskId))
  ipcMain.handle(CH.timer.pause, () => ctx.timer.pause())
  ipcMain.handle(CH.timer.resume, () => ctx.timer.resume())
  ipcMain.handle(CH.timer.takeBreak, () => ctx.timer.takeBreak())
  ipcMain.handle(CH.timer.skip, () => ctx.timer.skip())
  ipcMain.handle(CH.timer.stop, (_e, discard: boolean) => ctx.timer.stop(discard))
  ipcMain.handle(CH.timer.setTask, (_e, taskId: number | null) => ctx.timer.setTask(taskId))

  // Routed through applySettingsPatch so the persisted `mode` and the service's mirrored
  // copy can never disagree — the timer service is the one that decides what happens to an
  // in-flight session, so it runs first and settings follow.
  ipcMain.handle(
    CH.timer.setMode,
    (_e, mode: TimerMode, onRunning: OnRunningSession) => {
      const state = ctx.timer.setMode(mode, onRunning)
      ctx.applySettingsPatch({ mode })
      return state
    }
  )

  // ── projects ──
  ipcMain.handle(CH.projects.list, (_e, includeArchived: boolean) =>
    projectsRepo.list(includeArchived)
  )
  ipcMain.handle(CH.projects.create, (_e, input: ProjectCreate) => projectsRepo.create(input))
  ipcMain.handle(CH.projects.update, (_e, id: number, patch: ProjectUpdate) => {
    assertProjectEditable(id, patch)
    return projectsRepo.update(id, patch)
  })
  ipcMain.handle(CH.projects.remove, (_e, id: number) => {
    assertProjectEditable(id)
    return projectsRepo.remove(id)
  })

  // ── tasks ──
  ipcMain.handle(CH.tasks.list, (_e, projectId: number | null) => tasksRepo.list(projectId))
  ipcMain.handle(CH.tasks.listCompleted, (_e, projectId: number | null, limit: number) =>
    tasksRepo.listCompleted(projectId, limit)
  )
  ipcMain.handle(CH.tasks.get, (_e, id: number) => tasksRepo.get(id))
  ipcMain.handle(CH.tasks.create, (_e, input: TaskCreate) => pushSoon(tasksRepo.create(input)))
  ipcMain.handle(CH.tasks.update, (_e, id: number, patch: TaskUpdate) =>
    pushSoon(tasksRepo.update(id, patch))
  )
  ipcMain.handle(CH.tasks.setCompleted, (_e, id: number, completed: boolean) =>
    pushSoon(tasksRepo.setCompleted(id, completed))
  )
  ipcMain.handle(CH.tasks.reorder, (_e, ids: number[]) => tasksRepo.reorder(ids))
  ipcMain.handle(CH.tasks.keepLocal, (_e, id: number) => tasksRepo.keepLocal(id))
  ipcMain.handle(CH.tasks.remove, (_e, id: number) => {
    pushSoon(tasksRepo.remove(id))
    // The running session points at a task that no longer exists; drop the reference
    // rather than leave the timer attributing time to a ghost.
    if (ctx.timer.getState().taskId === id) ctx.timer.setTask(null)
  })

  // ── subtasks ──
  ipcMain.handle(CH.subtasks.list, (_e, taskId: number) => subtasksRepo.list(taskId))
  ipcMain.handle(CH.subtasks.create, (_e, input: SubtaskCreate) =>
    pushSoon(subtasksRepo.create(input))
  )
  ipcMain.handle(CH.subtasks.update, (_e, id: number, patch: SubtaskUpdate) =>
    pushSoon(subtasksRepo.update(id, patch))
  )
  ipcMain.handle(CH.subtasks.remove, (_e, id: number) => pushSoon(subtasksRepo.remove(id)))

  // ── sessions ──
  ipcMain.handle(CH.sessions.listRange, (_e, fromMs: number, toMs: number) =>
    sessionsRepo.listRange(fromMs, toMs)
  )
  ipcMain.handle(CH.sessions.recent, (_e, limit: number) => sessionsRepo.recent(limit))
  ipcMain.handle(CH.sessions.remove, (_e, id: number) => sessionsRepo.remove(id))

  // ── data ──
  ipcMain.handle(CH.data.exportJson, (e) =>
    exportJson(BrowserWindow.fromWebContents(e.sender) ?? undefined)
  )
  ipcMain.handle(CH.data.importJson, async (e) => {
    // A live session holds a task id and will be written when it ends; if the import has
    // removed that task, the session either fails its foreign key or attaches to whatever
    // row now owns the id. Checked twice: here so the user is told before picking a file,
    // and again just before the swap, because the timer can start behind the open dialog.
    const assertIdle = (): void => {
      if (ctx.timer.getState().status !== 'idle') {
        throw new Error('Stop the timer before importing — a running session would be written into the replaced data.')
      }
      // An imported snapshot under a live sync token and outbox would diverge from Todoist
      // in ways no later sync can reconcile. Disconnecting first makes the replace clean.
      const state = ctx.todoist.status().health.state
      if (state !== 'disconnected' && state !== 'unavailable') {
        throw new Error('Disconnect Todoist before importing — the imported data would conflict with what is synced.')
      }
    }
    assertIdle()

    const result = await importJson(BrowserWindow.fromWebContents(e.sender) ?? undefined, {
      beforeApply: assertIdle
    })
    if (result.path !== null) ctx.reloadAfterImport()
    return result
  })

  // ── system ──
  ipcMain.handle(CH.system.getHotkeyFailures, () => getHotkeyFailures())
  ipcMain.handle(CH.system.probeHotkey, (_e, accelerator: string) => probeHotkey(accelerator))
  ipcMain.handle(CH.system.suspendHotkeys, (e, suspended: boolean) => {
    setHotkeysSuspended(suspended)
    if (!suspended) return
    // A settings screen that reloads, crashes or closes mid-capture never sends the
    // matching "resume", and the user would be left with dead hotkeys and no clue why.
    const resume = (): void => setHotkeysSuspended(false)
    e.sender.once('did-start-loading', resume)
    e.sender.once('render-process-gone', resume)
    e.sender.once('destroyed', resume)
  })

  // ── integrations ──
  ipcMain.handle(CH.todoist.status, () => ctx.todoist.status())
  ipcMain.handle(CH.todoist.connect, (_e, token: string) => ctx.todoist.connect(String(token)))
  ipcMain.handle(CH.todoist.disconnect, () => ctx.todoist.disconnect())
  ipcMain.handle(CH.todoist.syncNow, () => ctx.todoist.syncNow())

  ipcMain.handle(CH.calendars.list, () => ctx.calendars.list())
  ipcMain.handle(CH.calendars.add, (_e, feed: CalendarFeedCreate) => ctx.calendars.add(feed))
  ipcMain.handle(CH.calendars.update, (_e, id: number, patch: CalendarFeedUpdate) =>
    ctx.calendars.update(id, patch)
  )
  ipcMain.handle(CH.calendars.remove, (_e, id: number) => ctx.calendars.remove(id))
  ipcMain.handle(CH.calendars.refreshNow, () => ctx.calendars.refreshNow())
  ipcMain.handle(CH.calendars.secureStorageAvailable, () => ctx.calendars.secureStorageAvailable())
  ipcMain.handle(CH.calendar.eventsRange, (_e, fromMs: number, toMs: number) =>
    ctx.calendars.eventsRange(fromMs, toMs)
  )

  // ── stats ──
  // "This week" follows the calendar's first-day-of-week setting, read per call so a change
  // applies on the next refresh without re-registering anything.
  const weekStartsOn = (): Weekday => ctx.getSettings().weekStartsOn
  ipcMain.handle(CH.stats.summary, (_e, range: StatsRange) =>
    statsRepo.summary(range, Date.now(), weekStartsOn())
  )
  ipcMain.handle(CH.stats.daily, (_e, range: StatsRange) =>
    statsRepo.daily(range, Date.now(), weekStartsOn())
  )
  ipcMain.handle(CH.stats.byProject, (_e, range: StatsRange) =>
    statsRepo.byProject(range, Date.now(), weekStartsOn())
  )

  // ── settings ──
  ipcMain.handle(CH.settings.get, () => ctx.getSettings())
  ipcMain.handle(CH.settings.set, (_e, patch: Partial<Settings>) => {
    // A mode change arriving through the settings screen has to reach the timer, or the
    // service keeps running the old mode while the UI claims otherwise.
    if (patch.mode && patch.mode !== ctx.getSettings().mode) {
      ctx.timer.setMode(patch.mode, 'keep')
    }
    return ctx.applySettingsPatch(patch)
  })

  // ── app ──
  ipcMain.handle(CH.app.getVersion, () => app.getVersion())
  ipcMain.handle(CH.app.isMiniWindow, (e) => isMiniWebContents(e.sender.id))
  ipcMain.handle(CH.app.setMiniWidget, (_e, visible: boolean) => {
    setMiniWidget(visible)
    ctx.applySettingsPatch({ showMiniWidget: visible })
  })
  ipcMain.handle(CH.app.quit, () => {
    setQuitting(true)
    app.quit()
  })
}
