import type { CSSProperties } from 'react'
import type { DoclingElement } from '../types/presentation'

const PPTX_WIDTH_EMU = 9144000
const PPTX_HEIGHT_EMU = 6858000

const FONT_FALLBACKS: Record<string, string[]> = {
  Calibri: ['Calibri', 'Arial', 'sans-serif'],
  Arial: ['Arial', 'Helvetica', 'sans-serif'],
  'Times New Roman': ['Times New Roman', 'Times', 'serif'],
  Aptos: ['Aptos', 'Calibri', 'Arial', 'sans-serif'],
  Cambria: ['Cambria', 'Georgia', 'serif']
}

function resolveFontFamily(fontName?: string): string {
  if (!fontName) {
    return 'Calibri, Arial, sans-serif'
  }

  const fallbacks = FONT_FALLBACKS[fontName]
  if (fallbacks) {
    return fallbacks.join(', ')
  }

  return `${fontName}, Calibri, Arial, sans-serif`
}

function scaleCoordinates(element: DoclingElement): CSSProperties {
  return {
    position: 'absolute',
    left: `${(element.bbox.x / PPTX_WIDTH_EMU) * 100}%`,
    top: `${(element.bbox.y / PPTX_HEIGHT_EMU) * 100}%`,
    width: `${(element.bbox.width / PPTX_WIDTH_EMU) * 100}%`,
    height: `${(element.bbox.height / PPTX_HEIGHT_EMU) * 100}%`
  }
}

interface TextOverlayProps {
  element: DoclingElement
}

export function TextOverlay({ element }: TextOverlayProps): React.JSX.Element {
  console.log('[TextOverlay] bbox:', element.bbox)
  console.log('[TextOverlay] content:', element.content.substring(0, 30))

  const style: CSSProperties = {
    ...scaleCoordinates(element),
    color: element.style?.color ?? '#111827',
    fontSize: element.style?.fontSize ? `${Math.max(10, element.style.fontSize)}px` : '14px',
    fontFamily: resolveFontFamily(element.style?.font),
    whiteSpace: 'pre-wrap',
    lineHeight: 1.25,
    overflow: 'hidden',
    background: 'transparent',
    border: '1px solid red',
    outline: 'none'
  }

  return (
    <div contentEditable suppressContentEditableWarning className="text-overlay" style={style}>
      {element.content}
    </div>
  )
}
