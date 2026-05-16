import { app, BrowserWindow, shell, protocol } from 'electron' 
import path, { join } from 'path' 
import fs from 'fs' // Added native fs module
import { electronApp, optimizer, is } from '@electron-toolkit/utils' 
import icon from '../../resources/icon.png?asset' 
import { registerIpcHandlers } from './ipcHandlers' 
import { cleanupOldSessions } from './services/workspaceManager' 
import { mediaUrlToPath, mimeTypeForPath } from './services/mediaProtocol'

app.commandLine.appendSwitch('disable-web-security') 
app.commandLine.appendSwitch('user-data-dir', path.join(app.getPath('userData'), 'dev-profile')) 

protocol.registerSchemesAsPrivileged([ 
  { 
    scheme: 'nemostage-media', 
    privileges: { 
      standard: true,      // Treats it like http/https URLs 
      secure: true,        // Allows it to mix with secure origins 
      supportFetchAPI: true, // Enables FontFace / fetch() requests 
      corsEnabled: true    // Critically unlocks CORS behaviors 
    } 
  } 
]) 

function createWindow(): BrowserWindow { 
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
      webSecurity: false, 
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

  protocol.handle('nemostage-media', async (request) => {
    try {
      const filePath = mediaUrlToPath(request.url)

      if (!fs.existsSync(filePath)) {
        console.error(`[nemostage-media] File missing at path: ${filePath}`)
        return new Response('Asset not found', { status: 404 })
      }

      const fileBuffer = fs.readFileSync(filePath)

      return new Response(fileBuffer, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Content-Type': mimeTypeForPath(filePath)
        }
      })
    } catch (error) {
      console.error('[nemostage-media] Handler crashed:', error)
      return new Response('Internal Protocol Error', { status: 500 })
    }
  })


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
