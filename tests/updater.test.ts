import { describe, expect, it, vi } from 'vitest'
import { createUpdater, RELEASES_URL, type AutoUpdaterLike, type UpdaterDeps } from '../src/main/updater'
import type { UpdateStatus } from '@shared/types'

type FakeAutoUpdater = AutoUpdaterLike & {
  emit: (event: string, ...args: unknown[]) => void
  checkForUpdatesMock: ReturnType<typeof vi.fn>
  quitAndInstallMock: ReturnType<typeof vi.fn>
}

/** A fake electron-updater AppUpdater. checkForUpdates is driven by the test via `impl`. */
function createFakeAutoUpdater(
  impl?: () => Promise<unknown> | void
): FakeAutoUpdater {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const checkForUpdatesMock = vi.fn(async () => {
    return impl ? impl() : undefined
  })
  const quitAndInstallMock = vi.fn()

  const fake: FakeAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: checkForUpdatesMock,
    quitAndInstall: quitAndInstallMock,
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener as (...args: unknown[]) => void)
      return fake
    },
    emit(event, ...args) {
      for (const l of listeners[event] ?? []) l(...args)
    },
    checkForUpdatesMock,
    quitAndInstallMock
  }
  return fake
}

interface Harness {
  deps: UpdaterDeps
  broadcasts: UpdateStatus[]
  getAutoUpdaterMock: ReturnType<typeof vi.fn>
  intervalFns: Array<() => void>
  clearIntervalMock: ReturnType<typeof vi.fn>
  setIntervalMock: ReturnType<typeof vi.fn>
  session: { active: boolean }
  settings: { autoUpdate: boolean }
  autoUpdater: FakeAutoUpdater
  beforeQuitAndInstallMock: ReturnType<typeof vi.fn>
  callOrder: string[]
}

function makeHarness(opts: {
  isPackaged?: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  checkImpl?: () => Promise<unknown> | void
} = {}): Harness {
  const broadcasts: UpdateStatus[] = []
  const session = { active: false }
  const settings = { autoUpdate: true }
  const callOrder: string[] = []
  const beforeQuitAndInstallMock = vi.fn(() => {
    callOrder.push('beforeQuitAndInstall')
  })

  const autoUpdater = createFakeAutoUpdater(opts.checkImpl)
  autoUpdater.quitAndInstallMock.mockImplementation((isSilent?: boolean, isForceRunAfter?: boolean) => {
    callOrder.push(`quitAndInstall(${isSilent},${isForceRunAfter})`)
  })

  const getAutoUpdaterMock = vi.fn(() => autoUpdater)

  const intervalFns: Array<() => void> = []
  const setIntervalMock = vi.fn((fn: () => void) => {
    intervalFns.push(fn)
    return intervalFns.length // handle
  })
  const clearIntervalMock = vi.fn()

  const deps: UpdaterDeps = {
    getSettings: () => settings,
    isSessionActive: () => session.active,
    broadcast: (status) => broadcasts.push(status),
    beforeQuitAndInstall: beforeQuitAndInstallMock,
    isPackaged: opts.isPackaged ?? true,
    platform: opts.platform ?? 'win32',
    env: opts.env ?? {},
    getAutoUpdater: getAutoUpdaterMock,
    now: () => 1000,
    setInterval: setIntervalMock,
    clearInterval: clearIntervalMock
  }

  return {
    deps,
    broadcasts,
    getAutoUpdaterMock,
    intervalFns,
    clearIntervalMock,
    setIntervalMock,
    session,
    settings,
    autoUpdater,
    beforeQuitAndInstallMock,
    callOrder
  }
}

describe('unsupported detection', () => {
  it('test-profile: FLOWDO_USER_DATA_DIR set takes priority over everything', async () => {
    const h = makeHarness({ isPackaged: false, env: { FLOWDO_USER_DATA_DIR: '/tmp/x' } })
    const updater = createUpdater(h.deps)
    const status = await updater.check()
    expect(status).toEqual({ state: 'unsupported', reason: 'test-profile', releasesUrl: RELEASES_URL })
    expect(h.getAutoUpdaterMock).not.toHaveBeenCalled()
    expect(h.setIntervalMock).not.toHaveBeenCalled()
  })

  it('dev: not packaged', async () => {
    const h = makeHarness({ isPackaged: false })
    const updater = createUpdater(h.deps)
    const status = await updater.check()
    expect(status).toEqual({ state: 'unsupported', reason: 'dev', releasesUrl: RELEASES_URL })
    expect(h.getAutoUpdaterMock).not.toHaveBeenCalled()
  })

  it('portable: Windows with PORTABLE_EXECUTABLE_DIR', async () => {
    const h = makeHarness({
      isPackaged: true,
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_DIR: 'C:\\somewhere' }
    })
    const updater = createUpdater(h.deps)
    const status = await updater.check()
    expect(status).toEqual({ state: 'unsupported', reason: 'portable', releasesUrl: RELEASES_URL })
    expect(h.getAutoUpdaterMock).not.toHaveBeenCalled()
  })

  it('deb: Linux without APPIMAGE', async () => {
    const h = makeHarness({ isPackaged: true, platform: 'linux', env: {} })
    const updater = createUpdater(h.deps)
    const status = await updater.check()
    expect(status).toEqual({ state: 'unsupported', reason: 'deb', releasesUrl: RELEASES_URL })
    expect(h.getAutoUpdaterMock).not.toHaveBeenCalled()
  })

  it('Linux WITH APPIMAGE is supported', async () => {
    const h = makeHarness({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } })
    const updater = createUpdater(h.deps)
    await updater.check()
    expect(h.getAutoUpdaterMock).toHaveBeenCalled()
  })

  it('start() on unsupported never schedules anything', () => {
    const h = makeHarness({ isPackaged: false })
    const updater = createUpdater(h.deps)
    updater.start()
    expect(h.getAutoUpdaterMock).not.toHaveBeenCalled()
    expect(h.setIntervalMock).not.toHaveBeenCalled()
    expect(updater.getStatus()).toEqual({ state: 'unsupported', reason: 'dev', releasesUrl: RELEASES_URL })
  })
})

describe('supported flow', () => {
  it('broadcasts checking -> available -> downloading(percent) -> ready in order, deduped', async () => {
    const h = makeHarness({
      checkImpl: () => {
        h_autoUpdaterEmit(h, 'checking-for-update')
        h_autoUpdaterEmit(h, 'update-available', { version: '1.2.3' })
        h_autoUpdaterEmit(h, 'download-progress', { percent: 10.9 })
        h_autoUpdaterEmit(h, 'download-progress', { percent: 10.1 }) // same floor(10) -> deduped
        h_autoUpdaterEmit(h, 'download-progress', { percent: 55.5 })
        h_autoUpdaterEmit(h, 'update-downloaded', { version: '1.2.3' })
      }
    })
    const updater = createUpdater(h.deps)
    const finalStatus = await updater.check()

    expect(finalStatus).toEqual({ state: 'ready', version: '1.2.3' })
    expect(h.broadcasts.map((s) => s.state)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'ready'
    ])
    const percents = h.broadcasts
      .filter((s): s is Extract<UpdateStatus, { state: 'downloading' }> => s.state === 'downloading')
      .map((s) => s.percent)
    expect(percents).toEqual([10, 55])
  })

  it('up-to-date', async () => {
    const h = makeHarness({
      checkImpl: () => {
        h_autoUpdaterEmit(h, 'checking-for-update')
        h_autoUpdaterEmit(h, 'update-not-available')
      }
    })
    const updater = createUpdater(h.deps)
    const status = await updater.check()
    expect(status).toEqual({ state: 'up-to-date', lastCheckedAt: 1000 })
  })

  it('error -> error status with message, no unhandled rejection', async () => {
    const h = makeHarness({
      checkImpl: () => {
        h_autoUpdaterEmit(h, 'checking-for-update')
        h_autoUpdaterEmit(h, 'error', new Error('network down'))
        throw new Error('network down')
      }
    })
    const updater = createUpdater(h.deps)
    const status = await updater.check()
    expect(status).toEqual({ state: 'error', message: 'network down', lastCheckedAt: 1000 })
  })

  it('concurrent check() calls share one in-flight check', async () => {
    let resolveCheck: (() => void) | null = null
    const h = makeHarness({
      checkImpl: () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve
        })
    })
    const updater = createUpdater(h.deps)
    const p1 = updater.check()
    const p2 = updater.check()
    expect(h.autoUpdater.checkForUpdatesMock).toHaveBeenCalledTimes(1)
    resolveCheck!()
    const [s1, s2] = await Promise.all([p1, p2])
    expect(s1).toBe(s2)
  })

  it('autoUpdate false: no automatic check on start(), manual check still works', () => {
    const h = makeHarness()
    h.settings.autoUpdate = false
    const updater = createUpdater(h.deps)
    updater.start()
    expect(h.autoUpdater.checkForUpdatesMock).not.toHaveBeenCalled()
    expect(h.setIntervalMock).not.toHaveBeenCalled()

    void updater.check()
    expect(h.autoUpdater.checkForUpdatesMock).toHaveBeenCalledTimes(1)
  })

  it('settingsChanged toggles the interval', () => {
    const h = makeHarness()
    h.settings.autoUpdate = false
    const updater = createUpdater(h.deps)
    updater.start()
    expect(h.setIntervalMock).not.toHaveBeenCalled()

    updater.settingsChanged({ autoUpdate: true })
    expect(h.setIntervalMock).toHaveBeenCalledTimes(1)
    expect(h.autoUpdater.checkForUpdatesMock).toHaveBeenCalledTimes(1)

    updater.settingsChanged({ autoUpdate: false })
    expect(h.clearIntervalMock).toHaveBeenCalledTimes(1)
  })

  it('dispose clears the interval', () => {
    const h = makeHarness()
    const updater = createUpdater(h.deps)
    updater.start()
    expect(h.setIntervalMock).toHaveBeenCalledTimes(1)
    updater.dispose()
    expect(h.clearIntervalMock).toHaveBeenCalledTimes(1)
  })
})

describe('installNow', () => {
  it('rejects while a session is active', async () => {
    const h = makeHarness()
    h.session.active = true
    const updater = createUpdater(h.deps)
    await expect(updater.installNow()).rejects.toThrow(
      'Finish or stop the current session first — the update installs when Flowdo restarts.'
    )
    expect(h.beforeQuitAndInstallMock).not.toHaveBeenCalled()
    expect(h.autoUpdater.quitAndInstallMock).not.toHaveBeenCalled()
  })

  it('rejects when nothing is downloaded (not ready)', async () => {
    const h = makeHarness()
    const updater = createUpdater(h.deps)
    await expect(updater.installNow()).rejects.toThrow()
    expect(h.beforeQuitAndInstallMock).not.toHaveBeenCalled()
    expect(h.autoUpdater.quitAndInstallMock).not.toHaveBeenCalled()
  })

  it('when ready: calls beforeQuitAndInstall then quitAndInstall(false, true), in order', async () => {
    const h = makeHarness({
      checkImpl: () => {
        h_autoUpdaterEmit(h, 'update-available', { version: '2.0.0' })
        h_autoUpdaterEmit(h, 'update-downloaded', { version: '2.0.0' })
      }
    })
    const updater = createUpdater(h.deps)
    await updater.check()
    expect(updater.getStatus()).toEqual({ state: 'ready', version: '2.0.0' })

    await updater.installNow()
    expect(h.callOrder).toEqual(['beforeQuitAndInstall', 'quitAndInstall(false,true)'])
  })
})

/** Helper to emit an event on the harness's fake autoUpdater from inside checkImpl. */
function h_autoUpdaterEmit(h: Harness, event: string, ...args: unknown[]): void {
  h.autoUpdater.emit(event, ...args)
}
