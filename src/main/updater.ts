/**
 * Background auto-update, wrapping electron-updater.
 *
 * Kept Electron-free (no `import 'electron'`) so the whole state machine is unit-testable
 * with a fake `AutoUpdaterLike`. The orchestrator (src/main/index.ts) supplies the real
 * `electron-updater` autoUpdater lazily via `getAutoUpdater`, and only ever calls it once
 * support has already been established — dev and test runs never load the module at all.
 *
 * Support is resolved once, in `start()`/`check()`, from environment alone (never from the
 * autoUpdater itself): a throwaway test profile, an unpackaged dev run, a Windows portable
 * exe, or a Linux build that isn't an AppImage all can't self-update, so they get a stable
 * `unsupported` status pointing at the GitHub releases page instead of ever touching
 * electron-updater.
 */

import type { Settings, UpdateStatus, UpdateUnsupportedReason } from '@shared/types'

/** The slice of electron-updater's AppUpdater this module uses — so tests pass a fake. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(
    event:
      | 'checking-for-update'
      | 'update-available'
      | 'update-not-available'
      | 'download-progress'
      | 'update-downloaded'
      | 'error',
    listener: (...args: any[]) => void
  ): unknown
}

export interface UpdaterDeps {
  getSettings: () => Pick<Settings, 'autoUpdate'>
  /** True while a session is running or paused — updates never restart the app then. */
  isSessionActive: () => boolean
  broadcast: (status: UpdateStatus) => void
  /** Called right before quitAndInstall so the close-to-tray handler lets the app quit. */
  beforeQuitAndInstall: () => void
  isPackaged: boolean
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Lazily provides electron-updater's autoUpdater (never imported in dev/test paths). */
  getAutoUpdater: () => AutoUpdaterLike
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface Updater {
  /** Begin: resolve support, and if supported + settings.autoUpdate, check now and every 6h. */
  start(): void
  /** Manual check, regardless of settings.autoUpdate. Resolves with the status reached. */
  check(): Promise<UpdateStatus>
  getStatus(): UpdateStatus
  /** Rejects with a user-readable Error while a session is active or nothing is downloaded. */
  installNow(): Promise<void>
  /** Settings changed — start/stop the periodic check when autoUpdate flips. */
  settingsChanged(settings: Pick<Settings, 'autoUpdate'>): void
  dispose(): void
}

export const RELEASES_URL = 'https://github.com/navidh0/Flowmo/releases'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Resolves the reason this build can't self-update, or null if it can. */
function resolveUnsupported(deps: UpdaterDeps): UpdateUnsupportedReason | null {
  if (deps.env['FLOWDO_USER_DATA_DIR']) return 'test-profile'
  if (!deps.isPackaged) return 'dev'
  if (deps.platform === 'win32' && deps.env['PORTABLE_EXECUTABLE_DIR']) return 'portable'
  if (deps.platform === 'linux' && !deps.env['APPIMAGE']) return 'deb'
  return null
}

function statusesEqual(a: UpdateStatus, b: UpdateStatus): boolean {
  if (a.state !== b.state) return false
  switch (a.state) {
    case 'idle':
      return a.lastCheckedAt === (b as typeof a).lastCheckedAt
    case 'checking':
      return true
    case 'up-to-date':
      return a.lastCheckedAt === (b as typeof a).lastCheckedAt
    case 'available':
      return a.version === (b as typeof a).version
    case 'downloading':
      return a.version === (b as typeof a).version && a.percent === (b as typeof a).percent
    case 'ready':
      return a.version === (b as typeof a).version
    case 'unsupported':
      return a.reason === (b as typeof a).reason && a.releasesUrl === (b as typeof a).releasesUrl
    case 'error':
      return a.message === (b as typeof a).message && a.lastCheckedAt === (b as typeof a).lastCheckedAt
  }
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const now = deps.now ?? (() => Date.now())
  const doSetInterval = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const doClearInterval = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout))

  let status: UpdateStatus = { state: 'idle', lastCheckedAt: null }
  let unsupportedReason: UpdateUnsupportedReason | null | undefined // undefined = not yet resolved
  let autoUpdater: AutoUpdaterLike | null = null
  let listenersBound = false
  let intervalHandle: unknown = null
  let inFlightCheck: Promise<UpdateStatus> | null = null
  let disposed = false

  function setStatus(next: UpdateStatus): void {
    if (statusesEqual(status, next)) {
      status = next
      return
    }
    status = next
    deps.broadcast(status)
  }

  /** Ensures support is resolved and, if supported, that the real autoUpdater is wired up. */
  function ensureAutoUpdater(): AutoUpdaterLike | null {
    if (unsupportedReason === undefined) {
      unsupportedReason = resolveUnsupported(deps)
      if (unsupportedReason !== null) {
        setStatus({ state: 'unsupported', reason: unsupportedReason, releasesUrl: RELEASES_URL })
      }
    }
    if (unsupportedReason !== null) return null

    if (!autoUpdater) {
      autoUpdater = deps.getAutoUpdater()
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
    }
    if (!listenersBound) {
      listenersBound = true
      autoUpdater.on('checking-for-update', () => {
        setStatus({ state: 'checking' })
      })
      autoUpdater.on('update-available', (info: { version: string }) => {
        setStatus({ state: 'available', version: info?.version ?? '' })
      })
      autoUpdater.on('update-not-available', () => {
        setStatus({ state: 'up-to-date', lastCheckedAt: now() })
      })
      autoUpdater.on('download-progress', (progress: { percent: number }) => {
        const current = status
        const version = current.state === 'downloading' || current.state === 'available' ? current.version : ''
        const percent = Math.floor(progress?.percent ?? 0)
        if (current.state === 'downloading' && current.percent === percent) return
        setStatus({ state: 'downloading', version, percent })
      })
      autoUpdater.on('update-downloaded', (info: { version: string }) => {
        setStatus({ state: 'ready', version: info?.version ?? '' })
      })
      autoUpdater.on('error', (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ state: 'error', message, lastCheckedAt: now() })
      })
    }
    return autoUpdater
  }

  function runCheck(): Promise<UpdateStatus> {
    if (inFlightCheck) return inFlightCheck

    const updater = ensureAutoUpdater()
    if (!updater) {
      // Unsupported — status was already set by ensureAutoUpdater.
      return Promise.resolve(status)
    }

    const promise = Promise.resolve(updater.checkForUpdates())
      .then(() => status)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ state: 'error', message, lastCheckedAt: now() })
        return status
      })
      .finally(() => {
        inFlightCheck = null
      })

    inFlightCheck = promise
    return promise
  }

  function startInterval(): void {
    if (intervalHandle !== null || disposed) return
    intervalHandle = doSetInterval(() => {
      void runCheck()
    }, CHECK_INTERVAL_MS)
  }

  function stopInterval(): void {
    if (intervalHandle === null) return
    doClearInterval(intervalHandle)
    intervalHandle = null
  }

  return {
    start() {
      const supported = ensureAutoUpdater() !== null
      if (!supported) return
      if (deps.getSettings().autoUpdate) {
        void runCheck()
        startInterval()
      }
    },

    check() {
      return runCheck()
    },

    getStatus() {
      return status
    },

    async installNow() {
      if (deps.isSessionActive()) {
        throw new Error(
          'Finish or stop the current session first — the update installs when Flowdo restarts.'
        )
      }
      if (status.state !== 'ready') {
        throw new Error('No update is ready to install yet.')
      }
      deps.beforeQuitAndInstall()
      const updater = ensureAutoUpdater()
      updater?.quitAndInstall(false, true)
    },

    settingsChanged(settings) {
      if (unsupportedReason) return
      if (settings.autoUpdate) {
        if (intervalHandle === null) {
          void runCheck()
        }
        startInterval()
      } else {
        stopInterval()
      }
    },

    dispose() {
      disposed = true
      stopInterval()
    }
  }
}
