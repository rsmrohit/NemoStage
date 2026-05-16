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

export interface ImageCrop {
  left: number
  top: number
  right: number
  bottom: number
}

export interface DoclingElement {
  type: 'text' | 'image' | 'shape'
  bbox: {
    x: number
    y: number
    width: number
    height: number
  }
  content: string
  style?: {
    font?: string
    fontSize?: number
    color?: string
  }
  textRuns?: TextRun[]
  crop?: ImageCrop  // ← Add this
}

export interface TextRun {
  text: string
  font: string
  size: number
  bold?: boolean
  italic?: boolean
  color: string
}

export interface SlideData {
  slideIndex: number
  elements: DoclingElement[]
  speakerNotes?: string
  unmappedText?: string
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
