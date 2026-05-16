import { useEffect, useRef } from 'react'

const COLOR = '#4acc00'
const COUNT = 15

interface Critter {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  rotSpeed: number
  size: number
  opacity: number
}

function LobsterSvg({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
      {/* tail fan */}
      <path d="M30 52 L22 60 L28 54 L30 58 L32 54 L38 60 Z" fill={COLOR} />
      {/* body segments */}
      <ellipse cx="30" cy="46" rx="6" ry="4" fill={COLOR} />
      <ellipse cx="30" cy="38" rx="7" ry="5" fill={COLOR} />
      <ellipse cx="30" cy="29" rx="8" ry="5" fill={COLOR} />
      {/* carapace */}
      <ellipse cx="30" cy="20" rx="10" ry="11" fill={COLOR} />
      {/* claws */}
      <path d="M20 14 Q8 6 6 16 Q8 24 20 20 Z" fill={COLOR} />
      <path d="M40 14 Q52 6 54 16 Q52 24 40 20 Z" fill={COLOR} />
      {/* walking legs */}
      <line x1="22" y1="20" x2="10" y2="17" stroke={COLOR} strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="26" x2="9"  y2="26" stroke={COLOR} strokeWidth="2" strokeLinecap="round" />
      <line x1="22" y1="32" x2="11" y2="34" stroke={COLOR} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="20" x2="50" y2="17" stroke={COLOR} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="26" x2="51" y2="26" stroke={COLOR} strokeWidth="2" strokeLinecap="round" />
      <line x1="38" y1="32" x2="49" y2="34" stroke={COLOR} strokeWidth="2" strokeLinecap="round" />
      {/* antennae */}
      <line x1="25" y1="10" x2="12" y2="1" stroke={COLOR} strokeWidth="1.5" strokeLinecap="round" />
      <line x1="35" y1="10" x2="48" y2="1" stroke={COLOR} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Generate stable random critter descriptors once per mount
function makeCritters(): Critter[] {
  return Array.from({ length: COUNT }, () => {
    const speed = 0.3 + Math.random() * 0.55
    const angle = Math.random() * Math.PI * 2
    return {
      x: 0, y: 0, // positioned after mount when we know container size
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 0.7,
      size: 45 + Math.floor(Math.random() * 32),
      opacity: 0.15 + Math.random() * 0.13
    }
  })
}

export function LobsterBackground(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const crittersRef = useRef<Critter[]>(makeCritters())
  const rafRef = useRef<number>(0)
  const elRefs = useRef<(HTMLDivElement | null)[]>(Array(COUNT).fill(null))

  // stable render-time descriptors (size/opacity don't change)
  const descriptors = crittersRef.current

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const w = container.offsetWidth || 800
    const h = container.offsetHeight || 600

    // seed positions now that we know the container size
    crittersRef.current.forEach((c) => {
      c.x = Math.random() * (w - c.size)
      c.y = Math.random() * (h - c.size)
    })

    const tick = (): void => {
      const cw = container.offsetWidth
      const ch = container.offsetHeight
      crittersRef.current.forEach((c, i) => {
        c.x += c.vx
        c.y += c.vy
        c.rot += c.rotSpeed

        if (c.x < 0)          { c.x = 0;           c.vx =  Math.abs(c.vx) }
        if (c.x > cw - c.size) { c.x = cw - c.size; c.vx = -Math.abs(c.vx) }
        if (c.y < 0)          { c.y = 0;           c.vy =  Math.abs(c.vy) }
        if (c.y > ch - c.size) { c.y = ch - c.size; c.vy = -Math.abs(c.vy) }

        const el = elRefs.current[i]
        if (el) el.style.transform = `translate(${c.x}px, ${c.y}px) rotate(${c.rot}deg)`
      })
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}
    >
      {descriptors.map((c, i) => (
        <div
          key={i}
          ref={(el) => { elRefs.current[i] = el }}
          style={{ position: 'absolute', top: 0, left: 0, opacity: c.opacity, willChange: 'transform' }}
        >
          <LobsterSvg size={c.size} />
        </div>
      ))}
    </div>
  )
}
