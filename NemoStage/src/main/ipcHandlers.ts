import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { pathToFileURL } from 'url'
import type {
  DoclingManifest,
  ExtractionProgressEvent,
  ExtractionResult,
  SessionMetadata,
  SessionRuntime,
  SlideData,
  DoclingElement
} from './types'
import { runDoclingParser } from './services/doclingParser'
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
import { emit } from 'process'

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024
const sessions = new Map<string, SessionRuntime>()
const doclingManifests = new Map<string, DoclingManifest>()

function emitToRenderer(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload)
  }
}

function toFileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).toString()
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

    const emitLog = (message: string): void => {
      emitToRenderer(getMainWindow(), 'pptx:log', { sessionId, message })
    }

    void runDoclingParser(filePath, manifestPath, emitProgress, emitLog)
      .then(async (manifest) => {
        doclingManifests.set(sessionId, manifest)
        const current = sessions.get(sessionId)
        if (current) {
          current.result.doclingStatus = 'ready'
        }
        emitToRenderer(getMainWindow(), 'pptx:doclingReady', { sessionId })
      })
      .catch((error) => {
        const current = sessions.get(sessionId)
        if (current) {
          current.result.doclingStatus = 'failed'
        }
        emitToRenderer(getMainWindow(), 'pptx:doclingError', {
          sessionId,
          message: (error as Error).message
        })
      })

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
    
    if (!manifest || !manifest.groups) {
      console.log('[pptx:getData] No manifest or groups')
      return { slideIndex, elements: [] }
    }

    console.log(`[pptx:getData] === Processing slide ${slideIndex} ===`)
    
    // Filter by 'chapter' for PowerPoint slides
    const slideGroups = manifest.groups.filter(g => g.label === 'chapter')
    console.log('[pptx:getData] Total chapters:', slideGroups.length)
    
    const slideGroup = slideGroups[slideIndex]
    
    if (!slideGroup) {
      console.log(`[pptx:getData] ❌ No slide group at index ${slideIndex}`)
      return { slideIndex, elements: [] }
    }

    console.log(`[pptx:getData] ✅ Found slide group:`, slideGroup.name)
    console.log(`[pptx:getData] Slide has ${slideGroup.children.length} children`)
    
    // Extract text elements that belong to this slide
    const elements: DoclingElement[] = []
    
    if (manifest.texts) {
      console.log(`[pptx:getData] Total text items in manifest:`, manifest.texts.length)
      
      // Get child references from the slide group
      const slideChildRefs = new Set(slideGroup.children.map(c => c.$ref))
      console.log(`[pptx:getData] Slide child refs:`, Array.from(slideChildRefs).slice(0, 5), '...')
      
      for (const textItem of manifest.texts) {
        // Check if this text item is a child of the current slide
        if (slideChildRefs.has(textItem.self_ref) && textItem.prov && textItem.prov[0]) {
          const bbox = textItem.prov[0].bbox
          
          console.log(`[pptx:getData] ✅ Matched text: "${textItem.text.substring(0, 50)}..."`)
          
          elements.push({
            type: 'text',
            bbox: {
              x: bbox.l,
              y: bbox.t,
              width: bbox.r - bbox.l,
              height: bbox.b - bbox.t
            },
            content: textItem.text,
            style: {
              font: 'Arial',
              fontSize: 12,
              color: '#000000'
            }
          })
        }
      }
    }

    console.log(`[pptx:getData] 📊 Final result: ${elements.length} text elements for slide ${slideIndex}`)

    return {
      slideIndex,
      elements
    }
  })

  ipcMain.handle('pptx:getRecentSessions', async () => listRecentSessions(5))

  ipcMain.handle('pptx:resumeSession', async (_event, sessionId: string) => {
    const runtime = sessions.get(sessionId) ?? (await hydrateSessionFromDisk(sessionId))
    if (!runtime) {
      throw new Error('Session not found')
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
}
