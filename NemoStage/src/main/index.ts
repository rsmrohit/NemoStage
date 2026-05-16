import { app, BrowserWindow, shell, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipcHandlers'
import { cleanupOldSessions } from './services/workspaceManager'

function createWindow(): BrowserWindow {

  protocol.registerFileProtocol('nemostage-media', (request, callback) => {
    const url = request.url.replace('nemostage-media://', '')
    const decodedPath = decodeURIComponent(url)
    
    try {
      return callback({ path: decodedPath })
    } catch (error) {
      console.error('Failed to load media:', error)
      return callback({ error: -2 }) // FILE_NOT_FOUND
    }
  })

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await cleanupOldSessions()
  let mainWindow: BrowserWindow | null = createWindow()
  registerIpcHandlers(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow
    }
    return BrowserWindow.getAllWindows()[0] ?? null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
