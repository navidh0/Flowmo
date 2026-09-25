/**
 * The ONLY renderer↔main surface.
 *
 * Deliberately a fixed set of named, typed channels — there is no generic `query(sql)`
 * bridge, so renderer code (or anything injected into it) cannot reach arbitrary SQL.
 * Every `on*` returns an unsubscribe function; React effects must call it or listeners
 * pile up on each hot reload and the tick handler runs N times per frame.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH, EV } from '@shared/channels'
import type {
  FlowdoApi,
  CalendarFeedCreate,
  CalendarFeedUpdate,
  DataChangedScope,
  HotkeyFailure,
  OnRunningSession,
  PhaseEndEvent,
  ProjectCreate,
  ProjectUpdate,
  Settings,
  TodoistStatus,
  UpdateStatus,
  StatsRange,
  SubtaskCreate,
  SubtaskUpdate,
  TaskCreate,
  TaskUpdate,
  TimerMode,
  TimerState
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: FlowdoApi = {
  timer: {
    getState: () => ipcRenderer.invoke(CH.timer.getState),
    // `undefined` and `null` are NOT interchangeable here: main reads an omitted argument
    // as "keep the current task" and an explicit null as "clear it". Collapsing them with
    // `?? null` made a plain start() silently detach the task and log the session against
    // nothing. Forward the omission by not passing the argument at all.
    start: (taskId?: number | null) =>
      taskId === undefined
        ? ipcRenderer.invoke(CH.timer.start)
        : ipcRenderer.invoke(CH.timer.start, taskId),
    pause: () => ipcRenderer.invoke(CH.timer.pause),
    resume: () => ipcRenderer.invoke(CH.timer.resume),
    takeBreak: () => ipcRenderer.invoke(CH.timer.takeBreak),
    skip: () => ipcRenderer.invoke(CH.timer.skip),
    stop: (discard?: boolean) => ipcRenderer.invoke(CH.timer.stop, discard ?? false),
    setMode: (mode: TimerMode, onRunning?: OnRunningSession) =>
      ipcRenderer.invoke(CH.timer.setMode, mode, onRunning ?? 'keep'),
    setTask: (taskId: number | null) => ipcRenderer.invoke(CH.timer.setTask, taskId),
    onTick: (cb: (state: TimerState) => void) => subscribe(EV.timerTick, cb),
    onPhaseEnd: (cb: (event: PhaseEndEvent) => void) => subscribe(EV.timerPhaseEnd, cb)
  },

  projects: {
    list: (includeArchived?: boolean) =>
      ipcRenderer.invoke(CH.projects.list, includeArchived ?? false),
    create: (input: ProjectCreate) => ipcRenderer.invoke(CH.projects.create, input),
    update: (id: number, patch: ProjectUpdate) =>
      ipcRenderer.invoke(CH.projects.update, id, patch),
    remove: (id: number) => ipcRenderer.invoke(CH.projects.remove, id)
  },

  tasks: {
    list: (projectId?: number | null) => ipcRenderer.invoke(CH.tasks.list, projectId ?? null),
    listCompleted: (projectId?: number | null, limit?: number) =>
      ipcRenderer.invoke(CH.tasks.listCompleted, projectId ?? null, limit ?? 100),
    get: (id: number) => ipcRenderer.invoke(CH.tasks.get, id),
    create: (input: TaskCreate) => ipcRenderer.invoke(CH.tasks.create, input),
    update: (id: number, patch: TaskUpdate) => ipcRenderer.invoke(CH.tasks.update, id, patch),
    setCompleted: (id: number, completed: boolean) =>
      ipcRenderer.invoke(CH.tasks.setCompleted, id, completed),
    reorder: (ids: number[]) => ipcRenderer.invoke(CH.tasks.reorder, ids),
    remove: (id: number) => ipcRenderer.invoke(CH.tasks.remove, id),
    keepLocal: (id: number) => ipcRenderer.invoke(CH.tasks.keepLocal, id)
  },

  subtasks: {
    list: (taskId: number) => ipcRenderer.invoke(CH.subtasks.list, taskId),
    create: (input: SubtaskCreate) => ipcRenderer.invoke(CH.subtasks.create, input),
    update: (id: number, patch: SubtaskUpdate) =>
      ipcRenderer.invoke(CH.subtasks.update, id, patch),
    remove: (id: number) => ipcRenderer.invoke(CH.subtasks.remove, id)
  },

  sessions: {
    listRange: (fromMs: number, toMs: number) =>
      ipcRenderer.invoke(CH.sessions.listRange, fromMs, toMs),
    recent: (limit?: number) => ipcRenderer.invoke(CH.sessions.recent, limit ?? 50),
    remove: (id: number) => ipcRenderer.invoke(CH.sessions.remove, id)
  },

  stats: {
    summary: (range: StatsRange) => ipcRenderer.invoke(CH.stats.summary, range),
    daily: (range: StatsRange) => ipcRenderer.invoke(CH.stats.daily, range),
    byProject: (range: StatsRange) => ipcRenderer.invoke(CH.stats.byProject, range)
  },

  settings: {
    get: () => ipcRenderer.invoke(CH.settings.get),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(CH.settings.set, patch),
    onChange: (cb: (settings: Settings) => void) => subscribe(EV.settingsChanged, cb)
  },

  data: {
    exportJson: () => ipcRenderer.invoke(CH.data.exportJson),
    importJson: () => ipcRenderer.invoke(CH.data.importJson)
  },

  system: {
    onHotkeyFailures: (cb: (failures: HotkeyFailure[]) => void) =>
      subscribe(EV.hotkeyFailures, cb),
    getHotkeyFailures: () => ipcRenderer.invoke(CH.system.getHotkeyFailures),
    probeHotkey: (accelerator: string) =>
      ipcRenderer.invoke(CH.system.probeHotkey, accelerator),
    suspendHotkeys: (suspended: boolean) =>
      ipcRenderer.invoke(CH.system.suspendHotkeys, suspended)
  },

  integrations: {
    todoist: {
      status: () => ipcRenderer.invoke(CH.todoist.status),
      connect: (token: string) => ipcRenderer.invoke(CH.todoist.connect, token),
      disconnect: () => ipcRenderer.invoke(CH.todoist.disconnect),
      syncNow: () => ipcRenderer.invoke(CH.todoist.syncNow),
      onStatus: (cb: (status: TodoistStatus) => void) => subscribe(EV.todoistStatus, cb)
    },
    calendars: {
      list: () => ipcRenderer.invoke(CH.calendars.list),
      add: (feed: CalendarFeedCreate) => ipcRenderer.invoke(CH.calendars.add, feed),
      update: (id: number, patch: CalendarFeedUpdate) =>
        ipcRenderer.invoke(CH.calendars.update, id, patch),
      remove: (id: number) => ipcRenderer.invoke(CH.calendars.remove, id),
      refreshNow: () => ipcRenderer.invoke(CH.calendars.refreshNow),
      secureStorageAvailable: () => ipcRenderer.invoke(CH.calendars.secureStorageAvailable)
    }
  },

  calendar: {
    eventsRange: (fromMs: number, toMs: number) =>
      ipcRenderer.invoke(CH.calendar.eventsRange, fromMs, toMs)
  },

  events: {
    onDataChanged: (cb: (scope: DataChangedScope) => void) => subscribe(EV.dataChanged, cb)
  },

  updates: {
    check: () => ipcRenderer.invoke(CH.updates.check),
    getStatus: () => ipcRenderer.invoke(CH.updates.getStatus),
    installNow: () => ipcRenderer.invoke(CH.updates.installNow),
    onStatus: (cb: (status: UpdateStatus) => void) => subscribe(EV.updateStatus, cb)
  },

  app: {
    getVersion: () => ipcRenderer.invoke(CH.app.getVersion),
    setMiniWidget: (visible: boolean) => ipcRenderer.invoke(CH.app.setMiniWidget, visible),
    isMiniWindow: () => ipcRenderer.invoke(CH.app.isMiniWindow),
    quit: () => ipcRenderer.invoke(CH.app.quit)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('flowdo', api)
} else {
  // Should never happen — contextIsolation is on. Present so a misconfiguration fails
  // loudly in dev rather than leaving `window.flowdo` mysteriously undefined.
  ;(globalThis as unknown as { flowdo: FlowdoApi }).flowdo = api
}
