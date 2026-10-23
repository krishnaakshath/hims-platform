// SERVER ONLY (the `server-only` package is not installed; never import this from a client
// component). SP5 Task 13: renders a LabReportData as an A4 PDF with pdf-lib.
//
// - Pure over its input: no network, no filesystem, no clock (dates come from the data), so the
//   same data always gives the same bytes. Only the 14 standard fonts are used (Helvetica,
//   Helvetica-Bold); their metrics ship inside pdf-lib, nothing is fetched or read at runtime.
// - Every string goes through toPdfSafeText. KNOWN LIMITATION: standard fonts are WinAnsi only,
//   and no Indian-script font is available offline, so such text prints as a '[non-Latin text]'
//   placeholder with a note under the patient block (see toPdfSafeText, docs/DEPLOYING.md).
// - Times are shown in IST through formatDateTimeIn.
// - WL T10: the header is the brand's print header text; the stored light logo (PNG bytes carried in
//   the data, never a URL) is embedded top-right at most 36 pt high, and skipped silently when it is
//   absent or cannot be decoded; the print footer text goes in every page footer.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { formatDateTimeIn } from '@/lib/india-time'
import { displaySampleId } from '@/lib/labs/sample-id'
import { flagLabel, hasNonLatinText, toPdfSafeText, type LabReportData } from '@/lib/labs/report-data'

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 50
const CONTENT_WIDTH = A4[0] - 2 * MARGIN
/** A new page starts when the next row would cross this line (the footer lives below it). */
const BOTTOM_LIMIT = 90
const FOOTER_Y = 40
/** The logo is drawn at most this tall and this wide (pt), keeping its aspect ratio. */
const LOGO_MAX_HEIGHT = 36
const LOGO_MAX_WIDTH = 160
const FOOTER_TEXT_LINES = 2
/** The header subline (billing address, up to 500 chars) is wrapped and capped at this many lines. */
const SUBLINE_LINES = 3

const BLACK = rgb(0, 0, 0)
const GREY = rgb(0.35, 0.35, 0.35)
const RULE = rgb(0.7, 0.7, 0.7)

const BODY = 9
const SMALL = 7.5
const LINE = 11.5
const SMALL_LINE = 9.5
const CELL_PAD = 4

const COLUMNS = [
  { title: 'Test', width: 165 },
  { title: 'Result', width: 100 },
  { title: 'Unit', width: 60 },
  { title: 'Reference range', width: 105 },
  { title: 'Flag', width: CONTENT_WIDTH - 165 - 100 - 60 - 105 },
] as const

interface Fonts { regular: PDFFont; bold: PDFFont }
interface Logo { image: PDFImage; width: number; height: number }

/** The embedded logo scaled to fit LOGO_MAX_HEIGHT x LOGO_MAX_WIDTH, or null when absent or not a decodable PNG. */
async function embedLogo(doc: PDFDocument, bytes: Uint8Array | null): Promise<Logo | null> {
  if (!bytes || bytes.byteLength === 0) return null
  try {
    const image = await doc.embedPng(bytes)
    if (image.width <= 0 || image.height <= 0) return null
    const scale = Math.min(LOGO_MAX_HEIGHT / image.height, LOGO_MAX_WIDTH / image.width)
    return { image, width: image.width * scale, height: image.height * scale }
  } catch {
    return null
  }
}

/** Greedy word wrap to `maxWidth`; a word longer than a line is split by character. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = toPdfSafeText(text)
  if (safe === '') return ['']
  const lines: string[] = []
  let current = ''
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth
  for (const word of safe.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (fits(candidate)) { current = candidate; continue }
    if (current !== '') lines.push(current)
    current = ''
    let piece = ''
    for (const ch of word) {
      if (fits(piece + ch)) { piece += ch; continue }
      if (piece !== '') lines.push(piece)
      piece = ch
    }
    current = piece
  }
  if (current !== '') lines.push(current)
  return lines
}

/** `wrap`, capped at `max` lines; a cut last line ends in "..." and still fits `maxWidth`. */
function wrapCapped(s: string, font: PDFFont, size: number, maxWidth: number, max: number): string[] {
  const lines = wrap(s, font, size, maxWidth)
  if (lines.length <= max) return lines
  const kept = lines.slice(0, max)
  let last = kept[max - 1]
  while (last !== '' && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) last = last.slice(0, -1)
  kept[max - 1] = `${last.trimEnd()}...`
  return kept
}

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size = BODY, color = BLACK) {
  const safe = toPdfSafeText(s)
  if (safe !== '') page.drawText(safe, { x, y, size, font, color })
}

function rule(page: PDFPage, y: number) {
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.5, color: RULE })
}

const ist = (iso: string | null) => (iso ? formatDateTimeIn(new Date(iso)) : '-')

function earliest(values: (string | null)[]): string | null {
  const present = values.filter((v): v is string => v !== null).sort()
  return present[0] ?? null
}

class Layout {
  pages: PDFPage[] = []
  page!: PDFPage
  y = 0

  constructor(private doc: PDFDocument, private fonts: Fonts, private data: LabReportData, private logo: Logo | null = null) {}

  /** The full header on page 1; a one-line header on continuation pages. */
  newPage(first: boolean) {
    this.page = this.doc.addPage(A4)
    this.pages.push(this.page)
    const { regular, bold } = this.fonts
    let y = A4[1] - MARGIN
    if (first) {
      const top = y
      const logo = this.logo
      if (logo) this.page.drawImage(logo.image, { x: A4[0] - MARGIN - logo.width, y: top - logo.height, width: logo.width, height: logo.height })
      const headerWidth = logo ? CONTENT_WIDTH - logo.width - 12 : CONTENT_WIDTH
      for (const line of wrap(this.data.hospital.headerText, bold, 15, headerWidth)) {
        text(this.page, line, MARGIN, y - 15, bold, 15)
        y -= 18
      }
      if (this.data.hospital.site) {
        // Wrapped beside the logo, so a long billing address never runs off the page or under the logo.
        const lines = wrapCapped(this.data.hospital.site, regular, 10, headerWidth, SUBLINE_LINES)
        lines.forEach((line, i) => text(this.page, line, MARGIN, y - 10 - i * 12, regular, 10, GREY))
        y -= lines.length * 12 + 2
      }
      text(this.page, 'LABORATORY REPORT', MARGIN, y - 16, bold, 12)
      y -= 24
      if (logo) y = Math.min(y, top - logo.height - 6)
    } else {
      text(this.page, wrap(this.data.hospital.headerText, bold, 10, CONTENT_WIDTH * 0.6)[0], MARGIN, y - 10, bold, 10)
      text(this.page, 'LABORATORY REPORT (continued)', MARGIN + CONTENT_WIDTH * 0.62, y - 10, regular, 9, GREY)
      y -= 18
    }
    rule(this.page, y)
    this.y = y - 8
  }

  ensure(height: number, onBreak?: () => void) {
    if (this.y - height >= BOTTOM_LIMIT) return
    this.newPage(false)
    onBreak?.()
  }
}

function drawPatientBlock(l: Layout, data: LabReportData, fonts: Fonts) {
  const { regular, bold } = fonts
  const reg = data.referringDoctor.registration
  const collected = earliest(data.rows.map((r) => r.collectedAt))
  const age = `${data.patient.ageYears} y${data.patient.gender ? ` / ${data.patient.gender}` : ''}`
  const left: [string, string][] = [
    ['Name', data.patient.name],
    ['UHID', data.patient.uhid ?? '-'],
    ['Age / Gender', age],
    ['Referred by', reg ? `${data.referringDoctor.name} (${reg})` : data.referringDoctor.name],
  ]
  const right: [string, string][] = [
    ['Report no.', `${data.reportNumber} / v${data.version}`],
    ['Collected', ist(collected)],
    ['Generated', ist(data.generatedAt)],
  ]
  const labelWidth = 70
  const colWidth = CONTENT_WIDTH / 2 - 8
  const drawColumn = (pairs: [string, string][], x: number) => {
    let y = l.y
    for (const [label, value] of pairs) {
      const lines = wrap(value, regular, BODY, colWidth - labelWidth)
      text(l.page, label, x, y - BODY, bold, BODY)
      lines.forEach((line, i) => text(l.page, line, x + labelWidth, y - BODY - i * LINE, regular, BODY))
      y -= lines.length * LINE + 2
    }
    return y
  }
  const yLeft = drawColumn(left, MARGIN)
  const yRight = drawColumn(right, MARGIN + CONTENT_WIDTH / 2 + 8)
  l.y = Math.min(yLeft, yRight) - 4
  if (hasNonLatinText(data.patient.name)) {
    for (const line of wrap(SCRIPT_NOTE, regular, BODY, CONTENT_WIDTH)) {
      text(l.page, line, MARGIN, l.y - BODY, regular, BODY)
      l.y -= LINE
    }
    l.y -= 2
  }
  rule(l.page, l.y)
  l.y -= 10
}

const SCRIPT_NOTE = 'The name is in a script this PDF cannot print; see the chart or the patient portal.'

function drawTableHeader(l: Layout, fonts: Fonts) {
  let x = MARGIN
  for (const c of COLUMNS) {
    text(l.page, c.title, x + CELL_PAD, l.y - BODY, fonts.bold, BODY)
    x += c.width
  }
  l.y -= LINE + 2
  rule(l.page, l.y)
  l.y -= 6
}

function drawRow(l: Layout, row: LabReportData['rows'][number], fonts: Fonts) {
  const { regular, bold } = fonts
  const flag = flagLabel(row.flag)
  const inner = (i: number) => COLUMNS[i].width - 2 * CELL_PAD
  const testLines = wrap(row.testName, regular, BODY, inner(0))
  const sampleLines = row.sampleId ? wrap(`Sample ${displaySampleId(row.sampleId)}`, regular, SMALL, inner(0)) : []
  const cells: { lines: string[]; font: PDFFont }[] = [
    { lines: testLines, font: regular },
    { lines: wrap(row.value, flag ? bold : regular, BODY, inner(1)), font: flag ? bold : regular },
    { lines: wrap(row.unit ?? '', regular, BODY, inner(2)), font: regular },
    { lines: wrap(row.referenceRange ?? '', regular, BODY, inner(3)), font: regular },
    { lines: wrap(flag, bold, BODY, inner(4)), font: bold },
  ]
  const maxLines = Math.max(...cells.map((c) => c.lines.length))
  // A row stays on one page unless it is taller than a page; then it continues line by line.
  const rowHeight = maxLines * LINE + sampleLines.length * SMALL_LINE + 4
  const pageRoom = A4[1] - MARGIN - 30 - BOTTOM_LIMIT
  l.ensure(Math.min(rowHeight, pageRoom), () => drawTableHeader(l, fonts))

  let y = l.y
  for (let i = 0; i < maxLines; i++) {
    if (y - LINE < BOTTOM_LIMIT) {
      l.newPage(false)
      drawTableHeader(l, fonts)
      y = l.y
    }
    let x = MARGIN
    cells.forEach((c, ci) => {
      const line = c.lines[i]
      if (line !== undefined) text(l.page, line, x + CELL_PAD, y - BODY, c.font, BODY)
      x += COLUMNS[ci].width
    })
    y -= LINE
  }
  for (const s of sampleLines) {
    if (y - SMALL_LINE < BOTTOM_LIMIT) {
      l.newPage(false)
      drawTableHeader(l, fonts)
      y = l.y
    }
    text(l.page, s, MARGIN + CELL_PAD, y - SMALL, regular, SMALL, GREY)
    y -= SMALL_LINE
  }
  l.y = y - 4
  rule(l.page, l.y + 2)
}

function drawClosing(l: Layout, data: LabReportData, fonts: Fonts) {
  const { regular, bold } = fonts
  const verified = wrap(`Verified by: ${data.verifiers.length > 0 ? data.verifiers.join(', ') : '-'}`, regular, BODY, CONTENT_WIDTH)
  l.ensure(verified.length * LINE + 70)
  l.y -= 8
  verified.forEach((line, i) => text(l.page, line, MARGIN, l.y - BODY - i * LINE, regular, BODY))
  l.y -= verified.length * LINE + 30
  text(l.page, 'Authorised signatory: ______________________', MARGIN, l.y - BODY, bold, BODY)
  l.y -= LINE + 10
  text(l.page, 'This is a computer-generated report.', MARGIN, l.y - SMALL, regular, SMALL, GREY)
  l.y -= SMALL_LINE
}

export async function renderLabReportPdf(data: LabReportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const generated = new Date(data.generatedAt)
  doc.setTitle(toPdfSafeText(`Lab report ${data.reportNumber}`))
  doc.setProducer(toPdfSafeText(data.hospital.name))
  doc.setCreator(toPdfSafeText(data.hospital.name))
  doc.setCreationDate(generated)
  doc.setModificationDate(generated)

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  const l = new Layout(doc, fonts, data, await embedLogo(doc, data.hospital.logoPng))
  l.newPage(true)
  drawPatientBlock(l, data, fonts)
  drawTableHeader(l, fonts)
  if (data.rows.length === 0) {
    text(l.page, 'No results.', MARGIN + CELL_PAD, l.y - BODY, fonts.regular, BODY, GREY)
    l.y -= LINE + 4
  }
  for (const row of data.rows) drawRow(l, row, fonts)
  drawClosing(l, data, fonts)

  const total = l.pages.length
  l.pages.forEach((page, i) => {
    const footer = toPdfSafeText(`Report ${data.reportNumber} v${data.version} · Page ${i + 1} of ${total}`)
    const width = fonts.regular.widthOfTextAtSize(footer, SMALL)
    page.drawLine({ start: { x: MARGIN, y: FOOTER_Y + 12 }, end: { x: A4[0] - MARGIN, y: FOOTER_Y + 12 }, thickness: 0.5, color: RULE })
    page.drawText(footer, { x: A4[0] - MARGIN - width, y: FOOTER_Y, size: SMALL, font: fonts.regular, color: GREY })
    if (data.hospital.footerText) {
      const lines = wrap(data.hospital.footerText, fonts.regular, SMALL, CONTENT_WIDTH - width - 16).slice(0, FOOTER_TEXT_LINES)
      lines.forEach((line, li) => text(page, line, MARGIN, FOOTER_Y - li * SMALL_LINE, fonts.regular, SMALL, GREY))
    }
  })

  return doc.save()
}
