import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
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
  const [statusMessage, setStatusMessage] = useState('')
  const [extractionPhase, setExtractionPhase] = useState<ExtractionPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recentSessions, setRecentSessions] = useState<SessionMetadata[]>([])
  const [presentationId, setPresentationId] = useState<string | null>(null)
  const [transcriptText, setTranscriptText] = useState('')
  const [liveAgentStatus, setLiveAgentStatus] = useState<LiveAgentStatus>('idle')
  const [liveAgentMessage, setLiveAgentMessage] = useState('No transcript analyzed yet.')
  const [slideGenerationNeeded, setSlideGenerationNeeded] = useState(false)
  const [vectorizationInfo, setVectorizationInfo] = useState<VectorizationFields | null>(null)
  const [liveSlideIndex, setLiveSlideIndex] = useState(0)

  const currentSlideImage = slides[currentSlide]?.imagePaths[0] ?? null
  const liveTotalSlides = totalSlides > 0 ? totalSlides + 1 : 0
  const isAudienceQrSlide = mode === 'live' && liveSlideIndex === 0
  const liveDeckSlideIndex = Math.max(liveSlideIndex - 1, 0)
  const liveSlideImage = isAudienceQrSlide ? null : (slides[liveDeckSlideIndex]?.imagePaths[0] ?? null)
  const liveSlideData = isAudienceQrSlide ? null : (slideData[liveDeckSlideIndex] ?? null)

  const loadRecentSessions = async (): Promise<void> => {
    try {
      const [sessions, sandbox] = await Promise.all([
        window.electronAPI.getRecentSessions(),
        listSandboxPresentations()
      ])
      const sandboxFilenames = new Set(sandbox.presentations.map((presentation) => presentation.filename))
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
      async ({ sessionId: readySessionId }) => {
        if (readySessionId !== sessionId) {
          return
        }

        setDoclingStatus('ready')
        const data = await window.electronAPI.getSlideData(readySessionId, currentSlide)
        setSlideData(currentSlide, data)
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
            const data = await window.electronAPI.getSlideData(sessionId, currentSlide)
            if (!cancelled) {
              setSlideData(currentSlide, data)
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
      reset()
      setMode('select')
      setPresentationId(null)
      setLiveAgentStatus('idle')
      setLiveAgentMessage('No transcript analyzed yet.')
      setSlideGenerationNeeded(false)
      setVectorizationInfo(null)
      setStatusMessage('Session cleared')
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
        result.vectorization_status === 'ready'
          ? `Live transcript agent ready. Using isolated vector index (${result.chunks_indexed ?? 0} chunks).`
          : `Live transcript agent ready, but vector search is ${result.vectorization_status ?? 'unavailable'}.`
      )
      setMode('live')
    } catch (error) {
      setLiveAgentStatus('error')
      setLiveAgentMessage(`Could not start live session: ${getErrorMessage(error)}`)
    }
  }

  const handleTranscriptSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    if (!presentationId) {
      setLiveAgentStatus('error')
      setLiveAgentMessage('Start the live presentation before sending transcript.')
      return
    }

    const transcript = transcriptText.trim()
    if (!transcript) {
      return
    }

    setLiveAgentStatus('analyzing')
    setLiveAgentMessage('Analyzing transcript against current slide...')

    try {
      const result = await sendPresentationTranscript(presentationId, transcript)
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
      setTranscriptText('')
    } catch (error) {
      setLiveAgentStatus('error')
      setLiveAgentMessage(`Transcript analysis failed: ${getErrorMessage(error)}`)
    }
  }

  const warningText = useMemo(() => warnings.join(' '), [warnings])

  return (
    <main className="app-shell">
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
            />

            <div className={`live-layout ${sidebarOpen ? '' : 'no-sidebar'}`}>
              {sidebarOpen && (
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
              )}

              <div className="live-stage">
                {isAudienceQrSlide ? (
                  <AudienceQrSlide audienceUrl={NEMOSTAGE_AUDIENCE_URL} />
                ) : (
                  <SlideCanvas
                    currentSlide={liveDeckSlideIndex}
                    slideData={liveSlideData}
                    slideImage={liveSlideImage}
                  />
                )}

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

                  <form className="transcript-form" onSubmit={(event) => void handleTranscriptSubmit(event)}>
                    <label htmlFor="live-transcript">Live transcript chunk</label>
                    <textarea
                      id="live-transcript"
                      value={transcriptText}
                      onChange={(event) => setTranscriptText(event.target.value)}
                      placeholder="Paste or type what the speaker just said..."
                    />
                    <button
                      className="primary"
                      type="submit"
                      disabled={!presentationId || liveAgentStatus === 'analyzing' || !transcriptText.trim()}
                    >
                      {liveAgentStatus === 'analyzing' ? 'Analyzing...' : 'Send transcript'}
                    </button>
                  </form>
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
