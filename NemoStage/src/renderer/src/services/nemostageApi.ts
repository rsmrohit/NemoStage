import type { SlideData, GeneratedSlide, QAEntry } from '../types/presentation'

export const NEMOSTAGE_BACKEND_URL = 'http://169.233.123.64:8000'
export const NEMOSTAGE_AUDIENCE_URL = `${NEMOSTAGE_BACKEND_URL}/audience`

export interface PresentationSlidePayload {
  slide_index: number
  title: string
  summary: string
  speaker_notes: string
}

export interface StartPresentationPayload {
  session_id: string
  file_name: string
  slide_count: number
  current_slide: number
  slides: PresentationSlidePayload[]
}

export interface TranscriptAgentResult {
  current_slide?: number | null
  coverage_status?: 'current_slide' | 'other_slide' | 'not_covered'
  matched_slide?: number | null
  summary_so_far?: string
  off_slide?: boolean
  off_slide_topic?: string | null
  topic?: string | null
  reason?: string
  raw?: string
}

export interface TranscriptAnalysisResponse {
  status: string
  presentation_id: string
  current_slide: number
  agent_result: TranscriptAgentResult
  coverage_status: 'current_slide' | 'other_slide' | 'not_covered' | 'unknown'
  slide_generation_needed: boolean
  vector_search?: {
    status: string
    collection_name?: string
    deck_id?: string
    best_distance?: number | null
    threshold?: number
    matches?: Array<{
      metadata: Record<string, unknown>
      distance: number
      strong_match: boolean
    }>
  }
}

export interface SandboxPresentation {
  filename: string
  size_bytes: number
  uploaded_at: string
  sandbox_path: string
}

export interface VectorizationFields {
  deck_id?: string | null
  collection_name?: string | null
  vectorization_enabled?: boolean
  vectorization_status?: 'ready' | 'failed' | 'unavailable'
  chunks_indexed?: number
  vectorization_error?: string | null
}

async function getJson<TResponse>(path: string): Promise<TResponse> {
  const response = await fetch(`${NEMOSTAGE_BACKEND_URL}${path}`)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `NemoStage backend request failed: ${response.status}`)
  }

  return response.json() as Promise<TResponse>
}

async function postJson<TResponse>(path: string, payload: unknown): Promise<TResponse> {
  const response = await fetch(`${NEMOSTAGE_BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `NemoStage backend request failed: ${response.status}`)
  }

  return response.json() as Promise<TResponse>
}

async function deleteJson<TResponse>(path: string): Promise<TResponse> {
  const response = await fetch(`${NEMOSTAGE_BACKEND_URL}${path}`, {
    method: 'DELETE'
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `NemoStage backend request failed: ${response.status}`)
  }

  return response.json() as Promise<TResponse>
}

export function startPresentation(payload: StartPresentationPayload): Promise<{
  status: string
  presentation_id: string
} & VectorizationFields> {
  return postJson('/presentation/start', payload)
}

export function updatePresentationSlide(
  presentationId: string,
  currentSlide: number
): Promise<{ status: string; presentation_id: string; current_slide: number }> {
  return postJson('/presentation/slide', {
    presentation_id: presentationId,
    current_slide: currentSlide
  })
}

export function sendPresentationTranscript(
  presentationId: string,
  transcript: string
): Promise<TranscriptAnalysisResponse> {
  return postJson('/presentation/transcript', {
    presentation_id: presentationId,
    transcript
  })
}

export function listSandboxPresentations(): Promise<{ presentations: SandboxPresentation[] }> {
  return getJson('/presentations')
}

export function deleteSandboxPresentation(filename: string): Promise<{
  status: string
  deleted: string
  sandbox_path: string
}> {
  return deleteJson(`/presentations/${encodeURIComponent(filename)}`)
}

export function getGeneratedSlides(presentationId: string): Promise<{ slides: GeneratedSlide[] }> {
  return getJson(`/presentation/${encodeURIComponent(presentationId)}/generated-slides`)
}

export function getRecentQA(after: number): Promise<{ qa: QAEntry[] }> {
  return getJson(`/audience/qa/recent?after=${after}`)
}

export function summarizeSlideData(slideIndex: number, data: SlideData | null): PresentationSlidePayload {
  if (!data) {
    return {
      slide_index: slideIndex,
      title: '',
      summary: '',
      speaker_notes: ''
    }
  }

  const text = data.elements
    .map((element) => element.content.trim())
    .filter(Boolean)
    .join('\n')

  return {
    slide_index: slideIndex,
    title: text.split('\n').find(Boolean)?.slice(0, 120) ?? '',
    summary: text,
    speaker_notes: data.speakerNotes ?? ''
  }
}
