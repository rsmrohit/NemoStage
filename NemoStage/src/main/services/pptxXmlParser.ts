import PizZip from 'pizzip'
import { parseStringPromise } from 'xml2js'
import fs from 'fs-extra'
import path from 'path'
import type { PptxManifest, PptxSlide, PptxElement, PptxTableCell, PptxTableRow, TextRun, ImageCrop, EmbeddedFont } from '../types'

// OOXML scheme color aliases (bg1/tx1 etc. map to canonical lt1/dk1 etc.)
const SCHEME_ALIAS: Record<string, string> = {
  bg1: 'lt1', bg2: 'lt2', tx1: 'dk1', tx2: 'dk2',
  lt1: 'lt1', lt2: 'lt2', dk1: 'dk1', dk2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
  accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
  hlink: 'hlink', folHlink: 'folHlink'
}

export async function parsePPTXStructure(
  pptxPath: string,
  sessionDir: string
): Promise<PptxManifest> {
  console.log('[pptxXmlParser] Starting parse of:', pptxPath)

  const data = await fs.readFile(pptxPath)
  const zip = new PizZip(data)

  const { slideWidth, slideHeight } = await getSlideDimensions(zip)
  const themeColors = await loadThemeColors(zip)
  const masterBg = await getMasterBackground(zip, themeColors)

  console.log('[pptxXmlParser] Slide dimensions:', { slideWidth, slideHeight })
  console.log('[pptxXmlParser] Theme colors loaded:', themeColors.size)
  console.log('[pptxXmlParser] Master background:', masterBg)

  const [imagePathMap, { fonts: embeddedFonts, googleFontNames }] = await Promise.all([
    extractImagesToMedia(zip, sessionDir),
    extractEmbeddedFonts(zip, sessionDir)
  ])

  const slides: PptxSlide[] = []
  let slideNum = 1

  while (true) {
    const slideFile = zip.file(`ppt/slides/slide${slideNum}.xml`)
    if (!slideFile) break

    console.log(`[pptxXmlParser] Parsing slide ${slideNum}`)
    const slide = await parseSlide(
      slideFile.asText(), slideNum - 1, slideNum, zip, imagePathMap, themeColors, masterBg
    )

    const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideNum}.xml`)
    if (notesFile) {
      slide.speakerNotes = await parseSpeakerNotes(notesFile.asText())
    }

    slides.push(slide)
    slideNum++
  }

  console.log(`[pptxXmlParser] Parsed ${slides.length} slides`)

  return { slideCount: slides.length, slideWidth, slideHeight, slides, embeddedFonts, googleFontNames }
}

// ─── Slide dimensions ───────────────────────────────────────────────────────

async function getSlideDimensions(zip: PizZip): Promise<{ slideWidth: number; slideHeight: number }> {
  const presXmlFile = zip.file('ppt/presentation.xml')
  if (!presXmlFile) return { slideWidth: 9144000, slideHeight: 6858000 }

  const parsed = await parseStringPromise(presXmlFile.asText())
  // p:sldSz is a CHILD element of p:presentation, not an attribute
  const sldSz = parsed['p:presentation']?.['p:sldSz']?.[0]?.$

  return {
    slideWidth: sldSz ? parseInt(sldSz.cx) : 9144000,
    slideHeight: sldSz ? parseInt(sldSz.cy) : 6858000
  }
}

// ─── Theme colors ────────────────────────────────────────────────────────────

async function loadThemeColors(zip: PizZip): Promise<Map<string, string>> {
  const colors = new Map<string, string>()
  const themeFile = zip.file('ppt/theme/theme1.xml')
  if (!themeFile) return colors

  try {
    const parsed = await parseStringPromise(themeFile.asText())
    const clrScheme =
      parsed['a:theme']?.['a:themeElements']?.[0]?.['a:clrScheme']?.[0]
    if (!clrScheme) return colors

    const slots = [
      'dk1', 'lt1', 'dk2', 'lt2',
      'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
      'hlink', 'folHlink'
    ]

    for (const slot of slots) {
      const el = clrScheme[`a:${slot}`]?.[0]
      if (!el) continue

      const srgb = el['a:srgbClr']?.[0]?.$.val
      if (srgb) { colors.set(slot, `#${srgb}`); continue }

      const sysClr = el['a:sysClr']?.[0]
      if (sysClr?.$.lastClr) colors.set(slot, `#${sysClr.$.lastClr}`)
    }
  } catch (e) {
    console.warn('[pptxXmlParser] Error loading theme colors:', e)
  }

  return colors
}

function resolveSchemeColor(val: string, themeColors: Map<string, string>): string {
  const canonical = SCHEME_ALIAS[val] ?? val
  return themeColors.get(canonical) ?? themeColors.get(val) ?? '#000000'
}

function applyLumMod(hex: string, lumMod: number, lumOff: number): string {
  // lumMod and lumOff are in 1/100000 units (100000 = 100%)
  if (hex.length < 7) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const mod = lumMod / 100000
  const off = (lumOff / 100000) * 255
  const clamp = (v: number): number => Math.round(Math.max(0, Math.min(255, v)))
  const nr = clamp(r * mod + off)
  const ng = clamp(g * mod + off)
  const nb = clamp(b * mod + off)
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`
}

function colorFromFillEl(fillEl: any, themeColors: Map<string, string>): string | undefined {
  if (!fillEl) return undefined

  const srgbClr = fillEl['a:srgbClr']?.[0]
  if (srgbClr?.$.val) return `#${srgbClr.$.val}`

  const schemeClr = fillEl['a:schemeClr']?.[0]
  if (schemeClr) {
    let color = resolveSchemeColor(schemeClr.$.val as string, themeColors)
    const lumMod = schemeClr['a:lumMod']?.[0]?.$.val
    const lumOff = schemeClr['a:lumOff']?.[0]?.$.val
    if (lumMod !== undefined || lumOff !== undefined) {
      color = applyLumMod(color, parseInt(lumMod ?? '100000'), parseInt(lumOff ?? '0'))
    }
    return color
  }

  return undefined
}

function gradientFromFillEl(gradFill: any, themeColors: Map<string, string>): string | undefined {
  const stops: any[] = gradFill['a:gsLst']?.[0]?.['a:gs'] || []
  if (stops.length === 0) return undefined

  const cssStops = stops
    .sort((a, b) => parseInt(a.$.pos || '0') - parseInt(b.$.pos || '0'))
    .map((gs) => {
      const pos = parseInt(gs.$.pos || '0') / 1000
      // a:gs itself is the fill container — check srgbClr/schemeClr directly under it
      const color = colorFromFillEl(gs, themeColors) || '#000000'
      return `${color} ${pos}%`
    })
    .join(', ')

  const linEl = gradFill['a:lin']?.[0]
  if (linEl) {
    const ang = parseInt(linEl.$.ang || '0') / 60000  // CCW from x-axis
    const cssDeg = Math.round(90 - ang)
    return `linear-gradient(${cssDeg}deg, ${cssStops})`
  }

  return `radial-gradient(circle, ${cssStops})`
}

function anyFillFrom(fillContainer: any, themeColors: Map<string, string>): string | undefined {
  const solidFill = fillContainer?.['a:solidFill']?.[0]
  if (solidFill) return colorFromFillEl(solidFill, themeColors)
  const gradFill = fillContainer?.['a:gradFill']?.[0]
  if (gradFill) return gradientFromFillEl(gradFill, themeColors)
  return undefined
}

function extractBgColor(bgEl: any, themeColors: Map<string, string>): string | undefined {
  if (!bgEl) return undefined

  const bgPr = bgEl['p:bgPr']?.[0]
  if (bgPr) {
    return anyFillFrom(bgPr, themeColors)
  }

  const bgRef = bgEl['p:bgRef']?.[0]
  if (bgRef) {
    const schemeClr = bgRef['a:schemeClr']?.[0]
    if (schemeClr) return resolveSchemeColor(schemeClr.$.val as string, themeColors)
  }

  return undefined
}

// ─── Background inheritance chain ────────────────────────────────────────────

async function getMasterBackground(
  zip: PizZip,
  themeColors: Map<string, string>
): Promise<string | undefined> {
  const masterFile = zip.file('ppt/slideMasters/slideMaster1.xml')
  if (!masterFile) return undefined
  try {
    const parsed = await parseStringPromise(masterFile.asText())
    const bgEl = parsed['p:sldMaster']?.['p:cSld']?.[0]?.['p:bg']?.[0]
    return extractBgColor(bgEl, themeColors)
  } catch {
    return undefined
  }
}

async function getLayoutBackground(
  zip: PizZip,
  slideNum: number,
  themeColors: Map<string, string>
): Promise<string | undefined> {
  const relsFile = zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`)
  if (!relsFile) return undefined

  try {
    const rels = await parseStringPromise(relsFile.asText())
    const layoutRel = (rels['Relationships']?.['Relationship'] || []).find(
      (r: any) => (r.$.Type as string)?.includes('slideLayout')
    )
    if (!layoutRel) return undefined

    const target = (layoutRel.$.Target as string).replace('../', '')
    const layoutFile = zip.file(`ppt/${target}`)
    if (!layoutFile) return undefined

    const parsed = await parseStringPromise(layoutFile.asText())
    const bgEl = parsed['p:sldLayout']?.['p:cSld']?.[0]?.['p:bg']?.[0]
    return extractBgColor(bgEl, themeColors)
  } catch {
    return undefined
  }
}

// ─── Group transform ─────────────────────────────────────────────────────────

interface GroupTransform {
  offX: number; offY: number
  extCx: number; extCy: number
  chOffX: number; chOffY: number
  chExtCx: number; chExtCy: number
}

function parseGroupTransform(xfrm: any): GroupTransform {
  const off = xfrm['a:off']?.[0]?.$ ?? {}
  const ext = xfrm['a:ext']?.[0]?.$ ?? {}
  const chOff = xfrm['a:chOff']?.[0]?.$ ?? {}
  const chExt = xfrm['a:chExt']?.[0]?.$ ?? {}
  return {
    offX: parseInt(off.x || '0'),
    offY: parseInt(off.y || '0'),
    extCx: parseInt(ext.cx || '1'),
    extCy: parseInt(ext.cy || '1'),
    chOffX: parseInt(chOff.x || '0'),
    chOffY: parseInt(chOff.y || '0'),
    chExtCx: parseInt(chExt.cx || '1'),
    chExtCy: parseInt(chExt.cy || '1')
  }
}

function applyGroupTransform(element: PptxElement, t: GroupTransform): PptxElement {
  const scaleX = t.extCx / (t.chExtCx || 1)
  const scaleY = t.extCy / (t.chExtCy || 1)
  return {
    ...element,
    bbox: {
      x: Math.round(t.offX + (element.bbox.x - t.chOffX) * scaleX),
      y: Math.round(t.offY + (element.bbox.y - t.chOffY) * scaleY),
      width: Math.round(element.bbox.width * scaleX),
      height: Math.round(element.bbox.height * scaleY)
    }
  }
}

// ─── Slide parsing ────────────────────────────────────────────────────────────

async function parseSlide(
  xml: string,
  slideIndex: number,
  slideNum: number,
  zip: PizZip,
  imagePathMap: Map<string, string>,
  themeColors: Map<string, string>,
  masterBg: string | undefined
): Promise<PptxSlide> {
  // Parse slide data normally; parse once more with order-preservation just to
  // extract the real document z-order of spTree children from the $$ array.
  const [parsed, orderedParsed] = await Promise.all([
    parseStringPromise(xml),
    parseStringPromise(xml, { explicitChildren: true, preserveChildrenOrder: true })
  ])
  const elements: PptxElement[] = []

  // Background: slide → layout → master
  const slideBgEl = parsed['p:sld']?.['p:cSld']?.[0]?.['p:bg']?.[0]
  let background: string | undefined = extractBgColor(slideBgEl, themeColors)
  if (!background) background = await getLayoutBackground(zip, slideNum, themeColors)
  if (!background) background = masterBg

  const imageRelationships = await parseSlideRelationships(zip, slideNum)

  const spTree = parsed['p:sld']?.['p:cSld']?.[0]?.['p:spTree']?.[0]
  if (!spTree) return { slideIndex, elements, background }

  type Tagged = { zIdx: number; promise: Promise<PptxElement | null> }
  const tagged: Tagged[] = []

  // Build z-order map: 'tagName-typeIndex' → absolute z-position in document order.
  // The $$ array from the ordered parse holds all spTree children in their
  // original XML order, so index into $$ == z-order position.
  const orderedSpTree = orderedParsed['p:sld']?.['p:cSld']?.[0]?.['p:spTree']?.[0]
  const docOrderChildren: any[] = orderedSpTree?.['$$'] || []
  const typeCounters: Record<string, number> = {}
  const zOrderMap = new Map<string, number>()  // 'tagName-i' → z-position

  for (let zPos = 0; zPos < docOrderChildren.length; zPos++) {
    const tagName: string = docOrderChildren[zPos]['#name']
    const idx = typeCounters[tagName] ?? 0
    zOrderMap.set(`${tagName}-${idx}`, zPos)
    typeCounters[tagName] = idx + 1
  }

  const spList: any[] = spTree['p:sp'] || []
  const picList: any[] = spTree['p:pic'] || []
  const grpList: any[] = spTree['p:grpSp'] || []
  const frameList: any[] = spTree['p:graphicFrame'] || []

  for (let i = 0; i < spList.length; i++) {
    const zIdx = zOrderMap.get(`p:sp-${i}`) ?? i * 4
    tagged.push({ zIdx, promise: parseSpElement(spList[i], themeColors) })
  }
  for (let i = 0; i < picList.length; i++) {
    const zIdx = zOrderMap.get(`p:pic-${i}`) ?? i * 4 + 1
    tagged.push({ zIdx, promise: parsePictureShape(picList[i], imageRelationships, imagePathMap) })
  }
  for (let i = 0; i < grpList.length; i++) {
    const grpZIdx = zOrderMap.get(`p:grpSp-${i}`) ?? i * 4 + 2
    const grp = grpList[i]
    const grpXfrm = grp['p:grpSpPr']?.[0]?.['a:xfrm']?.[0]
    const grpTransform = grpXfrm ? parseGroupTransform(grpXfrm) : undefined

    for (const s of (grp['p:sp'] || [])) {
      tagged.push({
        zIdx: grpZIdx,
        promise: parseSpElement(s, themeColors).then(el => el && grpTransform ? applyGroupTransform(el, grpTransform) : el)
      })
    }
    for (const p of (grp['p:pic'] || [])) {
      tagged.push({
        zIdx: grpZIdx,
        promise: parsePictureShape(p, imageRelationships, imagePathMap).then(el => el && grpTransform ? applyGroupTransform(el, grpTransform) : el)
      })
    }
    for (const f of (grp['p:graphicFrame'] || [])) {
      const raw = parseGraphicFrame(f, themeColors)
      const el = raw && grpTransform ? applyGroupTransform(raw, grpTransform) : raw
      tagged.push({ zIdx: grpZIdx, promise: Promise.resolve(el) })
    }
  }
  for (let i = 0; i < frameList.length; i++) {
    const zIdx = zOrderMap.get(`p:graphicFrame-${i}`) ?? i * 4 + 3
    tagged.push({ zIdx, promise: Promise.resolve(parseGraphicFrame(frameList[i], themeColors)) })
  }

  // Resolve all in parallel, sort by true document z-order, then collect
  const resolved = await Promise.all(tagged.map(async (t) => ({ zIdx: t.zIdx, el: await t.promise })))
  resolved.sort((a, b) => a.zIdx - b.zIdx)
  for (const { el } of resolved) {
    if (el) elements.push(el)
  }

  return { slideIndex, elements, background }
}

// ─── Shared text body extractor ──────────────────────────────────────────────

function extractTextRuns(
  textBody: any,
  themeColors: Map<string, string>,
  defaultFontSize = 18
): { textRuns: TextRun[]; fullText: string } {
  const paragraphs = textBody?.['a:p'] || []
  let fullText = ''
  const textRuns: TextRun[] = []

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const para = paragraphs[pIdx]
    const runs = para['a:r'] || []
    const lineBreaks = para['a:br'] || []

    const pPr = para['a:pPr']?.[0]
    const algn = (pPr?.$?.algn as TextRun['paragraphAlign']) || undefined
    const defRPr = pPr?.['a:defRPr']?.[0]

    const lnSpcPct = pPr?.['a:lnSpc']?.[0]?.['a:spcPct']?.[0]?.$?.val
    const lineHeight = lnSpcPct ? parseInt(lnSpcPct) / 100000 : undefined

    for (const run of runs) {
      const text = run['a:t']?.[0] || ''
      if (!text) continue
      fullText += text
      const rPr = run['a:rPr']?.[0]
      const sz = rPr?.$.sz ?? defRPr?.$.sz
      const font = rPr?.['a:latin']?.[0]?.$?.typeface || defRPr?.['a:latin']?.[0]?.$?.typeface || 'Calibri'
      const u = rPr?.$.u
      const strike = rPr?.$.strike
      const baselineRaw = rPr?.$.baseline
      textRuns.push({
        text, font,
        size: sz ? parseInt(sz) / 100 : defaultFontSize,
        bold: rPr?.$.b === '1',
        italic: rPr?.$.i === '1',
        underline: u && u !== 'none' ? true : undefined,
        strikethrough: strike && strike !== 'noStrike' ? true : undefined,
        baseline: baselineRaw ? parseInt(baselineRaw) / 1000 : undefined,
        color: extractColor(rPr, themeColors) || extractColor(defRPr, themeColors) || themeColors.get('dk1') || '#000000',
        paragraphAlign: algn,
        lineHeight
      })
    }

    for (const _br of lineBreaks) {
      fullText += '\n'
      textRuns.push({ text: '\n', font: '', size: 0, bold: false, italic: false, color: '' })
    }

    if (pIdx < paragraphs.length - 1) {
      fullText += '\n'
      textRuns.push({ text: '\n', font: '', size: 0, bold: false, italic: false, color: '', paragraphAlign: algn })
    }
  }

  return { textRuns, fullText }
}

// ─── Shape parsing ────────────────────────────────────────────────────────────

async function parseSpElement(
  shape: any,
  themeColors: Map<string, string>
): Promise<PptxElement | null> {
  try {
    const spPr = shape['p:spPr']?.[0]
    const xfrm = spPr?.['a:xfrm']?.[0]
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

    // Rotation in 1/60000-degree units, clockwise
    const rotRaw = xfrm.$?.rot
    const rotation = rotRaw ? parseInt(rotRaw) / 60000 : undefined

    // Shape fill from spPr — solidFill or gradFill; noFill → undefined → transparent
    const fillColor = spPr?.['a:noFill'] ? undefined : anyFillFrom(spPr, themeColors)

    // Preset geometry (for border-radius hints)
    const shapeGeom = spPr?.['a:prstGeom']?.[0]?.$?.prst as string | undefined

    const textBody = shape['p:txBody']?.[0]

    if (!textBody) {
      // Pure shape (no text) — only emit if it has a visible fill
      if (!fillColor) return null
      return { type: 'shape', bbox, content: '', fillColor, rotation, shapeGeom }
    }

    const bodyPr = textBody['a:bodyPr']?.[0]
    const verticalAnchor = (bodyPr?.$?.anchor as 't' | 'ctr' | 'b') || undefined
    const wrapNone = bodyPr?.$?.wrap === 'none'

    // Text box inset in EMUs (default in PPTX: 91440 L/R, 45720 T/B = 0.1"/0.05")
    const insL = bodyPr?.$?.insL !== undefined ? parseInt(bodyPr.$.insL) : 91440
    const insR = bodyPr?.$?.insR !== undefined ? parseInt(bodyPr.$.insR) : 91440
    const insT = bodyPr?.$?.insT !== undefined ? parseInt(bodyPr.$.insT) : 45720
    const insB = bodyPr?.$?.insB !== undefined ? parseInt(bodyPr.$.insB) : 45720

    // Placeholder type → default font size heuristic
    const phType = shape['p:nvSpPr']?.[0]?.['p:nvPr']?.[0]?.['p:ph']?.[0]?.$?.type
    const defaultFontSize = phType === 'title' ? 40
      : phType === 'subTitle' ? 28
      : phType === 'body' || phType === 'obj' ? 20
      : 18

    const { textRuns, fullText } = extractTextRuns(textBody, themeColors, defaultFontSize)

    // Skip invisible empty text shapes
    if (!fullText.trim() && !fillColor) return null

    const textBoxStyle = { insL, insR, insT, insB, wrapNone: wrapNone || undefined }

    return {
      type: 'text', bbox, content: fullText, textRuns,
      fillColor, rotation, verticalAnchor, shapeGeom, textBoxStyle
    }
  } catch (error) {
    console.error('[pptxXmlParser] Error parsing shape:', error)
    return null
  }
}

async function parsePictureShape(
  pic: any,
  imageRelationships: Map<string, string>,
  imagePathMap: Map<string, string>
): Promise<PptxElement | null> {
  try {
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

    const rotRaw = xfrm.$?.rot
    const rotation = rotRaw ? parseInt(rotRaw) / 60000 : undefined

    const blipFill = pic['p:blipFill']?.[0]
    const blip = blipFill?.['a:blip']?.[0]
    const embedId = blip?.$?.['r:embed']
    if (!embedId) return null

    const srcRect = blipFill?.['a:srcRect']?.[0]?.$
    let crop: ImageCrop | undefined
    if (srcRect) {
      crop = {
        left: srcRect.l ? parseInt(srcRect.l) / 1000 : 0,
        top: srcRect.t ? parseInt(srcRect.t) / 1000 : 0,
        right: srcRect.r ? parseInt(srcRect.r) / 1000 : 0,
        bottom: srcRect.b ? parseInt(srcRect.b) / 1000 : 0
      }
    }

    const relativeImagePath = imageRelationships.get(embedId)
    if (!relativeImagePath) {
      console.warn(`[pptxXmlParser] No relationship for embedId: ${embedId}`)
      return null
    }

    const absoluteImagePath = imagePathMap.get(relativeImagePath)
    if (!absoluteImagePath) {
      console.warn(`[pptxXmlParser] No image file for path: ${relativeImagePath}`)
      return null
    }

    console.log(`[pptxXmlParser] Resolved image: ${embedId} → ${path.basename(absoluteImagePath)}`)
    return { type: 'image', bbox, imagePath: absoluteImagePath, crop, rotation }
  } catch (error) {
    console.error('[pptxXmlParser] Error parsing picture:', error)
    return null
  }
}

// ─── Table parsing ────────────────────────────────────────────────────────────

function parseGraphicFrame(
  frame: any,
  themeColors: Map<string, string>
): PptxElement | null {
  try {
    const xfrm = frame['p:xfrm']?.[0]
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

    const tbl = frame['a:graphic']?.[0]?.['a:graphicData']?.[0]?.['a:tbl']?.[0]
    if (!tbl) return null

    const colWidths: number[] = (tbl['a:tblGrid']?.[0]?.['a:gridCol'] || [])
      .map((col: any) => parseInt(col.$.w || '0'))

    // Table-level fill from tblPr (used as fallback when no explicit cell fill)
    const tblPr = tbl['a:tblPr']?.[0]
    const tableFill = tblPr ? anyFillFrom(tblPr, themeColors) : undefined

    const tableRows: PptxTableRow[] = (tbl['a:tr'] || []).map((row: any): PptxTableRow => {
      const height = parseInt(row.$?.h || '0')
      const cells: PptxTableCell[] = (row['a:tc'] || []).map((tc: any): PptxTableCell => {
        // hMerge/vMerge continuation cells should be skipped in rendering
        const isContinuation = tc.$?.hMerge === '1' || tc.$?.vMerge === '1'
        if (isContinuation) {
          return { textRuns: [], content: '', isContinuation: true }
        }

        const txBody = tc['a:txBody']?.[0]
        const { textRuns, fullText } = txBody
          ? extractTextRuns(txBody, themeColors)
          : { textRuns: [], fullText: '' }

        const tcPr = tc['a:tcPr']?.[0]
        // Cell fill: explicit cell fill > table fill > undefined (transparent)
        const cellExplicitFill = tcPr?.['a:noFill'] ? undefined : anyFillFrom(tcPr, themeColors)
        const fillColor = cellExplicitFill ?? tableFill

        const colSpan = tc.$?.gridSpan ? parseInt(tc.$.gridSpan) : undefined
        const rowSpan = tc.$?.rowSpan ? parseInt(tc.$.rowSpan) : undefined

        return { textRuns, content: fullText, fillColor, colSpan, rowSpan }
      })

      return { cells, height }
    })

    return { type: 'table', bbox, content: '', tableRows, colWidths }
  } catch (error) {
    console.error('[pptxXmlParser] Error parsing graphic frame:', error)
    return null
  }
}

// ─── Color extraction ─────────────────────────────────────────────────────────

function extractColor(rPr: any, themeColors: Map<string, string>): string {
  try {
    const solidFill = rPr?.['a:solidFill']?.[0]
    if (solidFill) {
      const color = colorFromFillEl(solidFill, themeColors)
      if (color) return color
    }
  } catch {
    // ignore
  }
  return ''
}

// ─── Relationships ────────────────────────────────────────────────────────────

async function parseSlideRelationships(
  zip: PizZip,
  slideNum: number
): Promise<Map<string, string>> {
  const relsFile = zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`)
  if (!relsFile) return new Map()

  const parsed = await parseStringPromise(relsFile.asText())
  const relationships = parsed['Relationships']?.['Relationship'] || []
  const imageMap = new Map<string, string>()

  for (const rel of relationships) {
    if ((rel.$.Type as string)?.includes('image')) {
      imageMap.set(rel.$.Id, rel.$.Target)
    }
  }

  console.log(`[pptxXmlParser] Found ${imageMap.size} image relationships for slide ${slideNum}`)
  return imageMap
}

// ─── Media extraction ─────────────────────────────────────────────────────────

async function extractImagesToMedia(
  zip: PizZip,
  sessionDir: string
): Promise<Map<string, string>> {
  const mediaDir = path.join(sessionDir, 'media')
  await fs.ensureDir(mediaDir)

  const imagePathMap = new Map<string, string>()
  const mediaFiles = Object.keys(zip.files).filter(
    (name) => name.startsWith('ppt/media/') && !name.endsWith('/')
  )

  console.log(`[pptxXmlParser] Extracting ${mediaFiles.length} media files`)

  for (const mediaFile of mediaFiles) {
    const file = zip.file(mediaFile)
    if (!file) continue

    const fileName = path.basename(mediaFile)
    const outputPath = path.join(mediaDir, fileName)
    await fs.writeFile(outputPath, file.asNodeBuffer())

    imagePathMap.set(`../media/${fileName}`, outputPath)
    imagePathMap.set(`media/${fileName}`, outputPath)
  }

  return imagePathMap
}

// ─── Embedded font extraction ─────────────────────────────────────────────────

function isValidFontMagic(data: Buffer): boolean {
  if (data.length < 4) return false
  const sig = data.readUInt32BE(0)
  // TrueType 1.0, OpenType CFF (OTTO), TrueType 'true', WOFF, WOFF2
  return (
    sig === 0x00010000 ||
    sig === 0x4f54544f ||
    sig === 0x74727565 ||
    sig === 0x774f4646 ||
    sig === 0x774f4632
  )
}

function deobfuscateOdttf(data: Buffer, guid: string): Buffer {
  const hex = guid.replace(/[{}\-]/g, '')
  if (hex.length !== 32) return data
  const key = Buffer.from(hex, 'hex')
  key.reverse()
  const result = Buffer.from(data)
  for (let i = 0; i < 32 && i < result.length; i++) {
    result[i] ^= key[i % 16]
  }
  return result
}

function guidFromFilename(target: string): string | null {
  const base = path.basename(target, path.extname(target))
  return /^\{[0-9A-Fa-f-]{36}\}$/.test(base) ? base : null
}

function fontGuidFromElement(fontEl: any): string | null {
  // Try both p: and a: namespace prefixes for extLst
  const extLst = fontEl['p:extLst']?.[0] ?? fontEl['a:extLst']?.[0]
  const exts: any[] = extLst?.['p:ext'] ?? extLst?.['a:ext'] ?? []

  if (exts.length === 0 && !extLst) {
    console.log('[fonts] fontGuidFromElement: no extLst found — element keys:', Object.keys(fontEl))
  } else if (exts.length === 0) {
    console.log('[fonts] fontGuidFromElement: extLst found but no ext children — extLst keys:', Object.keys(extLst))
  }

  for (const ext of exts) {
    console.log('[fonts] fontGuidFromElement: ext keys:', Object.keys(ext))
    for (const key of Object.keys(ext)) {
      if (key.toLowerCase().includes('fontkey')) {
        const val = ext[key]?.[0]?.$?.val as string | undefined
        console.log(`[fonts] fontGuidFromElement: found fontKey element "${key}" val=${val}`)
        if (val?.startsWith('{')) return val
      }
    }
  }
  return null
}

async function extractFontVariant(
  zip: PizZip,
  target: string,
  fontsDir: string,
  baseName: string,
  variant: string,
  guid: string | null
): Promise<{ path: string | null; needsWebFont: boolean }> {
  const zipPath = target.startsWith('../')
    ? `ppt/${target.slice(3)}`
    : target.startsWith('fonts/')
      ? `ppt/${target}`
      : `ppt/fonts/${path.basename(target)}`

  console.log(`[fonts] extractFontVariant: "${baseName}" ${variant} → zip path "${zipPath}"`)

  const file = zip.file(zipPath)
  if (!file) {
    console.warn(`[fonts] ❌ Not found in zip: "${zipPath}"`)
    return { path: null, needsWebFont: false }
  }

  let data = file.asNodeBuffer()
  const ext = path.extname(target).toLowerCase()
  const mightBeObfuscated = ext === '.odttf' || ext === '.fntdata'
  let needsWebFont = false

  if (mightBeObfuscated) {
    const isAlreadyValidFont = isValidFontMagic(data)
    const firstBytes = data.subarray(0, 8).toString('hex').match(/../g)?.join(' ') ?? ''
    if (isAlreadyValidFont) {
      console.log(`[fonts] "${zipPath}" has valid font header — plain font, no de-obfuscation needed`)
    } else {
      const key = guid ?? guidFromFilename(target)
      console.log(`[fonts] "${zipPath}" first bytes: ${firstBytes} — ${key ? 'de-obfuscating' : 'no GUID, needs web font'}`)
      if (key) {
        data = deobfuscateOdttf(data, key)
      } else {
        needsWebFont = true
        console.warn(`[fonts] ⚠️ "${zipPath}" obfuscated with no GUID — will need Google Fonts fallback`)
      }
    }
  }

  const safe = baseName.replace(/[^a-zA-Z0-9]/g, '_')
  const outPath = path.join(fontsDir, `${safe}_${variant}.ttf`)
  await fs.writeFile(outPath, data)
  console.log(`[fonts] ✅ Saved ${variant} → ${outPath} (${data.length} bytes)`)
  return { path: outPath, needsWebFont }
}

async function extractEmbeddedFonts(
  zip: PizZip,
  sessionDir: string
): Promise<{ fonts: EmbeddedFont[]; googleFontNames: string[] }> {
  const presFile = zip.file('ppt/presentation.xml')
  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels')
  if (!presFile || !presRelsFile) return { fonts: [], googleFontNames: [] }

  try {
    const [presXml, relsXml] = await Promise.all([
      parseStringPromise(presFile.asText()),
      parseStringPromise(presRelsFile.asText())
    ])

    const relMap = new Map<string, string>()
    for (const rel of (relsXml['Relationships']?.['Relationship'] || [])) {
      if ((rel.$.Type as string)?.includes('font')) {
        relMap.set(rel.$.Id as string, rel.$.Target as string)
      }
    }

    const fontList: any[] =
      presXml['p:presentation']?.['p:embeddedFontLst']?.[0]?.['p:embeddedFont'] || []

    if (fontList.length === 0) return { fonts: [], googleFontNames: [] }

    const fontsDir = path.join(sessionDir, 'fonts')
    await fs.ensureDir(fontsDir)

    const results: EmbeddedFont[] = []
    const googleFontNames: string[] = []

    console.log(`[fonts] Found ${fontList.length} embedded font entries in presentation.xml`)
    console.log(`[fonts] Font relationship map has ${relMap.size} font entries`)

    for (const fontEl of fontList) {
      const fontName = fontEl['p:font']?.[0]?.$?.typeface as string | undefined
      if (!fontName) continue

      const guid = fontGuidFromElement(fontEl)

      const regularId = fontEl['p:regular']?.[0]?.$?.['r:id'] as string | undefined
      const boldId = fontEl['p:bold']?.[0]?.$?.['r:id'] as string | undefined
      const italicId = fontEl['p:italic']?.[0]?.$?.['r:id'] as string | undefined
      const boldItalicId = fontEl['p:boldItalic']?.[0]?.$?.['r:id'] as string | undefined

      console.log(`[fonts] Processing font: "${fontName}" | guid=${guid ?? 'none'} | ids: regular=${regularId} bold=${boldId} italic=${italicId} boldItalic=${boldItalicId}`)

      const regularTarget = regularId ? relMap.get(regularId) : undefined
      console.log(`[fonts] Regular target for "${fontName}": ${regularTarget ?? '(not found)'}`)
      if (!regularTarget) continue

      const regular = await extractFontVariant(zip, regularTarget, fontsDir, fontName, 'regular', guid)
      if (!regular.path) continue

      const font: EmbeddedFont = { name: fontName, path: regular.path, needsWebFont: regular.needsWebFont }
      if (regular.needsWebFont) googleFontNames.push(fontName)

      const boldTarget = boldId ? relMap.get(boldId) : undefined
      if (boldTarget) {
        const bold = await extractFontVariant(zip, boldTarget, fontsDir, fontName, 'bold', guid)
        font.bold = bold.path ?? undefined
      }
      const italicTarget = italicId ? relMap.get(italicId) : undefined
      if (italicTarget) {
        const italic = await extractFontVariant(zip, italicTarget, fontsDir, fontName, 'italic', guid)
        font.italic = italic.path ?? undefined
      }
      const boldItalicTarget = boldItalicId ? relMap.get(boldItalicId) : undefined
      if (boldItalicTarget) {
        const boldItalic = await extractFontVariant(zip, boldItalicTarget, fontsDir, fontName, 'boldItalic', guid)
        font.boldItalic = boldItalic.path ?? undefined
      }

      results.push(font)
    }

    console.log(`[pptxXmlParser] Extracted ${results.length} embedded fonts, ${googleFontNames.length} need Google Fonts`)
    return { fonts: results, googleFontNames }
  } catch (e) {
    console.warn('[pptxXmlParser] Font extraction failed:', e)
    return { fonts: [], googleFontNames: [] }
  }
}

// ─── Speaker notes ────────────────────────────────────────────────────────────

async function parseSpeakerNotes(xml: string): Promise<string> {
  try {
    const parsed = await parseStringPromise(xml)
    const shapes = parsed['p:notes']?.['p:cSld']?.[0]?.['p:spTree']?.[0]?.['p:sp']
    if (!shapes) return ''

    let notes = ''
    for (const shape of shapes) {
      for (const para of (shape['p:txBody']?.[0]?.['a:p'] || [])) {
        for (const run of (para['a:r'] || [])) {
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
