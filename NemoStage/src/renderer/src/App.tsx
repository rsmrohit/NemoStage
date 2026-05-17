import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FileSelector } from './components/FileSelector'
import { NavigationControls } from './components/NavigationControls'
import { SlideCanvas } from './components/SlideCanvas'
import { SlideGallery } from './components/SlideGallery'
import { AudienceQrSlide } from './components/AudienceQrSlide'
import { GeneratedSlideCard } from './components/GeneratedSlideCard'
import { QAOverlay } from './components/QAOverlay'
import { EngagementDashboard } from './components/EngagementDashboard'
import {
  NEMOSTAGE_AUDIENCE_URL,
  deleteSandboxPresentation,
  getGeneratedSlides,
  getRecentQA,
  listSandboxPresentations,
  sendPresentationTranscript,
  startPresentation,
  summarizeSlideData,
  updatePresentationSlide
} from './services/nemostageApi'
import type { VectorizationFields } from './services/nemostageApi'
import { usePresentationStore } from './store/presentationStore'
import type { ExtractionPhase, GeneratedSlide, QAEntry, SessionMetadata, SlideData } from './types/presentation'
import { useFonts } from './hooks/useFonts'
import { LobsterBackground } from './components/LobsterBackground'
import { DotGrid } from './components/DotGrid'

type AppMode = 'select' | 'gallery' | 'live'
type LiveAgentStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'analyzing'
  | 'on-slide'
  | 'covered-elsewhere'
  | 'slide-generation-needed'
  | 'error'

interface TranscriptFileEvent {
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
  intent?: boolean
}

type LiveSlot = { type: 'qr' } | { type: 'deck'; deckIndex: number } | { type: 'generated'; slide: GeneratedSlide }
type AnalyzerStatus = 'idle' | 'running' | 'stopped' | 'error'

interface DashboardSessionSummary {
  presentationId: string
  sessionId: string
  fileName: string
  startedAtMs: number
  pointCount: number
  averageEngagement: number | null
  sparkline: Array<{ elapsedMs: number; value: number }>
}

interface DashboardData {
  meta: { presentationId: string; sessionId: string; fileName: string; startedAtMs: number }
  timeline: Array<{
    liveSlideIndex: number
    deckSlideIndex: number | null
    slideType: 'qr' | 'deck' | 'generated'
    timestampMs: number
    elapsedMs: number
  }>
  averageSeries: Array<{ elapsedMs: number; value: number }>
  memberSeries: Array<{
    memberId: string
    averageEngagementScore: number
    points: Array<{ elapsedMs: number; value: number }>
    intervalPoints?: Array<{ elapsedMs: number; value: number }>
  }>
  intervals: Array<{
    intervalIndex: number
    slideLabel: string
    slideType: 'qr' | 'deck' | 'generated'
    startMs: number
    endMs: number
    durationMs: number
    avgEngagement: number
    peakEngagement: number
    deltaFromPrevious: number
  }>
  coverage?: {
    timelineMs: number
    engagementMs: number
    ratio: number
  }
}

function getTranscriptEventKey(event: TranscriptFileEvent): string {
  return [
    event.transcript_file ?? '',
    event.session_id ?? '',
    event.segment_index ?? '',
    event.timestamp ?? '',
    event.type ?? '',
    event.text ?? event.error ?? ''
  ].join('|')
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected error'
}

function AppContent(): React.JSX.Element {
  const {
    sessionId,
    fileName,
    currentSlide,
    totalSlides,
    slides,
    slideData,
    doclingStatus,
    warnings,
    setExtraction,
    setSlideData,
    setDoclingStatus,
    goToSlide,
    reset
  } = usePresentationStore()

  const [mode, setMode] = useState<AppMode>('select')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const [liveSidebarWidth, setLiveSidebarWidth] = useState(130)
  const [agentPanelWidth, setAgentPanelWidth] = useState(260)
  const [isSlideFullscreen, setIsSlideFullscreen] = useState(false)
  const isSlideFullscreenRef = useRef(false)
  const slideContainerRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef<string | null>(sessionId)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  const [statusMessage, setStatusMessage] = useState('')
  const [extractionPhase, setExtractionPhase] = useState<ExtractionPhase>('idle')
  const [googleFontNames, setGoogleFontNames] = useState<string[]>([])
  const [fontDownloadState, setFontDownloadState] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle')
  const { fontsVersion, loadFonts, clearFonts } = useFonts()
  const [progress, setProgress] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recentSessions, setRecentSessions] = useState<SessionMetadata[]>([])
  const [presentationId, setPresentationId] = useState<string | null>(null)
  const [dashboardSessions, setDashboardSessions] = useState<DashboardSessionSummary[]>([])
  const [selectedDashboardSessionKey, setSelectedDashboardSessionKey] = useState<string | null>(null)
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null)
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([])
  const [analyzerStatus, setAnalyzerStatus] = useState<AnalyzerStatus>('idle')
  const [analyzerErrorMessage, setAnalyzerErrorMessage] = useState<string | null>(null)
  const [liveAgentStatus, setLiveAgentStatus] = useState<LiveAgentStatus>('idle')
  const [liveAgentMessage, setLiveAgentMessage] = useState('No transcript analyzed yet.')
  const [slideGenerationNeeded, setSlideGenerationNeeded] = useState(false)
  const [vectorizationInfo, setVectorizationInfo] = useState<VectorizationFields | null>(null)
  const [liveSlideIndex, setLiveSlideIndex] = useState(0)
  const [recording, setRecording] = useState(false)
  const [transcriptDirectory, setTranscriptDirectory] = useState('')
  const [transcriptFile, setTranscriptFile] = useState<string | null>(null)
  const [manualTranscript, setManualTranscript] = useState('')
  const [latestTranscriptEvent, setLatestTranscriptEvent] = useState<TranscriptFileEvent | null>(
    null
  )
  const [, setTranscriptBuffer] = useState<string[]>([])
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const BATCH_INTERVAL_MS = 20000 // 20 seconds
  const presentationIdRef = useRef<string | null>(null)
  const processedTranscriptEventRef = useRef<string | null>(null)
  const recordingStartTimeRef = useRef<number>(0)
  const liveTimelineStartTimeRef = useRef<number>(0)
  const timelineReadyRef = useRef(false)
  const timelineDirRef = useRef<string | null>(null)
  const previousModeRef = useRef<AppMode>('select')
  const [injectedSlides, setInjectedSlides] = useState<GeneratedSlide[]>([])
  const slideGenPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [activeQA, setActiveQA] = useState<QAEntry | null>(null)
  const [latestQA, setLatestQA] = useState<QAEntry | null>(null)
  const [publicQADisplayEnabled, setPublicQADisplayEnabled] = useState(() => {
    return window.localStorage.getItem('nemostage.publicQADisplayEnabled') === 'true'
  })
  const getDashboardSessionKey = useCallback(
    (session: Pick<DashboardSessionSummary, 'sessionId' | 'startedAtMs'>): string =>
      `${session.sessionId}:${session.startedAtMs}`,
    []
  )
  const publicQADisplayEnabledRef = useRef(publicQADisplayEnabled)
  const qaLastPollTsRef = useRef<number>(0)
  const qaPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const currentSlideImage = slides[currentSlide]?.imagePaths[0] ?? null

  // Build the merged live slide sequence: [QR(0), deck slide 1, ...injected after N..., deck slide 2, ...]
  const liveMergedSlides = useMemo(() => {
    const slots: LiveSlot[] = [{ type: 'qr' }]
    for (let i = 0; i < totalSlides; i++) {
      slots.push({ type: 'deck', deckIndex: i })
      const injected = injectedSlides.filter((s) => s.after_slide === i)
      for (const s of injected) slots.push({ type: 'generated', slide: s })
    }
    return slots
  }, [totalSlides, injectedSlides])

  const liveTotalSlides = liveMergedSlides.length
  const currentLiveSlot = liveMergedSlides[liveSlideIndex] ?? { type: 'qr' }
  const isAudienceQrSlide = currentLiveSlot.type === 'qr'
  const isGeneratedSlide = currentLiveSlot.type === 'generated'
  const currentGeneratedSlide = isGeneratedSlide ? (currentLiveSlot as { type: 'generated'; slide: GeneratedSlide }).slide : null
  const liveDeckSlideIndex = currentLiveSlot.type === 'deck' ? (currentLiveSlot as { type: 'deck'; deckIndex: number }).deckIndex : 0
  const liveSlideImage = (isAudienceQrSlide || isGeneratedSlide) ? null : (slides[liveDeckSlideIndex]?.imagePaths[0] ?? null)
  const liveSlideData = (isAudienceQrSlide || isGeneratedSlide) ? null : (slideData[liveDeckSlideIndex] ?? null)

  const appendTimelineEntry = useCallback(
    (slot: LiveSlot, nextLiveSlideIndex: number): void => {
      if (!timelineReadyRef.current || !presentationIdRef.current || !sessionId || !fileName) {
        return
      }

      const now = Date.now()
      const elapsedMs = Math.max(0, now - liveTimelineStartTimeRef.current)
      const deckSlideIndex = slot.type === 'deck' ? slot.deckIndex : null

      void window.electronAPI
        .appendTimelineEntry({
          presentationId: presentationIdRef.current,
          sessionId,
          fileName,
          liveSlideIndex: nextLiveSlideIndex,
          deckSlideIndex,
          slideType: slot.type,
          timestampMs: now,
          elapsedMs
        })
        .catch((error) => {
          setStatusMessage(`Timeline write failed: ${getErrorMessage(error)}`)
        })
    },
    [fileName, sessionId]
  )

  useEffect(() => {
    presentationIdRef.current = presentationId
  }, [presentationId])

  useEffect(() => {
    publicQADisplayEnabledRef.current = publicQADisplayEnabled
    window.localStorage.setItem(
      'nemostage.publicQADisplayEnabled',
      publicQADisplayEnabled ? 'true' : 'false'
    )
    if (!publicQADisplayEnabled) {
      setActiveQA(null)
      return
    }
    if (latestQA) {
      setActiveQA(latestQA)
    }
  }, [publicQADisplayEnabled, latestQA])

  // Q&A polling — active only in live mode; also cleans up slide-gen poll on mode exit
  useEffect(() => {
    if (mode !== 'live') {
      if (qaPollRef.current) clearInterval(qaPollRef.current)
      if (slideGenPollRef.current) clearInterval(slideGenPollRef.current)
      return
    }
    qaPollRef.current = setInterval(async () => {
      try {
        const { qa } = await getRecentQA(qaLastPollTsRef.current)
        if (qa.length > 0) {
          const latest = qa[qa.length - 1]
          setLatestQA(latest)
          if (publicQADisplayEnabledRef.current) {
            setActiveQA(latest)
          }
          qaLastPollTsRef.current = latest.ts
        }
      } catch {
        // silently ignore poll failures
      }
    }, 4000)
    return () => { if (qaPollRef.current) clearInterval(qaPollRef.current) }
  }, [mode])

  const loadRecentSessions = async (): Promise<void> => {
    try {
      const [sessions, sandbox] = await Promise.all([
        window.electronAPI.getRecentSessions(),
        listSandboxPresentations()
      ])
      const sandboxFilenames = new Set(
        sandbox.presentations.map((presentation) => presentation.filename)
      )
      // sessions is sorted by lastAccessed desc; keep only the most recent session per filename
      const seen = new Set<string>()
      const deduplicated = sessions.filter((session) => {
        if (!sandboxFilenames.has(session.fileName)) return false
        if (seen.has(session.fileName)) return false
        seen.add(session.fileName)
        return true
      })
      setRecentSessions(deduplicated)
    } catch (error) {
      setRecentSessions([])
      setStatusMessage(`Sandbox presentations unavailable: ${getErrorMessage(error)}`)
    }
  }

  const loadDashboardSessions = useCallback(async (): Promise<void> => {
    if (!fileName) {
      setDashboardSessions([])
      return
    }
    try {
      const sessions = await window.electronAPI.listDashboardSessions(fileName)
      setDashboardSessions(sessions as DashboardSessionSummary[])
      if (sessions.length > 0 && !selectedDashboardSessionKey) {
        setSelectedDashboardSessionKey(getDashboardSessionKey(sessions[0]))
      }
    } catch (error) {
      setStatusMessage(`Dashboard sessions unavailable: ${getErrorMessage(error)}`)
      setDashboardSessions([])
    }
  }, [fileName, getDashboardSessionKey, selectedDashboardSessionKey])

  const loadDashboardData = useCallback(
    async (sessionSelection: { sessionId: string; startedAtMs: number }): Promise<void> => {
    try {
      const data = await window.electronAPI.getDashboardSessionData(sessionSelection)
      setDashboardData(data as DashboardData)
      setSelectedMemberIds([])
    } catch (error) {
      setStatusMessage(`Dashboard data unavailable: ${getErrorMessage(error)}`)
      setDashboardData(null)
    }
    },
    []
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecentSessions()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    void loadDashboardSessions()
  }, [loadDashboardSessions])

  useEffect(() => {
    if (!selectedDashboardSessionKey) {
      setDashboardData(null)
      return
    }
    const selected = dashboardSessions.find(
      (session) => getDashboardSessionKey(session) === selectedDashboardSessionKey
    )
    if (!selected) {
      setDashboardData(null)
      return
    }
    void loadDashboardData({ sessionId: selected.sessionId, startedAtMs: selected.startedAtMs })
  }, [dashboardSessions, getDashboardSessionKey, loadDashboardData, selectedDashboardSessionKey])

  useEffect(() => {
    const unsubscribeProgress = window.electronAPI.onExtractionProgress((event) => {
      setExtractionPhase(event.phase)
      setProgress(event.progress)
      setStatusMessage(event.message)
    })

    const unsubscribeDoclingReady = window.electronAPI.onDoclingReady(
      async ({ sessionId: readySessionId, googleFontNames: gfNames }) => {
        const currentSessionId = sessionIdRef.current
        console.log(`[fonts] onDoclingReady: readySessionId=${readySessionId} currentSessionId=${currentSessionId} match=${readySessionId === currentSessionId}`)
        if (readySessionId !== currentSessionId) {
          return
        }

        setDoclingStatus('ready')
        if (gfNames.length > 0) {
          setGoogleFontNames(gfNames)
          setFontDownloadState('idle')
        }
        console.log('[fonts] onDoclingReady fired for session', readySessionId, '— fetching slide data + fonts')
        const [data, fonts] = await Promise.all([
          window.electronAPI.getSlideData(readySessionId, currentSlide),
          window.electronAPI.getSessionFonts(readySessionId)
        ])
        console.log('[fonts] getSessionFonts returned', fonts.length, 'fonts from IPC')
        setSlideData(currentSlide, data)
        void loadFonts(fonts, 'truetype')
        setStatusMessage('Structured slide data is ready.')
        setProgress(1)
        setExtractionPhase('ready')
      }
    )

    const unsubscribeDoclingError = window.electronAPI.onDoclingError(
      ({ sessionId: failedSessionId, message }) => {
        if (failedSessionId !== sessionId) {
          return
        }
        setDoclingStatus('failed')
        setStatusMessage(`Docling unavailable: ${message}`)
        setProgress(1)
        setExtractionPhase('ready')
      }
    )

    const unsubscribeLog = window.electronAPI.onLog(({ sessionId: logSessionId, message }) => {
      if (logSessionId !== sessionId) {
        return
      }
      console.log(message)
    })

    return () => {
      unsubscribeProgress()
      unsubscribeDoclingReady()
      unsubscribeDoclingError()
      unsubscribeLog()
    }
  }, [currentSlide, sessionId, setDoclingStatus, setSlideData])

  useEffect(() => {
    if (!sessionId) {
      return
    }

    void window.electronAPI.updateSessionState(sessionId, currentSlide)
  }, [sessionId, currentSlide])

  useEffect(() => {
    const slidesToPreload = [currentSlide, currentSlide + 1, currentSlide + 2]
    slidesToPreload.forEach((slideIndex) => {
      const imagePath = slides[slideIndex]?.imagePaths[0]
      if (!imagePath) {
        return
      }
      const preloader = new Image()
      preloader.src = imagePath
    })
  }, [currentSlide, slides])

  const goToLiveSlide = useCallback((index: number): void => {
    const boundedIndex = Math.max(0, Math.min(index, Math.max(liveTotalSlides - 1, 0)))
    if (boundedIndex === liveSlideIndex) {
      return
    }
    setLiveSlideIndex(boundedIndex)

    const slot = liveMergedSlides[boundedIndex]
    if (slot?.type === 'deck') {
      goToSlide(slot.deckIndex)
    } else if (slot?.type === 'generated') {
      goToSlide(slot.slide.after_slide)
    }
    if (slot) {
      appendTimelineEntry(slot, boundedIndex)
    }
  }, [appendTimelineEntry, goToSlide, liveMergedSlides, liveSlideIndex, liveTotalSlides])

  const nextLiveSlide = useCallback((): void => {
    goToLiveSlide(liveSlideIndex + 1)
  }, [goToLiveSlide, liveSlideIndex])

  const previousLiveSlide = useCallback((): void => {
    goToLiveSlide(liveSlideIndex - 1)
  }, [goToLiveSlide, liveSlideIndex])

  const stopAnalyzerIfRunning = useCallback(async (): Promise<void> => {
    const activePresentationId = presentationIdRef.current
    if (!activePresentationId) {
      return
    }
    try {
      const result = await window.electronAPI.stopEngagementAnalyzer(activePresentationId)
      setAnalyzerStatus(result.status)
      setAnalyzerErrorMessage(null)
    } catch (error) {
      setStatusMessage(`Analyzer stop failed: ${getErrorMessage(error)}`)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'live') {
      return
    }

    const handleKeyPress = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') {
        nextLiveSlide()
      }
      if (event.key === 'ArrowLeft') {
        previousLiveSlide()
      }
      if (event.key === 'Escape') {
        if (isSlideFullscreenRef.current) return
        setMode('gallery')
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [mode, nextLiveSlide, previousLiveSlide])

  useEffect(() => {
    if (!sessionId) {
      return
    }

    if (doclingStatus === 'ready') {
      void window.electronAPI.getSlideData(sessionId, currentSlide).then((data) => {
        setSlideData(currentSlide, data)
      })
    }
  }, [currentSlide, sessionId, doclingStatus, setSlideData])

  useEffect(() => {
    if (!sessionId || doclingStatus !== 'pending') {
      return
    }

    let cancelled = false
    const timer = window.setInterval(() => {
      void window.electronAPI
        .getParseStatus(sessionId)
        .then(async (status) => {
          if (cancelled || status.doclingStatus === 'pending') {
            return
          }

          setDoclingStatus(status.doclingStatus)
          if (status.doclingStatus === 'ready') {
            // Set google font names NOW, before the await — cancelled becomes true
            // during the await when React re-renders on setDoclingStatus
            if (status.googleFontNames.length > 0) {
              setGoogleFontNames(status.googleFontNames)
              setFontDownloadState('idle')
            }
            console.log('[fonts] polling path: parse ready — fetching slide data + fonts')
            const [data, fonts] = await Promise.all([
              window.electronAPI.getSlideData(sessionId, currentSlide),
              window.electronAPI.getSessionFonts(sessionId)
            ])
            console.log('[fonts] polling path: getSessionFonts returned', fonts.length, 'fonts')
            if (!cancelled) {
              setSlideData(currentSlide, data)
              void loadFonts(fonts, 'truetype')
              setStatusMessage('Structured slide data is ready.')
            }
          } else {
            setStatusMessage('Structured slide parsing failed.')
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setStatusMessage(`Parse status unavailable: ${getErrorMessage(error)}`)
          }
        })
    }, 750)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [currentSlide, doclingStatus, sessionId, setDoclingStatus, setSlideData])

  useEffect(() => {
    const previousMode = previousModeRef.current
    if (previousMode === 'live' && mode !== 'live') {
      void stopAnalyzerIfRunning()
      timelineReadyRef.current = false
      void loadDashboardSessions()
    }
    previousModeRef.current = mode
  }, [loadDashboardSessions, mode, stopAnalyzerIfRunning])

  useEffect(() => {
    if (mode !== 'live' || !presentationId) {
      return
    }
    const timer = window.setInterval(() => {
      void window.electronAPI.getEngagementAnalyzerStatus(presentationId).then((status) => {
        setAnalyzerStatus(status.status)
        setAnalyzerErrorMessage(status.errorMessage)
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [mode, presentationId])

  useEffect(() => {
    if (mode !== 'live' || !presentationId) {
      return
    }

    let cancelled = false
    void updatePresentationSlide(presentationId, currentSlide).catch((error) => {
      if (cancelled) {
        return
      }
      setLiveAgentStatus('error')
      setLiveAgentMessage(`Slide sync failed: ${getErrorMessage(error)}`)
    })

    return () => {
      cancelled = true
    }
  }, [currentSlide, mode, presentationId])

  const flushTranscriptBuffer = useCallback(async (): Promise<void> => {
    const activePresentationId = presentationIdRef.current
    if (!activePresentationId) {
      setLiveAgentStatus('error')
      setLiveAgentMessage('Start the live presentation before recording transcript updates.')
      return
    }

    // Get all buffered text and clear the buffer
    setTranscriptBuffer((currentBuffer) => {
      if (currentBuffer.length === 0) {
        return currentBuffer
      }

      const combinedTranscript = currentBuffer.join(' ').trim()
      if (!combinedTranscript) {
        return []
      }
      

      console.log(`[transcript] Sending ${currentBuffer.length} segment(s) — "${combinedTranscript}"`)

      // Send the combined chunk
      setLiveAgentStatus('analyzing')
      setLiveAgentMessage('Analyzing transcript against current slide...')

      sendPresentationTranscript(activePresentationId, combinedTranscript)
        .then((result) => {
          if ((result as unknown as Record<string, unknown>).noop === true) {
            setLiveAgentStatus('ready')
            setLiveAgentMessage('Waiting for transcript speech...')
            return
          }

          if (result.coverage_status === 'not_relevant') {
            const dist = result.vector_search?.best_distance
            console.log(`[transcript] chunk not relevant to presentation (best_distance=${dist?.toFixed(3) ?? 'N/A'}) — skipping update`)
            return
          }

          const agentSummary = result.agent_result.summary_so_far ?? ''
          const missingTopic = result.agent_result.topic ?? result.agent_result.off_slide_topic
          const matchedSlide = result.agent_result.matched_slide
          const generationQueued = (result as unknown as Record<string, unknown>).generation_queued === true

          setSlideGenerationNeeded(result.slide_generation_needed)

          if (generationQueued) {
            setLiveAgentStatus('slide-generation-needed')
            setLiveAgentMessage(`Generating slide for: ${missingTopic ?? 'off-slide topic'}…`)
            // Poll for the generated slide
            if (slideGenPollRef.current) clearInterval(slideGenPollRef.current)
            slideGenPollRef.current = setInterval(async () => {
              try {
                const { slides: gen } = await getGeneratedSlides(activePresentationId)
                if (gen.length > 0) {
                  setInjectedSlides(gen)
                  if (slideGenPollRef.current) clearInterval(slideGenPollRef.current)
                  setLiveAgentStatus('on-slide')
                  setLiveAgentMessage(`New slide ready: ${gen[gen.length - 1].title}`)
                }
              } catch { /* ignore */ }
            }, 5000)
          } else if (result.coverage_status === 'not_covered') {
            setLiveAgentStatus('slide-generation-needed')
            setLiveAgentMessage(`Slide generation needed${missingTopic ? `: ${missingTopic}` : ''}`)
          } else if (result.coverage_status === 'other_slide') {
            setLiveAgentStatus('covered-elsewhere')
            setLiveAgentMessage(
              `Covered on another slide${typeof matchedSlide === 'number' ? ` (${matchedSlide + 1})` : ''}. ${
                agentSummary || result.agent_result.reason || ''
              }`.trim()
            )
          } else {
            setLiveAgentStatus('on-slide')
            setLiveAgentMessage(agentSummary || 'Speaker appears to be on the current slide.')
          }
        })
        .catch((error) => {
          setLiveAgentStatus('error')
          setLiveAgentMessage(`Transcript analysis failed: ${getErrorMessage(error)}`)
        })

      // Clear buffer after sending
      return []
    })
  }, [])

    const addToTranscriptBuffer = useCallback((text: string, intent?: boolean): void => {
    const trimmedText = text.trim()
    if (!trimmedText) {
      return
    }

    setTranscriptBuffer((prev) => [...prev, trimmedText])

    if (intent) {
      console.log('[transcript] Intent detected — flushing immediately')
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current)
        batchTimerRef.current = null
      }
      void flushTranscriptBuffer()
      return
    }

    // No intent — start fallback batch timer if one isn't already running
    if (batchTimerRef.current) {
      return
    }

    console.log('[transcript] Starting 20s batch timer')
    batchTimerRef.current = setTimeout(() => {
      batchTimerRef.current = null
      void flushTranscriptBuffer()
    }, BATCH_INTERVAL_MS)
  }, [flushTranscriptBuffer])

  const handleManualTranscriptSubmit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    const transcript = manualTranscript.trim()
    const activePresentationId = presentationIdRef.current

    if (!activePresentationId) {
      setLiveAgentStatus('error')
      setLiveAgentMessage('Start the live presentation before sending a manual transcript.')
      return
    }

    if (!transcript) {
      setLiveAgentStatus('ready')
      setLiveAgentMessage('Enter transcript text to send a manual test chunk.')
      return
    }

    setLiveAgentStatus('analyzing')
    setLiveAgentMessage('Analyzing manual transcript against current slide...')

    try {
      const result = await sendPresentationTranscript(activePresentationId, transcript)
      if ((result as unknown as Record<string, unknown>).noop === true) {
        setLiveAgentStatus('ready')
        setLiveAgentMessage('Manual transcript was empty.')
        return
      }

      const agentSummary = result.agent_result.summary_so_far ?? ''
      const missingTopic = result.agent_result.topic ?? result.agent_result.off_slide_topic
      const matchedSlide = result.agent_result.matched_slide
      const generationQueued = (result as unknown as Record<string, unknown>).generation_queued === true

      setSlideGenerationNeeded(result.slide_generation_needed)
      setManualTranscript('')

      if (generationQueued) {
        setLiveAgentStatus('slide-generation-needed')
        setLiveAgentMessage(`Generating slide for: ${missingTopic ?? 'off-slide topic'}...`)
        if (slideGenPollRef.current) clearInterval(slideGenPollRef.current)
        slideGenPollRef.current = setInterval(async () => {
          try {
            const { slides: gen } = await getGeneratedSlides(activePresentationId)
            if (gen.length > 0) {
              setInjectedSlides(gen)
              if (slideGenPollRef.current) clearInterval(slideGenPollRef.current)
              setLiveAgentStatus('on-slide')
              setLiveAgentMessage(`New slide ready: ${gen[gen.length - 1].title}`)
            }
          } catch {
            // ignore transient polling failures
          }
        }, 5000)
      } else if (result.coverage_status === 'not_covered') {
        setLiveAgentStatus('slide-generation-needed')
        setLiveAgentMessage(`Slide generation needed${missingTopic ? `: ${missingTopic}` : ''}`)
      } else if (result.coverage_status === 'other_slide') {
        setLiveAgentStatus('covered-elsewhere')
        setLiveAgentMessage(
          `Covered on another slide${typeof matchedSlide === 'number' ? ` (${matchedSlide + 1})` : ''}. ${
            agentSummary || result.agent_result.reason || ''
          }`.trim()
        )
      } else {
        setLiveAgentStatus('on-slide')
        setLiveAgentMessage(agentSummary || 'Manual transcript appears to be on the current slide.')
      }
    } catch (error) {
      setLiveAgentStatus('error')
      setLiveAgentMessage(`Manual transcript failed: ${getErrorMessage(error)}`)
    }
  }

  useEffect(() => {
    const unsubscribeTranscriptUpdate = window.electronAPI.onTranscriptUpdate((event) => {
      const transcriptEvent = event as TranscriptFileEvent
      setLatestTranscriptEvent(transcriptEvent)

      if (transcriptEvent.type === 'error') {
        setLiveAgentStatus('error')
        setLiveAgentMessage(transcriptEvent.error ?? 'Transcript file listener error.')
        return
      }

      if (transcriptEvent.type !== 'final' || !transcriptEvent.text?.trim()) {
        return
      }

      if (transcriptEvent.timestamp) {
        const eventTime = new Date(transcriptEvent.timestamp).getTime()
        if (!isNaN(eventTime) && eventTime < recordingStartTimeRef.current) {
          return
        }
      }

      const eventKey = getTranscriptEventKey(transcriptEvent)
      if (eventKey === processedTranscriptEventRef.current) {
        return
      }

      processedTranscriptEventRef.current = eventKey
      addToTranscriptBuffer(transcriptEvent.text, transcriptEvent.intent)
    })

    const unsubscribeTranscriptStatus = window.electronAPI.onTranscriptStatus((status) => {
      setRecording(status.listening)
      setTranscriptDirectory(status.directory)
      setTranscriptFile(status.filePath)
    })

    return () => {
      unsubscribeTranscriptUpdate()
      unsubscribeTranscriptStatus()
      
      // Clean up timer on unmount
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current)
      }
    }
  }, [addToTranscriptBuffer])

  const startExtraction = async (filePath: string, materialPaths: string[] = []): Promise<void> => {
    setErrorMessage(null)
    setStatusMessage('Starting extraction...')
    setExtractionPhase('extracting_images')
    setProgress(0)

    try {
      const result = await window.electronAPI.extractPPTX(filePath)
      setStatusMessage('Uploading and vectorizing presentation...')
      const upload = await window.electronAPI.uploadPPTXToSandbox(filePath)
      let materialStatus = ''
      if (materialPaths.length > 0) {
        setStatusMessage('Uploading audience Q&A materials...')
        const materialUpload = await window.electronAPI.uploadPresentationMaterials(
          upload.filename,
          materialPaths
        )
        upload.material_files_indexed = materialUpload.material_files_indexed
        upload.material_chunks_indexed = materialUpload.material_chunks_indexed
        upload.material_sandbox_dir = materialUpload.material_sandbox_dir
        materialStatus = ` ${materialUpload.material_files_indexed} material file${materialUpload.material_files_indexed === 1 ? '' : 's'} indexed for audience Q&A.`
        if (materialUpload.errors?.length) {
          materialStatus += ` ${materialUpload.errors.length} file${materialUpload.errors.length === 1 ? '' : 's'} had no supported text.`
        }
      }
      setVectorizationInfo(upload)
      setExtraction(result)
      setMode('gallery')
      setStatusMessage(
        upload.vectorization_status === 'ready'
          ? `Slide vector index ready (${upload.chunks_indexed ?? 0} chunks).${materialStatus}`
          : upload.vectorization_error
            ? `Vector search ${upload.vectorization_status ?? 'unavailable'}: ${upload.vectorization_error}`
            : result.doclingStatus === 'pending'
              ? 'Preview ready. Parsing structure in background.'
              : 'Ready'
      )
      if (result.doclingStatus === 'pending') {
        setProgress(0.9)
        setExtractionPhase('parsing_structure')
      } else {
        setProgress(1)
        setExtractionPhase('ready')
      }
      await loadRecentSessions()
      const sessions = await window.electronAPI.listDashboardSessions(result.fileName)
      setDashboardSessions(sessions as DashboardSessionSummary[])
      setSelectedDashboardSessionKey(sessions.length > 0 ? getDashboardSessionKey(sessions[0]) : null)
    } catch (error) {
      setExtractionPhase('error')
      setErrorMessage((error as Error).message)
    }
  }

  const handleResumeSession = async (selectedSessionId: string): Promise<void> => {
    setErrorMessage(null)
    setStatusMessage('Resuming session...')

    try {
      const result = await window.electronAPI.resumeSession(selectedSessionId)
      setExtraction(result)
      setMode('gallery')
      setExtractionPhase('ready')
      setProgress(1)
      setVectorizationInfo(null)
      const sessions = await window.electronAPI.listDashboardSessions(result.fileName)
      setDashboardSessions(sessions as DashboardSessionSummary[])
      setSelectedDashboardSessionKey(sessions.length > 0 ? getDashboardSessionKey(sessions[0]) : null)
      if (result.doclingStatus === 'ready') {
        console.log('[fonts] handleResumeSession: doclingStatus=ready, fetching fonts for session', selectedSessionId)
        const [fonts, status] = await Promise.all([
          window.electronAPI.getSessionFonts(selectedSessionId),
          window.electronAPI.getParseStatus(selectedSessionId)
        ])
        console.log('[fonts] getSessionFonts returned', fonts.length, 'fonts from IPC (resume)')
        void loadFonts(fonts, 'truetype')
        if (status.googleFontNames.length > 0) {
          setGoogleFontNames(status.googleFontNames)
          setFontDownloadState('idle')
        }
      } else {
        console.log('[fonts] handleResumeSession: doclingStatus=', result.doclingStatus, '— skipping font injection')
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    }
  }

  const handleClearSession = async (selectedSessionId: string): Promise<void> => {
    const session = recentSessions.find((entry) => entry.sessionId === selectedSessionId)
    if (session) {
      try {
        await deleteSandboxPresentation(session.fileName)
      } catch (error) {
        setStatusMessage(`Sandbox delete failed: ${getErrorMessage(error)}`)
      }
    }

    await window.electronAPI.clearSession(selectedSessionId)
    setRecentSessions((prev) => prev.filter((s) => s.sessionId !== selectedSessionId))

    if (selectedSessionId === sessionId) {
      await stopAnalyzerIfRunning()
      if (presentationIdRef.current) {
        await window.electronAPI.clearTimelineSession(presentationIdRef.current)
      }
      timelineReadyRef.current = false
      timelineDirRef.current = null
      await window.electronAPI.stopTranscriptListener()
      reset()
      setMode('select')
      setPresentationId(null)
      setLiveAgentStatus('idle')
      setLiveAgentMessage('No transcript analyzed yet.')
      setSlideGenerationNeeded(false)
      setVectorizationInfo(null)
      setGoogleFontNames([])
      setFontDownloadState('idle')
      clearFonts()
      setLatestTranscriptEvent(null)
      setRecording(false)
      setAnalyzerStatus('idle')
      setAnalyzerErrorMessage(null)
      setStatusMessage('Session cleared')
    }
  }

  const handleDownloadFonts = async (): Promise<void> => {
    if (!sessionId || fontDownloadState === 'downloading') return
    setFontDownloadState('downloading')
    try {
      const fonts = await window.electronAPI.downloadGoogleFonts(sessionId)
      await loadFonts(fonts, 'woff2')
      setFontDownloadState('done')
    } catch (e) {
      console.error('[fonts] Google Fonts download failed:', e)
      setFontDownloadState('error')
    }
  }

  const buildPresentationSlides = async (): Promise<ReturnType<typeof summarizeSlideData>[]> => {
    if (!sessionId) {
      return []
    }

    return Promise.all(
      slides.map(async (_slide, index) => {
        let data: SlideData | null = slideData[index] ?? null

        if (!data && doclingStatus === 'ready') {
          try {
            data = await window.electronAPI.getSlideData(sessionId, index)
            setSlideData(index, data)
          } catch {
            data = null
          }
        }

        return summarizeSlideData(index, data)
      })
    )
  }

  const handleLaunchPresentation = async (): Promise<void> => {
    if (!sessionId) {
      return
    }

    timelineReadyRef.current = false
    setErrorMessage(null)
    setLiveAgentStatus('starting')
    setLiveAgentMessage('Starting live presentation session...')
    setSlideGenerationNeeded(false)

    try {
      const presentationIdCandidate = sessionId
      const timelineStartedAtMs = Date.now()
      liveTimelineStartTimeRef.current = timelineStartedAtMs
      const timelineSession = await window.electronAPI.startTimelineSession({
        presentationId: presentationIdCandidate,
        sessionId,
        fileName: fileName ?? '',
        startedAtMs: timelineStartedAtMs
      })
      timelineDirRef.current = timelineSession.directory
      timelineReadyRef.current = true
      const analyzer = await window.electronAPI.startEngagementAnalyzer({
        presentationId: presentationIdCandidate,
        sessionId,
        timelineDir: timelineSession.directory
      })
      setAnalyzerStatus(analyzer.status)
      const analyzerState = await window.electronAPI.getEngagementAnalyzerStatus(
        presentationIdCandidate
      )
      setAnalyzerErrorMessage(analyzerState.errorMessage)

      const presentationSlides = await buildPresentationSlides()
      const result = await startPresentation({
        session_id: sessionId,
        file_name: fileName ?? '',
        slide_count: totalSlides,
        current_slide: 0,
        slides: presentationSlides
      })

      setPresentationId(result.presentation_id)
      setVectorizationInfo(result)
      setLiveSlideIndex(0)
      goToSlide(0)
      appendTimelineEntry({ type: 'qr' }, 0)
      setLiveAgentStatus('ready')
      setLiveAgentMessage(
        'Live transcript agent ready. Hit record to listen for transcript JSON updates.'
      )
      setMode('live')
    } catch (error) {
      if (sessionId) {
        await window.electronAPI.stopEngagementAnalyzer(sessionId).catch(() => undefined)
        await window.electronAPI.clearTimelineSession(sessionId).catch(() => undefined)
      }
      timelineReadyRef.current = false
      timelineDirRef.current = null
      setLiveAgentStatus('error')
      setLiveAgentMessage(`Could not start live session: ${getErrorMessage(error)}`)
    }
  }

  const handleToggleRecording = async (): Promise<void> => {
    if (!presentationId) {
      setLiveAgentStatus('error')
      setLiveAgentMessage('Start the live presentation before recording transcript updates.')
      return
    }

    try {
      if (recording) {
        const status = await window.electronAPI.stopTranscriptListener()
        setRecording(status.listening)
        setTranscriptDirectory(status.directory)
        setTranscriptFile(status.filePath)
        setLiveAgentStatus('ready')
        setLiveAgentMessage('Transcript recording stopped.')
        setTranscriptBuffer([]) // Clear buffer
      } else {
        processedTranscriptEventRef.current = null
        recordingStartTimeRef.current = Date.now()
        const status = await window.electronAPI.startTranscriptListener()
        setRecording(status.listening)
        setTranscriptDirectory(status.directory)
        setTranscriptFile(status.filePath)
        setLiveAgentStatus('ready')
        setLiveAgentMessage('Listening for final transcript JSON updates.')
        setTranscriptBuffer([]) // Clear buffer
      }
    } catch (error) {
      setLiveAgentStatus('error')
      setLiveAgentMessage(`Transcript listener failed: ${getErrorMessage(error)}`)
    }
  }

  useEffect(() => {
    isSlideFullscreenRef.current = isSlideFullscreen
  }, [isSlideFullscreen])

  useEffect(() => {
    const onFullscreenChange = (): void => setIsSlideFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    return () => {
      void stopAnalyzerIfRunning()
    }
  }, [stopAnalyzerIfRunning])

  const toggleSlideFullscreen = useCallback(async (): Promise<void> => {
    if (!document.fullscreenElement) {
      await slideContainerRef.current?.requestFullscreen()
    } else {
      await document.exitFullscreen()
    }
  }, [])

  const startResize = useCallback(
    (
      e: React.MouseEvent,
      currentWidth: number,
      setWidth: (w: number) => void,
      min: number,
      max: number,
      reverse = false
    ): void => {
      e.preventDefault()
      const startX = e.clientX

      const onMouseMove = (ev: MouseEvent): void => {
        const delta = reverse ? startX - ev.clientX : ev.clientX - startX
        setWidth(Math.max(min, Math.min(max, currentWidth + delta)))
      }

      const onMouseUp = (): void => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    []
  )

  const warningText = useMemo(() => warnings.join(' '), [warnings])
  const latestTranscriptText =
    latestTranscriptEvent?.text?.trim() || latestTranscriptEvent?.error || ''

  return (
    <main
      className={`app-shell${mode === 'live' ? ' app-live' : ''}`}
      style={mode !== 'live' ? ({ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties) : undefined}
    >
      {mode !== 'live' && (
        <aside className="sidebar">
          <FileSelector onSelect={startExtraction} />

          {recentSessions.length > 0 && (
            <section className="recent-sessions">
              <h3>Recent Presentations</h3>
              {recentSessions.map((session) => (
                <div key={session.sessionId} className="recent-item">
                  <button type="button" onClick={() => void handleResumeSession(session.sessionId)}>
                    {session.fileName}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void handleClearSession(session.sessionId)}
                  >
                    Clear
                  </button>
                </div>
              ))}
            </section>
          )}
        </aside>
      )}

      {mode !== 'live' && (
        <div
          className="sidebar-resizer"
          onMouseDown={(e) => startResize(e, sidebarWidth, setSidebarWidth, 160, 480)}
        />
      )}

      <section className="workspace">
        <DotGrid />
        <LobsterBackground />
        <header className="status-bar">
          <div>
            <strong>Status:</strong> {extractionPhase}
          </div>
          <div className="status-progress">
            <progress max={1} value={progress} />
            <span>{Math.round(progress * 100)}%</span>
          </div>
          {doclingStatus !== 'idle' && <div>Docling: {doclingStatus}</div>}
        </header>

        {statusMessage && <p className="info-text">{statusMessage}</p>}
        {warningText && <p className="warn-text">{warningText}</p>}
        {errorMessage && <p className="error-text">{errorMessage}</p>}

        {googleFontNames.length > 0 && fontDownloadState !== 'done' && (
          <div className="font-download-banner">
            <span>
              {fontDownloadState === 'error'
                ? 'Font download failed.'
                : `${googleFontNames.length} embedded font${googleFontNames.length > 1 ? 's' : ''} couldn't be decoded — download from Google Fonts for correct rendering.`}
            </span>
            <button
              className="font-download-btn"
              onClick={() => void handleDownloadFonts()}
              disabled={fontDownloadState === 'downloading'}
            >
              {fontDownloadState === 'downloading' ? 'Downloading…' : 'Download Fonts'}
            </button>
          </div>
        )}

        {mode === 'select' && <p className="placeholder-text">Select or drop a PPTX to begin.</p>}

        {mode === 'gallery' && (
          <div className="gallery-mode">
            <SlideGallery
              slides={slides}
              currentSlide={currentSlide}
              onSlideSelect={goToSlide}
              onLaunch={() => void handleLaunchPresentation()}
            />
            {(currentSlideImage || slideData[currentSlide]) && (
              <div className="selected-preview">
                <h3>Selected Slide</h3>
                <div className="selected-preview-media">
                  <SlideCanvas
                    currentSlide={currentSlide}
                    slideData={slideData[currentSlide] ?? null}
                    slideImage={currentSlideImage}
                    fontsVersion={fontsVersion}
                  />
                </div>
              </div>
            )}

            <section className="dashboard-sessions">
              <h3>Previous Sessions</h3>
              {dashboardSessions.length === 0 && <p className="placeholder-text">No previous session analytics yet.</p>}
              {dashboardSessions.length > 0 && (
                <div className="dashboard-session-list">
                  {dashboardSessions.map((session) => (
                    <button
                      key={`${session.presentationId}-${session.startedAtMs}`}
                      type="button"
                      className={`dashboard-session-item ${
                        selectedDashboardSessionKey === getDashboardSessionKey(session) ? 'active' : ''
                      }`}
                      onClick={() => setSelectedDashboardSessionKey(getDashboardSessionKey(session))}
                    >
                      <span>{new Date(session.startedAtMs).toLocaleString()}</span>
                      <span>
                        Avg:{' '}
                        {typeof session.averageEngagement === 'number'
                          ? session.averageEngagement.toFixed(2)
                          : 'n/a'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <EngagementDashboard
              data={dashboardData}
              selectedMemberIds={selectedMemberIds}
              onSelectedMemberIdsChange={setSelectedMemberIds}
            />
          </div>
        )}

        {mode === 'live' && (
          <div className="live-mode">
            <NavigationControls
              currentSlide={liveSlideIndex}
              totalSlides={liveTotalSlides}
              onNext={nextLiveSlide}
              onPrevious={previousLiveSlide}
              onExit={() => setMode('gallery')}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((state) => !state)}
              isFullscreen={isSlideFullscreen}
              onFullscreen={() => void toggleSlideFullscreen()}
            />

            <div
              className={`live-layout ${sidebarOpen ? '' : 'no-sidebar'}`}
              style={sidebarOpen ? ({ '--live-sidebar-width': `${liveSidebarWidth}px` } as React.CSSProperties) : undefined}
            >
              {sidebarOpen && (
                <>
                  <aside className="thumbnail-sidebar">
                    {liveMergedSlides.map((slot, index) => {
                      if (slot.type === 'qr') {
                        return (
                          <button
                            key="qr"
                            type="button"
                            className={`thumb-mini audience-thumb ${index === liveSlideIndex ? 'active' : ''}`}
                            onClick={() => goToLiveSlide(index)}
                          >
                            <div className="audience-thumb-preview">QR</div>
                            <span>{index + 1}</span>
                          </button>
                        )
                      }
                      if (slot.type === 'generated') {
                        const bg = slot.slide.style_hint?.bg || '#1a1a2e'
                        const accent = slot.slide.style_hint?.accent || '#4f8ef7'
                        return (
                          <button
                            key={`gen-${slot.slide.after_slide}-${slot.slide.created_at}`}
                            type="button"
                            className={`thumb-mini ${index === liveSlideIndex ? 'active' : ''}`}
                            style={{ border: `2px solid ${accent}` }}
                            onClick={() => goToLiveSlide(index)}
                          >
                            <div style={{ width: '100%', height: '100%', background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: accent, fontWeight: 700 }}>AI</div>
                            <span>{index + 1}</span>
                          </button>
                        )
                      }
                      const deckSlide = slides[slot.deckIndex]
                      return (
                        <button
                          key={`deck-${slot.deckIndex}`}
                          type="button"
                          className={`thumb-mini ${index === liveSlideIndex ? 'active' : ''}`}
                          onClick={() => goToLiveSlide(index)}
                        >
                          {deckSlide?.thumbnailPath ? (
                            <img src={deckSlide.thumbnailPath} alt={`Slide ${index + 1}`} />
                          ) : (
                            <span>No preview</span>
                          )}
                          <span>{index + 1}</span>
                        </button>
                      )
                    })}
                  </aside>
                  <div
                    className="sidebar-resizer"
                    onMouseDown={(e) => startResize(e, liveSidebarWidth, setLiveSidebarWidth, 80, 280)}
                  />
                </>
              )}

              <div
                className="live-stage"
                style={{ '--agent-panel-width': `${agentPanelWidth}px` } as React.CSSProperties}
              >
                <div ref={slideContainerRef} className="slide-fullscreen-wrapper">
                  {isAudienceQrSlide ? (
                    <AudienceQrSlide audienceUrl={NEMOSTAGE_AUDIENCE_URL} />
                  ) : isGeneratedSlide && currentGeneratedSlide ? (
                    <GeneratedSlideCard slide={currentGeneratedSlide} />
                  ) : (
                    <SlideCanvas
                      currentSlide={liveDeckSlideIndex}
                      slideData={liveSlideData}
                      slideImage={liveSlideImage}
                      fontsVersion={fontsVersion}
                    />
                  )}
                  <button
                    className="fullscreen-exit-btn"
                    type="button"
                    onClick={() => void toggleSlideFullscreen()}
                  >
                    Exit Fullscreen
                  </button>
                </div>

                <div
                  className="sidebar-resizer"
                  onMouseDown={(e) => startResize(e, agentPanelWidth, setAgentPanelWidth, 180, 480, true)}
                />

                <QAOverlay entry={activeQA} onDismiss={() => setActiveQA(null)} />

                <aside className="live-agent-panel" aria-label="Live transcript agent">
                  <div className="live-agent-header">
                    <h3>Transcript Agent</h3>
                    <span className={`live-agent-status ${liveAgentStatus}`}>
                      {liveAgentStatus === 'slide-generation-needed'
                        ? 'generation needed'
                        : liveAgentStatus === 'covered-elsewhere'
                          ? 'covered elsewhere'
                        : liveAgentStatus}
                    </span>
                  </div>

                  <label className="public-qa-toggle">
                    <input
                      type="checkbox"
                      checked={publicQADisplayEnabled}
                      onChange={(event) => setPublicQADisplayEnabled(event.currentTarget.checked)}
                    />
                    <span>
                      <strong>Public Q&amp;A display</strong>
                      <small>
                        {publicQADisplayEnabled
                          ? 'Answers also appear on the slideshow.'
                          : 'Answers go back to audience devices only.'}
                      </small>
                    </span>
                  </label>

                  {slideGenerationNeeded && (
                    <div className="generation-alert">Slide generation needed</div>
                  )}

                  {vectorizationInfo && (
                    <div
                      className={`vector-index-alert ${
                        vectorizationInfo.vectorization_status === 'ready' ? 'ready' : 'warning'
                      }`}
                    >
                      {vectorizationInfo.vectorization_status === 'ready'
                        ? `Vector index ready (${vectorizationInfo.chunks_indexed ?? 0} slide chunks${
                            vectorizationInfo.material_chunks_indexed
                              ? `, ${vectorizationInfo.material_chunks_indexed} material chunks`
                              : ''
                          }${
                            vectorizationInfo.slide_templates_indexed
                              ? `, ${vectorizationInfo.slide_templates_indexed} templates`
                              : ''
                          })`
                        : `Vector search ${vectorizationInfo.vectorization_status ?? 'unavailable'}`}
                    </div>
                  )}

                  <p className="live-agent-message">{liveAgentMessage}</p>
                  <p className="live-agent-message">Engagement analyzer: {analyzerStatus}</p>
                  {analyzerErrorMessage && (
                    <p className="warn-text">Analyzer error: {analyzerErrorMessage}</p>
                  )}

                  <form className="transcript-form" onSubmit={(event) => void handleManualTranscriptSubmit(event)}>
                    <label htmlFor="manual-transcript">Manual transcript test</label>
                    <textarea
                      id="manual-transcript"
                      value={manualTranscript}
                      onChange={(event) => setManualTranscript(event.currentTarget.value)}
                      placeholder="Paste or type a transcript chunk to analyze..."
                      disabled={!presentationId || liveAgentStatus === 'analyzing'}
                    />
                    <button
                      className="primary"
                      type="submit"
                      disabled={!presentationId || !manualTranscript.trim() || liveAgentStatus === 'analyzing'}
                    >
                      Send transcript
                    </button>
                  </form>

                  <div className="transcript-recorder">
                    <button
                      className="primary"
                      type="button"
                      onClick={() => void handleToggleRecording()}
                      disabled={!presentationId || (!recording && liveAgentStatus === 'analyzing')}
                    >
                      {recording ? 'Stop record' : 'Hit record'}
                    </button>

                    <div className="transcript-source">
                      <span>{recording ? 'Listening' : 'Paused'}</span>
                      <small>
                        {transcriptFile ||
                          transcriptDirectory ||
                          'Transcript folder not opened yet'}
                      </small>
                    </div>

                    <div className="latest-transcript">
                      <strong>Latest transcript JSON update</strong>
                      <p>{latestTranscriptText || 'No transcript events received yet.'}</p>
                      {latestTranscriptEvent?.timestamp && (
                        <small>{latestTranscriptEvent.timestamp}</small>
                      )}
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  )
}

export default App
