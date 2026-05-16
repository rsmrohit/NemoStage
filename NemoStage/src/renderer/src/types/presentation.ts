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

export interface TableCell {
  textRuns: TextRun[]
  content: string
  fillColor?: string
  colSpan?: number
  rowSpan?: number
  isContinuation?: boolean
}

export interface TableRow {
  cells: TableCell[]
  height: number
}

export interface DoclingElement {
  type: 'text' | 'image' | 'shape' | 'table'
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
  crop?: ImageCrop
  fillColor?: string
  rotation?: number
  verticalAnchor?: 't' | 'ctr' | 'b'
  shapeGeom?: string
  textBoxStyle?: {
    insL?: number; insR?: number; insT?: number; insB?: number
    wrapNone?: boolean
  }
  tableRows?: TableRow[]
  colWidths?: number[]
}

export interface TextRun {
  text: string
  font: string
  size: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  baseline?: number
  color: string
  paragraphAlign?: 'l' | 'ctr' | 'r' | 'just'
  lineHeight?: number
}

export interface SlideData {
  slideIndex: number
  elements: DoclingElement[]
  speakerNotes?: string
  background?: string
  slideWidth?: number
  slideHeight?: number
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
