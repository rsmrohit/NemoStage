import https from 'https'
import fs from 'fs-extra'
import path from 'path'
import { app } from 'electron'
import type { EmbeddedFontEntry } from '../types'
import { pathToMediaUrl } from './mediaProtocol'

// Weight suffix → numeric weight. Ordered longest-first to avoid partial matches.
const WEIGHT_SUFFIXES: [string, number][] = [
  ['ExtraBold', 800],
  ['Extra Bold', 800],
  ['SemiBold', 600],
  ['Semi Bold', 600],
  ['DemiBold', 600],
  ['Medium', 500],
  ['ExtraLight', 200],
  ['Extra Light', 200],
  ['UltraLight', 200],
  ['Ultra Light', 200],
  ['Light', 300],
  ['Thin', 100],
  ['Black', 900],
  ['Heavy', 900],
  ['Bold', 700],
  ['Regular', 400],
]

function parseFontName(pptxName: string): { family: string; weight: number } {
  const lower = pptxName.toLowerCase()
  for (const [suffix, weight] of WEIGHT_SUFFIXES) {
    if (lower.endsWith(' ' + suffix.toLowerCase())) {
      return { family: pptxName.slice(0, pptxName.length - suffix.length - 1), weight }
    }
  }
  return { family: pptxName, weight: 400 }
}

function httpsGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location, headers))
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

function httpsDownload(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsDownload(res.headers.location))
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

export async function downloadGoogleFonts(pptxFontNames: string[]): Promise<EmbeddedFontEntry[]> {
  const cacheDir = path.join(app.getPath('userData'), 'font-cache')
  await fs.ensureDir(cacheDir)

  const entries: EmbeddedFontEntry[] = []

  for (const pptxName of pptxFontNames) {
    try {
      const { family, weight } = parseFontName(pptxName)
      const familyParam = encodeURIComponent(family).replace(/%20/g, '+')
      // Request regular + italic at the base weight; also bold weight for the bold variant
      const boldWeight = weight >= 700 ? weight : Math.min(weight + 300, 900)
      const cssUrl = `https://fonts.googleapis.com/css2?family=${familyParam}:ital,wght@0,${weight};0,${boldWeight};1,${weight};1,${boldWeight}&display=swap`

      console.log(`[googleFonts] Fetching CSS for "${pptxName}" → family="${family}" weight=${weight}`)
      const css = await httpsGet(cssUrl, {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      })

      // Collect last @font-face block per (weight, style) — Google Fonts puts Latin last
      const blockRe = /@font-face\s*\{([^}]+)\}/g
      const fontsByKey = new Map<string, { url: string; weight: number; italic: boolean }>()

      for (const match of css.matchAll(blockRe)) {
        const block = match[1]
        const styleMatch = block.match(/font-style:\s*(\w+)/)
        const weightMatch = block.match(/font-weight:\s*(\d+)/)
        const urlMatch = block.match(/url\(([^)]+)\)/)
        if (!urlMatch) continue
        const fontUrl = urlMatch[1].replace(/['"]/g, '')
        const isItalic = styleMatch?.[1] === 'italic'
        const blockWeight = parseInt(weightMatch?.[1] ?? '400')
        const key = `${blockWeight}-${isItalic ? 'italic' : 'normal'}`
        fontsByKey.set(key, { url: fontUrl, weight: blockWeight, italic: isItalic })
      }

      const familySafe = family.replace(/[^a-zA-Z0-9]/g, '_')

      const download = async (key: string, label: string): Promise<string | null> => {
        const entry = fontsByKey.get(key)
        if (!entry) return null
        const fileName = `${familySafe}_${entry.weight}_${label}.woff2`
        const filePath = path.join(cacheDir, fileName)
        if (!await fs.pathExists(filePath)) {
          console.log(`[googleFonts] Downloading ${label} → ${fileName}`)
          const data = await httpsDownload(entry.url)
          await fs.writeFile(filePath, data)
        } else {
          console.log(`[googleFonts] Cache hit: ${fileName}`)
        }
        return filePath
      }

      const regularPath = await download(`${weight}-normal`, 'regular')
      if (!regularPath) {
        console.warn(`[googleFonts] No regular variant found for "${pptxName}" — skipping`)
        continue
      }

      const italicPath = await download(`${weight}-italic`, 'italic')
      const boldPath = boldWeight !== weight ? await download(`${boldWeight}-normal`, 'bold') : null
      const boldItalicPath = boldWeight !== weight ? await download(`${boldWeight}-italic`, 'boldItalic') : null

      entries.push({
        name: pptxName,
        url: pathToMediaUrl(regularPath),
        italicUrl: italicPath ? pathToMediaUrl(italicPath) : undefined,
        boldUrl: boldPath ? pathToMediaUrl(boldPath) : undefined,
        boldItalicUrl: boldItalicPath ? pathToMediaUrl(boldItalicPath) : undefined
      })

      console.log(`[googleFonts] ✅ "${pptxName}"`)
    } catch (e) {
      console.warn(`[googleFonts] Failed to download "${pptxName}":`, e)
    }
  }

  return entries
}
