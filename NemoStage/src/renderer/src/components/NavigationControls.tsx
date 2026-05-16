interface NavigationControlsProps {
  currentSlide: number
  totalSlides: number
  onNext: () => void
  onPrevious: () => void
  onExit: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  isFullscreen: boolean
  onFullscreen: () => void
}

export function NavigationControls({
  currentSlide,
  totalSlides,
  onNext,
  onPrevious,
  onExit,
  sidebarOpen,
  onToggleSidebar,
  isFullscreen,
  onFullscreen
}: NavigationControlsProps): React.JSX.Element {
  return (
    <nav className="navigation-controls" aria-label="Slide navigation controls">
      <button type="button" onClick={onPrevious} disabled={currentSlide <= 0}>
        Previous
      </button>
      <button type="button" onClick={onNext} disabled={currentSlide >= totalSlides - 1}>
        Next
      </button>
      <span className="slide-counter">
        {totalSlides === 0 ? '0 / 0' : `${currentSlide + 1} / ${totalSlides}`}
      </span>
      <button type="button" onClick={onToggleSidebar}>
        {sidebarOpen ? 'Hide Thumbnails' : 'Show Thumbnails'}
      </button>
      <button type="button" onClick={onFullscreen}>
        {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
      </button>
      <button type="button" onClick={onExit}>
        Exit
      </button>
    </nav>
  )
}
