/**
 * App entry. Owned by the integration layer.
 *
 * Wave 0 scope: single-instance lock, window creation, and the `app:*` channels so the
 * preload bridge can be verified end to end. The db / timer / tray modules get wired in
 * here once Wave 1 lands — this file is the convergence point, which is exactly why no
 * feature agent edits it.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { CH } from '@shared/channels'
import {
  createMainWindow,
  getMainWindow,
  isMiniWebContents,
  setMiniWidget,
  setQuitting,
  showMainWindow
} from './windows'

// A second instance would run a second timer against the same SQLite file.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('io.flowdo.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerAppHandlers()

    // Replaced with the persisted setting once the settings repo is wired in Wave 1.
    createMainWindow({ minimizeToTray: () => false })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow({ minimizeToTray: () => false })
      } else {
        showMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => setQuitting(true))
}

function registerAppHandlers(): void {
  ipcMain.handle(CH.app.getVersion, () => app.getVersion())

  ipcMain.handle(CH.app.isMiniWindow, (e) => isMiniWebContents(e.sender.id))

  ipcMain.handle(CH.app.setMiniWidget, (_e, visible: boolean) => {
    setMiniWidget(visible)
  })

  ipcMain.handle(CH.app.quit, () => {
    setQuitting(true)
    app.quit()
  })

  // Keeps the reference used so a future refactor doesn't silently drop it.
  void getMainWindow
}
