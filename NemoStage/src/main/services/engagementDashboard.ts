import path from 'path'
import fs from 'fs-extra'
import { WORKSPACE_DIR } from './workspaceManager'

interface TimelineEntry {
  liveSlideIndex: number
  deckSlideIndex: number | null
  slideType: 'qr' | 'deck' | 'generated'
  timestampMs: number
  elapsedMs: number
}

interface TimelineFile {
  presentationId: string
  sessionId: string
  fileName: string
  startedAtMs: number
  entries: TimelineEntry[]
}

interface EngagementSamplePoint {
  elapsedMs: number
  value: number
}

interface MemberSeries {
  memberId: string
  averageEngagementScore: number
  points: EngagementSamplePoint[]
  intervalPoints?: EngagementSamplePoint[]
}

interface SlideIntervalBoundary {
  intervalIndex: number
  startMs: number
  endMs: number
  slideLabel: string
  slideType: 'qr' | 'deck' | 'generated'
}

function parseJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    return []
  }
  const content = fs.readFileSync(filePath, 'utf8')
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return {}
      }
    })
}

function loadTimeline(timelinePath: string): TimelineFile | null {
  if (!fs.existsSync(timelinePath)) return null
  try {
    return fs.readJsonSync(timelinePath) as TimelineFile
  } catch {
    return null
  }
}

function findTimelineByPresentationId(presentationId: string): { timelinePath: string; timeline: TimelineFile } | null {
  const entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('slide_timeline_')) continue
    const timelinePath = path.join(WORKSPACE_DIR, entry.name, 'timeline.json')
    const timeline = loadTimeline(timelinePath)
    if (timeline && timeline.presentationId === presentationId) {
      return { timelinePath, timeline }
    }
  }
  return null
}

function discoverEngagementFiles(engagementDir: string): {
  summaryFile: string | null
  memberDir: string | null
  intervalAverageFile: string | null
} {
  if (!fs.existsSync(engagementDir)) {
    return { summaryFile: null, memberDir: null, intervalAverageFile: null }
  }
  const files = fs.readdirSync(engagementDir)
  const summaryName = files.find((name) => /^engagement_summary_.*\.jsonl$/i.test(name)) ?? null
  const memberDirName = files.find((name) => /^audience_engagement_.*/i.test(name)) ?? null
  const intervalAverageName = files.find((name) => name === 'interval_average_engagement.json') ?? null
  return {
    summaryFile: summaryName ? path.join(engagementDir, summaryName) : null,
    memberDir: memberDirName ? path.join(engagementDir, memberDirName) : null,
    intervalAverageFile: intervalAverageName ? path.join(engagementDir, intervalAverageName) : null
  }
}

function loadAverageSeries(summaryFile: string | null): EngagementSamplePoint[] {
  if (!summaryFile) return []
  const raw = parseJsonLines(summaryFile)
    .map((row) => {
      const timestampMs = Number(row.timestamp_ms)
      const score = Number(row.engagement_score)
      if (!Number.isFinite(timestampMs) || !Number.isFinite(score)) return null
      return { elapsedMs: timestampMs, value: score }
    })
    .filter((row): row is EngagementSamplePoint => row !== null)
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
  return normalizeElapsedSeries(raw)
}

function loadMemberSeries(memberDir: string | null): MemberSeries[] {
  if (!memberDir || !fs.existsSync(memberDir)) return []
  const files = fs.readdirSync(memberDir).filter((name) => /^member\d+\.json$/i.test(name))
  return files
    .map((name) => {
      const memberPath = path.join(memberDir, name)
      try {
        const payload = fs.readJsonSync(memberPath) as {
          member_id: string
          average_engagement_score?: number
          records?: Array<{
            timestamp_ms?: number
            end_timestamp_ms?: number
            engagement_score?: number
          }>
        }
        const points = (payload.records ?? [])
          .map((record) => {
            const elapsedMsRaw = Number(
              record.end_timestamp_ms ?? record.timestamp_ms
            )
            const value = Number(record.engagement_score)
            if (!Number.isFinite(elapsedMsRaw) || !Number.isFinite(value)) return null
            return { elapsedMs: elapsedMsRaw, value }
          })
          .filter((point): point is EngagementSamplePoint => point !== null)
          .sort((a, b) => a.elapsedMs - b.elapsedMs)
        return {
          memberId: payload.member_id ?? name.replace('.json', ''),
          averageEngagementScore: Number(payload.average_engagement_score ?? 0),
          points: normalizeElapsedSeries(points)
        }
      } catch {
        return null
      }
    })
    .filter((row): row is MemberSeries => row !== null)
}

function normalizeElapsedSeries(points: EngagementSamplePoint[]): EngagementSamplePoint[] {
  if (points.length === 0) return []
  const sorted = [...points].sort((a, b) => a.elapsedMs - b.elapsedMs)
  const first = sorted[0].elapsedMs
  const looksEpoch = first > 10_000_000_000
  const base = looksEpoch ? first : 0
  return sorted.map((point) => ({
    elapsedMs: Math.max(0, point.elapsedMs - base),
    value: point.value
  }))
}

function buildAverageFromMembers(memberSeries: MemberSeries[]): EngagementSamplePoint[] {
  const bucket = new Map<number, number[]>()
  for (const member of memberSeries) {
    for (const point of member.points) {
      const key = Math.floor(point.elapsedMs / 1000) * 1000
      const list = bucket.get(key) ?? []
      list.push(point.value)
      bucket.set(key, list)
    }
  }
  return Array.from(bucket.entries())
    .map(([elapsedMs, values]) => ({
      elapsedMs,
      value: values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1)
    }))
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
}

function buildSlideIntervals(timeline: TimelineFile, maxElapsed: number): SlideIntervalBoundary[] {
  const boundaries = [...timeline.entries].sort((a, b) => a.elapsedMs - b.elapsedMs)
  if (boundaries.length === 0) return []
  const intervals: SlideIntervalBoundary[] = []
  for (let i = 0; i < boundaries.length; i++) {
    const startMs = boundaries[i].elapsedMs
    const nextBoundary = i < boundaries.length - 1 ? boundaries[i + 1].elapsedMs : maxElapsed
    const endMs = Math.max(startMs, nextBoundary)
    intervals.push({
      intervalIndex: i,
      startMs,
      endMs,
      slideLabel: `#${boundaries[i].liveSlideIndex + 1} (${boundaries[i].slideType})`,
      slideType: boundaries[i].slideType
    })
  }
  return intervals
}

function pointsInInterval(
  points: EngagementSamplePoint[],
  startMs: number,
  endMs: number,
  isLast: boolean
): EngagementSamplePoint[] {
  return points.filter((point) =>
    isLast
      ? point.elapsedMs >= startMs && point.elapsedMs <= endMs
      : point.elapsedMs >= startMs && point.elapsedMs < endMs
  )
}

function computeIntervals(
  slideIntervals: SlideIntervalBoundary[],
  averageSeries: EngagementSamplePoint[],
  intervalAverageOverride: {
    byIndex: Map<number, number>
    byRange: Map<string, number>
  }
): Array<Record<string, unknown>> {
  if (slideIntervals.length === 0) return []
  const intervals: Array<Record<string, unknown>> = []
  for (let i = 0; i < slideIntervals.length; i++) {
    const interval = slideIntervals[i]
    const points = pointsInInterval(averageSeries, interval.startMs, interval.endMs, i === slideIntervals.length - 1)
    const computedAvg = points.length > 0 ? points.reduce((sum, p) => sum + p.value, 0) / points.length : 0
    const rangeKey = `${interval.startMs}:${interval.endMs}`
    const avg =
      intervalAverageOverride.byIndex.get(interval.intervalIndex) ??
      intervalAverageOverride.byRange.get(rangeKey) ??
      computedAvg
    const peak = points.length > 0 ? Math.max(...points.map((p) => p.value)) : avg
    intervals.push({
      intervalIndex: interval.intervalIndex,
      slideLabel: interval.slideLabel,
      slideType: interval.slideType,
      startMs: interval.startMs,
      endMs: interval.endMs,
      durationMs: interval.endMs - interval.startMs,
      avgEngagement: avg,
      peakEngagement: peak
    })
  }

  for (let i = 0; i < intervals.length; i++) {
    const current = intervals[i]
    const prev = i > 0 ? intervals[i - 1] : null
    const prevAvg = prev ? Number(prev.avgEngagement) : Number(current.avgEngagement)
    current.deltaFromPrevious = Number(current.avgEngagement) - prevAvg
  }
  return intervals
}

function loadIntervalAverageOverrideFlexible(filePath: string | null): {
  byIndex: Map<number, number>
  byRange: Map<string, number>
} {
  if (!filePath || !fs.existsSync(filePath)) {
    return { byIndex: new Map(), byRange: new Map() }
  }
  try {
    const payload = fs.readJsonSync(filePath) as {
      intervals?: Array<{
        intervalIndex?: number
        averageEngagement?: number
        startMs?: number
        endMs?: number
      }>
    }
    const byIndex = new Map<number, number>()
    const byRange = new Map<string, number>()
    for (const interval of payload.intervals ?? []) {
      const avg = Number(interval.averageEngagement)
      if (!Number.isFinite(avg)) continue
      const index = Number(interval.intervalIndex)
      if (Number.isFinite(index)) byIndex.set(index, avg)
      const start = Number(interval.startMs)
      const end = Number(interval.endMs)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        byRange.set(`${start}:${end}`, avg)
      }
    }
    return { byIndex, byRange }
  } catch {
    return { byIndex: new Map(), byRange: new Map() }
  }
}

export function getPresentationDashboardData(presentationId: string): Record<string, unknown> {
  const found = findTimelineByPresentationId(presentationId)
  if (!found) {
    throw new Error('Timeline not found for presentation.')
  }

  const timelineDir = path.dirname(found.timelinePath)
  const engagementDir = path.join(timelineDir, 'engagement')
  const discovered = discoverEngagementFiles(engagementDir)
  const memberSeries = loadMemberSeries(discovered.memberDir)
  let averageSeries = loadAverageSeries(discovered.summaryFile)
  if (averageSeries.length < 3 && memberSeries.length > 0) {
    averageSeries = buildAverageFromMembers(memberSeries)
  }
  const maxElapsed = Math.max(
    averageSeries[averageSeries.length - 1]?.elapsedMs ?? 0,
    found.timeline.entries[found.timeline.entries.length - 1]?.elapsedMs ?? 0
  )
  const slideIntervals = buildSlideIntervals(found.timeline, maxElapsed)
  const intervalAverageOverride = loadIntervalAverageOverrideFlexible(discovered.intervalAverageFile)
  const intervals = computeIntervals(slideIntervals, averageSeries, intervalAverageOverride)
  const memberSeriesWithIntervals = memberSeries.map((member) => ({
    ...member,
    intervalPoints: slideIntervals.map((interval, index) => {
      const points = pointsInInterval(
        member.points,
        interval.startMs,
        interval.endMs,
        index === slideIntervals.length - 1
      )
      const value = points.length > 0 ? points.reduce((sum, p) => sum + p.value, 0) / points.length : 0
      return { elapsedMs: interval.startMs, value }
    })
  }))
  const timelineMs = found.timeline.entries[found.timeline.entries.length - 1]?.elapsedMs ?? 0
  const engagementMs = averageSeries[averageSeries.length - 1]?.elapsedMs ?? 0
  const coverageRatio = timelineMs > 0 ? Math.max(0, Math.min(1, engagementMs / timelineMs)) : 0

  return {
    meta: {
      presentationId: found.timeline.presentationId,
      sessionId: found.timeline.sessionId,
      fileName: found.timeline.fileName,
      startedAtMs: found.timeline.startedAtMs
    },
    timeline: found.timeline.entries,
    averageSeries,
    memberSeries: memberSeriesWithIntervals,
    intervals,
    coverage: {
      timelineMs,
      engagementMs,
      ratio: coverageRatio
    }
  }
}

export function listPresentationDashboardSessions(fileName: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(WORKSPACE_DIR)) return []
  const results: Array<Record<string, unknown>> = []
  const entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('slide_timeline_')) continue
    const timelinePath = path.join(WORKSPACE_DIR, entry.name, 'timeline.json')
    const timeline = loadTimeline(timelinePath)
    if (!timeline || timeline.fileName !== fileName) continue
    const engagementDir = path.join(path.dirname(timelinePath), 'engagement')
    const discovered = discoverEngagementFiles(engagementDir)
    const averageSeries = loadAverageSeries(discovered.summaryFile)
    const avg =
      averageSeries.length > 0
        ? averageSeries.reduce((sum, point) => sum + point.value, 0) / averageSeries.length
        : null
    results.push({
      presentationId: timeline.presentationId,
      sessionId: timeline.sessionId,
      fileName: timeline.fileName,
      startedAtMs: timeline.startedAtMs,
      pointCount: averageSeries.length,
      averageEngagement: avg,
      sparkline: averageSeries.slice(-40)
    })
  }
  return results.sort((a, b) => Number(b.startedAtMs) - Number(a.startedAtMs))
}
