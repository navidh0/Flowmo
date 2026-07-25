/**
 * Window lifecycle and the broadcast fan-out.
 *
 * Owned by the integration layer, not by any feature module: `timer.ts` needs
 * `broadcast()`, `tray.ts` needs `showMainWindow()`/`setMiniWidget()`, and both would
 * otherwise be editing the same file to get them.
 */

import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null

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

export function createMainWindow(opts: { minimizeToTray: () => boolean }): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  const win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 560,
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
