import type { CSSProperties } from 'react'
import type { DoclingElement, TextRun } from '../types/presentation'

const DEFAULT_W = 9144000
const DEFAULT_H = 6858000
const EMU_PER_PT = 12700  // 914400 EMU/inch ÷ 72 pt/inch

function geomToBorderRadius(geom?: string): string | undefined {
  if (geom === 'ellipse' || geom === 'circle') return '50%'
  if (geom === 'roundRect') return '8%'
  return undefined
}

const FONT_FALLBACKS: Record<string, string[]> = {
  Calibri: ['Calibri', 'Arial', 'sans-serif'],
  Arial: ['Arial', 'Helvetica', 'sans-serif'],
  'Times New Roman': ['Times New Roman', 'Times', 'serif'],
  Aptos: ['Aptos', 'Calibri', 'Arial', 'sans-serif'],
  Cambria: ['Cambria', 'Georgia', 'serif']
}

function resolveFontFamily(fontName?: string): string {
  if (!fontName) return 'Calibri, Arial, sans-serif'
  const fallbacks = FONT_FALLBACKS[fontName]
  if (fallbacks) return fallbacks.join(', ')
  return `${fontName}, Calibri, Arial, sans-serif`
}

// Convert pt → cqw so font scales with the slide container
function ptToCqw(pt: number, slideWidth: number): string {
  const pct = (pt * EMU_PER_PT / slideWidth) * 100
  return `${pct.toFixed(4)}cqw`
}

const ALIGN_MAP: Record<string, CSSProperties['textAlign']> = {
  l: 'left',
  ctr: 'center',
  r: 'right',
  just: 'justify'
}

interface TextOverlayProps {
  element: DoclingElement
  slideWidth?: number
  slideHeight?: number
}

export function TextOverlay({ element, slideWidth = DEFAULT_W, slideHeight = DEFAULT_H }: TextOverlayProps): React.JSX.Element {
  const rotateStyle: CSSProperties = element.rotation
    ? { transform: `rotate(${element.rotation}deg)`, transformOrigin: 'center center' }
    : {}

  const anchorMap: Record<string, CSSProperties['justifyContent']> = {
    t: 'flex-start',
    ctr: 'center',
    b: 'flex-end'
  }

  const tbs = element.textBoxStyle
  const paddingLeft   = tbs?.insL !== undefined ? `${(tbs.insL / slideWidth) * 100}%` : undefined
  const paddingRight  = tbs?.insR !== undefined ? `${(tbs.insR / slideWidth) * 100}%` : undefined
  const paddingTop    = tbs?.insT !== undefined ? `${(tbs.insT / slideHeight) * 100}%` : undefined
  const paddingBottom = tbs?.insB !== undefined ? `${(tbs.insB / slideHeight) * 100}%` : undefined

  const containerStyle: CSSProperties = {
    position: 'absolute',
    left: `${(element.bbox.x / slideWidth) * 100}%`,
    top: `${(element.bbox.y / slideHeight) * 100}%`,
    width: `${(element.bbox.width / slideWidth) * 100}%`,
    height: `${(element.bbox.height / slideHeight) * 100}%`,
    // Clip filled shapes; let unfilled text boxes overflow so text isn't cut
    overflow: element.fillColor ? 'hidden' : 'visible',
    background: element.fillColor ?? 'transparent',
    borderRadius: geomToBorderRadius(element.shapeGeom),
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
    boxSizing: 'border-box',
    whiteSpace: tbs?.wrapNone ? 'nowrap' : undefined,
    lineHeight: 1.25,
    outline: 'none',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: element.verticalAnchor ? anchorMap[element.verticalAnchor] : 'flex-start',
    ...rotateStyle
  }

  if (element.textRuns && element.textRuns.length > 0) {
    const paragraphs = groupIntoParagraphs(element.textRuns)

    return (
      <div className="text-overlay" style={containerStyle}>
        {paragraphs.map((paraRuns, pIdx) => {
          const align = paraRuns[0]?.paragraphAlign
          const lh = paraRuns[0]?.lineHeight
          const paraStyle: CSSProperties = {
            textAlign: align ? ALIGN_MAP[align] : 'left',
            lineHeight: lh ?? 1.25,
            margin: 0,
            padding: 0,
            minHeight: '1em'
          }
          return (
            <p key={pIdx} style={paraStyle}>
              {paraRuns.map((run, rIdx) => {
                const decorations: string[] = []
                if (run.underline) decorations.push('underline')
                if (run.strikethrough) decorations.push('line-through')

                const spanStyle: CSSProperties = {
                  fontFamily: resolveFontFamily(run.font),
                  fontSize: run.size > 0 ? ptToCqw(run.size, slideWidth) : undefined,
                  fontWeight: run.bold ? 'bold' : 'normal',
                  fontStyle: run.italic ? 'italic' : 'normal',
                  color: run.color || 'inherit',
                  textDecoration: decorations.length > 0 ? decorations.join(' ') : undefined,
                  verticalAlign: run.baseline
                    ? run.baseline > 0 ? 'super' : 'sub'
                    : undefined
                }
                return (
                  <span key={rIdx} style={spanStyle}>
                    {run.text}
                  </span>
                )
              })}
            </p>
          )
        })}
      </div>
    )
  }

  // Fallback: single-style render
  return (
    <div
      className="text-overlay"
      style={{
        ...containerStyle,
        color: element.style?.color ?? '#111827',
        fontSize: element.style?.fontSize
          ? ptToCqw(element.style.fontSize, slideWidth)
          : ptToCqw(18, slideWidth),
        fontFamily: resolveFontFamily(element.style?.font),
        whiteSpace: 'pre-wrap'
      }}
    >
      {element.content}
    </div>
  )
}

function groupIntoParagraphs(runs: TextRun[]): TextRun[][] {
  const paragraphs: TextRun[][] = []
  let current: TextRun[] = []

  for (const run of runs) {
    if (run.text === '\n') {
      paragraphs.push(current)
      current = []
    } else {
      current.push(run)
    }
  }

  if (current.length > 0) paragraphs.push(current)
  return paragraphs
}
