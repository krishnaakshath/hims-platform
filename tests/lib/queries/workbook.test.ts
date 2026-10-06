import { describe, it, expect } from 'vitest'
import { listWorkbookRows, calculateAge } from '@/lib/queries/workbook'

describe('calculateAge', () => {
  it('computes age as of today from a DOB string', () => {
    const twentyYearsAgo = new Date()
    twentyYearsAgo.setFullYear(twentyYearsAgo.getFullYear() - 20)
    expect(calculateAge(twentyYearsAgo.toISOString().slice(0, 10))).toBe(20)
  })

  it('does not count a birthday that has not happened yet this year', () => {
    const now = new Date()
    const notYetBirthday = new Date(now.getFullYear() - 20, now.getMonth() + 1, now.getDate())
    expect(calculateAge(notYetBirthday.toISOString().slice(0, 10))).toBe(19)
  })
})

describe('listWorkbookRows', () => {
  it('returns one row per seeded patient with all 29 workbook fields present', async () => {
    const rows = await listWorkbookRows()
    expect(rows.length).toBeGreaterThanOrEqual(15)

    const row = rows[0]
    // Every field WorkbookRow declares must be a real key on the returned
    // row (even if its value is null) -- this is the mechanical check that
    // the query never silently drops one of the workbook columns. Originally
    // 30 columns; 'tebraChartUrl' (LINK TEBRA) was dropped once the
    // unified-patient-record migration removed that column outright, with
    // no single-sourced replacement -- see excel-export.ts's
    // FULL_WORKBOOK_COLUMNS comment.
    const expectedKeys = [
      'id', 'dateAdded', 'patientName', 'currentProvider', 'ratingScales',
      'dob', 'age', 'city', 'zip', 'phone',
      'dxCodes', 'lastCommunication', 'referralType', 'availability', 'apptDates',
      'commConsent', 'formNotes', 'reviewerNotes', 'clinicianReviewerNotes', 'piRecommendation',
      'activeMeds', 'inactiveMeds', 'oldNotes', 'oldRecs',
      'intakeqEmail', 'patientEmail', 'outsideMedsConfirmation', 'templateDocUrl', 'prescreeningSentDate',
    ]
    for (const key of expectedKeys) expect(row).toHaveProperty(key)
    expect(expectedKeys.length).toBe(29)
  })

  it('derives patient name and DOB from the single-sourced patients.name/patients.dob columns', async () => {
    const rows = await listWorkbookRows()
    expect(rows.every((r) => typeof r.patientName === 'string' && r.patientName.length > 0)).toBe(true)
    expect(rows.every((r) => typeof r.dob === 'string' && r.dob.length > 0)).toBe(true)
  })

  it('joins diagnoses and medications per patient rather than returning them for every row', async () => {
    const rows = await listWorkbookRows()
    // Not every seeded patient shares the same diagnosis/medication text --
    // if the join were unfiltered (missing a patientId match), every row's
    // dxCodes would be identical.
    const distinctDx = new Set(rows.map((r) => r.dxCodes))
    expect(distinctDx.size).toBeGreaterThan(1)
  })
})
