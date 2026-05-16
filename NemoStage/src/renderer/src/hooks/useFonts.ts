import { useCallback, useRef, useState } from 'react'
import type { EmbeddedFontEntry } from '../../../preload/index.d'

export function useFonts(): {
  fontsVersion: number
  loadFonts: (entries: EmbeddedFontEntry[], format: 'truetype' | 'woff2') => Promise<void>
  clearFonts: () => void
} {
  const [fontsVersion, setFontsVersion] = useState(0)
  const addedFacesRef = useRef<FontFace[]>([])

  const loadFonts = useCallback(
    async (entries: EmbeddedFontEntry[], format: 'truetype' | 'woff2'): Promise<void> => {
      const faces: FontFace[] = []

      for (const entry of entries) {
        const add = (url: string, weight: string, style: string): void => {
          const face = new FontFace(entry.name, `url("${url}") format("${format}")`, {
            weight,
            style
          })
          document.fonts.add(face)
          addedFacesRef.current.push(face)
          faces.push(face)
        }

        add(entry.url, 'normal', 'normal')
        if (entry.boldUrl) add(entry.boldUrl, 'bold', 'normal')
        if (entry.italicUrl) add(entry.italicUrl, 'normal', 'italic')
        if (entry.boldItalicUrl) add(entry.boldItalicUrl, 'bold', 'italic')
      }

      await Promise.allSettled(faces.map((f) => f.load()))
      setFontsVersion((v) => v + 1)
    },
    []
  )

  const clearFonts = useCallback((): void => {
    for (const face of addedFacesRef.current) {
      document.fonts.delete(face)
    }
    addedFacesRef.current = []
    setFontsVersion(0)
  }, [])

  return { fontsVersion, loadFonts, clearFonts }
}
