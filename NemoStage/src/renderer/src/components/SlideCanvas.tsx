import { memo } from 'react'
import { ImageOverlay } from './ImageOverlay'
import { TextOverlay } from './TextOverlay'
import { TableOverlay } from './TableOverlay'
import type { DoclingElement, SlideData } from '../types/presentation'
import type { CSSProperties } from 'react'

const DEFAULT_SLIDE_WIDTH = 9144000
const DEFAULT_SLIDE_HEIGHT = 6858000

interface SlideCanvasProps {
  currentSlide: number
  slideData: SlideData | null
  slideImage: string | null
}

function geomToBorderRadius(geom?: string): string | undefined {
  if (!geom) return undefined
  if (geom === 'ellipse' || geom === 'circle') return '50%'
  if (geom === 'roundRect') return '8%'
  return undefined
}

function ShapeOverlay({ element, slideWidth, slideHeight }: { element: DoclingElement; slideWidth: number; slideHeight: number }): React.JSX.Element {
  const rotateStyle: CSSProperties = element.rotation
    ? { transform: `rotate(${element.rotation}deg)`, transformOrigin: 'center center' }
    : {}

  const style: CSSProperties = {
    position: 'absolute',
    left: `${(element.bbox.x / slideWidth) * 100}%`,
    top: `${(element.bbox.y / slideHeight) * 100}%`,
    width: `${(element.bbox.width / slideWidth) * 100}%`,
    height: `${(element.bbox.height / slideHeight) * 100}%`,
    background: element.fillColor ?? 'transparent',
    borderRadius: geomToBorderRadius(element.shapeGeom),
    ...rotateStyle
  }
  return <div className="shape-overlay" style={style} />
}

function renderElement(el: DoclingElement, key: string, slideWidth: number, slideHeight: number): React.JSX.Element | null {
  if (el.type === 'shape') {
    return <ShapeOverlay key={key} element={el} slideWidth={slideWidth} slideHeight={slideHeight} />
  }
  if (el.type === 'image') {
    return <ImageOverlay key={key} element={el} slideWidth={slideWidth} slideHeight={slideHeight} />
  }
  if (el.type === 'text') {
    return <TextOverlay key={key} element={el} slideWidth={slideWidth} slideHeight={slideHeight} />
  }
  if (el.type === 'table') {
    return <TableOverlay key={key} element={el} slideWidth={slideWidth} slideHeight={slideHeight} />
  }
  return null
}

export const SlideCanvas = memo(function SlideCanvas({
  currentSlide,
  slideData,
  slideImage
}: SlideCanvasProps): React.JSX.Element {
  const slideWidth = slideData?.slideWidth ?? DEFAULT_SLIDE_WIDTH
  const slideHeight = slideData?.slideHeight ?? DEFAULT_SLIDE_HEIGHT
  const aspectRatio = slideWidth / slideHeight
  const background = slideData?.background ?? '#FFFFFF'

  return (
    <div className="slide-canvas-shell">
      <div
        className="slide-canvas"
        style={{
          aspectRatio: `${aspectRatio}`,
          background,
          position: 'relative',
          containerType: 'inline-size'
        }}
      >
        {slideImage && !slideData && (
          <img
            src={slideImage}
            className="slide-base-image"
            alt={`Slide ${currentSlide + 1}`}
            style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block' }}
          />
        )}

        {/* Render elements in document order (z-order preserved) */}
        <div className="slide-overlays" style={{ position: 'absolute', inset: 0 }}>
          {slideData?.elements.map((el, i) =>
            renderElement(el, `${el.type}-${currentSlide}-${i}`, slideWidth, slideHeight)
          )}
        </div>
      </div>
    </div>
  )
})
