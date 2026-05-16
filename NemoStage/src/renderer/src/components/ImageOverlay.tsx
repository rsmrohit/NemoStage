import type { CSSProperties } from 'react'
import type { DoclingElement } from '../types/presentation'

const DEFAULT_W = 9144000
const DEFAULT_H = 6858000

interface ImageOverlayProps {
  element: DoclingElement
  slideWidth?: number
  slideHeight?: number
}

export function ImageOverlay({ element, slideWidth = DEFAULT_W, slideHeight = DEFAULT_H }: ImageOverlayProps): React.JSX.Element {
  const rotateStyle: CSSProperties = element.rotation
    ? { transform: `rotate(${element.rotation}deg)`, transformOrigin: 'center center' }
    : {}

  const containerStyle: CSSProperties = {
    position: 'absolute',
    left: `${(element.bbox.x / slideWidth) * 100}%`,
    top: `${(element.bbox.y / slideHeight) * 100}%`,
    width: `${(element.bbox.width / slideWidth) * 100}%`,
    height: `${(element.bbox.height / slideHeight) * 100}%`,
    overflow: 'hidden',
    ...rotateStyle
  }

  const imageStyle: CSSProperties = { width: '100%', height: '100%', display: 'block' }

  if (element.crop) {
    const { left, top, right, bottom } = element.crop
    imageStyle.width = `${100 + left + right}%`
    imageStyle.height = `${100 + top + bottom}%`
    imageStyle.marginLeft = `-${left}%`
    imageStyle.marginTop = `-${top}%`
    imageStyle.objectFit = 'fill'
  }

  return (
    <div className="image-overlay" style={containerStyle}>
      <img src={element.content} alt="" style={imageStyle} />
    </div>
  )
}
