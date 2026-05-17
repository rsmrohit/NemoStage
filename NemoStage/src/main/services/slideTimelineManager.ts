import path from 'path'
import fs from 'fs-extra'
import { WORKSPACE_DIR } from './workspaceManager'

export type TimelineSlideType = 'qr' | 'deck' | 'generated'

export interface TimelineEntryInput {
  presentationId: string
  sessionId: string
  fileName: string
  liveSlideIndex: number
  deckSlideIndex: number | null
  slideType: TimelineSlideType
  timestampMs: number
  elapsedMs: number
}

interface TimelineFile {
  presentationId: string
  sessionId: string
  fileName: string
  startedAtMs: number
  startedAtIso: string
  entries: TimelineEntryInput[]
}

interface TimelineRuntime {
  directory: string
  filePath: string
  file: TimelineFile
}

const timelineByPresentationId = new Map<string, TimelineRuntime>()

function encodeTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

export async function startTimelineSession(params: {
  presentationId: string
  sessionId: string
  fileName: string
  startedAtMs: number
}): Promise<{ directory: string; filePath: string }> {
  const startedAt = new Date(params.startedAtMs)
  const encodedTime = encodeTimestamp(startedAt)
  const timelineDir = path.join(WORKSPACE_DIR, `slide_timeline_${encodedTime}`)
  const filePath = path.join(timelineDir, 'timeline.json')

  const file: TimelineFile = {
    presentationId: params.presentationId,
    sessionId: params.sessionId,
    fileName: params.fileName,
    startedAtMs: params.startedAtMs,
    startedAtIso: startedAt.toISOString(),
    entries: []
  }

  await fs.ensureDir(timelineDir)
  await fs.writeJson(filePath, file, { spaces: 2 })

  timelineByPresentationId.set(params.presentationId, {
    directory: timelineDir,
    filePath,
    file
  })

  return { directory: timelineDir, filePath }
}

export async function appendTimelineEntry(entry: TimelineEntryInput): Promise<{ filePath: string }> {
  const runtime = timelineByPresentationId.get(entry.presentationId)
  if (!runtime) {
    throw new Error('Timeline session not started for this presentation.')
  }

  runtime.file.entries.push(entry)
  await fs.writeJson(runtime.filePath, runtime.file, { spaces: 2 })

  return { filePath: runtime.filePath }
}

export function clearTimelineSession(presentationId: string): void {
  timelineByPresentationId.delete(presentationId)
}
