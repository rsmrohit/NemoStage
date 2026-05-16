import type { CSSProperties } from 'react'
import type { DoclingElement, TextRun } from '../types/presentation'

const DEFAULT_W = 9144000
const DEFAULT_H = 6858000
const EMU_PER_PT = 12700

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
  return fallbacks ? fallbacks.join(', ') : `${fontName}, Calibri, Arial, sans-serif`
}

function ptToCqw(pt: number, slideWidth: number): string {
  return `${((pt * EMU_PER_PT) / slideWidth) * 100}cqw`
}

const ALIGN_MAP: Record<string, CSSProperties['textAlign']> = {
  l: 'left', ctr: 'center', r: 'right', just: 'justify'
}

function CellContent({ runs, slideWidth }: { runs: TextRun[]; slideWidth: number }): React.JSX.Element {
  const paragraphs: TextRun[][] = []
  let current: TextRun[] = []
  for (const run of runs) {
    if (run.text === '\n') { paragraphs.push(current); current = [] }
    else current.push(run)
  }
  if (current.length > 0) paragraphs.push(current)

  return (
    <>
      {paragraphs.map((paraRuns, pIdx) => {
        const align = paraRuns[0]?.paragraphAlign
        return (
          <p key={pIdx} style={{ textAlign: align ? ALIGN_MAP[align] : 'left', margin: 0, padding: 0, minHeight: '1em' }}>
            {paraRuns.map((run, rIdx) => (
              <span key={rIdx} style={{
                fontFamily: resolveFontFamily(run.font),
                fontSize: run.size > 0 ? ptToCqw(run.size, slideWidth) : undefined,
                fontWeight: run.bold ? 'bold' : 'normal',
                fontStyle: run.italic ? 'italic' : 'normal',
                color: run.color || 'inherit',
                textDecoration: [run.underline && 'underline', run.strikethrough && 'line-through'].filter(Boolean).join(' ') || undefined
              }}>{run.text}</span>
            ))}
          </p>
        )
      })}
    </>
  )
}

interface TableOverlayProps {
  element: DoclingElement
  slideWidth?: number
  slideHeight?: number
}

export function TableOverlay({ element, slideWidth = DEFAULT_W, slideHeight = DEFAULT_H }: TableOverlayProps): React.JSX.Element | null {
  const { tableRows, colWidths, bbox } = element
  if (!tableRows || !colWidths || colWidths.length === 0) return null

  const totalColWidth = colWidths.reduce((a, b) => a + b, 0) || 1
  const totalRowHeight = tableRows.reduce((a, r) => a + r.height, 0) || 1

  const tableStyle: CSSProperties = {
    position: 'absolute',
    left: `${(bbox.x / slideWidth) * 100}%`,
    top: `${(bbox.y / slideHeight) * 100}%`,
    width: `${(bbox.width / slideWidth) * 100}%`,
    height: `${(bbox.height / slideHeight) * 100}%`
  }

  return (
    <div className="table-overlay" style={tableStyle}>
      <table style={{
        width: '100%',
        height: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        border: '1px solid rgba(0,0,0,0.15)'
      }}>
        <colgroup>
          {colWidths.map((w, i) => (
            <col key={i} style={{ width: `${(w / totalColWidth) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {tableRows.map((row, rIdx) => (
            <tr key={rIdx} style={{ height: `${(row.height / totalRowHeight) * 100}%` }}>
              {row.cells
                .filter(cell => !cell.isContinuation)
                .map((cell, cIdx) => (
                  <td
                    key={cIdx}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    style={{
                      background: cell.fillColor ?? 'transparent',
                      padding: '1% 2%',
                      verticalAlign: 'middle',
                      overflow: 'hidden',
                      border: '1px solid rgba(0,0,0,0.15)',
                      boxSizing: 'border-box'
                    }}
                  >
                    <CellContent runs={cell.textRuns} slideWidth={slideWidth} />
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
