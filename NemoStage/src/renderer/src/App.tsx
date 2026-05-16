import { useEffect, useMemo, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FileSelector } from './components/FileSelector'
import { NavigationControls } from './components/NavigationControls'
import { SlideCanvas } from './components/SlideCanvas'
import { SlideGallery } from './components/SlideGallery'
import { usePresentationStore } from './store/presentationStore'
import type { ExtractionPhase, SessionMetadata } from './types/presentation'

type AppMode = 'select' | 'gallery' | 'live'

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

  const currentSlideImage = slides[currentSlide]?.imagePaths[0] ?? null
  const currentSlideData = slideData[currentSlide] ?? null

  const loadRecentSessions = async (): Promise<void> => {
    const sessions = await window.electronAPI.getRecentSessions()
    setRecentSessions(sessions)
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

  const startExtraction = async (filePath: string): Promise<void> => {
    setErrorMessage(null)
    setStatusMessage('Starting extraction...')
    setExtractionPhase('extracting_images')
    setProgress(0)

    try {
      const result = await window.electronAPI.extractPPTX(filePath)
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
      setStatusMessage('Session cleared')
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
              onLaunch={() => setMode('live')}
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

            <div className="live-layout">
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

              <SlideCanvas
                currentSlide={currentSlide}
                slideData={currentSlideData}
                slideImage={currentSlideImage}
              />
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
