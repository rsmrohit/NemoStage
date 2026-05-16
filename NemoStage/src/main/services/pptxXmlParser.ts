import PizZip from 'pizzip'
import { parseStringPromise } from 'xml2js'
import fs from 'fs-extra'
import path from 'path'
import type { PptxManifest, PptxSlide, PptxElement, TextRun, ImageCrop } from '../types'

export async function parsePPTXStructure(
  pptxPath: string,
  sessionDir: string
): Promise<PptxManifest> {
  console.log('[pptxXmlParser] Starting parse of:', pptxPath)
  
  // Read the PPTX file
  const data = await fs.readFile(pptxPath)
  const zip = new PizZip(data)
  
  // Get slide dimensions
  const { slideWidth, slideHeight } = await getSlideDimensions(zip)
  console.log('[pptxXmlParser] Slide dimensions:', { slideWidth, slideHeight })
  
  // Extract all images first
  const imagePathMap = await extractImagesToMedia(zip, sessionDir)
  
  // Parse each slide
  const slides: PptxSlide[] = []
  let slideNum = 1
  
  while (true) {
    const slideFile = zip.file(`ppt/slides/slide${slideNum}.xml`)
    if (!slideFile) break
    
    console.log(`[pptxXmlParser] Parsing slide ${slideNum}`)
    
    const slideXml = slideFile.asText()
    const slide = await parseSlide(slideXml, slideNum - 1, slideNum, zip, imagePathMap)
    
    // Get speaker notes (optional)
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideNum}.xml`)
    if (notesFile) {
      slide.speakerNotes = await parseSpeakerNotes(notesFile.asText())
    }
    
    slides.push(slide)
    slideNum++
  }
  
  console.log(`[pptxXmlParser] Parsed ${slides.length} slides`)
  
  return {
    slideCount: slides.length,
    slideWidth,
    slideHeight,
    slides
  }
}

async function getSlideDimensions(zip: PizZip): Promise<{ slideWidth: number, slideHeight: number }> {
  const presXmlFile = zip.file('ppt/presentation.xml')

  if (!presXmlFile) {
    // Default PowerPoint slide size
    return {
      slideWidth: 9144000,   // 10 inches in EMUs
      slideHeight: 6858000   // 7.5 inches in EMUs
    }
  }

  const presXml = presXmlFile.asText()
  const parsed = await parseStringPromise(presXml)
  const sldSz = parsed['p:presentation']?.$?.['p:sldSz']?.[0]?.$
  
  return {
    slideWidth: sldSz ? parseInt(sldSz.cx) : 9144000,
    slideHeight: sldSz ? parseInt(sldSz.cy) : 6858000
  }
}

async function parseSlide(
  xml: string,
  slideIndex: number,
  slideNum: number,
  zip: PizZip,
  imagePathMap: Map<string, string>
): Promise<PptxSlide> {
  const parsed = await parseStringPromise(xml)
  const elements: PptxElement[] = []
  
  // Get image relationships for this slide
  const imageRelationships = await parseSlideRelationships(zip, slideNum)
  
  // Navigate to the shape tree
  const spTree = parsed['p:sld']?.['p:cSld']?.[0]?.['p:spTree']?.[0]
  if (!spTree) {
    return { slideIndex, elements }
  }
  
  // Parse text shapes (p:sp)
  const shapes = spTree['p:sp'] || []
  for (const shape of shapes) {
    const element = await parseTextShape(shape)
    if (element) {
      elements.push(element)
    }
  }
  
  // Parse picture shapes (p:pic) - NOW WITH IMAGE RESOLUTION
  const pictures = spTree['p:pic'] || []
  for (const pic of pictures) {
    const element = await parsePictureShape(pic, imageRelationships, imagePathMap)
    if (element) {
      elements.push(element)
    }
  }
  
  return {
    slideIndex,
    elements
  }
}

async function parseTextShape(shape: any): Promise<PptxElement | null> {
  try {
    // Extract position and size
    const xfrm = shape['p:spPr']?.[0]?.['a:xfrm']?.[0]
    if (!xfrm) return null
    
    const off = xfrm['a:off']?.[0]?.$
    const ext = xfrm['a:ext']?.[0]?.$
    if (!off || !ext) return null
    
    const bbox = {
      x: parseInt(off.x || '0'),
      y: parseInt(off.y || '0'),
      width: parseInt(ext.cx || '0'),
      height: parseInt(ext.cy || '0')
    }
    
    // Extract text content
    const textBody = shape['p:txBody']?.[0]
    if (!textBody) return null
    
    const paragraphs = textBody['a:p'] || []
    let fullText = ''
    const textRuns: TextRun[] = []
    
    for (const para of paragraphs) {
      const runs = para['a:r'] || []
      
      for (const run of runs) {
        const text = run['a:t']?.[0] || ''
        fullText += text
        
        // Extract text properties
        const rPr = run['a:rPr']?.[0]
        
        textRuns.push({
          text,
          font: rPr?.$?.typeface || rPr?.['a:latin']?.[0]?.$?.typeface || 'Calibri',
          size: rPr?.$.sz ? parseInt(rPr.$.sz) / 100 : 18,
          bold: rPr?.$.b === '1',
          italic: rPr?.$.i === '1',
          color: extractColor(rPr)
        })
      }
      
      // Add newline between paragraphs
      if (paragraphs.indexOf(para) < paragraphs.length - 1) {
        fullText += '\n'
      }
    }
    
    return {
      type: 'text',
      bbox,
      content: fullText,
      textRuns
    }
  } catch (error) {
    console.error('[pptxXmlParser] Error parsing text shape:', error)
    return null
  }
}

async function parsePictureShape(
  pic: any,
  imageRelationships: Map<string, string>,
  imagePathMap: Map<string, string>
): Promise<PptxElement | null> {
  try {
    // Extract position and size
    const xfrm = pic['p:spPr']?.[0]?.['a:xfrm']?.[0]
    if (!xfrm) return null
    
    const off = xfrm['a:off']?.[0]?.$
    const ext = xfrm['a:ext']?.[0]?.$
    if (!off || !ext) return null
    
    const bbox = {
      x: parseInt(off.x || '0'),
      y: parseInt(off.y || '0'),
      width: parseInt(ext.cx || '0'),
      height: parseInt(ext.cy || '0')
    }
    
    // Get image reference
    const blipFill = pic['p:blipFill']?.[0]
    const blip = blipFill?.['a:blip']?.[0]
    const embedId = blip?.$?.['r:embed']
    
    if (!embedId) return null
    
    // Extract crop data from srcRect
    const srcRect = blipFill?.['a:srcRect']?.[0]?.$
    let crop: ImageCrop | undefined
    
    if (srcRect) {
      // PowerPoint stores crop as percentages (0-100000, where 100000 = 100%)
      crop = {
        left: srcRect.l ? parseInt(srcRect.l) / 1000 : 0,      // Convert to percentage
        top: srcRect.t ? parseInt(srcRect.t) / 1000 : 0,
        right: srcRect.r ? parseInt(srcRect.r) / 1000 : 0,
        bottom: srcRect.b ? parseInt(srcRect.b) / 1000 : 0
      }
      
      console.log(`[pptxXmlParser] Image crop:`, crop)
    }
    
    // Resolve embedId → image path
    const relativeImagePath = imageRelationships.get(embedId)
    if (!relativeImagePath) {
      console.warn(`[pptxXmlParser] No relationship found for embedId: ${embedId}`)
      return null
    }
    
    const absoluteImagePath = imagePathMap.get(relativeImagePath)
    if (!absoluteImagePath) {
      console.warn(`[pptxXmlParser] No image file found for path: ${relativeImagePath}`)
      return null
    }
    
    console.log(`[pptxXmlParser] Resolved image: ${embedId} → ${path.basename(absoluteImagePath)}`)
    
    return {
      type: 'image',
      bbox,
      imagePath: absoluteImagePath,
      crop  // Include crop data
    }
  } catch (error) {
    console.error('[pptxXmlParser] Error parsing picture:', error)
    return null
  }
}

function extractColor(rPr: any): string {
  try {
    // Try solid fill first
    const solidFill = rPr?.['a:solidFill']?.[0]
    if (solidFill) {
      const srgbClr = solidFill['a:srgbClr']?.[0]
      if (srgbClr?.$.val) {
        return `#${srgbClr.$.val}`
      }
    }
    
    // Try scheme color (theme colors)
    const schemeClr = solidFill?.['a:schemeClr']?.[0]
    if (schemeClr) {
      // Map common scheme colors
      const schemeMap: Record<string, string> = {
        'tx1': '#000000',  // Text 1
        'tx2': '#000000',  // Text 2
        'bg1': '#FFFFFF',  // Background 1
        'bg2': '#FFFFFF',  // Background 2
        'accent1': '#4472C4',
        'accent2': '#ED7D31'
      }
      return schemeMap[schemeClr.$.val] || '#000000'
    }
  } catch (e) {
    // Fall through to default
  }
  
  return '#000000'  // Default black
}

async function parseSpeakerNotes(xml: string): Promise<string> {
  try {
    const parsed = await parseStringPromise(xml)
    const textBody = parsed['p:notes']?.['p:cSld']?.[0]?.['p:spTree']?.[0]?.['p:sp']
    
    if (!textBody) return ''
    
    let notes = ''
    for (const shape of textBody) {
      const paragraphs = shape['p:txBody']?.[0]?.['a:p'] || []
      for (const para of paragraphs) {
        const runs = para['a:r'] || []
        for (const run of runs) {
          notes += run['a:t']?.[0] || ''
        }
        notes += '\n'
      }
    }
    
    return notes.trim()
  } catch (error) {
    console.error('[pptxXmlParser] Error parsing speaker notes:', error)
    return ''
  }
}

async function parseSlideRelationships(
  zip: PizZip,
  slideNum: number
): Promise<Map<string, string>> {
  const relsFile = zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`)
  if (!relsFile) {
    return new Map()
  }

  const relsXml = relsFile.asText()
  const parsed = await parseStringPromise(relsXml)
  
  const relationships = parsed['Relationships']?.['Relationship'] || []
  const imageMap = new Map<string, string>()
  
  for (const rel of relationships) {
    const id = rel.$.Id
    const target = rel.$.Target
    const type = rel.$.Type
    
    // Check if it's an image relationship
    if (type?.includes('image')) {
      // Target is like "../media/image1.png"
      imageMap.set(id, target)
    }
  }
  
  console.log(`[pptxXmlParser] Found ${imageMap.size} image relationships for slide ${slideNum}`)
  return imageMap
}


async function extractImagesToMedia(
  zip: PizZip,
  sessionDir: string
): Promise<Map<string, string>> {
  const mediaDir = path.join(sessionDir, 'media')
  await fs.ensureDir(mediaDir)
  
  const imagePathMap = new Map<string, string>()
  
  // Get all files in ppt/media/
  const mediaFiles = Object.keys(zip.files).filter(name => 
    name.startsWith('ppt/media/') && !name.endsWith('/')
  )
  
  console.log(`[pptxXmlParser] Extracting ${mediaFiles.length} media files`)
  
  for (const mediaFile of mediaFiles) {
    const file = zip.file(mediaFile)
    if (!file) continue
    
    // Get filename (e.g., "image1.png")
    const fileName = path.basename(mediaFile)
    const outputPath = path.join(mediaDir, fileName)
    
    // Extract the image
    const content = file.asNodeBuffer()
    await fs.writeFile(outputPath, content)
    
    // Map the relative path from PPTX to the absolute output path
    // e.g., "../media/image1.png" → "/full/path/to/media/image1.png"
    imagePathMap.set(`../media/${fileName}`, outputPath)
    imagePathMap.set(`media/${fileName}`, outputPath)  // Some PPTXs use this format
    
    console.log(`[pptxXmlParser] Extracted: ${fileName}`)
  }
  
  return imagePathMap
}