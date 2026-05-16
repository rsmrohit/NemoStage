import type { SlidePreview } from '../types/presentation'

interface SlideGalleryProps {
  slides: SlidePreview[]
  currentSlide: number
  onSlideSelect: (index: number) => void
  onLaunch: () => void
}

export function SlideGallery({
  slides,
  currentSlide,
  onSlideSelect,
  onLaunch
}: SlideGalleryProps): React.JSX.Element {
  return (
    <section className="gallery-panel">
      <header>
        <h2>Slide Gallery</h2>
        <button className="primary" type="button" onClick={onLaunch} disabled={slides.length === 0}>
          Launch Presentation
        </button>
      </header>

      <div className="gallery-grid">
        {slides.map((slide, index) => (
          <button
            key={slide.slideIndex}
            className={`slide-thumbnail ${index === currentSlide ? 'active' : ''}`}
            type="button"
            onClick={() => onSlideSelect(index)}
          >
            {slide.thumbnailPath ? (
              <img loading="lazy" src={slide.thumbnailPath} alt={`Slide ${index + 1}`} />
            ) : (
              <div className="missing-thumb">No preview</div>
            )}
            <span>Slide {index + 1}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
