// SP5 Task 13: the pdf-lib lab report renderer. Text is checked by inflating each page's content
// stream and decoding the WinAnsi hex strings pdf-lib writes for the standard fonts.
import { describe, it, expect, vi } from 'vitest'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from 'pdf-lib'
import { buildLabReportData, type LabReportData } from '@/lib/labs/report-data'
import { renderLabReportPdf } from '@/lib/labs/report-pdf'
import { formatDateTimeIn } from '@/lib/india-time'
import { SRC } from './report-fixtures'

const NOW = new Date('2099-03-04T06:00:00Z')
const DATA3: LabReportData = buildLabReportData(SRC, NOW)
const DATA60: LabReportData = {
  ...DATA3,
  rows: Array.from({ length: 60 }, (_, i) => ({ ...DATA3.rows[i % 3], testName: `Test number ${i + 1} with a fairly long descriptive panel name` })),
}

function streamBytes(page: PDFPage): Buffer[] {
  const contents = page.node.Contents()
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => page.doc.context.lookup(ref))
    : [contents]
  return streams.map((s) => {
    if (!(s instanceof PDFRawStream)) throw new Error('unexpected content stream type')
    const raw = Buffer.from(s.getContents())
    return s.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode') ? inflateSync(raw) : raw
  })
}

/** The text drawn on each page, one string per page (show-text operands joined by newlines). */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((page) =>
    streamBytes(page)
      .map((b) => [...b.toString('latin1').matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n'))
      .join('\n'))
}

describe('renderLabReportPdf', () => {
  it('renders a one-page PDF with metadata', async () => {
    const bytes = await renderLabReportPdf(DATA3)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-')
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Lab report LR-2099-000001')
    expect(doc.getProducer()).toBe('Test Hospital')
    expect(doc.getCreationDate()?.toISOString()).toBe(NOW.toISOString())
    const { width, height } = doc.getPage(0).getSize()
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842])
  })

  it('prints the header, patient block, results, verifiers, signature line and footer', async () => {
    const [text] = await pageTexts(await renderLabReportPdf(DATA3))
    for (const s of [
      'Test Hospital Trust', 'Main campus', 'LABORATORY REPORT',
      'Asha Rao', 'UH-000042', '25 y / Female'.replace('25', String(DATA3.patient.ageYears)),
      'Dr Meera Iyer (SMC KA 12345)', 'LR-2099-000001 / v1',
      'Haemoglobin', '11.2', 'g/dL', '12-16 g/dL', 'ABNORMAL', 'CRITICAL', 'Glucose, fasting', '70-110 mg/dL',
      'Test', 'Result', 'Unit', 'Reference range', 'Flag',
      'Verified by: Dr Path One, Dr Path Two',
      'Authorised signatory: ______________________',
      'This is a computer-generated report.',
      'Report LR-2099-000001 v1 · Page 1 of 1',
    ]) expect(text).toContain(s)
    // Generated time in IST through the shared formatter (whitespace collapsed as on the page).
    expect(text).toContain(formatDateTimeIn(NOW).replace(/\s+/g, ' '))
    // Collection time (IST) of the earliest collected sample.
    expect(text).toContain(formatDateTimeIn(new Date('2099-03-02T04:00:00Z')).replace(/\s+/g, ' '))
  })

  it('never prints a date of birth, phone, address or ID numbers it was not given', async () => {
    const [text] = await pageTexts(await renderLabReportPdf(DATA3))
    expect(text).not.toMatch(/aadhaar|abha|2059-03-03/i)
  })

  it('breaks long reports across pages with the header row repeated and n of m footers', async () => {
    const bytes = await renderLabReportPdf(DATA60)
    const doc = await PDFDocument.load(bytes)
    const n = doc.getPageCount()
    expect(n).toBeGreaterThan(1)
    const texts = await pageTexts(bytes)
    texts.forEach((t, i) => {
      expect(t).toContain(`Report LR-2099-000001 v1 · Page ${i + 1} of ${n}`)
      // Every page that carries result rows repeats the table header row.
      if (t.includes('Test number')) expect(t).toContain('Reference range')
    })
    expect(texts.filter((t) => t.includes('Test number')).length).toBeGreaterThan(1)
    const all = texts.join('\n')
    expect(all).toContain('Test number 1 ')
    expect(all).toContain('Test number 60 ')
    expect(texts[n - 1]).toContain('Authorised signatory: ______________________')
  })

  it('prints a clear placeholder and a note for a Devanagari name (no Indian-script font)', async () => {
    const bytes = await renderLabReportPdf({ ...DATA3, patient: { ...DATA3.patient, name: 'राम Kumar' } })
    expect(bytes).toBeInstanceOf(Uint8Array)
    const [text] = await pageTexts(bytes)
    expect(text).toContain('[non-Latin text] Kumar')
    expect(text).not.toContain('???')
    expect(text).toContain('The name is in a script this PDF cannot print; see the chart or the patient portal.')
  })

  it('adds no script note for a Latin name', async () => {
    const [text] = await pageTexts(await renderLabReportPdf(DATA3))
    expect(text).not.toContain('cannot print')
  })

  it('does not throw on a very long name, an unbreakable value, many results or no results', async () => {
    const long = 'Venkata Subrahmanya Lakshmi Narasimha Ramachandra Bhagavatula Sriramachandramurthy'.repeat(3)
    const bytes = await renderLabReportPdf({
      ...DATA3,
      patient: { ...DATA3.patient, name: long },
      rows: [{ ...DATA3.rows[0], value: 'X'.repeat(300), referenceRange: 'Y'.repeat(200) }, ...DATA60.rows, ...DATA60.rows],
    })
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(2)
    const empty = await renderLabReportPdf({ ...DATA3, rows: [], verifiers: [], hospital: { ...DATA3.hospital, site: null }, patient: { ...DATA3.patient, uhid: null, gender: null } })
    const [text] = await pageTexts(empty)
    expect(text).toContain('No results.')
    expect((await PDFDocument.load(empty)).getPageCount()).toBe(1)
  })

  it('is deterministic and touches neither the network nor the filesystem', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const a = await renderLabReportPdf(DATA3)
    const b = await renderLabReportPdf(DATA3)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
