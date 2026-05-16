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
