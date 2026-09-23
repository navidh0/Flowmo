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
  OnRunningSession,
  ProjectCreate,
  ProjectUpdate,
  Settings,
  StatsRange,
  SubtaskCreate,
  SubtaskUpdate,
  TaskCreate,
  TaskUpdate,
  TimerMode
} from '@shared/types'
import type { TimerService } from './timer'
import { getHotkeyFailures, probeHotkey } from './hotkeys'
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
}

export function registerIpcHandlers(ctx: IpcContext): void {
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
  ipcMain.handle(CH.projects.update, (_e, id: number, patch: ProjectUpdate) =>
    projectsRepo.update(id, patch)
  )
  ipcMain.handle(CH.projects.remove, (_e, id: number) => projectsRepo.remove(id))

  // ── tasks ──
  ipcMain.handle(CH.tasks.list, (_e, projectId: number | null) => tasksRepo.list(projectId))
  ipcMain.handle(CH.tasks.listCompleted, (_e, projectId: number | null, limit: number) =>
    tasksRepo.listCompleted(projectId, limit)
  )
  ipcMain.handle(CH.tasks.get, (_e, id: number) => tasksRepo.get(id))
  ipcMain.handle(CH.tasks.create, (_e, input: TaskCreate) => tasksRepo.create(input))
  ipcMain.handle(CH.tasks.update, (_e, id: number, patch: TaskUpdate) =>
    tasksRepo.update(id, patch)
  )
  ipcMain.handle(CH.tasks.setCompleted, (_e, id: number, completed: boolean) =>
    tasksRepo.setCompleted(id, completed)
  )
  ipcMain.handle(CH.tasks.reorder, (_e, ids: number[]) => tasksRepo.reorder(ids))
  ipcMain.handle(CH.tasks.remove, (_e, id: number) => {
    tasksRepo.remove(id)
    // The running session points at a task that no longer exists; drop the reference
    // rather than leave the timer attributing time to a ghost.
    if (ctx.timer.getState().taskId === id) ctx.timer.setTask(null)
  })

  // ── subtasks ──
  ipcMain.handle(CH.subtasks.list, (_e, taskId: number) => subtasksRepo.list(taskId))
  ipcMain.handle(CH.subtasks.create, (_e, input: SubtaskCreate) => subtasksRepo.create(input))
  ipcMain.handle(CH.subtasks.update, (_e, id: number, patch: SubtaskUpdate) =>
    subtasksRepo.update(id, patch)
  )
  ipcMain.handle(CH.subtasks.remove, (_e, id: number) => subtasksRepo.remove(id))

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

  // ── stats ──
  ipcMain.handle(CH.stats.summary, (_e, range: StatsRange) => statsRepo.summary(range))
  ipcMain.handle(CH.stats.daily, (_e, range: StatsRange) => statsRepo.daily(range))
  ipcMain.handle(CH.stats.byProject, (_e, range: StatsRange) => statsRepo.byProject(range))

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
