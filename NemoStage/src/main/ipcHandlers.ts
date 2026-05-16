import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import type { FSWatcher } from 'fs'
import fs from 'fs-extra'
import path from 'path'
import type {
  ExtractionProgressEvent,
  ExtractionResult,
  SessionMetadata,
  SessionRuntime,
  DoclingElement,
  PptxManifest,
  TranscriptEvent,
  TranscriptListenerStatus
} from './types'
import { extractPPTX, extractThemeFonts, parseSlideRelationships } from './services/pptxExtractor'
import {
  clearSession,
  generateSessionId,
  getSessionDir,
  initializeWorkspace,
  listRecentSessions,
  readSessionMetadata,
  touchSession,
  writeSessionMetadata
} from './services/workspaceManager'

import { parsePPTXStructure } from './services/pptxXmlParser'
import { downloadGoogleFonts } from './services/googleFontsDownloader'

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024
const NEMOSTAGE_BACKEND_URL = 'http://169.233.123.64:8000'
const TRANSCRIPT_FILE_PATTERN = /^transcript_.*\.jsonl$/
const sessions = new Map<string, SessionRuntime>()
const doclingManifests = new Map<string, PptxManifest>()
const parsingSessions = new Set<string>()

const transcriptWatchState: {
  directoryWatcher: FSWatcher | null
  fileWatcher: FSWatcher | null
  directory: string | null
  filePath: string | null
  lastEventKey: string | null
  debounceTimer: NodeJS.Timeout | null
} = {
  directoryWatcher: null,
  fileWatcher: null,
  directory: null,
  filePath: null,
  lastEventKey: null,
  debounceTimer: null
}

function emitToRenderer(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload)
  }
}

function toFileUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  return `nemostage-media:///${encodeURI(normalized)}`
}

async function resolveTranscriptDirectory(): Promise<string> {
  const candidates = [
    process.env.NEMOSTAGE_TRANSCRIPT_DIR,
    path.resolve(process.cwd(), '..', 'backend', 'transcript', 'transcripts'),
    path.resolve(process.cwd(), 'backend', 'transcript', 'transcripts')
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      return candidate
    }
  }

  return candidates[0]
}

async function getLatestTranscriptFile(directory: string): Promise<string | null> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && TRANSCRIPT_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name)
        const stat = await fs.stat(filePath).catch(() => null)
        return stat ? { filePath, mtimeMs: stat.mtimeMs } : null
      })
  )

  return (
    files
      .filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.filePath ?? null
  )
}

async function readLastTranscriptEvent(filePath: string): Promise<TranscriptEvent | null> {
  const content = await fs.readFile(filePath, 'utf8').catch(() => '')
  const line = content
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.trim().length > 0)

  if (!line) {
    return null
  }

  try {
    return JSON.parse(line) as TranscriptEvent
  } catch {
    return {
      type: 'error',
      error: `Could not parse latest transcript JSON line in ${path.basename(filePath)}`
    }
  }
}

function getTranscriptEventKey(event: TranscriptEvent, filePath: string): string {
  return [
    filePath,
    event.session_id ?? '',
    event.segment_index ?? '',
    event.timestamp ?? '',
    event.type ?? '',
    event.text ?? event.error ?? ''
  ].join('|')
}

function closeTranscriptFileWatcher(): void {
  transcriptWatchState.fileWatcher?.close()
  transcriptWatchState.fileWatcher = null
  transcriptWatchState.filePath = null
}

function stopTranscriptWatcher(): void {
  transcriptWatchState.directoryWatcher?.close()
  transcriptWatchState.directoryWatcher = null
  closeTranscriptFileWatcher()
  if (transcriptWatchState.debounceTimer) {
    clearTimeout(transcriptWatchState.debounceTimer)
    transcriptWatchState.debounceTimer = null
  }
  transcriptWatchState.directory = null
  transcriptWatchState.lastEventKey = null
}

function getTranscriptListenerStatus(): TranscriptListenerStatus {
  return {
    listening: transcriptWatchState.directoryWatcher !== null,
    directory: transcriptWatchState.directory ?? '',
    filePath: transcriptWatchState.filePath
  }
}

function scheduleTranscriptRead(window: BrowserWindow | null, delayMs = 80): void {
  if (transcriptWatchState.debounceTimer) {
    clearTimeout(transcriptWatchState.debounceTimer)
  }

  transcriptWatchState.debounceTimer = setTimeout(() => {
    transcriptWatchState.debounceTimer = null
    void publishLatestTranscriptEvent(window)
  }, delayMs)
}

async function watchTranscriptFile(window: BrowserWindow | null, filePath: string): Promise<void> {
  if (transcriptWatchState.filePath === filePath && transcriptWatchState.fileWatcher) {
    return
  }

  closeTranscriptFileWatcher()
  transcriptWatchState.filePath = filePath
  transcriptWatchState.fileWatcher = fs.watch(filePath, () => scheduleTranscriptRead(window))
  emitToRenderer(window, 'transcript:status', getTranscriptListenerStatus())
}

async function publishLatestTranscriptEvent(window: BrowserWindow | null): Promise<void> {
  if (!transcriptWatchState.directory) {
    return
  }

  const latestFile = await getLatestTranscriptFile(transcriptWatchState.directory)
  if (!latestFile) {
    emitToRenderer(window, 'transcript:status', getTranscriptListenerStatus())
    return
  }

  await watchTranscriptFile(window, latestFile)
  const event = await readLastTranscriptEvent(latestFile)
  if (!event) {
    return
  }

  const eventKey = getTranscriptEventKey(event, latestFile)
  if (eventKey === transcriptWatchState.lastEventKey) {
    return
  }

  transcriptWatchState.lastEventKey = eventKey
  emitToRenderer(window, 'transcript:update', {
    ...event,
    transcript_file: latestFile
  })
}

async function validatePptxFile(filePath: string): Promise<string[]> {
  const warnings: string[] = []
  const fileName = path.basename(filePath)
  if (path.extname(fileName).toLowerCase() !== '.pptx') {
    throw new Error('Only .pptx files are supported.')
  }

  const exists = await fs.pathExists(filePath)
  if (!exists) {
    throw new Error('Selected file does not exist.')
  }

  const stats = await fs.stat(filePath)
  if (!stats.isFile()) {
    throw new Error('Selected path is not a file.')
  }

  await fs.access(filePath, fs.constants.R_OK)

  if (stats.size > MAX_FILE_SIZE_BYTES) {
    warnings.push('This file is larger than 100MB. Extraction may take longer than usual.')
  }

  return warnings
}

async function hydrateSessionFromDisk(sessionId: string): Promise<SessionRuntime | null> {
  const metadata = await readSessionMetadata(sessionId)
  if (!metadata) {
    return null
  }

  const sessionDir = getSessionDir(sessionId)
  const rawDir = path.join(sessionDir, 'raw')
  const manifestPath = path.join(sessionDir, 'manifest.json')

  const slidesFromDisk = await parseSlideRelationships(rawDir, sessionDir)
  const fonts = await extractThemeFonts(rawDir)
  const doclingExists = await fs.pathExists(manifestPath)

  const result: ExtractionResult = {
    sessionId,
    filePath: metadata.filePath,
    fileName: metadata.fileName,
    slideCount: metadata.slideCount,
    slides: slidesFromDisk.map((slide) => ({
      slideIndex: slide.slideIndex,
      imagePaths: slide.imagePaths.map(toFileUrl),
      thumbnailPath: slide.imagePaths[0] ? toFileUrl(slide.imagePaths[0]) : null
    })),
    doclingStatus: doclingExists ? 'ready' : 'failed',
    fonts,
    warnings: []
  }

  const runtime: SessionRuntime = {
    sessionId,
    sessionDir,
    manifestPath,
    result
  }

  if (doclingExists) {
    const manifest = await fs.readJson(manifestPath).catch(() => null)
    if (manifest) {
      doclingManifests.set(sessionId, manifest)
    }
  }

  sessions.set(sessionId, runtime)
  return runtime
}

async function refreshParseStatusFromDisk(runtime: SessionRuntime): Promise<void> {
  const manifestExists = await fs.pathExists(runtime.manifestPath)
  if (!manifestExists) {
    return
  }

  runtime.result.doclingStatus = 'ready'
  if (!doclingManifests.has(runtime.sessionId)) {
    const manifest = await fs.readJson(runtime.manifestPath).catch(() => null)
    if (manifest) {
      doclingManifests.set(runtime.sessionId, manifest)
    }
  }
}

function startStructureParse(
  runtime: SessionRuntime,
  filePath: string,
  getMainWindow: () => BrowserWindow | null
): void {
  if (parsingSessions.has(runtime.sessionId)) {
    return
  }

  parsingSessions.add(runtime.sessionId)
  runtime.result.doclingStatus = 'pending'
  emitToRenderer(getMainWindow(), 'pptx:progress', {
    sessionId: runtime.sessionId,
    phase: 'parsing_structure',
    progress: 0.9,
    message: 'Parsing slide structure'
  })

  void parsePPTXStructure(filePath, runtime.sessionDir)
    .then(async (manifest) => {
      await fs.writeJson(runtime.manifestPath, manifest, { spaces: 2 })
      doclingManifests.set(runtime.sessionId, manifest)

      const current = sessions.get(runtime.sessionId)
      if (current) {
        current.result.doclingStatus = 'ready'
      }
      emitToRenderer(getMainWindow(), 'pptx:doclingReady', {
        sessionId: runtime.sessionId,
        googleFontNames: doclingManifests.get(runtime.sessionId)?.googleFontNames ?? []
      })
    })
    .catch((error) => {
      const current = sessions.get(runtime.sessionId)
      if (current) {
        current.result.doclingStatus = 'failed'
      }
      emitToRenderer(getMainWindow(), 'pptx:doclingError', {
        sessionId: runtime.sessionId,
        message: (error as Error).message
      })
    })
    .finally(() => {
      parsingSessions.delete(runtime.sessionId)
    })
}

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('dialog:openFile', async () => {
    const window = getMainWindow()
    const dialogOptions: OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'PowerPoint Presentations', extensions: ['pptx'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]
    await validatePptxFile(selectedPath)
    return selectedPath
  })

  ipcMain.handle('file:getStats', async (_event, filePath: string) => {
    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat || !stat.isFile()) {
      return null
    }

    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  })

  ipcMain.handle('pptx:uploadToSandbox', async (_event, filePath: string) => {
    await validatePptxFile(filePath)

    const bytes = await fs.readFile(filePath)
    const formData = new FormData()
    formData.append(
      'file',
      new Blob([new Uint8Array(bytes)], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      }),
      path.basename(filePath)
    )

    const response = await fetch(`${NEMOSTAGE_BACKEND_URL}/sandbox/uploadpptx`, {
      method: 'POST',
      body: formData
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || `Sandbox upload failed: ${response.status}`)
    }

    return response.json()
  })

  ipcMain.handle('pptx:extract', async (_event, filePath: string) => {
    const warnings = await validatePptxFile(filePath)
    const sessionId = generateSessionId()
    const sessionDir = await initializeWorkspace(sessionId)

    const emitProgress = (progress: ExtractionProgressEvent): void => {
      emitToRenderer(getMainWindow(), 'pptx:progress', { ...progress, sessionId })
    }

    emitProgress({ phase: 'extracting_images', progress: 0, message: 'Preparing workspace' })
    const extraction = await extractPPTX(filePath, sessionDir, emitProgress)

    const manifestPath = path.join(sessionDir, 'manifest.json')
    const metadata: SessionMetadata = {
      sessionId,
      fileName: path.basename(filePath),
      filePath,
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      slideCount: extraction.slides.length,
      currentSlide: 0
    }

    await writeSessionMetadata(metadata)

    const result: ExtractionResult = {
      sessionId,
      filePath,
      fileName: path.basename(filePath),
      slideCount: extraction.slides.length,
      slides: extraction.slides.map((slide) => ({
        slideIndex: slide.slideIndex,
        imagePaths: slide.imagePaths.map(toFileUrl),
        thumbnailPath: slide.imagePaths[0] ? toFileUrl(slide.imagePaths[0]) : null
      })),
      doclingStatus: 'pending',
      fonts: extraction.fonts,
      warnings
    }

    const runtime: SessionRuntime = {
      sessionId,
      sessionDir,
      manifestPath,
      result
    }

    sessions.set(sessionId, runtime)

    startStructureParse(runtime, filePath, getMainWindow)

    emitProgress({ phase: 'extracting_images', progress: 1, message: 'Preview ready' })
    return result
  })

  ipcMain.handle('pptx:getImage', async (_event, sessionId: string, slideIndex: number) => {
    const runtime = sessions.get(sessionId) ?? (await hydrateSessionFromDisk(sessionId))
    if (!runtime) {
      return null
    }

    const slide = runtime.result.slides.find((entry) => entry.slideIndex === slideIndex)
    return slide?.imagePaths[0] ?? null
  })

  ipcMain.handle('pptx:getData', async (_event, sessionId: string, slideIndex: number) => {
    const runtime = sessions.get(sessionId) ?? (await hydrateSessionFromDisk(sessionId))
    if (!runtime) {
      throw new Error('Session not found')
    }

    const manifest = doclingManifests.get(sessionId)

    if (!manifest) {
      console.log('[pptx:getData] No manifest found')
      return { slideIndex, elements: [] }
    }

    console.log(`[pptx:getData] === Processing slide ${slideIndex} ===`)

    // NEW: Direct access to slides array
    const slide = manifest.slides?.[slideIndex]

    if (!slide) {
      console.log(`[pptx:getData] ❌ No slide at index ${slideIndex}`)
      return { slideIndex, elements: [] }
    }

    console.log(`[pptx:getData] ✅ Found slide with ${slide.elements.length} elements`)

    // Convert PptxElement to DoclingElement format (for renderer compatibility)
    const elements: DoclingElement[] = slide.elements.map((element) => {
      if (element.type === 'text') {
        const firstRun = element.textRuns?.[0]
        return {
          type: 'text',
          bbox: element.bbox,
          content: element.content || '',
          style: {
            font: firstRun?.font || 'Calibri',
            fontSize: firstRun?.size || 18,
            color: firstRun?.color || '#000000'
          },
          textRuns: element.textRuns,
          fillColor: element.fillColor,
          rotation: element.rotation,
          verticalAnchor: element.verticalAnchor,
          shapeGeom: element.shapeGeom,
          textBoxStyle: element.textBoxStyle
        }
      } else if (element.type === 'image') {
        return {
          type: 'image',
          bbox: element.bbox,
          content: element.imagePath ? toFileUrl(element.imagePath) : '',
          style: {},
          crop: element.crop,
          rotation: element.rotation
        }
      } else if (element.type === 'table') {
        return {
          type: 'table',
          bbox: element.bbox,
          content: '',
          style: {},
          tableRows: element.tableRows,
          colWidths: element.colWidths
        }
      } else {
        return {
          type: element.type,
          bbox: element.bbox,
          content: '',
          style: {},
          fillColor: element.fillColor,
          rotation: element.rotation,
          shapeGeom: element.shapeGeom
        }
      }
    })

    console.log(`[pptx:getData] 📊 Returning ${elements.length} elements`)

    return {
      slideIndex,
      elements,
      speakerNotes: slide.speakerNotes,
      background: slide.background,
      slideWidth: manifest.slideWidth,
      slideHeight: manifest.slideHeight
    }
  })

  ipcMain.handle('pptx:getParseStatus', async (_event, sessionId: string) => {
    const runtime = sessions.get(sessionId) ?? (await hydrateSessionFromDisk(sessionId))
    if (!runtime) {
      throw new Error('Session not found')
    }

    await refreshParseStatusFromDisk(runtime)

    return {
      doclingStatus: runtime.result.doclingStatus,
      hasManifest: doclingManifests.has(sessionId) || (await fs.pathExists(runtime.manifestPath)),
      googleFontNames: doclingManifests.get(sessionId)?.googleFontNames ?? []
    }
  })

  ipcMain.handle('pptx:downloadGoogleFonts', async (_event, sessionId: string) => {
    const manifest = doclingManifests.get(sessionId)
    const names = manifest?.googleFontNames ?? []
    if (!names.length) return []
    console.log(`[pptx:downloadGoogleFonts] Downloading ${names.length} fonts for session ${sessionId}:`, names)
    return downloadGoogleFonts(names)
  })

  ipcMain.handle('pptx:getSessionFonts', async (_event, sessionId: string) => {
    const manifest = doclingManifests.get(sessionId)
    console.log(`[pptx:getSessionFonts] sessionId=${sessionId} | manifest found=${!!manifest} | embeddedFonts count=${manifest?.embeddedFonts?.length ?? 0}`)
    if (!manifest?.embeddedFonts?.length) return []
    const entries = manifest.embeddedFonts.map((font) => ({
      name: font.name,
      url: toFileUrl(font.path),
      boldUrl: font.bold ? toFileUrl(font.bold) : undefined,
      italicUrl: font.italic ? toFileUrl(font.italic) : undefined,
      boldItalicUrl: font.boldItalic ? toFileUrl(font.boldItalic) : undefined
    }))
    console.log('[pptx:getSessionFonts] Returning font entries:', entries.map(e =>
      `${e.name} [regular${e.boldUrl ? ' bold' : ''}${e.italicUrl ? ' italic' : ''}${e.boldItalicUrl ? ' boldItalic' : ''}]`
    ))
    return entries
  })

  ipcMain.handle('pptx:getRecentSessions', async () => listRecentSessions(5))

  ipcMain.handle('pptx:resumeSession', async (_event, sessionId: string) => {
    const runtime = sessions.get(sessionId) ?? (await hydrateSessionFromDisk(sessionId))
    if (!runtime) {
      throw new Error('Session not found')
    }

    await refreshParseStatusFromDisk(runtime)
    if (runtime.result.doclingStatus !== 'ready') {
      const fileExists = await fs.pathExists(runtime.result.filePath)
      if (fileExists) {
        startStructureParse(runtime, runtime.result.filePath, getMainWindow)
      }
    }

    await touchSession(sessionId)
    return runtime.result
  })

  ipcMain.handle(
    'pptx:updateSessionState',
    async (_event, sessionId: string, currentSlide: number) => {
      await touchSession(sessionId, currentSlide)
      return true
    }
  )

  ipcMain.handle('pptx:clearSession', async (_event, sessionId: string) => {
    await clearSession(sessionId)
    sessions.delete(sessionId)
    doclingManifests.delete(sessionId)
    return true
  })

  ipcMain.handle('transcript:startListening', async () => {
    stopTranscriptWatcher()

    const directory = await resolveTranscriptDirectory()
    await fs.ensureDir(directory)
    transcriptWatchState.directory = directory
    transcriptWatchState.directoryWatcher = fs.watch(directory, () => {
      scheduleTranscriptRead(getMainWindow())
    })

    await publishLatestTranscriptEvent(getMainWindow())
    emitToRenderer(getMainWindow(), 'transcript:status', getTranscriptListenerStatus())
    return getTranscriptListenerStatus()
  })

  ipcMain.handle('transcript:stopListening', async () => {
    stopTranscriptWatcher()
    return getTranscriptListenerStatus()
  })
}
