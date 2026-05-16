import { memo } from 'react'
import { TextOverlay } from './TextOverlay'
import type { SlideData } from '../types/presentation'

interface SlideCanvasProps {
  currentSlide: number
  slideData: SlideData | null
  slideImage: string | null
}

export const SlideCanvas = memo(function SlideCanvas({
  currentSlide,
  slideData,
  slideImage
}: SlideCanvasProps): React.JSX.Element {
  return (
    <div className="slide-canvas-shell">
      <div className="slide-canvas" style={{ aspectRatio: '16 / 9' }}>
        {slideImage ? (
          <img src={slideImage} className="slide-base-image" alt={`Slide ${currentSlide + 1}`} />
        ) : (
          <div className="empty-slide">No slide image available</div>
        )}

        <div className="slide-overlays">
          {slideData?.elements
            ?.filter((element) => element.type === 'text')
            .map((element, index) => (
              <TextOverlay key={`${currentSlide}-${index}`} element={element} />
            ))}
        </div>
      </div>
    </div>
  )
})
