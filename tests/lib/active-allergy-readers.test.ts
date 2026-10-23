// WS1 T4 (Task 3 review ruling): an inactivated allergy (allergies.inactivated_at set) is history,
// not a current alert. The patient detail read (medical record, patient page, workbook export) and
// the FHIR/C-CDA export gather return active allergies only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { allergies, patients } from '@/db/schema'
import { getPatientDetail } from '@/lib/queries/patients'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'

const PATIENT = `TWS1T4A-${Date.now()}`

describe.skipIf(!process.env.DATABASE_URL)('allergy readers return active allergies only', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_WS1T4 Allergy', dob: '1980-01-01', gender: 'female', uhid: `${PATIENT}-UH` })
    await db.insert(allergies).values([
      { patientId: PATIENT, allergen: 'Penicillin', severity: 'severe' },
      { patientId: PATIENT, allergen: 'Peanut', severity: 'mild', inactivatedAt: new Date() },
    ])
    await invalidateCache(patientDetailCacheKey(PATIENT))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(allergies).where(eq(allergies.patientId, PATIENT))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await invalidateCache(patientDetailCacheKey(PATIENT))
  })

  it('getPatientDetail', async () => {
    const detail = await getPatientDetail(PATIENT)
    expect(detail?.allergies.map((a) => a.allergen)).toEqual(['Penicillin'])
  })

  it('gatherPatientFhirData', async () => {
    const data = await gatherPatientFhirData(PATIENT)
    expect(data?.allergyRows.map((a) => a.allergen)).toEqual(['Penicillin'])
  })
})
