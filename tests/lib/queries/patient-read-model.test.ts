import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientContacts, patientAadhaar } from '@/db/schema'
import { getPatientDetail, listPatientsWithStatus } from '@/lib/queries/patients'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { buildAadhaarRow } from '@/lib/patient-identity'
import { aadhaarInputSchema } from '@/lib/validation/patient-registration'
import { invalidateCache, patientDetailCacheKey, patientListCacheKey } from '@/lib/cache'

// Runtime half of the no-leak guard (static half: tests/lib/no-aadhaar-leak.test.ts).
// Real rows, real queries: the detail read model carries the Aadhaar SUMMARY
// (last4, never ciphertext or the decline note), the list and the portal
// carry no Aadhaar value at all.
const RUN = `${Date.now()}`
const AADHAAR = '234567890124'
const DIGIT_RUNS = /2345|6789|234567890124/
let seq = 0
const createdIds: string[] = []

async function fixturePatient(over: Partial<typeof patients.$inferInsert> = {}): Promise<string> {
  const id = `TEST-SP1-rm-${RUN}-${++seq}`
  await getDb().insert(patients).values({
    id, name: `TEST-SP1 ReadModel ${RUN}`, dob: '1990-01-01', gender: 'male', uhid: null,
    addressLine1: '12 MG Road', city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
    abhaUnavailableReason: 'not_created', ...over,
  })
  createdIds.push(id)
  await invalidateCache(patientDetailCacheKey(id))
  return id
}
const recordAadhaar = (id: string) =>
  getDb().insert(patientAadhaar).values(buildAadhaarRow(id, aadhaarInputSchema.parse({ status: 'provided', number: AADHAAR, consent: true }), 'TEST-SP1 Asha', new Date()))
const recordDecline = (id: string) =>
  getDb().insert(patientAadhaar).values(buildAadhaarRow(id, aadhaarInputSchema.parse({ status: 'declined', reason: 'other', note: 'secretnote-rm' }), 'TEST-SP1 Asha', new Date()))
const ciphertextOf = async (id: string) =>
  (await getDb().select({ c: patientAadhaar.aadhaarEncrypted }).from(patientAadhaar).where(eq(patientAadhaar.patientId, id)))[0].c!

describe.skipIf(!process.env.DATABASE_URL)('patient read model never carries Aadhaar values (DB)', () => {
  beforeEach(() => { vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64')) })
  afterEach(async () => {
    vi.unstubAllEnvs()
    const ids = createdIds.splice(0)
    if (ids.length === 0) return
    const db = getDb()
    await db.delete(patientContacts).where(inArray(patientContacts.patientId, ids))
    await db.delete(patientAadhaar).where(inArray(patientAadhaar.patientId, ids))
    await db.delete(patients).where(inArray(patients.id, ids))
    for (const id of ids) await invalidateCache(patientDetailCacheKey(id))
    await invalidateCache(patientListCacheKey(null))
  })

  it('getPatientDetail carries contacts and the Aadhaar summary, never ciphertext', async () => {
    const id = await fixturePatient()
    await recordAadhaar(id)
    await getDb().insert(patientContacts).values({ patientId: id, kind: 'emergency', name: 'Sita Kumar', relationship: 'spouse', phone: '+919876543210', isPrimary: true })
    const ciphertext = await ciphertextOf(id)

    const detail = await getPatientDetail(id)
    expect(detail?.aadhaar).toMatchObject({ status: 'on_file', last4: '0124', declineReason: null, recordedByName: 'TEST-SP1 Asha' })
    expect(detail?.contacts.map((c) => c.name)).toEqual(['Sita Kumar'])
    const json = JSON.stringify(detail)
    expect(json).not.toContain(ciphertext)
    expect(json).not.toMatch(/aadhaarEncrypted|declineNote|consentGiven|mfaSecretEncrypted/)
    expect(json).not.toMatch(DIGIT_RUNS)
  })

  it('getPatientDetail for a decline carries the reason code but never the free-text note', async () => {
    const id = await fixturePatient()
    await recordDecline(id)
    const detail = await getPatientDetail(id)
    expect(detail?.aadhaar).toMatchObject({ status: 'declined', last4: null, declineReason: 'other' })
    expect(JSON.stringify(detail)).not.toContain('secretnote-rm')
  })

  it('getPatientDetail with no Aadhaar row is not_recorded', async () => {
    const id = await fixturePatient()
    const detail = await getPatientDetail(id)
    expect(detail?.aadhaar).toEqual({ status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null })
    expect(detail?.contacts).toEqual([])
  })

  it('the patient list carries no Aadhaar at all', async () => {
    const id = await fixturePatient()
    await recordAadhaar(id)
    const ciphertext = await ciphertextOf(id)
    await invalidateCache(patientListCacheKey(null))
    const row = (await listPatientsWithStatus(null)).find((p) => p.id === id)
    expect(row).toBeDefined()
    const json = JSON.stringify(row)
    expect(json).not.toMatch(/aadhaar|0124/i)
    expect(json).not.toContain(ciphertext)
  })

  it('the portal profile has the on-file flag, masked ABHA, address and emergency contact -- no Aadhaar digits', async () => {
    const id = await fixturePatient({ uhid: `UHT${RUN.slice(-9)}`, abhaNumber: `91${RUN.slice(-12).padStart(12, '0')}`, abhaAddress: `rm${RUN.slice(-8)}@sbx`, abhaUnavailableReason: null })
    await recordAadhaar(id)
    await getDb().insert(patientContacts).values([
      { patientId: id, kind: 'next_of_kin', name: 'Kin Person', relationship: 'brother', phone: '+919876543211' },
      { patientId: id, kind: 'emergency', name: 'Sita Kumar', relationship: 'spouse', phone: '+919876543210', isPrimary: true },
    ])
    const ciphertext = await ciphertextOf(id)

    const data = await getPatientPortalData(id)
    expect(data?.profile).toEqual({
      uhid: `UHT${RUN.slice(-9)}`,
      abhaAddress: `rm${RUN.slice(-8)}@sbx`,
      abhaNumberMasked: `XX-XXXX-XXXX-${RUN.slice(-4)}`,
      addressSummary: 'Pune, Pune, Maharashtra 411001',
      emergencyContactName: 'Sita Kumar',
      aadhaarStatus: 'on_file',
    })
    const json = JSON.stringify(data)
    expect(json).not.toMatch(/0124|last4|masked"|aadhaarEncrypted|declineReason/)
    expect(json).not.toContain(ciphertext)
  })

  it('the portal profile for a sparse record: nulls, and Aadhaar declined', async () => {
    const id = await fixturePatient({ district: null })
    await recordDecline(id)
    const data = await getPatientPortalData(id)
    expect(data?.profile).toEqual({ uhid: null, abhaAddress: null, abhaNumberMasked: null, addressSummary: null, emergencyContactName: null, aadhaarStatus: 'declined' })
    expect(JSON.stringify(data)).not.toMatch(/secretnote-rm|other/)
  })
})
