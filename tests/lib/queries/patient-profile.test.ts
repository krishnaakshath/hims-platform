import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientContacts, patientAadhaar, auditLog } from '@/db/schema'
import { getIdentitySnapshot, updatePatientProfile, replacePatientContacts, upsertPatientAadhaar } from '@/lib/queries/patient-profile'
import { buildAadhaarRow } from '@/lib/patient-identity'
import { patientProfileUpdateSchema, aadhaarInputSchema, contactInputSchema } from '@/lib/validation/patient-registration'
import { isUniqueViolation } from '@/lib/db-errors'
import { decryptSensitive } from '@/lib/crypto'
import type { Session } from '@/lib/auth'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST-SP1-profile-${RUN}`
const SESSION: Session = { role: 'crc', name: PROBE_USER, userId: null }
const AADHAAR_FRAGMENTS = /2345[\s.-]*6789[\s.-]*0124/
const ABHA_NUMBER = `92${RUN.slice(-12).padStart(12, '0')}`
const ABHA_ADDRESS = `sp1p${RUN.slice(-8)}@sbx`

let seq = 0
const createdIds: string[] = []

async function fixturePatient(over: Partial<typeof patients.$inferInsert> = {}): Promise<string> {
  const id = `TEST-SP1-${RUN}-${++seq}`
  await getDb().insert(patients).values({
    id, name: `TEST-SP1 Profile ${RUN}`, dob: '1990-01-01', gender: 'female', city: 'Mumbai', district: 'Mumbai',
    stateCode: 'IN-MH', pinCode: '400001', addressLine1: '12 MG Road', abhaUnavailableReason: 'not_created', ...over,
  })
  createdIds.push(id)
  return id
}

const auditFor = async (id: string) => getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog)
  .where(sql`${auditLog.userName} = ${PROBE_USER} and ${auditLog.patientId} = ${id}`).orderBy(auditLog.id)

describe.skipIf(!process.env.DATABASE_URL)('patient profile queries (DB)', () => {
  beforeEach(() => {
    vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    const ids = createdIds.splice(0)
    if (ids.length === 0) return
    const db = getDb()
    await db.delete(patientContacts).where(inArray(patientContacts.patientId, ids))
    await db.delete(patientAadhaar).where(inArray(patientAadhaar.patientId, ids))
    await db.delete(auditLog).where(sql`${auditLog.userName} = ${PROBE_USER} and ${inArray(auditLog.patientId, ids)}`)
    await db.delete(patients).where(inArray(patients.id, ids))
  })

  it('getIdentitySnapshot returns null for an unknown patient and status-only Aadhaar for a known one', async () => {
    expect(await getIdentitySnapshot('TEST-SP1-nope')).toBeNull()
    const id = await fixturePatient({ isMlc: true })
    expect(await getIdentitySnapshot(id)).toEqual({
      dob: '1990-01-01',
      snapshot: { aadhaarStatus: 'not_recorded', aadhaarDeclineReason: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: 'not_created', isMlc: true },
    })
    await getDb().insert(patientAadhaar).values(buildAadhaarRow(id, aadhaarInputSchema.parse({ status: 'provided', number: '234567890124', consent: true }), PROBE_USER, new Date()))
    const snap = await getIdentitySnapshot(id)
    expect(snap?.snapshot.aadhaarStatus).toBe('on_file')
    expect(JSON.stringify(snap)).not.toMatch(/0124|aadhaarEncrypted/)
  })

  it('updatePatientProfile returns false for an unknown patient and writes nothing', async () => {
    expect(await updatePatientProfile('TEST-SP1-nope', patientProfileUpdateSchema.parse({ city: 'Pune' }), SESSION)).toBe(false)
  })

  it('updatePatientProfile sets ABHA provided (nulling unavailable), audits in the same call, and never touches Aadhaar', async () => {
    const id = await fixturePatient({ abhaUnavailableNote: 'x' })
    await getDb().insert(patientAadhaar).values(buildAadhaarRow(id, aadhaarInputSchema.parse({ status: 'provided', number: '234567890124', consent: true }), PROBE_USER, new Date()))
    const [aBefore] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, id))

    const ok = await updatePatientProfile(id, patientProfileUpdateSchema.parse({
      city: 'Pune', isMlc: true, mlcNumber: 'MLC-9', abha: { status: 'provided', abhaNumber: ABHA_NUMBER, abhaAddress: ABHA_ADDRESS },
    }), SESSION)
    expect(ok).toBe(true)

    const [p] = await getDb().select().from(patients).where(eq(patients.id, id))
    expect(p).toMatchObject({ city: 'Pune', district: 'Mumbai', isMlc: true, mlcNumber: 'MLC-9', abhaNumber: ABHA_NUMBER, abhaAddress: ABHA_ADDRESS, abhaUnavailableReason: null, abhaUnavailableNote: null })
    const [aAfter] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, id))
    expect(aAfter).toEqual(aBefore)

    const audit = await auditFor(id)
    expect(audit).toEqual([
      { action: 'updated patient profile', details: null },
      { action: 'set ABHA number', details: null },
      { action: 'set ABHA address', details: null },
      { action: 'set MLC flag', details: null },
    ])
  })

  it('updatePatientProfile with ABHA unavailable nulls number/address; clearing MLC nulls its number', async () => {
    const id = await fixturePatient({ abhaNumber: ABHA_NUMBER, abhaAddress: ABHA_ADDRESS, abhaUnavailableReason: null, isMlc: true, mlcNumber: 'MLC-3' })
    await updatePatientProfile(id, patientProfileUpdateSchema.parse({ isMlc: false, abha: { status: 'unavailable', reason: 'other', note: 'no phone' } }), SESSION)
    const [p] = await getDb().select().from(patients).where(eq(patients.id, id))
    expect(p).toMatchObject({ abhaNumber: null, abhaAddress: null, abhaUnavailableReason: 'other', abhaUnavailableNote: 'no phone', isMlc: false, mlcNumber: null })
    expect((await auditFor(id)).map((a) => a.action)).toEqual(['updated patient profile', 'removed ABHA number', 'removed ABHA address', 'recorded ABHA unavailable', 'cleared MLC flag'])
  })

  it('a duplicate ABHA address on another patient is a unique violation and rolls back the profile change and its audit', async () => {
    await fixturePatient({ abhaAddress: ABHA_ADDRESS, abhaUnavailableReason: null })
    const id = await fixturePatient()
    const err = await updatePatientProfile(id, patientProfileUpdateSchema.parse({ city: 'Pune', abha: { status: 'provided', abhaAddress: ABHA_ADDRESS } }), SESSION).catch((e: unknown) => e)
    expect(isUniqueViolation(err, 'patients_abha_address_unique')).toBe(true)
    const [p] = await getDb().select().from(patients).where(eq(patients.id, id))
    expect(p.city).toBe('Mumbai')
    expect(await auditFor(id)).toEqual([])
  })

  it('replacePatientContacts deletes and inserts in one transaction and audits', async () => {
    const id = await fixturePatient()
    await getDb().insert(patientContacts).values({ patientId: id, kind: 'emergency', name: 'Old', relationship: 'friend', phone: '+919876543210' })
    const next = [contactInputSchema.parse({ kind: 'next_of_kin', name: 'New', relationship: 'spouse', phone: '9876543211', isPrimary: true })]
    await replacePatientContacts(id, next, SESSION)
    const rows = await getDb().select().from(patientContacts).where(eq(patientContacts.patientId, id))
    expect(rows.map((r) => ({ kind: r.kind, name: r.name, phone: r.phone, isPrimary: r.isPrimary }))).toEqual([{ kind: 'next_of_kin', name: 'New', phone: '+919876543211', isPrimary: true }])
    expect(await auditFor(id)).toEqual([{ action: 'updated patient contacts', details: null }])

    // A failing insert (unknown patient) leaves nothing behind.
    await expect(replacePatientContacts('TEST-SP1-nope', next, SESSION)).rejects.toBeTruthy()
  })

  it('upsertPatientAadhaar inserts, then switches declined -> on_file -> declined with one audit action each and no digits', async () => {
    const id = await fixturePatient()
    const decline = aadhaarInputSchema.parse({ status: 'declined', reason: 'emergency' })
    const provide = aadhaarInputSchema.parse({ status: 'provided', number: '2345 6789 0124', consent: true })

    await upsertPatientAadhaar(id, buildAadhaarRow(id, decline, PROBE_USER, new Date()), SESSION)
    await upsertPatientAadhaar(id, buildAadhaarRow(id, provide, PROBE_USER, new Date()), SESSION)
    let [row] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, id))
    expect(row).toMatchObject({ aadhaarLast4: '0124', consentGiven: true, declineReason: null, declineNote: null })
    expect(decryptSensitive(row.aadhaarEncrypted!)).toBe('234567890124')

    await upsertPatientAadhaar(id, buildAadhaarRow(id, provide, PROBE_USER, new Date()), SESSION)
    await upsertPatientAadhaar(id, buildAadhaarRow(id, aadhaarInputSchema.parse({ status: 'declined', reason: 'other', note: 'lost card' }), PROBE_USER, new Date()), SESSION)
    ;[row] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, id))
    expect(row).toMatchObject({ aadhaarEncrypted: null, aadhaarLast4: null, consentGiven: false, declineReason: 'other', declineNote: 'lost card' })

    const audit = await auditFor(id)
    expect(audit).toEqual([
      { action: 'recorded Aadhaar decline', details: 'reason: emergency' },
      { action: 'recorded Aadhaar with consent', details: null },
      { action: 'replaced Aadhaar', details: null },
      { action: 'recorded Aadhaar decline', details: 'reason: other' },
    ])
    expect(JSON.stringify(audit)).not.toMatch(AADHAAR_FRAGMENTS)
    expect(JSON.stringify(audit)).not.toMatch(/0124/)
  })
})
