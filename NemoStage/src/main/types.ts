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

// Add this to support the new XML parser format
export interface PptxManifest {
  slideCount: number
  slideWidth: number
  slideHeight: number
  slides: PptxSlide[]
}

export interface PptxSlide {
  slideIndex: number
  elements: PptxElement[]
  speakerNotes?: string
}

export interface PptxElement {
  type: 'text' | 'image' | 'shape'
  bbox: {
    x: number
    y: number
    width: number
    height: number
  }
  content?: string
  textRuns?: TextRun[]
  embedId?: string
}

export interface TextRun {
  text: string
  font: string
  size: number
  bold?: boolean
  italic?: boolean
  color: string
}

// Keep DoclingElement for renderer compatibility
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
  crop?: ImageCrop  
}

export interface SlideData {
  slideIndex: number
  elements: DoclingElement[]
  speakerNotes?: string
}

export interface DoclingManifest {
  schema_name: string
  version: string
  name: string
  origin: {
    mimetype: string
    binary_hash: number
    filename: string
  }
  body: DoclingNode
  furniture: DoclingNode
  groups: DoclingGroup[]
  texts?: DoclingText[]
  pictures?: DoclingPicture[]
  tables?: DoclingTable[]
  pages?: DoclingPage[]
}

export interface DoclingPage {
  page_no: number
  size?: {
    width: number
    height: number
  }
}

export interface DoclingNode {
  self_ref: string
  children: DoclingRef[]
  content_layer: string
  label?: string
  name?: string
}

export interface DoclingRef {
  $ref: string
}

export interface DoclingGroup {
  self_ref: string
  label: string  // "slide" for PowerPoint slides
  name: string
  children: DoclingRef[]
  parent?: DoclingRef
}

export interface DoclingText {
  self_ref: string
  label: string  // "paragraph", "title", "section_header"
  text: string
  prov?: DoclingProvenance[]
  parent?: DoclingRef
}

export interface DoclingPicture {
  self_ref: string
  label: string
  prov?: DoclingProvenance[]
  image?: {
    mimetype?: string
    uri?: string
  }
}

export interface DoclingTable {
  self_ref: string
  label: string
  prov?: DoclingProvenance[]
}

export interface DoclingProvenance {
  page_no: number
  bbox: DoclingBoundingBox
  charspan?: [number, number]
}

export interface DoclingBoundingBox {
  l: number  // left
  t: number  // top
  r: number  // right
  b: number  // bottom
  coord_origin: 'TOPLEFT' | 'BOTTOMLEFT'
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

export interface SessionRuntime {
  sessionId: string
  sessionDir: string
  manifestPath: string
  result: ExtractionResult
}

export interface SlideManifestEntry {
  slideIndex: number
  imagePaths: string[]
}


export interface PptxManifest {
  slideCount: number
  slideWidth: number   // In EMUs
  slideHeight: number  // In EMUs
  slides: PptxSlide[]
}

export interface PptxSlide {
  slideIndex: number
  elements: PptxElement[]
  speakerNotes?: string
}

export interface ImageCrop {
  left: number    // Percentage from left (0-100)
  top: number     // Percentage from top (0-100)
  right: number   // Percentage from right (0-100)
  bottom: number  // Percentage from bottom (0-100)
}

export interface PptxElement {
  type: 'text' | 'image' | 'shape'
  bbox: {
    x: number
    y: number
    width: number
    height: number
  }
  content?: string
  textRuns?: TextRun[]
  imagePath?: string
  crop?: ImageCrop
}

export interface TextRun {
  text: string
  font: string
  size: number
  bold?: boolean
  italic?: boolean
  color: string
}