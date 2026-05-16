import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from './index.d'

const electronAPI: ElectronAPI = {
  selectPPTX: () => ipcRenderer.invoke('dialog:openFile'),
  getFileStats: (filePath) => ipcRenderer.invoke('file:getStats', filePath),
  uploadPPTXToSandbox: (filePath) => ipcRenderer.invoke('pptx:uploadToSandbox', filePath),
  extractPPTX: (filePath) => ipcRenderer.invoke('pptx:extract', filePath),
  getSlideImage: (sessionId, index) => ipcRenderer.invoke('pptx:getImage', sessionId, index),
  getSlideData: (sessionId, index) => ipcRenderer.invoke('pptx:getData', sessionId, index),
  getParseStatus: (sessionId) => ipcRenderer.invoke('pptx:getParseStatus', sessionId),
  getRecentSessions: () => ipcRenderer.invoke('pptx:getRecentSessions'),
  resumeSession: (sessionId) => ipcRenderer.invoke('pptx:resumeSession', sessionId),
  updateSessionState: (sessionId, currentSlide) =>
    ipcRenderer.invoke('pptx:updateSessionState', sessionId, currentSlide),
  clearSession: (sessionId) => ipcRenderer.invoke('pptx:clearSession', sessionId),
  onExtractionProgress: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0]
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('pptx:progress', listener)
    return () => {
      ipcRenderer.removeListener('pptx:progress', listener)
    }
  },
  onDoclingReady: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0]
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('pptx:doclingReady', listener)
    return () => {
      ipcRenderer.removeListener('pptx:doclingReady', listener)
    }
  },
  onDoclingError: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0]
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('pptx:doclingError', listener)
    return () => {
      ipcRenderer.removeListener('pptx:doclingError', listener)
    }
  },
  onLog: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0]
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('pptx:log', listener)
    return () => {
      ipcRenderer.removeListener('pptx:log', listener)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI)
} else {
  // @ts-ignore fallback for non-isolated contexts
  window.electronAPI = electronAPI
}
