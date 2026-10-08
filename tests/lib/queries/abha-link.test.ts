import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmConsents, auditLog, patientAadhaar, patientContacts, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { AbhaFlow } from '@/lib/abdm/flow-store'

const flows = new Map<string, AbhaFlow>()
vi.mock('@/lib/abdm/flow-store', () => ({
  getFlow: vi.fn(async (id: string, staff: string) => {
    const f = flows.get(id)
    return f && f.staffName === staff ? f : null
  }),
}))

import { applyVerifiedAbha, recordConsent } from '@/lib/queries/abha-link'
import { registerPatient } from '@/lib/queries/patient-registration'
import { patientRegistrationSchema } from '@/lib/validation/patient-registration'
import { purgeSp8Consents } from '../../db/sp8-fixtures'

const RUN = `${Date.now()}`
const STAFF = `TEST-SP8-link-${RUN}`
const SESSION: Session = { role: 'frontdesk', name: STAFF, userId: null }
const abha = (n: number) => `91${(RUN.slice(-10) + String(n)).slice(-12).padStart(12, '0')}`
const NUM_A = abha(1)
const NUM_B = abha(2)
const NUM_C = abha(3)
const ADDR_A = `sp8a${RUN.slice(-8)}@sbx`

const createdPatients: string[] = []
const flowIds: string[] = []

function flow(over: Partial<AbhaFlow> = {}): AbhaFlow {
  const f: AbhaFlow = {
    flowId: randomUUID(), staffName: STAFF, staffUserId: null, patientId: null, kind: 'abha_number_aadhaar_otp', txnId: null, userToken: null,
    transientToken: null, consentId: null, consentPurpose: null, verified: null, accounts: [], ...over,
  }
  flows.set(f.flowId, f); flowIds.push(f.flowId)
  return f
}

async function makePatient(suffix: string): Promise<string> {
  const id = `TEST-SP8-${RUN.slice(-7)}-${suffix}`
  await getDb().insert(patients).values({ id, name: `TEST-SP8 ${suffix} ${RUN}`, dob: '1990-01-01', gender: 'female' })
  createdPatients.push(id)
  return id
}

describe.skipIf(!process.env.DATABASE_URL)('ABHA linking (DB)', () => {
  beforeEach(() => { vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64')) })
  afterAll(async () => {
    vi.unstubAllEnvs()
    const stray = await getDb().select({ id: patients.id }).from(patients).where(sql`${patients.name} like ${`TEST-SP8 %${RUN}`}`)
    const ids = [...new Set([...createdPatients, ...stray.map((r) => r.id)])]
    await purgeSp8Consents(flowIds)
    if (ids.length === 0) return
    const db = getDb()
    await db.delete(patientContacts).where(inArray(patientContacts.patientId, ids))
    await db.delete(patientAadhaar).where(inArray(patientAadhaar.patientId, ids))
    await db.delete(auditLog).where(sql`${auditLog.userName} = ${STAFF} and ${inArray(auditLog.patientId, ids)}`)
    await db.delete(patients).where(inArray(patients.id, ids))
  })

  it('linking a verified flow sets number, address and verification columns with an audit row carrying no number', async () => {
    const pid = await makePatient('L1')
    const f = flow({ verified: { abhaNumber: NUM_A, abhaAddress: ADDR_A, via: 'abha_number_aadhaar_otp', source: 'abdm' } })
    const { consentId } = await recordConsent({ flowId: f.flowId, patientId: null, purpose: 'abha_verification', givenBy: 'patient', textSha256: 'a'.repeat(64) }, SESSION)
    f.consentId = consentId
    expect(await applyVerifiedAbha(pid, f, SESSION)).toEqual({ ok: true })
    const [p] = await getDb().select().from(patients).where(eq(patients.id, pid))
    expect(p).toMatchObject({ abhaNumber: NUM_A, abhaAddress: ADDR_A, abhaVerificationSource: 'abdm', abhaVerifiedVia: 'abha_number_aadhaar_otp' })
    expect(p.abhaVerifiedAt).toBeInstanceOf(Date)
    const [c] = await getDb().select().from(abdmConsents).where(eq(abdmConsents.id, consentId))
    expect(c).toMatchObject({ patientId: pid, consentCode: 'hospital-abha-verification', purpose: 'abha_verification' })
    const rows = await getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.patientId, pid))
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['set ABHA number', 'set ABHA address', 'abdm: verified ABHA']))
    expect(rows.find((r) => r.action === 'abdm: verified ABHA')!.details).toBe(`patient=${pid} via=abha_number_aadhaar_otp source=abdm`)
    expect(JSON.stringify(rows)).not.toContain(NUM_A)
    expect(JSON.stringify(rows)).not.toContain(ADDR_A)
  })

  it('linking an ABHA already on another patient is a conflict', async () => {
    const pid = await makePatient('L2')
    const f = flow({ verified: { abhaNumber: NUM_A, abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })
    expect(await applyVerifiedAbha(pid, f, SESSION)).toEqual({ ok: false, error: 'abha_conflict' })
    const [p] = await getDb().select().from(patients).where(eq(patients.id, pid))
    expect(p.abhaNumber).toBeNull(); expect(p.abhaVerifiedAt).toBeNull()
  })

  it('an unverified flow or an unknown patient is refused', async () => {
    expect(await applyVerifiedAbha(await makePatient('L3'), flow(), SESSION)).toEqual({ ok: false, error: 'flow_not_verified' })
    expect(await applyVerifiedAbha('TEST-SP8-NOPE', flow({ verified: { abhaNumber: NUM_C, abhaAddress: null, via: 'mobile_otp', source: 'abdm' } }), SESSION)).toEqual({ ok: false, error: 'not_found' })
  })

  const reg = (name: string, abhaInput: Record<string, unknown>) => patientRegistrationSchema.parse({
    name: `TEST-SP8 ${name} ${RUN}`, dob: '1990-01-01', gender: 'female', addressLine1: '12 MG Road', city: 'Mumbai', district: 'Mumbai',
    stateCode: 'IN-MH', pinCode: '400001',
    aadhaar: { status: 'declined', reason: 'patient_declined' },
    abha: { status: 'provided', ...abhaInput },
    contacts: [{ kind: 'emergency', name: `TEST-SP8 Contact ${RUN}`, relationship: 'spouse', phone: '9876543210' }],
  })

  it('registration with a verified flowId stamps verification; without it the ABHA is unverified', async () => {
    const f = flow({ verified: { abhaNumber: NUM_B, abhaAddress: null, via: 'aadhaar_otp_enrolment', source: 'abdm_sandbox_mock' } })
    const r1 = await registerPatient(reg('R1', { abhaNumber: NUM_B, flowId: f.flowId }), SESSION)
    createdPatients.push(r1.id)
    const [p1] = await getDb().select().from(patients).where(eq(patients.id, r1.id))
    expect(p1).toMatchObject({ abhaNumber: NUM_B, abhaVerificationSource: 'abdm_sandbox_mock', abhaVerifiedVia: 'aadhaar_otp_enrolment' })

    const r2 = await registerPatient(reg('R2', { abhaNumber: NUM_C }), SESSION)
    createdPatients.push(r2.id)
    const [p2] = await getDb().select().from(patients).where(eq(patients.id, r2.id))
    expect(p2.abhaNumber).toBe(NUM_C); expect(p2.abhaVerifiedAt).toBeNull()
  })

  it('a flow verified for number X does not verify a registration typed with number Y', async () => {
    const f = flow({ verified: { abhaNumber: abha(7), abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })
    const r = await registerPatient(reg('R3', { abhaNumber: abha(8), flowId: f.flowId }), SESSION)
    createdPatients.push(r.id)
    const [p] = await getDb().select().from(patients).where(eq(patients.id, r.id))
    expect(p.abhaNumber).toBe(abha(8)); expect(p.abhaVerifiedAt).toBeNull()
  })

  it('a flow of another staff member does not verify', async () => {
    const f = flow({ staffName: 'someone else', verified: { abhaNumber: abha(9), abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })
    const r = await registerPatient(reg('R4', { abhaNumber: abha(9), flowId: f.flowId }), SESSION)
    createdPatients.push(r.id)
    const [p] = await getDb().select().from(patients).where(eq(patients.id, r.id))
    expect(p.abhaVerifiedAt).toBeNull()
  })
})
