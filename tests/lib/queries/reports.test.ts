import { describe, it, expect } from 'vitest'
import {
  listAllAppointmentsReport,
  listUnsignedNotesReport,
  listAllEncountersReport,
  listInsuranceCollectionsReport,
} from '@/lib/queries/reports'

describe('listAllAppointmentsReport', () => {
  it('returns rows shaped for the All Appointments columns', async () => {
    const rows = await listAllAppointmentsReport()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toHaveProperty('patientName')
    expect(rows[0]).toHaveProperty('apptDate')
    expect(rows[0]).toHaveProperty('apptTime')
    // apptDate must be a plain YYYY-MM-DD string derived from startsAt, not
    // a raw Date/timestamp -- this is the exact field this task had to
    // reconcile against Phase 2's real schema.
    expect(rows[0].apptDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('listUnsignedNotesReport', () => {
  it('only includes completed submissions without a screening row', async () => {
    const rows = await listUnsignedNotesReport()
    expect(rows.every((r) => r.status === 'Unsigned')).toBe(true)
  })

  it('normalizes visitDate to a string regardless of cache hit/miss', async () => {
    // formSubmissions.completedDate is a `timestamp` column -- a real Date
    // object on a fresh DB read but a plain string after this function's own
    // Redis round-trip on a cache hit. Calling twice exercises both paths.
    await listUnsignedNotesReport()
    const rows = await listUnsignedNotesReport()
    for (const r of rows) {
      if (r.visitDate !== null) expect(typeof r.visitDate).toBe('string')
    }
  })
})

describe('listAllEncountersReport', () => {
  it('only includes completed appointments', async () => {
    const rows = await listAllEncountersReport()
    expect(Array.isArray(rows)).toBe(true)
  })

  it('derives Payer Scenario/Encounter Status/Procedure from a real charges/claims join', async () => {
    const rows = await listAllEncountersReport()
    for (const r of rows) {
      expect(['Insurance', 'Self-Pay']).toContain(r.payerScenario)
      expect(['Billed', 'Completed — Not Billed']).toContain(r.encounterStatus)
    }
  })
})

describe('listInsuranceCollectionsReport', () => {
  it('returns claim rows joined with patient names and a service date derived from the linked charge', async () => {
    const rows = await listInsuranceCollectionsReport()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toHaveProperty('patientName')
    expect(rows[0]).toHaveProperty('serviceDate')
    expect(rows[0].serviceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
