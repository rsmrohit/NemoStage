import type { CSSProperties } from 'react'
import type { DoclingElement } from '../types/presentation'

const PPTX_WIDTH_EMU = 9144000
const PPTX_HEIGHT_EMU = 6858000

function scaleCoordinates(element: DoclingElement): CSSProperties {
  return {
    position: 'absolute',
    left: `${(element.bbox.x / PPTX_WIDTH_EMU) * 100}%`,
    top: `${(element.bbox.y / PPTX_HEIGHT_EMU) * 100}%`,
    width: `${(element.bbox.width / PPTX_WIDTH_EMU) * 100}%`,
    height: `${(element.bbox.height / PPTX_HEIGHT_EMU) * 100}%`
  }
}

interface ImageOverlayProps {
  element: DoclingElement
}

export function ImageOverlay({ element }: ImageOverlayProps): React.JSX.Element | null {
  if (!element.content) {
    return null
  }

  return (
    <img
      className="image-overlay"
      src={element.content}
      alt=""
      style={scaleCoordinates(element)}
      draggable={false}
    />
  )
}
