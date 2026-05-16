import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FileSelector } from './components/FileSelector'
import { NavigationControls } from './components/NavigationControls'
import { SlideCanvas } from './components/SlideCanvas'
import { SlideGallery } from './components/SlideGallery'
import {
  listSandboxPresentations,
  sendPresentationTranscript,
  startPresentation,
  summarizeSlideData,
  updatePresentationSlide
} from './services/nemostageApi'
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
    nextSlide,
    previousSlide,
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

  const currentSlideImage = slides[currentSlide]?.imagePaths[0] ?? null
  const currentSlideData = slideData[currentSlide] ?? null

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

  useEffect(() => {
    if (mode !== 'live') {
      return
    }

    const handleKeyPress = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') {
        nextSlide()
      }
      if (event.key === 'ArrowLeft') {
        previousSlide()
      }
      if (event.key === 'Escape') {
        setMode('gallery')
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [mode, nextSlide, previousSlide])

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
      setStatusMessage('Uploading presentation to sandbox...')
      await window.electronAPI.uploadPPTXToSandbox(filePath)
      setExtraction(result)
      setMode('gallery')
      setStatusMessage(
        result.doclingStatus === 'pending'
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
    } catch (error) {
      setErrorMessage((error as Error).message)
    }
  }

  const handleClearSession = async (selectedSessionId: string): Promise<void> => {
    await window.electronAPI.clearSession(selectedSessionId)
    await loadRecentSessions()

    if (selectedSessionId === sessionId) {
      reset()
      setMode('select')
      setPresentationId(null)
      setLiveAgentStatus('idle')
      setLiveAgentMessage('No transcript analyzed yet.')
      setSlideGenerationNeeded(false)
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
        current_slide: currentSlide,
        slides: presentationSlides
      })

      setPresentationId(result.presentation_id)
      setLiveAgentStatus('ready')
      setLiveAgentMessage('Live transcript agent ready.')
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
              currentSlide={currentSlide}
              totalSlides={totalSlides}
              onNext={nextSlide}
              onPrevious={previousSlide}
              onExit={() => setMode('gallery')}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((state) => !state)}
            />

            <div className={`live-layout ${sidebarOpen ? '' : 'no-sidebar'}`}>
              {sidebarOpen && (
                <aside className="thumbnail-sidebar">
                  {slides.map((slide, index) => (
                    <button
                      key={slide.slideIndex}
                      type="button"
                      className={`thumb-mini ${index === currentSlide ? 'active' : ''}`}
                      onClick={() => goToSlide(index)}
                    >
                      {slide.thumbnailPath ? (
                        <img src={slide.thumbnailPath} alt={`Slide ${index + 1}`} />
                      ) : (
                        <span>No preview</span>
                      )}
                      <span>{index + 1}</span>
                    </button>
                  ))}
                </aside>
              )}

              <div className="live-stage">
                <SlideCanvas
                  currentSlide={currentSlide}
                  slideData={currentSlideData}
                  slideImage={currentSlideImage}
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
