import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patientContacts, patients } from '@/db/schema'
import { correctPatientDemographics } from '@/lib/queries/patient-profile'

// Wave C P1-11. Fixture patient by id (TEST_WC_ prefix); audit rows written
// by this file carry a unique probe userName and are deleted by it.
const PID = 'TEST_WC_DEMO1'
const PROBE = `TEST_WC_PROBE_${Date.now()}`
const session = { role: 'admin' as const, name: PROBE, userId: null }

beforeAll(async () => {
  await getDb().delete(patientContacts).where(eq(patientContacts.patientId, PID))
  await getDb().delete(patients).where(eq(patients.id, PID))
  await getDb().insert(patients).values({ id: PID, name: 'Asha Raoo', dob: '1990-01-01' })
})

afterAll(async () => {
  await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  await getDb().delete(patientContacts).where(eq(patientContacts.patientId, PID))
  await getDb().delete(patients).where(eq(patients.id, PID))
})

describe('correctPatientDemographics', () => {
  it('corrects name and DOB and audits field names plus the reason (no values) in the same transaction', async () => {
    const r = await correctPatientDemographics(PID, { name: 'Asha Rao', dob: '1990-01-10', reason: 'Typo at registration' }, session)
    expect(r).toBe('ok')
    const [row] = await getDb().select({ name: patients.name, dob: patients.dob }).from(patients).where(eq(patients.id, PID))
    expect(row).toEqual({ name: 'Asha Rao', dob: '1990-01-10' })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'corrected patient demographics: name, dob', patientId: PID, details: 'reason: Typo at registration', role: 'admin' })
    expect(`${audits[0].action} ${audits[0].details}`).not.toMatch(/Asha|1990/)
  })

  it('refuses a DOB that makes the patient a minor without a guardian contact, writing nothing', async () => {
    const r = await correctPatientDemographics(PID, { dob: '2020-01-01', reason: 'Wrong year' }, session)
    expect(r).toBe('guardian_required')
    const [row] = await getDb().select({ dob: patients.dob }).from(patients).where(eq(patients.id, PID))
    expect(row.dob).toBe('1990-01-10')
    expect(await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE))).toHaveLength(1)
  })

  it('returns not_found for an unknown patient', async () => {
    expect(await correctPatientDemographics('TEST_WC_NOPE', { name: 'X Y', reason: 'Typo here' }, session)).toBe('not_found')
  })
})
