/**
 * App entry and the single place the feature modules are wired together.
 *
 * The Wave 1 modules (db, timer, tray/notifications/hotkeys/power) are all
 * dependency-injected and know nothing about each other; every connection between them is
 * made here. That is deliberate — it keeps the modules independently testable and means
 * only this file has to be read to understand how the app is assembled.
 */

import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { EV } from '@shared/channels'
import type { PhaseEndEvent, Settings, TimerState } from '@shared/types'
import { closeDb, getDb } from './db'
import * as settingsRepo from './db/repo/settings'
import * as sessionsRepo from './db/repo/sessions'
import * as tasksRepo from './db/repo/tasks'
import { createTimerService, type TimerService } from './timer'
import { registerIpcHandlers } from './ipc'
import { destroyTray, initTray, updateTray } from './tray'
import { disposeNotifications, initNotifications, notifyPhaseEnd } from './notifications'
import { initHotkeys, reregisterHotkeys, unregisterHotkeys } from './hotkeys'
import { disposePower, initPower, setFocusActive } from './power'
import {
  broadcast,
  createMainWindow,
  getMiniWindow,
  setMiniWidget,
  setQuitting,
  showMainWindow
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

/** Tray tooltips only need second resolution; the timer ticks four times faster. */
let lastTrayUpdateMs = 0

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

    timer = createTimerService({
      getSettings: () => settings,
      createSession: (input) => sessionsRepo.create(input),
      broadcast: onTimerBroadcast,
      getProjectIdForTask: (taskId) =>
        taskId == null ? null : (tasksRepo.get(taskId)?.projectId ?? null)
    })

    registerIpcHandlers({
      timer,
      getSettings: () => settings,
      applySettingsPatch
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
      onSkip: () => timer.skip()
    })

    createMainWindow({ minimizeToTray: () => settings.minimizeToTray })
    if (settings.showMiniWidget) setMiniWidget(true)

    // Paint the tray with the real initial state rather than leaving it blank until the
    // first tick — which, when idle, never comes.
    updateTray(timer.getState())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow({ minimizeToTray: () => settings.minimizeToTray })
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
    timer?.dispose()
    destroyTray()
    unregisterHotkeys()
    disposePower()
    disposeNotifications()
    closeDb()
  })
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
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin })
  }

  if (patch.showMiniWidget !== undefined && patch.showMiniWidget !== !!getMiniWindow()) {
    setMiniWidget(settings.showMiniWidget)
  }

  // Push to the renderer so two open windows can't show different settings.
  broadcast(EV.settingsChanged, settings)

  // A duration change alters the tray's labels even with no tick in flight.
  if (before !== settings) updateTray(timer.getState())

  return settings
}
