import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from './index.d'

const electronAPI: ElectronAPI = {
  selectPPTX: () => ipcRenderer.invoke('dialog:openFile'),
  selectPresentationMaterials: () => ipcRenderer.invoke('dialog:openMaterials'),
  getFileStats: (filePath) => ipcRenderer.invoke('file:getStats', filePath),
  uploadPPTXToSandbox: (filePath) => ipcRenderer.invoke('pptx:uploadToSandbox', filePath),
  uploadPresentationMaterials: (presentationFilename, filePaths) =>
    ipcRenderer.invoke('pptx:uploadPresentationMaterials', presentationFilename, filePaths),
  extractPPTX: (filePath) => ipcRenderer.invoke('pptx:extract', filePath),
  getSlideImage: (sessionId, index) => ipcRenderer.invoke('pptx:getImage', sessionId, index),
  getSlideData: (sessionId, index) => ipcRenderer.invoke('pptx:getData', sessionId, index),
  getSessionFonts: (sessionId) => ipcRenderer.invoke('pptx:getSessionFonts', sessionId),
  getParseStatus: (sessionId) => ipcRenderer.invoke('pptx:getParseStatus', sessionId),
  downloadGoogleFonts: (sessionId) => ipcRenderer.invoke('pptx:downloadGoogleFonts', sessionId),
  getRecentSessions: () => ipcRenderer.invoke('pptx:getRecentSessions'),
  resumeSession: (sessionId) => ipcRenderer.invoke('pptx:resumeSession', sessionId),
  updateSessionState: (sessionId, currentSlide) =>
    ipcRenderer.invoke('pptx:updateSessionState', sessionId, currentSlide),
  clearSession: (sessionId) => ipcRenderer.invoke('pptx:clearSession', sessionId),
  startTranscriptListener: () => ipcRenderer.invoke('transcript:startListening'),
  stopTranscriptListener: () => ipcRenderer.invoke('transcript:stopListening'),
  startTimelineSession: (payload) => ipcRenderer.invoke('timeline:startSession', payload),
  appendTimelineEntry: (entry) => ipcRenderer.invoke('timeline:appendEntry', entry),
  clearTimelineSession: (presentationId) => ipcRenderer.invoke('timeline:clearSession', presentationId),
  startEngagementAnalyzer: (payload) => ipcRenderer.invoke('engagement:startAnalyzer', payload),
  stopEngagementAnalyzer: (presentationId) => ipcRenderer.invoke('engagement:stopAnalyzer', presentationId),
  getEngagementAnalyzerStatus: (presentationId) =>
    ipcRenderer.invoke('engagement:getAnalyzerStatus', presentationId),
  getDashboardPresentationData: (presentationId) =>
    ipcRenderer.invoke('dashboard:getPresentationData', presentationId),
  listDashboardSessions: (fileName) => ipcRenderer.invoke('dashboard:listSessions', fileName),
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
  onTranscriptUpdate: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0]
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('transcript:update', listener)
    return () => {
      ipcRenderer.removeListener('transcript:update', listener)
    }
  },
  onTranscriptStatus: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0]
    ): void => {
      callback(payload)
    }

    ipcRenderer.on('transcript:status', listener)
    return () => {
      ipcRenderer.removeListener('transcript:status', listener)
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
