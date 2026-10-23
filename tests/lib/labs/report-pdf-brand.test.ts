// @vitest-environment node
// WL T10 (group 3): the lab report PDF carries the brand resolved at request time -- the print
// header text, the stored light logo (an embedded PNG image XObject, at most 36 pt high), the print
// footer text in the page footer, and the brand name as producer/creator. With no stored brand the
// header and metadata are today's (env brand) and no image is embedded.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFPage } from 'pdf-lib'
import type { Session } from '@/lib/auth'
import type { BrandSettingsInput } from '@/lib/brand-snapshot'
import { buildLabReportData, type LabReportData } from '@/lib/labs/report-data'
import { renderLabReportPdf } from '@/lib/labs/report-pdf'
import { SRC } from './report-fixtures'

const NOW = new Date('2099-03-04T06:00:00Z')
// A 1x1 PNG.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))

function streamBytes(page: PDFPage): Buffer[] {
  const contents = page.node.Contents()
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => page.doc.context.lookup(ref)) : [contents]
  return streams.map((s) => {
    if (!(s instanceof PDFRawStream)) throw new Error('unexpected content stream type')
    const raw = Buffer.from(s.getContents())
    return s.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode') ? inflateSync(raw) : raw
  })
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((page) =>
    streamBytes(page)
      .map((b) => [...b.toString('latin1').matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n'))
      .join('\n'))
}

/** Image XObjects referenced by every page's resources, and the height each is drawn at (from the cm operator). */
async function images(bytes: Uint8Array): Promise<{ count: number; heights: number[] }> {
  const doc = await PDFDocument.load(bytes)
  let count = 0
  const heights: number[] = []
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
    for (const [, ref] of xobjects?.entries() ?? []) {
      const obj = doc.context.lookup(ref)
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) count++
    }
    for (const b of streamBytes(page)) {
      for (const m of b.toString('latin1').matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s+\/Image/g)) heights.push(Number(m[4]))
    }
  }
  return { count, heights }
}

const BASE: LabReportData = buildLabReportData(SRC, NOW)

/** Every text run on page 1: font size, origin and decoded text (pdf-lib writes `size Tf ... 1 0 0 1 x y Tm <hex> Tj`). */
async function textRuns(bytes: Uint8Array): Promise<{ bold: boolean; size: number; x: number; y: number; text: string }[]> {
  const doc = await PDFDocument.load(bytes)
  const stream = streamBytes(doc.getPage(0)).map((b) => b.toString('latin1')).join('\n')
  return [...stream.matchAll(/\/(\S+) ([\d.]+) Tf[^]*?1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)].map((m) => ({
    bold: m[1].includes('Bold'), size: Number(m[2]), x: Number(m[3]), y: Number(m[4]), text: Buffer.from(m[5], 'hex').toString('latin1'),
  }))
}

/** The drawn logo box (x, y, width, height), composing the (diagonal) `cm` operators of the image's q...Q block. */
async function logoBox(bytes: Uint8Array): Promise<{ x: number; y: number; w: number; h: number }> {
  const doc = await PDFDocument.load(bytes)
  const stream = streamBytes(doc.getPage(0)).map((b) => b.toString('latin1')).join('\n')
  const block = stream.match(/q\n((?:(?!\nQ)[^])*?)\/Image\S* Do/)
  if (!block) throw new Error('no logo drawn')
  let box = { x: 0, y: 0, w: 1, h: 1 }
  for (const m of block[1].matchAll(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g)) {
    const [a, d, e, f] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    box = { x: box.x + box.w * e, y: box.y + box.h * f, w: box.w * a, h: box.h * d }
  }
  return box
}

describe('renderLabReportPdf brand identity (pure)', () => {
  it('prints the header text, footer text and embeds the logo at most 36 pt high', async () => {
    const data: LabReportData = {
      ...BASE,
      hospital: { ...BASE.hospital, headerText: 'Sunrise Hospital, Pune', footerText: 'NABL accredited laboratory', logoPng: PNG },
    }
    const bytes = await renderLabReportPdf(data)
    const [text] = await pageTexts(bytes)
    expect(text).toContain('Sunrise Hospital, Pune')
    expect(text).toContain('NABL accredited laboratory')
    const img = await images(bytes)
    expect(img.count).toBe(1)
    expect(img.heights.length).toBe(1)
    expect(img.heights[0]).toBeGreaterThan(0)
    expect(img.heights[0]).toBeLessThanOrEqual(36)
  })

  it('wraps a long subline beside the logo, at most 3 lines with an ellipsis, and pushes the report down', async () => {
    const address = 'Plot 14, Survey No. 221/3, Near Old Mumbai-Pune Highway, Opposite Chinchwad Railway Station, Chinchwad Industrial Area, '.repeat(4)
    const data: LabReportData = { ...BASE, hospital: { ...BASE.hospital, headerText: 'Sunrise Hospital, Pune', site: address, logoPng: PNG } }
    const bytes = await renderLabReportPdf(data)
    const runs = await textRuns(bytes)
    const logo = await logoBox(bytes)
    const measure = await PDFDocument.create()
    const regular = await measure.embedFont(StandardFonts.Helvetica)
    const bold = await measure.embedFont(StandardFonts.HelveticaBold)
    const width = (r: (typeof runs)[number]) => (r.bold ? bold : regular).widthOfTextAtSize(r.text, r.size)

    const reportIdx = runs.findIndex((r) => r.text === 'LABORATORY REPORT')
    const siteRuns = runs.slice(1, reportIdx)
    expect(runs[0].text).toBe('Sunrise Hospital, Pune')
    expect(siteRuns.length).toBe(3)
    expect(siteRuns[2].text.endsWith('...')).toBe(true)
    for (const r of runs.slice(0, reportIdx + 1)) {
      // Every header line stays on the page and left of the logo (no overlap with the logo band).
      expect(r.x + width(r)).toBeLessThanOrEqual(logo.x)
      expect(r.x + width(r)).toBeLessThanOrEqual(595.28 - 50)
    }
    // The report title sits below the wrapped subline; the patient block below the title and the logo.
    const report = runs[reportIdx]
    expect(report.y).toBeLessThan(siteRuns[2].y)
    expect(runs[reportIdx + 1].y).toBeLessThan(Math.min(report.y, logo.y))
  })

  it('embeds nothing without a logo and skips unreadable logo bytes silently', async () => {
    expect((await images(await renderLabReportPdf(BASE))).count).toBe(0)
    const broken: LabReportData = { ...BASE, hospital: { ...BASE.hospital, logoPng: new Uint8Array([1, 2, 3, 4]) } }
    const bytes = await renderLabReportPdf(broken)
    expect((await images(bytes)).count).toBe(0)
    expect((await pageTexts(bytes))[0]).toContain(BASE.hospital.headerText)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('lab report PDF reads the stored brand (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const ACTOR = `TEST-WL-T10-LAB-${RUN}`
  const session: Session = { role: 'admin', name: ACTOR, userId: null }
  let dir: string

  const blank = (over: Partial<BrandSettingsInput> = {}): BrandSettingsInput => ({
    displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, ...over,
  })

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hims-wl-lab-'))
    vi.stubEnv('BLOB_DRIVER', '')
    vi.stubEnv('BLOB_LOCAL_DIR', dir)
    vi.resetModules()
  })

  afterEach(async () => {
    const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
    await resetBrandSettings(null)
    vi.unstubAllEnvs()
    vi.resetModules()
    await rm(dir, { recursive: true, force: true })
  })

  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { auditLog } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  async function render() {
    const { labReportHospital } = await import('@/lib/queries/lab-reports')
    const hospital = await labReportHospital()
    const { renderLabReportPdf: renderPdf } = await import('@/lib/labs/report-pdf')
    const { buildLabReportData: build } = await import('@/lib/labs/report-data')
    return { hospital, bytes: await renderPdf(build({ ...SRC, hospital }, NOW)) }
  }

  it('stored name, header, footer and light logo', async () => {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const r = await q.updateBrandSettings(blank({
      displayName: 'Sunrise Hospital', printHeaderText: 'Sunrise Hospital, Pune', printFooterText: 'NABL accredited laboratory',
    }), 0, session)
    expect(r.ok).toBe(true)
    const { putPrivateBlob } = await import('@/lib/blob-store')
    const { url } = await putPrivateBlob(`branding/test-${RUN}.png`, PNG, 'image/png')
    await q.putBrandAsset('logo_light', { source: 'upload', blobUrl: url, sha256: 'b2'.repeat(32), width: 1, height: 1, byteSize: PNG.byteLength }, session)

    const { hospital, bytes } = await render()
    expect(JSON.stringify({ ...hospital, logoPng: null })).not.toContain('local:')
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getProducer()).toBe('Sunrise Hospital')
    expect(doc.getCreator()).toBe('Sunrise Hospital')
    const [text] = await pageTexts(bytes)
    expect(text).toContain('Sunrise Hospital, Pune')
    expect(text).toContain('NABL accredited laboratory')
    expect((await images(bytes)).count).toBe(1)
  })

  it('a logo row whose blob is gone renders without a logo', async () => {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    await q.putBrandAsset('logo_light', { source: 'upload', blobUrl: `local:branding/missing-${RUN}.png`, sha256: 'c3'.repeat(32), width: 1, height: 1, byteSize: 10 }, session)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { hospital, bytes } = await render()
    expect(hospital.logoPng).toBeNull()
    expect((await images(bytes)).count).toBe(0)
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('local:')
    warn.mockRestore()
  })

  it('with no stored brand: today\'s header and metadata, no logo, no footer text', async () => {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const { getBrand } = await import('@/lib/brand-server')
    const b = await getBrand()
    const { hospital, bytes } = await render()
    expect(hospital).toEqual({
      name: b.name, legalName: b.legalName, headerText: b.print.headerText, site: b.print.subline, footerText: null, logoPng: null,
    })
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getProducer()).toBe(b.name)
    expect((await images(bytes)).count).toBe(0)
  })
})
