import type { GeneratedSlide } from '../types/presentation'

interface Props {
  slide: GeneratedSlide
}

function normalizeHex(color?: string | null): string | null {
  if (!color) return null
  const value = color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value
  if (/^[0-9a-fA-F]{6}$/.test(value)) return `#${value}`
  return null
}

function colorLuminance(hexColor: string): number {
  const hex = hexColor.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16) || 0
  const g = parseInt(hex.slice(2, 4), 16) || 0
  const b = parseInt(hex.slice(4, 6), 16) || 0
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function paletteFor(slide: GeneratedSlide) {
  const templateColors = slide.template?.colors?.map(normalizeHex).filter(Boolean) as string[]
  const bg =
    normalizeHex(slide.template?.bg_color) ?? normalizeHex(slide.style_hint?.bg) ?? '#1a1a2e'
  const accent =
    normalizeHex(slide.style_hint?.accent) ??
    templateColors.find((color) => color.toLowerCase() !== bg.toLowerCase()) ??
    '#4f8ef7'
  const secondary =
    templateColors.find(
      (color) =>
        color.toLowerCase() !== bg.toLowerCase() && color.toLowerCase() !== accent.toLowerCase()
    ) ?? accent
  const isLight = colorLuminance(bg) > 0.58

  return {
    bg,
    accent,
    secondary,
    text: isLight ? '#141418' : '#f7f7fb',
    muted: isLight ? 'rgba(20,20,24,0.58)' : 'rgba(247,247,251,0.64)',
    panel: isLight ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.08)',
    rule: isLight ? 'rgba(20,20,24,0.12)' : 'rgba(255,255,255,0.16)'
  }
}

function contentFor(slide: GeneratedSlide): string[] {
  if (slide.bullets.length) return slide.bullets

  const filledText = slide.text_boxes?.map((box) => box.text.trim()).filter(Boolean) ?? []
  return filledText.slice(0, 4)
}

export function GeneratedSlideCard({ slide }: Props) {
  const palette = paletteFor(slide)
  const font = slide.style_hint?.font || 'Calibri, sans-serif'
  const content = contentFor(slide)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: palette.bg,
        boxSizing: 'border-box',
        color: palette.text,
        display: 'grid',
        fontFamily: font,
        gridTemplateRows: 'auto 1fr auto',
        overflow: 'hidden',
        padding: '7% 9%',
        position: 'relative'
      }}
    >
      <div
        style={{
          background: palette.accent,
          height: '100%',
          left: 0,
          opacity: 0.95,
          position: 'absolute',
          top: 0,
          width: 10
        }}
      />

      <header>
        <div
          style={{
            alignItems: 'center',
            color: palette.muted,
            display: 'flex',
            fontSize: '0.68rem',
            fontWeight: 700,
            gap: 10,
            letterSpacing: '0.08em',
            marginBottom: '4%',
            textTransform: 'uppercase'
          }}
        >
          <span
            style={{
              background: palette.accent,
              borderRadius: 999,
              display: 'inline-block',
              height: 8,
              width: 8
            }}
          />
          <span>{slide.topic || 'Generated slide'}</span>
        </div>

        <h2
          style={{
            fontSize: '1.95rem',
            fontWeight: 750,
            lineHeight: 1.08,
            margin: 0,
            maxWidth: '88%'
          }}
        >
          {slide.title || 'Untitled slide'}
        </h2>
      </header>

      <main
        style={{
          alignSelf: 'center',
          display: 'grid',
          gap: 12,
          marginTop: '5%'
        }}
      >
        {content.length ? (
          content.slice(0, 5).map((item, index) => (
            <div
              key={`${item}-${index}`}
              style={{
                alignItems: 'flex-start',
                background: palette.panel,
                border: `1px solid ${palette.rule}`,
                borderRadius: 8,
                display: 'grid',
                gap: 12,
                gridTemplateColumns: 'auto 1fr',
                padding: '0.75rem 0.85rem'
              }}
            >
              <span
                style={{
                  background: index % 2 === 0 ? palette.accent : palette.secondary,
                  borderRadius: 999,
                  color: '#fff',
                  display: 'grid',
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  height: 24,
                  lineHeight: 1,
                  placeItems: 'center',
                  width: 24
                }}
              >
                {index + 1}
              </span>
              <span style={{ fontSize: '1.03rem', lineHeight: 1.35 }}>{item}</span>
            </div>
          ))
        ) : (
          <div
            style={{
              border: `1px dashed ${palette.rule}`,
              borderRadius: 8,
              color: palette.muted,
              fontSize: '1rem',
              padding: '1rem'
            }}
          >
            Add supporting points here.
          </div>
        )}
      </main>

      <footer
        style={{
          alignItems: 'center',
          borderTop: `1px solid ${palette.rule}`,
          color: palette.muted,
          display: 'flex',
          fontSize: '0.68rem',
          justifyContent: 'space-between',
          marginTop: '5%',
          paddingTop: '3%'
        }}
      >
        <span>Generated from your deck</span>
        <span>Slide {slide.index + 1}</span>
      </footer>
    </div>
  )
}
