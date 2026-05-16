import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FileSelector } from './components/FileSelector'
import { NavigationControls } from './components/NavigationControls'
import { SlideCanvas } from './components/SlideCanvas'
import { SlideGallery } from './components/SlideGallery'
import { AudienceQrSlide } from './components/AudienceQrSlide'
import {
  NEMOSTAGE_AUDIENCE_URL,
  deleteSandboxPresentation,
  listSandboxPresentations,
  sendPresentationTranscript,
  startPresentation,
  summarizeSlideData,
  updatePresentationSlide
} from './services/nemostageApi'
import type { VectorizationFields } from './services/nemostageApi'
import { usePresentationStore } from './store/presentationStore'
import type { ExtractionPhase, SessionMetadata, SlideData } from './types/presentation'
import { useFonts } from './hooks/useFonts'

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
  const [liveAgentStatus, setLiveAgentStatus] = useState<LiveAgentStatus>('idle')
  const [liveAgentMessage, setLiveAgentMessage] = useState('No transcript analyzed yet.')
  const [slideGenerationNeeded, setSlideGenerationNeeded] = useState(false)
  const [vectorizationInfo, setVectorizationInfo] = useState<VectorizationFields | null>(null)
  const [liveSlideIndex, setLiveSlideIndex] = useState(0)
  const [recording, setRecording] = useState(false)
  const [transcriptDirectory, setTranscriptDirectory] = useState('')
  const [transcriptFile, setTranscriptFile] = useState<string | null>(null)
  const [latestTranscriptEvent, setLatestTranscriptEvent] = useState<TranscriptFileEvent | null>(
    null
  )
  const [transcriptBuffer, setTranscriptBuffer] = useState<string[]>([])
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const BATCH_INTERVAL_MS = 20000 // 20 seconds
  const presentationIdRef = useRef<string | null>(null)
  const processedTranscriptEventRef = useRef<string | null>(null)

  const currentSlideImage = slides[currentSlide]?.imagePaths[0] ?? null
  const liveTotalSlides = totalSlides > 0 ? totalSlides + 1 : 0
  const isAudienceQrSlide = mode === 'live' && liveSlideIndex === 0
  const liveDeckSlideIndex = Math.max(liveSlideIndex - 1, 0)
  const liveSlideImage = isAudienceQrSlide ? null : (slides[liveDeckSlideIndex]?.imagePaths[0] ?? null)
  const liveSlideData = isAudienceQrSlide ? null : (slideData[liveDeckSlideIndex] ?? null)

  useEffect(() => {
    presentationIdRef.current = presentationId
  }, [presentationId])

  const loadRecentSessions = async (): Promise<void> => {
    try {
      const [sessions, sandbox] = await Promise.all([
        window.electronAPI.getRecentSessions(),
        listSandboxPresentations()
      ])
      const sandboxFilenames = new Set(
        sandbox.presentations.map((presentation) => presentation.filename)
      )
      setRecentSessions(sessions.filter((session) => sandboxFilenames.has(session.fileName)))
    } catch (error) {
      setRecentSessions([])
      setStatusMessage(`Sandbox presentations unavailable: ${getErrorMessage(error)}`)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecentSessions()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [])

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
    setLiveSlideIndex(boundedIndex)

    if (boundedIndex > 0) {
      goToSlide(boundedIndex - 1)
    }
  }, [goToSlide, liveTotalSlides])

  const nextLiveSlide = useCallback((): void => {
    goToLiveSlide(liveSlideIndex + 1)
  }, [goToLiveSlide, liveSlideIndex])

  const previousLiveSlide = useCallback((): void => {
    goToLiveSlide(liveSlideIndex - 1)
  }, [goToLiveSlide, liveSlideIndex])

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
      
      // Send the combined chunk
      setLiveAgentStatus('analyzing')
      setLiveAgentMessage('Analyzing transcript against current slide...')

      sendPresentationTranscript(activePresentationId, combinedTranscript)
        .then((result) => {
          const agentSummary = result.agent_result.summary_so_far ?? ''
          const missingTopic = result.agent_result.topic ?? result.agent_result.off_slide_topic
          const matchedSlide = result.agent_result.matched_slide

          setSlideGenerationNeeded(result.slide_generation_needed)
          if (result.coverage_status === 'not_covered') {
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

    const addToTranscriptBuffer = useCallback((text: string): void => {
    const trimmedText = text.trim()
    if (!trimmedText) {
      return
    }

    setTranscriptBuffer((prev) => [...prev, trimmedText])

    // Reset the 3-second timer
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current)
    }

    batchTimerRef.current = setTimeout(() => {
      void flushTranscriptBuffer()
    }, BATCH_INTERVAL_MS)
  }, [flushTranscriptBuffer])

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

      const eventKey = getTranscriptEventKey(transcriptEvent)
      if (eventKey === processedTranscriptEventRef.current) {
        return
      }

      processedTranscriptEventRef.current = eventKey
      addToTranscriptBuffer(transcriptEvent.text) // Changed from analyzeTranscriptChunk
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

  const startExtraction = async (filePath: string): Promise<void> => {
    setErrorMessage(null)
    setStatusMessage('Starting extraction...')
    setExtractionPhase('extracting_images')
    setProgress(0)

    try {
      const result = await window.electronAPI.extractPPTX(filePath)
      setStatusMessage('Uploading and vectorizing presentation...')
      const upload = await window.electronAPI.uploadPPTXToSandbox(filePath)
      setVectorizationInfo(upload)
      setExtraction(result)
      setMode('gallery')
      setStatusMessage(
        upload.vectorization_status === 'ready'
          ? `Slide vector index ready (${upload.chunks_indexed ?? 0} chunks).`
          : upload.vectorization_error
            ? `Vector search ${upload.vectorization_status ?? 'unavailable'}: ${upload.vectorization_error}`
            : result.doclingStatus === 'pending'
              ? 'Preview ready. Parsing structure in background.'
              : 'Ready'
      )
      setProgress(1)
      setExtractionPhase('ready')
      await loadRecentSessions()
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
    await loadRecentSessions()

    if (selectedSessionId === sessionId) {
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

    setErrorMessage(null)
    setLiveAgentStatus('starting')
    setLiveAgentMessage('Starting live presentation session...')
    setSlideGenerationNeeded(false)

    try {
      const presentationSlides = await buildPresentationSlides()
      const result = await startPresentation({
        session_id: sessionId,
        file_name: usePresentationStore.getState().fileName ?? '',
        slide_count: totalSlides,
        current_slide: 0,
        slides: presentationSlides
      })

      setPresentationId(result.presentation_id)
      setVectorizationInfo(result)
      setLiveSlideIndex(0)
      goToSlide(0)
      setLiveAgentStatus('ready')
      setLiveAgentMessage(
        'Live transcript agent ready. Hit record to listen for transcript JSON updates.'
      )
      setMode('live')
    } catch (error) {
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
            {currentSlideImage && (
              <div className="selected-preview">
                <h3>Selected Slide</h3>
                <div className="selected-preview-media">
                  <img src={currentSlideImage} alt={`Selected slide ${currentSlide + 1}`} />
                </div>
              </div>
            )}
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
                  <button
                    type="button"
                    className={`thumb-mini audience-thumb ${liveSlideIndex === 0 ? 'active' : ''}`}
                    onClick={() => goToLiveSlide(0)}
                  >
                    <div className="audience-thumb-preview">QR</div>
                    <span>1</span>
                  </button>
                    {slides.map((slide, index) => (
                      <button
                        key={slide.slideIndex}
                        type="button"
                        className={`thumb-mini ${index + 1 === liveSlideIndex ? 'active' : ''}`}
                        onClick={() => goToLiveSlide(index + 1)}
                      >
                        {slide.thumbnailPath ? (
                          <img src={slide.thumbnailPath} alt={`Slide ${index + 2}`} />
                        ) : (
                          <span>No preview</span>
                        )}
                        <span>{index + 2}</span>
                      </button>
                    ))}
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
                        ? `Vector index ready (${vectorizationInfo.chunks_indexed ?? 0} chunks)`
                        : `Vector search ${vectorizationInfo.vectorization_status ?? 'unavailable'}`}
                    </div>
                  )}

                  <p className="live-agent-message">{liveAgentMessage}</p>

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
