import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientAadhaar } from '@/db/schema'
import { gatherPatientFhirData } from '@/lib/fhir/gather'
import { buildFullBundle } from '@/lib/fhir/bundle'
import { toCcdaXml } from '@/lib/fhir/ccda'

const PATIENT_ID = 'RD-FHIR-NOAADH-1'
const FULL_NUMBER = '234567890124'
const LAST4 = '0124'
const CIPHERTEXT = 'ciphertext-fixture-value'

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values({ id: PATIENT_ID, name: 'No Leak Patient', dob: '1980-01-01', uhid: 'UH000000999', gender: 'female', addressLine1: '1 Test Street', stateCode: 'IN-KA', pinCode: '560001' })
  await db.insert(patientAadhaar).values({ patientId: PATIENT_ID, aadhaarEncrypted: CIPHERTEXT, aadhaarLast4: LAST4, consentGiven: true, consentRecordedAt: new Date(), recordedByName: 'Fixture' })
})
afterAll(async () => {
  const db = getDb()
  await db.delete(patientAadhaar).where(eq(patientAadhaar.patientId, PATIENT_ID))
  await db.delete(patients).where(eq(patients.id, PATIENT_ID))
})

describe('FHIR and C-CDA output for a patient with an Aadhaar row', () => {
  it('contains no Aadhaar digits, last4, ciphertext or label anywhere', async () => {
    const data = (await gatherPatientFhirData(PATIENT_ID))!
    const out = JSON.stringify(buildFullBundle(data)) + toCcdaXml(data)
    expect(out).toContain('UH000000999')
    for (const needle of [FULL_NUMBER, '2345 6789 0124', '2345-6789-0124', LAST4, CIPHERTEXT]) expect(out).not.toContain(needle)
    expect(out).not.toMatch(/aadhaar/i)
  })
})
