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

export interface SandboxUploadResult {
  status: string
  filename: string
  sandbox_path: string
  container: string
  size_bytes: number
}

export interface ElectronAPI {
  selectPPTX: () => Promise<string | null>
  getFileStats: (filePath: string) => Promise<{ size: number; mtimeMs: number } | null>
  uploadPPTXToSandbox: (filePath: string) => Promise<SandboxUploadResult>
  extractPPTX: (filePath: string) => Promise<ExtractionResult>
  getSlideImage: (sessionId: string, slideIndex: number) => Promise<string | null>
  getSlideData: (sessionId: string, slideIndex: number) => Promise<SlideData>
  getParseStatus: (sessionId: string) => Promise<{
    doclingStatus: 'pending' | 'ready' | 'failed'
    hasManifest: boolean
  }>
  getRecentSessions: () => Promise<SessionMetadata[]>
  resumeSession: (sessionId: string) => Promise<ExtractionResult>
  updateSessionState: (sessionId: string, currentSlide: number) => Promise<boolean>
  clearSession: (sessionId: string) => Promise<boolean>
  onExtractionProgress: (callback: (event: ExtractionProgressEvent) => void) => () => void
  onDoclingReady: (callback: (event: { sessionId: string }) => void) => () => void
  onDoclingError: (callback: (event: { sessionId: string; message: string }) => void) => () => void
  onLog: (callback: (event: { sessionId: string; message: string }) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
