import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientContacts, patientAadhaar, identityVerifications, auditLog } from '@/db/schema'
import { registerPatient } from '@/lib/queries/patient-registration'
import { patientRegistrationSchema, type PatientRegistrationInput } from '@/lib/validation/patient-registration'
import { isUniqueViolation } from '@/lib/db-errors'
import { decryptSensitive } from '@/lib/crypto'
import { parseUhid, formatUhid } from '@/lib/uhid'
import { getUhidPrefix } from '@/lib/queries/uhid'

const AADHAAR = '234567890124'
// Fixture ids, UHIDs and ABHA values are run-derived digits, so match the
// number in any of its typed forms rather than bare 4-digit groups.
const AADHAAR_FRAGMENTS = /2345[\s.-]*6789[\s.-]*0124/
const RUN = `${Date.now()}`
const PROBE_USER = `TEST-SP1-registration-${RUN}`
// Unique per run: ABHA number/address are UNIQUE on patients.
const ABHA_NUMBER = `91${RUN.slice(-12).padStart(12, '0')}`
const ABHA_ADDRESS = `sp1t${RUN.slice(-8)}@sbx`

const input = (over: Record<string, unknown> = {}): PatientRegistrationInput => patientRegistrationSchema.parse({
  name: `TEST-SP1 Patient ${RUN}`, dob: '1990-01-01', gender: 'female', addressLine1: '12 MG Road', city: 'Mumbai', district: 'Mumbai',
  stateCode: 'IN-MH', pinCode: '400001',
  aadhaar: { status: 'provided', number: '2345 6789 0124', consent: true },
  abha: { status: 'provided', abhaNumber: ABHA_NUMBER, abhaAddress: ABHA_ADDRESS },
  contacts: [{ kind: 'emergency', name: `TEST-SP1 Contact ${RUN}`, relationship: 'spouse', phone: '9876543210' }],
  ...over,
})

const createdIds: string[] = []

async function patientsNamed(name: string) {
  return getDb().select({ id: patients.id, uhid: patients.uhid }).from(patients).where(eq(patients.name, name))
}

describe.skipIf(!process.env.DATABASE_URL)('registerPatient (DB)', () => {
  beforeEach(() => {
    vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    // Safety net: anything registered under this run's fixture names, even
    // if a test failed before recording its id.
    const stray = await getDb().select({ id: patients.id }).from(patients).where(sql`${patients.name} like ${`TEST-SP1 %${RUN}`}`)
    const ids = [...new Set([...createdIds.splice(0), ...stray.map((r) => r.id)])]
    if (ids.length === 0) return
    const db = getDb()
    await db.delete(patientContacts).where(inArray(patientContacts.patientId, ids))
    await db.delete(patientAadhaar).where(inArray(patientAadhaar.patientId, ids))
    await db.delete(identityVerifications).where(inArray(identityVerifications.patientId, ids))
    await db.delete(auditLog).where(sql`${auditLog.userName} = ${PROBE_USER} and ${inArray(auditLog.patientId, ids)}`)
    await db.delete(patients).where(inArray(patients.id, ids))
  })

  it('writes the patient, contacts, encrypted Aadhaar and KYC in one go and returns the identity audit entries', async () => {
    const res = await registerPatient(input({ kyc: { docType: 'pan', docNumber: 'ABCDE1234F' }, isMlc: true, mlcNumber: 'MLC-77' }), PROBE_USER)
    createdIds.push(res.id)

    expect(res.id).toMatch(/^RD-\d{4,}$/)
    expect(parseUhid(res.uhid)).not.toBeNull()
    expect(JSON.stringify(res)).not.toMatch(AADHAAR_FRAGMENTS)
    expect(res.auditEntries).toEqual([
      { action: 'recorded Aadhaar with consent', details: null },
      { action: 'set ABHA number', details: null },
      { action: 'set ABHA address', details: null },
      { action: 'set MLC flag', details: null },
    ])

    const [p] = await getDb().select().from(patients).where(eq(patients.id, res.id))
    expect(p.uhid).toBe(res.uhid)
    expect(parseUhid(p.uhid!)).not.toBeNull()
    expect(p).toMatchObject({
      gender: 'female', addressLine1: '12 MG Road', city: 'Mumbai', district: 'Mumbai', stateCode: 'IN-MH', pinCode: '400001',
      zip: null, nationality: 'IN', abhaNumber: ABHA_NUMBER, abhaAddress: ABHA_ADDRESS, abhaUnavailableReason: null,
      isMlc: true, mlcNumber: 'MLC-77',
    })
    expect(JSON.stringify(p)).not.toMatch(AADHAAR_FRAGMENTS)

    const contacts = await getDb().select().from(patientContacts).where(eq(patientContacts.patientId, res.id))
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ kind: 'emergency', relationship: 'spouse', phone: '+919876543210', isPrimary: false })

    const [a] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, res.id))
    expect(a.aadhaarEncrypted).not.toBeNull()
    expect(a.aadhaarEncrypted).not.toBe(AADHAAR)
    expect(a.aadhaarEncrypted).not.toContain(AADHAAR)
    expect(decryptSensitive(a.aadhaarEncrypted!)).toBe(AADHAAR)
    expect(a).toMatchObject({ aadhaarLast4: '0124', consentGiven: true, declineReason: null, recordedByName: PROBE_USER })

    const [k] = await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, res.id))
    expect(k).toMatchObject({ idType: 'pan', verified: false })
    expect(k.idNumberEncrypted).not.toContain('ABCDE1234F')
    expect(decryptSensitive(k.idNumberEncrypted)).toBe('ABCDE1234F')
  })

  it('records an Aadhaar decline and ABHA unavailable with reason codes only', async () => {
    const res = await registerPatient(input({
      aadhaar: { status: 'declined', reason: 'patient_declined' },
      abha: { status: 'unavailable', reason: 'not_created' },
      contacts: [],
    }), PROBE_USER)
    createdIds.push(res.id)
    expect(res.auditEntries).toEqual([
      { action: 'recorded Aadhaar decline', details: 'reason: patient_declined' },
      { action: 'recorded ABHA unavailable', details: 'reason: not_created' },
    ])
    const [p] = await getDb().select().from(patients).where(eq(patients.id, res.id))
    expect(p).toMatchObject({ abhaNumber: null, abhaAddress: null, abhaUnavailableReason: 'not_created', isMlc: false })
    const [a] = await getDb().select().from(patientAadhaar).where(eq(patientAadhaar.patientId, res.id))
    expect(a).toMatchObject({ aadhaarEncrypted: null, aadhaarLast4: null, consentGiven: false, declineReason: 'patient_declined' })
    expect(await getDb().select().from(patientContacts).where(eq(patientContacts.patientId, res.id))).toHaveLength(0)
    expect(await getDb().select().from(identityVerifications).where(eq(identityVerifications.patientId, res.id))).toHaveLength(0)
  })

  it('a second registration with the same ABHA number throws a unique violation and leaves nothing behind', async () => {
    const first = await registerPatient(input({ abha: { status: 'provided', abhaNumber: ABHA_NUMBER } }), PROBE_USER)
    createdIds.push(first.id)
    const dupName = `TEST-SP1 Duplicate ${RUN}`
    const err = await registerPatient(input({ name: dupName, abha: { status: 'provided', abhaNumber: ABHA_NUMBER } }), PROBE_USER).catch((e: unknown) => e)
    expect(isUniqueViolation(err, 'patients_abha_number_unique')).toBe(true)
    expect(await patientsNamed(dupName)).toEqual([])
  })

  it('a second registration with the same ABHA address throws a unique violation', async () => {
    const first = await registerPatient(input({ abha: { status: 'provided', abhaAddress: ABHA_ADDRESS } }), PROBE_USER)
    createdIds.push(first.id)
    const err = await registerPatient(input({ name: `TEST-SP1 Duplicate addr ${RUN}`, abha: { status: 'provided', abhaAddress: ABHA_ADDRESS.toUpperCase() } }), PROBE_USER).catch((e: unknown) => e)
    expect(isUniqueViolation(err, 'patients_abha_address_unique')).toBe(true)
  })

  // Rollback proofs: a failure AFTER the patient row (and contacts) were
  // inserted must leave no patient, no contacts, no Aadhaar row, and the UHID
  // drawn inside the failed transaction must be on no patient row.
  async function expectNothingPersisted(name: string, contactName: string, aadhaarCountBefore: number) {
    expect(await patientsNamed(name)).toEqual([])
    expect(await getDb().select().from(patientContacts).where(eq(patientContacts.name, contactName))).toEqual([])
    const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(patientAadhaar)
    expect(n).toBe(aadhaarCountBefore)
    const seq = await getDb().execute(sql`select last_value from uhid_seq`)
    const lastValue = Number((seq as unknown as { rows: { last_value: string }[] }).rows[0].last_value)
    const drawn = formatUhid(await getUhidPrefix(), lastValue)
    expect(await getDb().select({ id: patients.id }).from(patients).where(eq(patients.uhid, drawn))).toEqual([])
  }

  it('rolls everything back when the Aadhaar step fails after the patient and contacts were inserted', async () => {
    const name = `TEST-SP1 Rollback aadhaar ${RUN}`
    const contactName = `TEST-SP1 Rollback contact A ${RUN}`
    const data = input({ name, abha: { status: 'unavailable', reason: 'not_created' }, contacts: [{ kind: 'emergency', name: contactName, relationship: 'friend', phone: '9876543210' }] })
    const [{ n: before }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(patientAadhaar)
    // Encryption fails inside the transaction, after two inserts.
    vi.stubEnv('IDENTITY_ENCRYPTION_KEY', '')
    const err = await registerPatient(data, PROBE_USER).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(`${(err as Error).message}\n${(err as Error).stack}`).not.toMatch(AADHAAR_FRAGMENTS)
    await expectNothingPersisted(name, contactName, before)
  })

  it('rolls everything back when the last insert (KYC) fails in Postgres after the Aadhaar row was written', async () => {
    const name = `TEST-SP1 Rollback kyc ${RUN}`
    const contactName = `TEST-SP1 Rollback contact K ${RUN}`
    const data = input({ name, abha: { status: 'unavailable', reason: 'not_created' }, contacts: [{ kind: 'emergency', name: contactName, relationship: 'friend', phone: '9876543210' }] })
    // Not an id_type enum value: bypasses zod, so Postgres rejects the final insert.
    data.kyc = { docType: 'not_a_doc_type' as never, docNumber: 'X1' }
    const [{ n: before }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(patientAadhaar)
    const err = await registerPatient(data, PROBE_USER).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    // The driver error carries query params: ciphertext only, never plaintext.
    expect(`${(err as Error).message}\n${(err as Error).stack}\n${JSON.stringify((err as { cause?: unknown }).cause ?? null)}`).not.toMatch(/234567890124|2345 6789 0124/)
    await expectNothingPersisted(name, contactName, before)
  })
})
