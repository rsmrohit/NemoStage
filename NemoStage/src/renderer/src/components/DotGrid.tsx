import { useEffect, useRef } from 'react'

const SPACING = 34       // px between dots
const DOT_R = 1.8        // resting dot radius
const BLOB_COUNT = 3
const BLOB_INFLUENCE = 150  // radius of influence
const MAX_SPEED = 1.1
const [GR, GG, GB] = [116, 255, 2] // #74ff02

interface Blob {
  x: number; y: number
  vx: number; vy: number
  tx: number; ty: number
}

function makeBlobs(w: number, h: number): Blob[] {
  return Array.from({ length: BLOB_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2
    const spd = 0.6 + Math.random() * 0.5
    return {
      x: Math.random() * w, y: Math.random() * h,
      vx: Math.cos(angle) * spd, vy: Math.sin(angle) * spd,
      tx: Math.random() * w, ty: Math.random() * h
    }
  })
}

export function DotGrid(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const blobsRef = useRef<Blob[]>([])
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = canvas.offsetWidth || 800
    let h = canvas.offsetHeight || 600
    canvas.width = w
    canvas.height = h
    blobsRef.current = makeBlobs(w, h)

    const tick = (): void => {
      const nw = canvas.offsetWidth
      const nh = canvas.offsetHeight
      if (nw !== w || nh !== h) {
        w = nw; h = nh
        canvas.width = w; canvas.height = h
      }

      ctx.clearRect(0, 0, w, h)

      // update blobs — organic steering toward a wandering target
      for (const b of blobsRef.current) {
        b.vx += (b.tx - b.x) * 0.0007 + (Math.random() - 0.5) * 0.06
        b.vy += (b.ty - b.y) * 0.0007 + (Math.random() - 0.5) * 0.06
        const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
        if (spd > MAX_SPEED) { b.vx = b.vx / spd * MAX_SPEED; b.vy = b.vy / spd * MAX_SPEED }
        b.x += b.vx; b.y += b.vy
        if (b.x < 0 || b.x > w) b.vx *= -1
        if (b.y < 0 || b.y > h) b.vy *= -1
        b.x = Math.max(0, Math.min(w, b.x))
        b.y = Math.max(0, Math.min(h, b.y))
        const ddx = b.tx - b.x; const ddy = b.ty - b.y
        if (ddx * ddx + ddy * ddy < 400) { b.tx = Math.random() * w; b.ty = Math.random() * h }
      }

      const blobs = blobsRef.current
      const cols = Math.ceil(w / SPACING) + 1
      const rows = Math.ceil(h / SPACING) + 1
      const ox = (w % SPACING) / 2
      const oy = (h % SPACING) / 2

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const px = ox + c * SPACING
          const py = oy + r * SPACING

          // max intensity across all blobs (quadratic falloff = soft edge)
          let intensity = 0
          for (const b of blobs) {
            const dx = px - b.x; const dy = py - b.y
            const d2 = dx * dx + dy * dy
            const t = Math.max(0, 1 - Math.sqrt(d2) / BLOB_INFLUENCE)
            if (t > intensity) intensity = t * t
          }

          const opacity = 0.05 + intensity * 0.88
          const radius = DOT_R + intensity * 2.2

          // soft bloom halo for bright dots
          if (intensity > 0.25) {
            ctx.beginPath()
            ctx.arc(px, py, radius * 4, 0, Math.PI * 2)
            ctx.fillStyle = `rgba(${GR},${GG},${GB},${intensity * 0.07})`
            ctx.fill()
          }

          // core dot
          ctx.beginPath()
          ctx.arc(px, py, radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${GR},${GG},${GB},${opacity})`
          ctx.fill()
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 0
      }}
    />
  )
}
