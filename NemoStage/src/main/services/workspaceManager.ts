import { app } from 'electron'
import fs from 'fs-extra'
import path from 'path'
import { randomBytes } from 'crypto'
import type { SessionMetadata } from '../types'

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000

export const WORKSPACE_DIR = path.join(app.getPath('userData'), 'temp_presentation')

export function generateSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  const randomPart = randomBytes(4).toString('hex')
  return `${timestamp}-${randomPart}`
}

export async function initializeWorkspace(sessionId: string): Promise<string> {
  const sessionDir = path.join(WORKSPACE_DIR, sessionId)
  await fs.ensureDir(path.join(sessionDir, 'raw'))
  await fs.ensureDir(path.join(sessionDir, 'media'))
  return sessionDir
}

export async function cleanupOldSessions(): Promise<void> {
  await fs.ensureDir(WORKSPACE_DIR)
  const entries = await fs.readdir(WORKSPACE_DIR)
  const now = Date.now()

  await Promise.all(
    entries.map(async (entry) => {
      const sessionDir = path.join(WORKSPACE_DIR, entry)
      const stat = await fs.stat(sessionDir).catch(() => null)
      if (!stat?.isDirectory()) {
        return
      }

      const metadata = await readSessionMetadata(entry)
      const baseTime = metadata ? new Date(metadata.createdAt).getTime() : stat.mtimeMs
      if (Number.isNaN(baseTime)) {
        return
      }

      if (now - baseTime > MAX_SESSION_AGE_MS) {
        await fs.remove(sessionDir)
      }
    })
  )
}

function getMetadataPath(sessionId: string): string {
  return path.join(WORKSPACE_DIR, sessionId, 'metadata.json')
}

export async function writeSessionMetadata(metadata: SessionMetadata): Promise<void> {
  const metadataPath = getMetadataPath(metadata.sessionId)
  await fs.outputJson(metadataPath, metadata, { spaces: 2 })
}

export async function readSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  const metadataPath = getMetadataPath(sessionId)
  const exists = await fs.pathExists(metadataPath)
  if (!exists) {
    return null
  }
  return fs.readJson(metadataPath)
}

export async function listRecentSessions(limit = 5): Promise<SessionMetadata[]> {
  await fs.ensureDir(WORKSPACE_DIR)
  const entries = await fs.readdir(WORKSPACE_DIR)
  const sessionMetadata = await Promise.all(entries.map((entry) => readSessionMetadata(entry)))

  return sessionMetadata
    .filter((metadata): metadata is SessionMetadata => metadata !== null)
    .sort((a, b) => new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime())
    .slice(0, limit)
}

export async function touchSession(sessionId: string, currentSlide?: number): Promise<void> {
  const metadata = await readSessionMetadata(sessionId)
  if (!metadata) {
    return
  }

  const updated: SessionMetadata = {
    ...metadata,
    currentSlide: currentSlide ?? metadata.currentSlide,
    lastAccessed: new Date().toISOString()
  }
  await writeSessionMetadata(updated)
}

export async function clearSession(sessionId: string): Promise<void> {
  await fs.remove(path.join(WORKSPACE_DIR, sessionId))
}

export function getSessionDir(sessionId: string): string {
  return path.join(WORKSPACE_DIR, sessionId)
}
