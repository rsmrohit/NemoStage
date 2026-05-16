import fs from 'fs-extra'
import path from 'path'
import PizZip from 'pizzip'
import { XMLParser } from 'fast-xml-parser'
import type { ExtractionProgressEvent, SlideManifestEntry } from '../types'

const IMAGE_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ''
})

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

export async function extractPPTX(
  filePath: string,
  sessionDir: string,
  onProgress?: (event: ExtractionProgressEvent) => void
): Promise<{ slides: SlideManifestEntry[]; fonts: string[] }> {
  const data = await fs.readFile(filePath)
  const zip = new PizZip(data)

  const fileNames = Object.keys(zip.files)
  const rawDir = path.join(sessionDir, 'raw')

  let processed = 0
  for (const zipFilePath of fileNames) {
    const zipFile = zip.files[zipFilePath]
    if (!zipFile.dir) {
      const content = zipFile.asNodeBuffer()
      await fs.outputFile(path.join(rawDir, zipFilePath), content)
    }

    processed += 1
    onProgress?.({
      phase: 'extracting_images',
      progress: Math.min(0.7, (processed / Math.max(fileNames.length, 1)) * 0.7),
      message: 'Extracting package files'
    })
  }

  await extractMediaFiles(zip, sessionDir)
  onProgress?.({ phase: 'extracting_images', progress: 0.85, message: 'Extracting media files' })

  const slides = await parseSlideRelationships(rawDir, sessionDir)
  const fonts = await extractThemeFonts(rawDir)

  onProgress?.({ phase: 'extracting_images', progress: 1, message: 'Slide extraction complete' })

  return { slides, fonts }
}

export async function extractMediaFiles(zip: PizZip, sessionDir: string): Promise<void> {
  const mediaDir = path.join(sessionDir, 'media')
  const mediaFiles = Object.keys(zip.files).filter((filePath) => filePath.startsWith('ppt/media/'))

  await Promise.all(
    mediaFiles.map(async (mediaPath) => {
      const file = zip.files[mediaPath]
      if (!file || file.dir) {
        return
      }

      const content = file.asNodeBuffer()
      const targetPath = path.join(mediaDir, path.basename(mediaPath))
      await fs.outputFile(targetPath, content)
    })
  )
}

export async function parseSlideRelationships(
  rawDir: string,
  sessionDir: string
): Promise<SlideManifestEntry[]> {
  const slideDir = path.join(rawDir, 'ppt/slides')
  const relationDir = path.join(slideDir, '_rels')

  const slideFiles = (await fs.readdir(slideDir).catch(() => []))
    .filter((fileName) => /^slide\d+\.xml$/i.test(fileName))
    .sort((left, right) => getSlideIndex(left) - getSlideIndex(right))

  const result: SlideManifestEntry[] = []

  for (const slideFile of slideFiles) {
    const slideIndex = getSlideIndex(slideFile)
    const relationFileName = `${slideFile}.rels`
    const relationPath = path.join(relationDir, relationFileName)
    const imagePaths: string[] = []

    const relationXml = await fs.readFile(relationPath, 'utf-8').catch(() => null)
    if (relationXml) {
      const parsed = xmlParser.parse(relationXml)
      const relationships = normalizeArray(parsed?.Relationships?.Relationship)

      for (const relationship of relationships) {
        if (
          relationship.Type !== IMAGE_RELATIONSHIP_TYPE ||
          typeof relationship.Target !== 'string'
        ) {
          continue
        }

        const target = relationship.Target.replace('../media/', '')
        const absolutePath = path.join(sessionDir, 'media', path.basename(target))
        imagePaths.push(absolutePath)
      }
    }

    const thumbnailPath = imagePaths[0] ?? buildSlideFallbackImagePath(sessionDir, slideIndex)
    result.push({
      slideIndex,
      imagePaths: thumbnailPath ? [thumbnailPath, ...imagePaths.slice(1)] : []
    })
  }

  return result
}

function buildSlideFallbackImagePath(sessionDir: string, slideIndex: number): string | null {
  const guessedName = `slide${slideIndex + 1}.png`
  const absolutePath = path.join(sessionDir, 'media', guessedName)
  return fs.pathExistsSync(absolutePath) ? absolutePath : null
}

function getSlideIndex(slideFileName: string): number {
  const match = slideFileName.match(/slide(\d+)\.xml/i)
  if (!match) {
    return 0
  }
  return Number(match[1]) - 1
}

export async function extractThemeFonts(rawDir: string): Promise<string[]> {
  const themePath = path.join(rawDir, 'ppt/theme/theme1.xml')
  const xml = await fs.readFile(themePath, 'utf-8').catch(() => null)
  if (!xml) {
    return []
  }

  const parsed = xmlParser.parse(xml)
  const latinFonts = [
    parsed?.['a:theme']?.['a:themeElements']?.['a:fontScheme']?.['a:majorFont']?.['a:latin']
      ?.typeface,
    parsed?.['a:theme']?.['a:themeElements']?.['a:fontScheme']?.['a:minorFont']?.['a:latin']
      ?.typeface
  ]

  const additionalFonts = normalizeArray(
    parsed?.['a:theme']?.['a:themeElements']?.['a:fontScheme']?.['a:majorFont']?.['a:font']
  )
    .map((font) => font.typeface)
    .filter((font): font is string => typeof font === 'string' && font.length > 0)

  return Array.from(
    new Set(
      [...latinFonts, ...additionalFonts].filter(
        (font): font is string => typeof font === 'string' && font.trim().length > 0
      )
    )
  )
}
