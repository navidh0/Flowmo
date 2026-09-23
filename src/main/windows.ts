/**
 * Window lifecycle and the broadcast fan-out.
 *
 * Owned by the integration layer, not by any feature module: `timer.ts` needs
 * `broadcast()`, `tray.ts` needs `showMainWindow()`/`setMiniWidget()`, and both would
 * otherwise be editing the same file to get them.
 */

import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_SIZE = { width: 1040, height: 720 }
const MIN_SIZE = { width: 760, height: 560 }

/**
 * Persisted bounds, restored only if they still land on a connected display.
 *
 * A window saved on a second monitor that is now unplugged would otherwise open at
 * coordinates no display covers — invisible, un-dragga, and indistinguishable from the
 * app failing to start. `screen.getDisplayMatching` returns the *closest* display, so the
 * test is whether the saved rectangle actually intersects it.
 */
function isOnSomeDisplay(bounds: WindowBounds): boolean {
  const area = screen.getDisplayMatching(bounds).workArea
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const overlapY =
    Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)

  // Require a real chunk on screen, not one stray pixel of title bar.
  return overlapX > 80 && overlapY > 40
}

/**
 * Clamp a rectangle to fit entirely inside another, pure and Electron-free so it's
 * unit-testable without a display.
 *
 * Overlapping a display is not the same as fitting on it: bounds saved on a 2560×1400
 * monitor restored onto a 1366×768 one would still open larger than the screen, and a
 * saved y above the work area's top puts the title bar off-screen where it can't be
 * dragged back down. Size is clamped first (never below `min`, but never above `area`'s
 * own size even when `min` is larger than the area — the area wins so the window still
 * fits), then position is clamped so the whole window lies inside `area`.
 */
export function clampBoundsToArea(
  bounds: WindowBounds,
  area: WindowBounds,
  min: { width: number; height: number }
): WindowBounds {
  const width = Math.min(Math.max(bounds.width, Math.min(min.width, area.width)), area.width)
  const height = Math.min(Math.max(bounds.height, Math.min(min.height, area.height)), area.height)

  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)

  return { x, y, width, height }
}

/** Set immediately before app.quit() so the close handler stops hiding to tray. */
let quitting = false

export function setQuitting(value: boolean): void {
  quitting = value
}

export function isQuitting(): boolean {
  return quitting
}

const preload = join(__dirname, '../preload/index.js')

/** Dev serves from the Vite dev server; production loads the built file. */
function loadRenderer(win: BrowserWindow, hash = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devUrl) {
    void win.loadURL(`${devUrl}${hash}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.slice(1) })
  }
}

export interface MainWindowOptions {
  minimizeToTray: () => boolean
  /** Last persisted bounds, if any. Ignored when they fall off every connected display. */
  savedBounds?: WindowBounds | null
  /** Called on resize/move, debounced by the caller — this fires on every drag frame. */
  onBoundsChanged?: (bounds: WindowBounds) => void
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const saved = opts.savedBounds
  const usable =
    saved && isOnSomeDisplay(saved)
      ? clampBoundsToArea(saved, screen.getDisplayMatching(saved).workArea, MIN_SIZE)
      : null

  const win = new BrowserWindow({
    width: usable?.width ?? DEFAULT_SIZE.width,
    height: usable?.height ?? DEFAULT_SIZE.height,
    ...(usable ? { x: usable.x, y: usable.y } : {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'Flowdo',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Avoid the white flash before React paints.
  win.on('ready-to-show', () => win.show())

  // Report normal bounds only. getBounds() while maximised or minimised records the
  // maximised rectangle, so the window would restore un-maximised at full screen size and
  // never return to the size the user actually chose.
  const reportBounds = (): void => {
    if (!opts.onBoundsChanged) return
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) return
    opts.onBoundsChanged(win.getNormalBounds())
  }
  win.on('resize', reportBounds)
  win.on('move', reportBounds)

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Close means hide-to-tray, not quit — a timer that dies when you hit X is useless.
  win.on('close', (e) => {
    if (!quitting && opts.minimizeToTray()) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  loadRenderer(win)
  mainWindow = win
  return win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function getMiniWindow(): BrowserWindow | null {
  return miniWindow && !miniWindow.isDestroyed() ? miniWindow : null
}

/**
 * The always-on-top mini timer. Frameless and draggable (the renderer sets
 * `-webkit-app-region: drag`), skipped in the taskbar so it reads as a widget rather
 * than a second app.
 */
export function setMiniWidget(visible: boolean): void {
  if (!visible) {
    getMiniWindow()?.close()
    miniWindow = null
    return
  }

  if (getMiniWindow()) {
    miniWindow?.showInactive()
    return
  }

  const win = new BrowserWindow({
    width: 220,
    height: 88,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#0f1115',
    title: 'Flowdo',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 'screen-saver' keeps it above full-screen apps, which is the point of a focus widget.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('ready-to-show', () => win.showInactive())
  win.on('closed', () => {
    miniWindow = null
  })

  loadRenderer(win, '#/mini')
  miniWindow = win
}

/** True when the given webContents belongs to the mini widget. */
export function isMiniWebContents(id: number): boolean {
  return getMiniWindow()?.webContents.id === id
}

/** Push an event to every open window. Used for timer ticks and settings changes. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of [getMainWindow(), getMiniWindow()]) {
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
