/**
 * App entry and the single place the feature modules are wired together.
 *
 * The Wave 1 modules (db, timer, tray/notifications/hotkeys/power) are all
 * dependency-injected and know nothing about each other; every connection between them is
 * made here. That is deliberate — it keeps the modules independently testable and means
 * only this file has to be read to understand how the app is assembled.
 */

import { app, BrowserWindow, nativeTheme } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { EV } from '@shared/channels'
import type { PhaseEndEvent, Settings, TimerState } from '@shared/types'
import { closeDb, getDb } from './db'
import * as settingsRepo from './db/repo/settings'
import * as sessionsRepo from './db/repo/sessions'
import * as tasksRepo from './db/repo/tasks'
import { createTimerService, type TimerService } from './timer'
import { registerIpcHandlers } from './ipc'
import { createTodoistIntegration, type TodoistIntegration } from './integrations/todoist'
import { createCalendarIntegration, type CalendarIntegration } from './integrations/ical'
import { destroyTray, initTray, updateTray } from './tray'
import { disposeNotifications, initNotifications, notifyPhaseEnd } from './notifications'
import { initHotkeys, reregisterHotkeys, unregisterHotkeys } from './hotkeys'
import { disposePower, initPower, setFocusActive } from './power'
import { createMiniAuto, type MiniAuto } from './miniAuto'
import { createUpdater, type Updater } from './updater'
import { setLinuxAutostart } from './autostart'
// electron-updater's `autoUpdater` is a lazy getter: importing the module constructs nothing,
// and updater.ts only touches it once it has ruled out dev, portable, deb and test builds.
import { autoUpdater } from 'electron-updater'
import {
  applyThemeBackground,
  broadcast,
  configureMiniWidget,
  createMainWindow,
  getMainWindow,
  getMiniWindow,
  setMiniWidget,
  setQuitting,
  showMainWindow,
  type Point,
  type WindowBounds
} from './windows'

/**
 * Settings live in memory and are written through to SQLite.
 *
 * The timer derives state ~4x/second and reads settings on every derive, so this MUST be a
 * cache — hitting SQLite at that rate for values that change a few times a month would be
 * absurd.
 */
let settings: Settings
let timer: TimerService
let todoist: TodoistIntegration | null = null
let calendars: CalendarIntegration | null = null

/** Tray tooltips only need second resolution; the timer ticks four times faster. */
let lastTrayUpdateMs = 0

/** Last value handed to setProgressBar, so an unchanged bar is not re-set 4×/second. */
let lastProgress = -1

/** Pending window-bounds write. Resize fires per frame; only the final rest position matters. */
let boundsTimer: NodeJS.Timeout | null = null

/** Pending mini-widget position write, debounced the same way. */
let miniPositionTimer: NodeJS.Timeout | null = null

/**
 * The last position `rememberMiniPosition` was told about, kept around so `before-quit` can
 * flush it even once the mini widget itself is gone. A drag can be immediately followed by
 * the widget closing (the user clicks away, or the option auto-closes it) well inside the
 * 400ms debounce; reading the live window's position at flush time would then find no window
 * and silently drop a position the user just chose, instead of writing what was last reported.
 */
let lastMiniPosition: Point | null = null

/** Opens the mini widget while the main window is off screen. Created once settings load. */
let miniAuto: MiniAuto

/** Checks for, downloads and installs new versions. Created before IPC so handlers can reach it. */
let updater: Updater

// Test harnesses (e2e/smoke.mjs) point the app at a throwaway profile, so an automated run
// can never open — or damage — a real database. Must precede the single-instance lock, which
// is keyed on userData, so a test instance also never collides with a running real one.
if (process.env['FLOWDO_USER_DATA_DIR']) {
  app.setPath('userData', process.env['FLOWDO_USER_DATA_DIR'])
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // A second instance would run a second timer against the same SQLite file.
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    // Must precede initNotifications: on Windows, Notification.isSupported() and toast
    // attribution both depend on the AppUserModelId being set first.
    electronApp.setAppUserModelId('io.flowdo.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    getDb()
    settings = settingsRepo.get()

    // Before any window exists, so the first paint and the renderer's first
    // prefers-color-scheme read already agree with the setting. The OS switching scheme
    // under 'system' repaints the window backgrounds; the CSS follows on its own.
    applyTheme(settings.theme)
    nativeTheme.on('updated', applyThemeBackground)

    timer = createTimerService({
      getSettings: () => settings,
      createSession: (input) => sessionsRepo.create(input),
      broadcast: onTimerBroadcast,
      getProjectIdForTask: (taskId) =>
        taskId == null ? null : (tasksRepo.get(taskId)?.projectId ?? null)
    })

    // Network lives only here in main; the renderer learns about it through status and
    // data-changed events and never fetches anything itself.
    todoist = createTodoistIntegration({
      onStatus: (status) => broadcast(EV.todoistStatus, status),
      onDataChanged: (scope) => broadcast(EV.dataChanged, scope)
    })
    calendars = createCalendarIntegration({
      onDataChanged: (scope) => broadcast(EV.dataChanged, scope)
    })

    updater = createUpdater({
      getSettings: () => settings,
      isSessionActive: () => timer.getState().status !== 'idle',
      broadcast: (status) => broadcast(EV.updateStatus, status),
      // Close-to-tray would otherwise swallow the quit that installs the update.
      beforeQuitAndInstall: () => setQuitting(true),
      isPackaged: app.isPackaged,
      platform: process.platform,
      env: process.env,
      getAutoUpdater: () => autoUpdater
    })

    registerIpcHandlers({
      timer,
      getSettings: () => settings,
      applySettingsPatch,
      reloadAfterImport,
      todoist,
      calendars,
      updater
    })

    initNotifications({ getSettings: () => settings })
    initPower({
      onSuspend: () => timer.handleSuspend(),
      onResume: () => timer.handleResume()
    })
    initTray({
      getState: () => timer.getState(),
      getSettings: () => settings,
      onStartPause: toggleStartPause,
      onSkip: () => timer.skip(),
      onStop: () => timer.stop(false),
      toggleMini: () => applySettingsPatch({ showMiniWidget: !getMiniWindow() }),
      quit: () => {
        setQuitting(true)
        app.quit()
      }
    })
    initHotkeys({
      getSettings: () => settings,
      onStartPause: toggleStartPause,
      onSkip: () => timer.skip(),
      // Without this the classification in hotkeys.ts never left the main process, so a
      // combination another app already owned simply did nothing and said nothing.
      onFailure: (failures) => broadcast(EV.hotkeyFailures, failures)
    })

    configureMiniWidget({
      getSavedPosition: () => settingsRepo.getMiniPosition(),
      onMoved: rememberMiniPosition
    })
    miniAuto = createMiniAuto({
      getSettings: () => settings,
      isMiniOpen: () => !!getMiniWindow(),
      // A live query, not a cached flag — see MiniAutoDeps.isMainAway's doc comment for why
      // this has to reflect the window's real state at the moment it's asked, not the event
      // that triggered the ask.
      isMainAway: () => {
        const win = getMainWindow()
        return !win || win.isMinimized() || !win.isVisible()
      },
      openMini: () => setMiniWidget(true),
      closeMini: () => setMiniWidget(false)
    })

    createMainWindow(mainWindowOptions())
    if (settings.showMiniWidget) setMiniWidget(true)

    // After the window exists, so the first status broadcast has a renderer to reach.
    updater.start()

    // Started after the window exists so the first status broadcast has somewhere to land.
    // Both are no-ops until an account or feed is connected.
    todoist.start()
    calendars.start()

    // Coming back to the app is when stale tasks are most noticeable; nudge() syncs only if
    // the last cycle is more than a minute old, so alt-tabbing does not hammer the API.
    app.on('browser-window-focus', () => todoist?.nudge())

    // Paint the tray with the real initial state rather than leaving it blank until the
    // first tick — which, when idle, never comes.
    updateTray(timer.getState())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow(mainWindowOptions())
      } else {
        showMainWindow()
      }
    })
  })

  // With close-to-tray the app deliberately outlives its windows, so this must not quit.
  app.on('window-all-closed', () => {
    // no-op: quitting happens through the tray, the hotkey, or app:quit.
  })

  app.on('before-quit', () => {
    setQuitting(true)
    // Flush a pending bounds write before the database closes, or quitting right after a
    // resize loses the position the user just chose.
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
      const win = getMainWindow()
      if (win && !win.isMinimized()) settingsRepo.setWindowBounds(win.getNormalBounds())
    }
    if (miniPositionTimer) {
      clearTimeout(miniPositionTimer)
      miniPositionTimer = null
      // The last reported position, not the live window: it may already be closed by now
      // (see lastMiniPosition's doc comment).
      if (lastMiniPosition) settingsRepo.setMiniPosition(lastMiniPosition)
    }
    updater?.dispose()
    todoist?.stop()
    calendars?.stop()
    timer?.dispose()
    destroyTray()
    unregisterHotkeys()
    disposePower()
    disposeNotifications()
    closeDb()
  })
}

/**
 * Debounced: `resize` and `move` fire continuously while a window is being dragged, and
 * each write is a SQLite round trip. Only where it comes to rest matters.
 */
function rememberBounds(bounds: WindowBounds): void {
  if (boundsTimer) clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    boundsTimer = null
    settingsRepo.setWindowBounds(bounds)
  }, 400)
}

/** Same debounce for the mini widget, which reports every frame of a drag. */
function rememberMiniPosition(position: Point): void {
  lastMiniPosition = position
  if (miniPositionTimer) clearTimeout(miniPositionTimer)
  miniPositionTimer = setTimeout(() => {
    miniPositionTimer = null
    settingsRepo.setMiniPosition(position)
  }, 400)
}

/** One definition for both places the main window is created (startup and macOS activate). */
function mainWindowOptions(): Parameters<typeof createMainWindow>[0] {
  return {
    minimizeToTray: () => settings.minimizeToTray,
    savedBounds: settingsRepo.getWindowBounds(),
    onBoundsChanged: rememberBounds,
    onLeave: () => miniAuto.mainLeft(),
    onReturn: () => miniAuto.mainReturned()
  }
}

/**
 * Everything the timer emits passes through here, so the OS-facing side effects live in one
 * place instead of being scattered across the feature modules.
 */
function onTimerBroadcast(channel: string, payload: unknown): void {
  broadcast(channel, payload)

  if (channel === EV.timerTick) {
    const state = payload as TimerState
    onTick(state)
    return
  }

  if (channel === EV.timerPhaseEnd) {
    const event = payload as PhaseEndEvent
    // `nextKind: null` means the user stopped, or switched mode — they already know what
    // happened, and a toast announcing it is noise. Only announce a real transition.
    if (event.nextKind !== null) notifyPhaseEnd(event)
    onTick(timer.getState())
  }
}

function onTick(state: TimerState): void {
  // Hold the display awake only while focus is actually running.
  setFocusActive(state.kind === 'focus' && state.status === 'running')

  const now = Date.now()
  if (now - lastTrayUpdateMs >= 1000) {
    lastTrayUpdateMs = now
    updateTray(state)
  }

  updateProgressBar(state)
}

/**
 * Taskbar progress — glanceable state without raising the window.
 *
 * Only bounded phases have meaningful progress. An open-ended Flowmodoro focus has no
 * target by definition, so it gets the indeterminate bar rather than a fake percentage
 * climbing toward a number that does not exist.
 *
 * Windows only in practice: on Linux this needs a Unity launcher and `desktopName`, and
 * elsewhere it is a silent no-op — which is the correct degradation, so no guard here.
 */
function updateProgressBar(state: TimerState): void {
  const win = getMainWindow()
  if (!win) return

  let progress: number
  if (state.status === 'idle' || state.kind === null) {
    progress = -1 // clears the bar
  } else if (state.remainingMs === null) {
    progress = 2 // Electron's indeterminate mode
  } else {
    progress = Math.min(1, Math.max(0, state.progress))
  }

  // Quantised: the bar cannot show more than about a percent, and setting it 4×/second
  // is a needless native call on every tick.
  const quantised = progress < 0 ? -1 : progress === 2 ? 2 : Math.round(progress * 100) / 100
  if (quantised === lastProgress) return

  lastProgress = quantised
  win.setProgressBar(quantised, state.status === 'paused' ? { mode: 'paused' } : undefined)
}

/**
 * An import swapped the database underneath every cache. Main's copy of settings, and
 * every side effect derived from it, is re-read and re-applied; the renderers are reloaded
 * outright, because their stores hold projects, tasks and stats from the old data and
 * patching each of them would be a second, drift-prone copy of this list. The timer is
 * guaranteed idle by the import handler, so reloading cannot interrupt a session.
 */
function reloadAfterImport(): void {
  settings = settingsRepo.get()

  // The service mirrors `mode`; idle, this only re-arms it.
  timer.setMode(settings.mode)
  applyTheme(settings.theme)
  reregisterHotkeys(settings)
  applyLaunchAtLogin(settings.launchAtLogin)
  updater.settingsChanged(settings)
  // The imported pin decides; any auto-opened widget is re-evaluated from scratch.
  miniAuto.pinChanged()
  if (settings.showMiniWidget !== !!getMiniWindow()) setMiniWidget(settings.showMiniWidget)

  broadcast(EV.settingsChanged, settings)
  updateTray(timer.getState())

  for (const win of [getMainWindow(), getMiniWindow()]) {
    if (win && !win.webContents.isDestroyed()) win.webContents.reload()
  }
}

/**
 * The theme setting drives Chromium's `prefers-color-scheme` in every renderer (index.css
 * switches its tokens on it) and the native chrome, so no renderer code has to know.
 * Window backgrounds are repainted directly as well: whether setting `themeSource` emits
 * nativeTheme's 'updated' depends on the effective scheme actually changing.
 */
function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
  applyThemeBackground()
}

/**
 * Launch at login. `app.setLoginItemSettings` does nothing on Linux, so there an XDG autostart
 * entry is written instead. Only for packaged builds: in development `process.execPath` is the
 * bare Electron binary, and an autostart entry pointing at it would open an empty Electron.
 */
function applyLaunchAtLogin(enabled: boolean): void {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return
  }
  if (!app.isPackaged) return
  setLinuxAutostart(enabled, {
    homeDir: app.getPath('home'),
    xdgConfigHome: process.env['XDG_CONFIG_HOME'],
    execPath: process.execPath,
    appImagePath: process.env['APPIMAGE']
  })
}

function toggleStartPause(): void {
  const state = timer.getState()
  if (state.status === 'running') {
    timer.pause()
  } else {
    // Covers both paused and idle — the service resumes or starts as appropriate.
    timer.start()
  }
}

/**
 * The single write path for settings: persist, refresh the cache, then apply the side
 * effects that a changed value implies.
 */
function applySettingsPatch(patch: Partial<Settings>): Settings {
  const before = settings
  settings = settingsRepo.set(patch)

  if (
    patch.hotkeyStartPause !== undefined ||
    patch.hotkeySkip !== undefined
  ) {
    reregisterHotkeys(settings)
  }

  if (patch.launchAtLogin !== undefined) {
    applyLaunchAtLogin(settings.launchAtLogin)
  }

  if (patch.theme !== undefined) applyTheme(settings.theme)

  if (patch.showMiniWidget !== undefined) {
    // The user chose explicitly (settings, tray or IPC), so an auto-opened widget is theirs now.
    miniAuto.pinChanged()
    if (patch.showMiniWidget !== !!getMiniWindow()) setMiniWidget(settings.showMiniWidget)
  }

  if (patch.miniWidgetOnMinimize === false) miniAuto.disabled()

  if (patch.autoUpdate !== undefined) updater.settingsChanged(settings)

  // Push to the renderer so two open windows can't show different settings.
  broadcast(EV.settingsChanged, settings)

  // A duration change alters the tray's labels even with no tick in flight.
  if (before !== settings) updateTray(timer.getState())

  return settings
}
