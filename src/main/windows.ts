/**
 * Window lifecycle and the broadcast fan-out.
 *
 * Owned by the integration layer, not by any feature module: `timer.ts` needs
 * `broadcast()`, `tray.ts` needs `showMainWindow()`/`setMiniWidget()`, and both would
 * otherwise be editing the same file to get them.
 */

import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import appIcon from '../../build/icon.png?asset'

/*
 * APP_ICON_NOTE — both windows get the app icon explicitly rather than inheriting the exe's
 * embedded one. On Windows the taskbar button otherwise resolves its icon through the
 * Start-menu shortcut registered for the AppUserModelId; a shortcut left behind by an older
 * install, or none at all for the portable build, gave the blank placeholder icon. Many Linux
 * window managers show no icon at all without it. `?asset` has electron-vite copy the file
 * into out/ (which is what gets packaged) and hand back its runtime path.
 */

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What a window paints before its renderer's first frame. Each value must equal
 * `--color-surface` for that scheme in `assets/index.css` (tests/theme-surface.test.ts
 * checks), or every new window flashes the other theme's colour on open.
 */
const SURFACE = { dark: '#0f1115', light: '#f6f7f9' } as const

/** The pre-paint colour for the scheme in effect: `nativeTheme` already resolves 'system'. */
export function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? SURFACE.dark : SURFACE.light
}

/** Repaint open windows after the effective scheme changed (setting or OS). */
export function applyThemeBackground(): void {
  for (const win of [mainWindow, miniWindow]) {
    if (win && !win.isDestroyed()) win.setBackgroundColor(themeBackground())
  }
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
  /** The window went off screen: minimized, or hidden to the tray. May fire twice per departure. */
  onLeave?: () => void
  /** The window is back: restored or shown. May fire twice per return. */
  onReturn?: () => void
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
    backgroundColor: themeBackground(),
    title: 'Flowdo',
    // See APP_ICON_NOTE at the top of the file.
    icon: appIcon,
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

  // Minimize and hide-to-tray are both "the window left"; restore and show are both "it came
  // back". showMainWindow() does restore() then show(), so each side can fire twice — the
  // listeners are idempotent (see miniAuto.ts).
  if (opts.onLeave) {
    win.on('minimize', opts.onLeave)
    win.on('hide', opts.onLeave)
  }
  if (opts.onReturn) {
    win.on('restore', opts.onReturn)
    win.on('show', opts.onReturn)
  }

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

export interface Point {
  x: number
  y: number
}

/**
 * The mini widget's default and minimum size: the renderer's layout is built for exactly
 * this and scales up from it (container queries in components/mini), never down.
 */
export const MINI_SIZE = { width: 220, height: 88 }

/** Past this the widget stops being a widget and starts covering what you're working on. */
export const MINI_MAX_SIZE = { width: 480, height: 200 }

/**
 * A saved size clamped into [MINI_SIZE, MINI_MAX_SIZE] and rounded to whole pixels, or the
 * default when nothing was saved. Pure, for tests.
 */
export function fitMiniSize(saved: { width: number; height: number } | null): {
  width: number
  height: number
} {
  if (!saved) return { ...MINI_SIZE }
  const clamp = (v: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, v)))
  return {
    width: clamp(saved.width, MINI_SIZE.width, MINI_MAX_SIZE.width),
    height: clamp(saved.height, MINI_SIZE.height, MINI_MAX_SIZE.height)
  }
}

/** Gap between the widget and the work area's edge, so it doesn't sit flush on the taskbar. */
const MINI_MARGIN = 16

/**
 * Top-left of a `size` window tucked into the bottom-right of `area`, `margin` in from both
 * edges. `area` is a display's work area, so the taskbar is already excluded. Pure, for tests.
 */
export function bottomRightCorner(
  area: WindowBounds,
  size: { width: number; height: number },
  margin = MINI_MARGIN
): Point {
  return {
    x: Math.max(area.x, area.x + area.width - size.width - margin),
    y: Math.max(area.y, area.y + area.height - size.height - margin)
  }
}

export interface MiniWidgetOptions {
  /** Where the user last dragged the widget, or null to use the corner. */
  getSavedPosition?: () => Point | null
  /** Called on every move frame; the caller debounces the write. */
  onMoved?: (position: Point) => void
  /** The size the user last resized the widget to, or null for the default. */
  getSavedSize?: () => { width: number; height: number } | null
  /** Called on every resize frame; the caller debounces the write. */
  onResized?: (size: { width: number; height: number }) => void
}

let miniOptions: MiniWidgetOptions = {}

/** Wired once from index.ts, so every caller of setMiniWidget places it the same way. */
export function configureMiniWidget(options: MiniWidgetOptions): void {
  miniOptions = options
}

/**
 * Where the widget opens: where the user last left it if that is still on a connected
 * display (clamped so none of it hangs off the edge), otherwise the bottom-right corner of
 * the display the main window is on — the screen the user is looking at.
 */
function miniPlacement(size: { width: number; height: number }): Point {
  const saved = miniOptions.getSavedPosition?.() ?? null
  if (saved) {
    const rect = { ...saved, ...size }
    if (isOnSomeDisplay(rect)) {
      const fitted = clampBoundsToArea(rect, screen.getDisplayMatching(rect).workArea, size)
      return { x: fitted.x, y: fitted.y }
    }
  }

  const main = getMainWindow()
  const display = main
    ? screen.getDisplayMatching(main.getNormalBounds())
    : screen.getPrimaryDisplay()
  return bottomRightCorner(display.workArea, size)
}

/**
 * The always-on-top mini timer. Frameless and draggable (the renderer sets
 * `-webkit-app-region: drag`), skipped in the taskbar so it reads as a widget rather
 * than a second app. Opens in the screen's bottom-right corner until the user drags it
 * somewhere else, and remembers that spot from then on.
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

  const size = fitMiniSize(miniOptions.getSavedSize?.() ?? null)
  const position = miniPlacement(size)
  const win = new BrowserWindow({
    ...size,
    ...position,
    minWidth: MINI_SIZE.width,
    minHeight: MINI_SIZE.height,
    maxWidth: MINI_MAX_SIZE.width,
    maxHeight: MINI_MAX_SIZE.height,
    show: false,
    frame: false,
    // Resized from its edges: frameless windows keep a thin native resize border.
    resizable: true,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: themeBackground(),
    title: 'Flowdo',
    // See APP_ICON_NOTE at the top of the file.
    icon: appIcon,
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
  win.on('move', () => {
    const [x, y] = win.getPosition()
    if (x !== undefined && y !== undefined) miniOptions.onMoved?.({ x, y })
  })
  win.on('resize', () => {
    const [width, height] = win.getSize()
    if (width !== undefined && height !== undefined) miniOptions.onResized?.({ width, height })
  })
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
