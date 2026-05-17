export type ExtractionPhase = 'idle' | 'extracting_images' | 'parsing_structure' | 'ready' | 'error'

export interface SlidePreview {
  slideIndex: number
  imagePaths: string[]
  thumbnailPath: string | null
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface DoclingElement {
  type: 'text' | 'image' | 'shape'
  bbox: BoundingBox
  content: string
  style?: {
    font?: string
    fontSize?: number
    color?: string
  }
}

export interface SlideData {
  slideIndex: number
  elements: DoclingElement[]
  speakerNotes?: string
}

export interface ExtractionResult {
  sessionId: string
  filePath: string
  fileName: string
  slideCount: number
  slides: SlidePreview[]
  doclingStatus: 'pending' | 'ready' | 'failed'
  fonts: string[]
  warnings: string[]
}

export interface SessionMetadata {
  sessionId: string
  fileName: string
  filePath: string
  createdAt: string
  lastAccessed: string
  slideCount: number
  currentSlide: number
}

export interface ExtractionProgressEvent {
  sessionId?: string
  phase: ExtractionPhase
  progress: number
  message: string
}

export interface TranscriptEvent {
  type: 'sync' | 'interim' | 'final' | 'error' | string
  text?: string
  full_transcript?: string
  timestamp?: string
  segment_index?: number
  source?: string
  speaker?: string | null
  session_id?: string
  error?: string
  transcript_file?: string
}

export interface TranscriptListenerStatus {
  listening: boolean
  directory: string
  filePath: string | null
}

export interface SandboxUploadResult {
  status: string
  filename: string
  sandbox_path: string
  container: string
  size_bytes: number
  deck_id?: string | null
  collection_name?: string | null
  vectorization_enabled?: boolean
  vectorization_status?: 'ready' | 'failed' | 'unavailable'
  chunks_indexed?: number
  vectorization_error?: string | null
  material_files_indexed?: number
  material_chunks_indexed?: number
  material_sandbox_dir?: string
}

export interface MaterialUploadResult {
  status: string
  presentation_filename: string
  sandbox_dir: string
  material_sandbox_dir: string
  material_files_indexed: number
  material_chunks_indexed: number
  errors?: string[]
  files: Array<{
    filename: string
    sandbox_path: string
    size_bytes: number
  }>
}

export interface EmbeddedFontEntry {
  name: string
  url: string
  boldUrl?: string
  italicUrl?: string
  boldItalicUrl?: string
}

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

export interface DashboardPoint {
  elapsedMs: number
  value: number
}

export interface DashboardMemberSeries {
  memberId: string
  averageEngagementScore: number
  points: DashboardPoint[]
  intervalPoints?: DashboardPoint[]
}

export interface DashboardInterval {
  intervalIndex: number
  slideLabel: string
  slideType: TimelineSlideType
  startMs: number
  endMs: number
  durationMs: number
  avgEngagement: number
  peakEngagement: number
  deltaFromPrevious: number
}

export interface ElectronAPI {
  selectPPTX: () => Promise<string | null>
  selectPresentationMaterials: () => Promise<string[]>
  getFileStats: (filePath: string) => Promise<{ size: number; mtimeMs: number } | null>
  uploadPPTXToSandbox: (filePath: string) => Promise<SandboxUploadResult>
  uploadPresentationMaterials: (
    presentationFilename: string,
    filePaths: string[]
  ) => Promise<MaterialUploadResult>
  extractPPTX: (filePath: string) => Promise<ExtractionResult>
  getSlideImage: (sessionId: string, slideIndex: number) => Promise<string | null>
  getSlideData: (sessionId: string, slideIndex: number) => Promise<SlideData>
  getSessionFonts: (sessionId: string) => Promise<EmbeddedFontEntry[]>
  getParseStatus: (sessionId: string) => Promise<{
    doclingStatus: 'pending' | 'ready' | 'failed'
    hasManifest: boolean
    googleFontNames: string[]
  }>
  downloadGoogleFonts: (sessionId: string) => Promise<EmbeddedFontEntry[]>
  getRecentSessions: () => Promise<SessionMetadata[]>
  resumeSession: (sessionId: string) => Promise<ExtractionResult>
  updateSessionState: (sessionId: string, currentSlide: number) => Promise<boolean>
  clearSession: (sessionId: string) => Promise<boolean>
  startTranscriptListener: () => Promise<TranscriptListenerStatus>
  stopTranscriptListener: () => Promise<TranscriptListenerStatus>
  startTimelineSession: (payload: {
    presentationId: string
    sessionId: string
    fileName: string
    startedAtMs: number
  }) => Promise<{ directory: string; filePath: string }>
  appendTimelineEntry: (entry: TimelineEntryInput) => Promise<{ filePath: string }>
  clearTimelineSession: (presentationId: string) => Promise<boolean>
  startEngagementAnalyzer: (payload: {
    presentationId: string
    sessionId: string
    timelineDir: string
  }) => Promise<{ status: 'idle' | 'running' | 'stopped' | 'error'; outputDir: string }>
  stopEngagementAnalyzer: (
    presentationId: string
  ) => Promise<{ status: 'idle' | 'running' | 'stopped' | 'error' }>
  getEngagementAnalyzerStatus: (
    presentationId: string
  ) => Promise<{ status: 'idle' | 'running' | 'stopped' | 'error'; errorMessage: string | null }>
  getDashboardPresentationData: (presentationId: string) => Promise<{
    meta: { presentationId: string; sessionId: string; fileName: string; startedAtMs: number }
    timeline: Array<{
      liveSlideIndex: number
      deckSlideIndex: number | null
      slideType: TimelineSlideType
      timestampMs: number
      elapsedMs: number
    }>
    averageSeries: DashboardPoint[]
    memberSeries: DashboardMemberSeries[]
    intervals: DashboardInterval[]
  }>
  listDashboardSessions: (fileName: string) => Promise<
    Array<{
      presentationId: string
      sessionId: string
      fileName: string
      startedAtMs: number
      pointCount: number
      averageEngagement: number | null
      sparkline: DashboardPoint[]
    }>
  >
  onExtractionProgress: (callback: (event: ExtractionProgressEvent) => void) => () => void
  onDoclingReady: (callback: (event: { sessionId: string; googleFontNames: string[] }) => void) => () => void
  onDoclingError: (callback: (event: { sessionId: string; message: string }) => void) => () => void
  onTranscriptUpdate: (callback: (event: TranscriptEvent) => void) => () => void
  onTranscriptStatus: (callback: (event: TranscriptListenerStatus) => void) => () => void
  onLog: (callback: (event: { sessionId: string; message: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
