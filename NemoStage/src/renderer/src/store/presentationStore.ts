import { create } from 'zustand'
import type { ExtractionResult, SlideData, SlidePreview } from '../types/presentation'

interface PresentationState {
  sessionId: string | null
  filePath: string | null
  fileName: string | null
  currentSlide: number
  totalSlides: number
  slides: SlidePreview[]
  slideData: Record<number, SlideData>
  doclingStatus: 'pending' | 'ready' | 'failed' | 'idle'
  fonts: string[]
  warnings: string[]
  setExtraction: (result: ExtractionResult) => void
  setSlideData: (index: number, slideData: SlideData) => void
  setDoclingStatus: (status: PresentationState['doclingStatus']) => void
  goToSlide: (index: number) => void
  nextSlide: () => void
  previousSlide: () => void
  reset: () => void
}

const initialState = {
  sessionId: null,
  filePath: null,
  fileName: null,
  currentSlide: 0,
  totalSlides: 0,
  slides: [],
  slideData: {},
  doclingStatus: 'idle' as const,
  fonts: [],
  warnings: []
}

export const usePresentationStore = create<PresentationState>((set) => ({
  ...initialState,
  setExtraction: (result) =>
    set({
      sessionId: result.sessionId,
      filePath: result.filePath,
      fileName: result.fileName,
      currentSlide: 0,
      totalSlides: result.slideCount,
      slides: result.slides,
      slideData: {},
      doclingStatus: result.doclingStatus,
      fonts: result.fonts,
      warnings: result.warnings
    }),
  setSlideData: (index, slideData) =>
    set((state) => ({
      slideData: {
        ...state.slideData,
        [index]: slideData
      }
    })),
  setDoclingStatus: (status) => set({ doclingStatus: status }),
  goToSlide: (index) =>
    set((state) => ({
      currentSlide: Math.max(0, Math.min(index, Math.max(state.totalSlides - 1, 0)))
    })),
  nextSlide: () =>
    set((state) => ({
      currentSlide: Math.min(state.currentSlide + 1, Math.max(state.totalSlides - 1, 0))
    })),
  previousSlide: () =>
    set((state) => ({
      currentSlide: Math.max(state.currentSlide - 1, 0)
    })),
  reset: () => set(initialState)
}))
