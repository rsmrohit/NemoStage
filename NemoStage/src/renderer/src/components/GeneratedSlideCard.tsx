import type { CSSProperties } from 'react'
import type { GeneratedSlide, GeneratedTemplateTextBox } from '../types/presentation'

interface Props {
  slide: GeneratedSlide
}

function colorLuminance(hexColor: string): number {
  const hex = hexColor.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16) || 0
  const g = parseInt(hex.slice(2, 4), 16) || 0
  const b = parseInt(hex.slice(4, 6), 16) || 0
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function textAlignFor(box: GeneratedTemplateTextBox): CSSProperties['textAlign'] {
  if (box.align === 'ctr') return 'center'
  if (box.align === 'r') return 'right'
  if (box.align === 'just') return 'justify'
  return 'left'
}

function fontSizeFor(box: GeneratedTemplateTextBox): string {
  if (!box.font_size) return box.role === 'title' ? '1.65rem' : '1rem'
  const rem = Math.max(0.72, Math.min(2.4, box.font_size / 20))
  return `${rem.toFixed(2)}rem`
}

export function GeneratedSlideCard({ slide }: Props) {
  if (slide.template?.text_boxes?.length) {
    const template = slide.template
    const bg = template.bg_color || slide.style_hint?.bg || '#1a1a2e'
    const fallbackText = colorLuminance(bg) > 0.5 ? '#1a1a2e' : '#f4f4f5'
    const contentById = new Map((slide.text_boxes ?? []).map((box) => [box.id, box.text]))
    let bulletIndex = 0

    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: bg,
          boxSizing: 'border-box',
          fontFamily: slide.style_hint?.font || 'Calibri, sans-serif',
          position: 'relative',
          color: fallbackText
        }}
      >
        {template.text_boxes.map((box) => {
          let text = contentById.get(box.id) ?? ''
          if (!text && box.role === 'title') {
            text = slide.title
          } else if (!text && slide.bullets?.[bulletIndex]) {
            text = slide.bullets[bulletIndex]
            bulletIndex += 1
          }

          if (box.role === 'image') {
            return (
              <div
                key={box.id}
                style={{
                  position: 'absolute',
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.06)',
                  border: `1px dashed rgba(255,255,255,0.2)`,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'rgba(255,255,255,0.3)',
                  fontSize: '0.7rem',
                  fontStyle: 'italic',
                }}
              >
                image
              </div>
            )
          }

          if (box.role === 'chart') {
            return (
              <div
                key={box.id}
                style={{
                  position: 'absolute',
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  boxSizing: 'border-box',
                  background: 'rgba(255,255,255,0.06)',
                  border: `1px dashed rgba(255,255,255,0.2)`,
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'rgba(255,255,255,0.3)',
                  fontSize: '0.7rem',
                  fontStyle: 'italic',
                }}
              >
                chart
              </div>
            )
          }

          return (
            <div
              key={box.id}
              style={{
                position: 'absolute',
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.w * 100}%`,
                height: `${box.h * 100}%`,
                boxSizing: 'border-box',
                overflow: 'hidden',
                display: 'flex',
                alignItems: box.role === 'title' ? 'center' : 'flex-start',
                justifyContent: textAlignFor(box) === 'center' ? 'center' : 'flex-start',
                padding: box.role === 'title' ? '0.3rem 0.45rem' : '0.25rem 0.35rem',
                color: box.color || fallbackText,
                fontFamily: box.font_family || slide.style_hint?.font || 'Calibri, sans-serif',
                fontSize: fontSizeFor(box),
                fontWeight: box.bold || box.role === 'title' ? 700 : 400,
                fontStyle: box.italic ? 'italic' : 'normal',
                lineHeight: box.role === 'title' ? 1.12 : 1.28,
                textAlign: textAlignFor(box),
                whiteSpace: 'pre-wrap'
              }}
            >
              {text}
            </div>
          )
        })}
      </div>
    )
  }

  const bg = slide.style_hint?.bg || '#1a1a2e'
  const accent = slide.style_hint?.accent || '#4f8ef7'
  const font = slide.style_hint?.font || 'Calibri, sans-serif'
  const luminance = colorLuminance(bg)
  const textColor = luminance > 0.5 ? '#1a1a2e' : '#f4f4f5'
  const mutedColor = luminance > 0.5 ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.55)'

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: bg,
        display: 'flex',
        flexDirection: 'column',
        padding: '8% 10%',
        boxSizing: 'border-box',
        fontFamily: font,
        position: 'relative',
        color: textColor
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '4%',
          right: '4%',
          background: accent,
          color: '#fff',
          fontSize: '0.75em',
          fontWeight: 700,
          padding: '4px 10px',
          borderRadius: 999,
          letterSpacing: '0.06em',
          textTransform: 'uppercase'
        }}
      >
        AI
      </div>

      <div style={{ width: 56, height: 4, background: accent, borderRadius: 2, marginBottom: '6%' }} />

      <div
        style={{
          fontSize: '2rem',
          fontWeight: 700,
          lineHeight: 1.2,
          marginBottom: '5%',
          maxWidth: '85%'
        }}
      >
        {slide.title}
      </div>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '2.5%',
          flex: 1
        }}
      >
        {slide.bullets.map((bullet, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span style={{ color: accent, fontSize: '1.1em', lineHeight: 1.4, flexShrink: 0 }}>{'>'}</span>
            <span style={{ fontSize: '1.1rem', lineHeight: 1.5 }}>{bullet}</span>
          </li>
        ))}
      </ul>

      <div
        style={{
          position: 'absolute',
          bottom: '4%',
          left: '10%',
          right: '10%',
          fontSize: '0.65em',
          color: mutedColor,
          display: 'flex',
          justifyContent: 'space-between'
        }}
      >
        <span>Generated from your deck</span>
        <span>Topic: {slide.topic}</span>
      </div>
    </div>
  )
}
