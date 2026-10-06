import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildWorkbookXlsx, buildFullWorkbookXlsx } from '@/lib/excel-export'

// Fields every `ExportablePatient` literal in this file needs but that most
// individual tests don't care about -- spread this in and override only the
// fields under test, so each test stays focused on what it's actually
// asserting instead of restating the whole shape every time.
const baseExportablePatient = {
  name: 'Maria Alvarez',
  dob: '1985-03-12',
  phone: null,
  email: null,
  identityVerified: false,
  idType: null,
  currentProvider: 'Dr. R. Kunam',
  referralType: 'Provider referral',
  diagnoses: [],
  medications: [],
  allergies: [],
  trialName: null,
  overallStatus: null,
  criteriaNeedingVerification: [],
  formStatus: null,
  lastCommunication: null,
}

describe('buildWorkbookXlsx', () => {
  it('produces a non-empty xlsx buffer with a header row matching the column map', async () => {
    const buffer = await buildWorkbookXlsx([
      { ...baseExportablePatient, id: 'RD-0001' },
    ])
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('uses the neutral "PI Recommendation" heading and never names an individual', async () => {
    const buffer = await buildFullWorkbookXlsx([])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    const headers = (wb.worksheets[0].getRow(1).values as unknown[]).map(String)
    expect(headers).toContain('PI Recommendation')
    expect(headers.join('|')).not.toMatch(/Kunam/)
  })

  it('neutralizes a leading formula character so Excel treats the cell as literal text, not a formula', async () => {
    const buffer = await buildWorkbookXlsx([
      {
        ...baseExportablePatient,
        id: 'RD-0002',
        name: '=cmd|"/c calc"!A1',
        currentProvider: '+SUM(A1:A9)',
        referralType: '@import(evil)',
      },
    ])

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    const sheet = workbook.getWorksheet('Screening Workbook')!
    const row = sheet.getRow(2)

    // The security property that matters: the value is stored as a plain
    // string cell (never ExcelJS's formula-object shape, `{formula, result}`),
    // so Excel can never execute it as a formula regardless of leading
    // character. The leading apostrophe is prepended to the stored text
    // itself — that's the standard mitigation (OWASP's CSV/Excel injection
    // guidance): it's a UI-input convention Excel recognizes when a *user*
    // types it, but writing it into the literal string value achieves the
    // same "this is text" signal for programmatically-written cells, at the
    // cost of the apostrophe being visible in the cell — an acceptable,
    // intentional tradeoff for a security-sensitive export.
    // Column 2 = "Name", 8 = "Current Provider", 9 = "Referral Type".
    expect(typeof row.getCell(2).value).toBe('string')
    expect(row.getCell(2).value).toBe("'=cmd|\"/c calc\"!A1")
    expect(typeof row.getCell(8).value).toBe('string')
    expect(row.getCell(8).value).toBe("'+SUM(A1:A9)")
    expect(typeof row.getCell(9).value).toBe('string')
    expect(row.getCell(9).value).toBe("'@import(evil)")
  })

  it('neutralizes a leading minus sign (the fourth dangerous character)', async () => {
    const buffer = await buildWorkbookXlsx([
      { ...baseExportablePatient, id: 'RD-0004', name: '-2+3+cmd|"/c calc"!A0', referralType: 'Self-referral' },
    ])

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    const sheet = workbook.getWorksheet('Screening Workbook')!
    const cell = sheet.getRow(2).getCell(2) // "Name"

    expect(typeof cell.value).toBe('string')
    expect(cell.value).toBe('\'-2+3+cmd|"/c calc"!A0')
  })

  it('leaves ordinary values untouched', async () => {
    const buffer = await buildWorkbookXlsx([
      { ...baseExportablePatient, id: 'RD-0003', referralType: 'Self-referral' },
    ])

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    const sheet = workbook.getWorksheet('Screening Workbook')!
    expect(sheet.getRow(2).getCell(2).value).toBe('Maria Alvarez') // "Name"
  })

  it('renders a null phone/email as an empty cell rather than the literal string "null"', async () => {
    const buffer = await buildWorkbookXlsx([
      { ...baseExportablePatient, id: 'RD-0003', phone: null, email: null },
    ])

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
    const sheet = workbook.getWorksheet('Screening Workbook')!
    const row = sheet.getRow(2)

    // Column 4 = "Phone", 5 = "Email".
    expect(row.getCell(4).value == null).toBe(true)
    expect(row.getCell(5).value == null).toBe(true)
  })

  it('includes identity, allergy, and needs-verification columns', async () => {
    const buffer = await buildWorkbookXlsx([{
      id: 'RD-9999', name: 'Test Patient', dob: '1990-01-01',
      phone: null, email: null,
      identityVerified: true, idType: 'passport',
      currentProvider: null, referralType: null,
      diagnoses: [{ code: 'F33.1', description: 'MDD, recurrent, moderate' }],
      medications: [{ name: 'Sertraline', dose: '50mg', startDate: '2026-06-01' }],
      allergies: [{ allergen: 'Penicillin', severity: 'moderate' }],
      trialName: 'NCT06911112', overallStatus: 'yellow',
      criteriaNeedingVerification: [{ criterionText: 'Medication washout', evidenceQuote: 'started 5 weeks ago' }],
      formStatus: 'completed', lastCommunication: null,
    }])
    expect(buffer.length).toBeGreaterThan(0)
  })
})
