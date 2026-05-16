import { useEffect, useRef } from 'react'
import type { QAEntry } from '../types/presentation'

interface Props {
  entry: QAEntry | null
  onDismiss: () => void
}

export function QAOverlay({ entry, onDismiss }: Props) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!entry) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(onDismiss, 20_000)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [entry, onDismiss])

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 32,
        right: 32,
        width: 380,
        maxWidth: 'calc(100vw - 48px)',
        maxHeight: '40vh',
        background: '#18181b',
        border: '1px solid #2a2a2e',
        borderRadius: 16,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000,
        transition: 'opacity 0.25s ease, transform 0.25s ease',
        opacity: entry ? 1 : 0,
        transform: entry ? 'translateY(0)' : 'translateY(24px)',
        pointerEvents: entry ? 'auto' : 'none',
      }}
    >
      {entry && (
        <>
          {/* Header */}
          <div
            style={{
              padding: '12px 16px 10px',
              borderBottom: '1px solid #2a2a2e',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  background: '#6366f1',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 999,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Q&amp;A
              </span>
              <span style={{ color: '#71717a', fontSize: 12 }}>Audience question</span>
            </div>
            <button
              onClick={onDismiss}
              style={{
                background: 'none',
                border: 'none',
                color: '#71717a',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: '2px 4px',
                borderRadius: 4,
              }}
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '12px 16px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Question */}
            <div
              style={{
                color: '#a1a1aa',
                fontSize: 13,
                fontStyle: 'italic',
                borderLeft: '2px solid #3f3f46',
                paddingLeft: 10,
                lineHeight: 1.45,
              }}
            >
              {entry.question}
            </div>

            {/* Answer */}
            <div
              style={{
                color: '#f4f4f5',
                fontSize: 14,
                lineHeight: 1.6,
                borderLeft: '2px solid #6366f1',
                paddingLeft: 10,
              }}
            >
              {entry.answer}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
