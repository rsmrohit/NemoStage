import type { GeneratedSlide } from '../types/presentation'

interface Props {
  slide: GeneratedSlide
}

export function GeneratedSlideCard({ slide }: Props) {
  const bg = slide.style_hint?.bg || '#1a1a2e'
  const accent = slide.style_hint?.accent || '#4f8ef7'
  const font = slide.style_hint?.font || 'Calibri, sans-serif'

  // Decide text color based on bg brightness
  const hex = bg.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16) || 0
  const g = parseInt(hex.slice(2, 4), 16) || 0
  const b = parseInt(hex.slice(4, 6), 16) || 0
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
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
        color: textColor,
      }}
    >
      {/* AI badge */}
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
          textTransform: 'uppercase',
        }}
      >
        AI
      </div>

      {/* Accent bar */}
      <div style={{ width: 56, height: 4, background: accent, borderRadius: 2, marginBottom: '6%' }} />

      {/* Title */}
      <div
        style={{
          fontSize: 'clamp(1.2rem, 3vw, 2.2rem)',
          fontWeight: 700,
          lineHeight: 1.2,
          marginBottom: '5%',
          maxWidth: '85%',
        }}
      >
        {slide.title}
      </div>

      {/* Bullets */}
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '2.5%',
          flex: 1,
        }}
      >
        {slide.bullets.map((bullet, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span style={{ color: accent, fontSize: '1.1em', lineHeight: 1.4, flexShrink: 0 }}>▸</span>
            <span style={{ fontSize: 'clamp(0.85rem, 1.8vw, 1.25rem)', lineHeight: 1.5 }}>{bullet}</span>
          </li>
        ))}
      </ul>

      {/* Footer */}
      <div
        style={{
          position: 'absolute',
          bottom: '4%',
          left: '10%',
          right: '10%',
          fontSize: '0.65em',
          color: mutedColor,
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>Generated from your deck</span>
        <span>Topic: {slide.topic}</span>
      </div>
    </div>
  )
}
