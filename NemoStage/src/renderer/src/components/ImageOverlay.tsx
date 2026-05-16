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

export function ImageOverlay({ element }: ImageOverlayProps): React.JSX.Element {
  const style: CSSProperties = {
    ...scaleCoordinates(element),
    overflow: 'hidden'
  }

  // Calculate crop using CSS clip-path or object-position
  const imageStyle: CSSProperties = {}
  
  if (element.crop) {
    const { left, top, right, bottom } = element.crop
    
    // Method 1: Use object-fit and object-position (simpler but less precise)
    // This shows the uncropped portion
    imageStyle.objectFit = 'cover'
    imageStyle.objectPosition = `${-left}% ${-top}%`
    imageStyle.width = `${100 + left + right}%`
    imageStyle.height = `${100 + top + bottom}%`
    
    // Method 2: Use clip-path (more precise)
    // Uncomment this if you prefer clip-path approach
    /*
    const clipLeft = left
    const clipTop = top
    const clipRight = 100 - right
    const clipBottom = 100 - bottom
    imageStyle.clipPath = `inset(${clipTop}% ${clipRight}% ${clipBottom}% ${clipLeft}%)`
    */
  }

  return (
    <div className="image-overlay" style={style}>
      <img 
        src={element.content} 
        alt="" 
        style={{
          width: '100%',
          height: '100%',
          ...imageStyle
        }}
      />
    </div>
  )
}