import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { applyPreauthAction, createPreauth } from '@/lib/queries/preauths'
import { listApprovedPreauthsForPatient, validatePreauthReference } from '@/lib/queries/preauth-reference'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from './preauth-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Reference Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const NOW = new Date('2099-06-01T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('pre-auth reference validator (DB)', () => {
  let w: PreauthWorld
  let other: PreauthWorld
  let approvedNumber = ''
  let queriedNumber = ''
  const make = async (x: PreauthWorld) => {
    const r = await createPreauth({ policyId: x.policyId, claimType: 'opd', encounterId: x.encounterId, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1, treatingProviderId: x.providerId, diagnosisCodeIds: [x.dxId], procedureCodeIds: [], estimate: [{ serviceId: x.pricedServiceId, quantity: 1 }] }, RCM, NOW)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  beforeAll(async () => {
    w = await makePreauthWorld(RUN, 'R')
    other = await makePreauthWorld(RUN, 'O')
    const a = await make(w); approvedNumber = a.preauthNumber
    await applyPreauthAction(a.preauthId, { action: 'request' }, RCM, NOW)
    await applyPreauthAction(a.preauthId, { action: 'approve', approvedPaise: 40_000_00, approvalReference: `CL/${RUN}/9`, validUntil: '2026-10-31', decidedOn: '2026-10-01' }, RCM, NOW)
    const q = await make(w); queriedNumber = q.preauthNumber
    await applyPreauthAction(q.preauthId, { action: 'request' }, RCM, NOW)
  })
  afterAll(async () => {
    await destroyPreauthWorld(w); await destroyPreauthWorld(other)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })
  const v = (over: Partial<{ patientId: string; payerId: number | null; reference: string; serviceDate: string }>) =>
    validatePreauthReference(getDb(), { patientId: w.patientId, payerId: w.tpaId, reference: `CL/${RUN}/9`, serviceDate: '2026-10-20', ...over })

  it('validates by approval reference or PA number, case-insensitive', async () => {
    expect((await v({})).status).toBe('valid')
    expect((await v({ reference: ` ${approvedNumber.toLowerCase()} ` })).status).toBe('valid')
    expect((await v({ reference: `cl/${RUN}/9`, payerId: w.insurerId })).status).toBe('valid')
    expect((await v({ payerId: null })).preauthId).not.toBeNull()
  })
  it('reports not_approved, expired and payer_mismatch', async () => {
    expect((await v({ reference: queriedNumber })).status).toBe('not_approved')
    expect((await v({ serviceDate: '2026-11-01' })).status).toBe('expired')
    expect((await v({ payerId: other.insurerId })).status).toBe('payer_mismatch')
  })
  it('another patient\'s reference is not_found', async () => {
    expect(await v({ patientId: other.patientId })).toEqual({ status: 'not_found', preauthId: null })
    expect((await v({ reference: '   ' })).status).toBe('not_found')
  })
  it('lists approved pre-auths still valid on the date', async () => {
    const list = await listApprovedPreauthsForPatient(w.patientId, '2026-10-20')
    expect(list).toEqual([expect.objectContaining({ preauthNumber: approvedNumber, approvalReference: `CL/${RUN}/9`, approvedPaise: 40_000_00, validUntil: '2026-10-31', payerIds: [w.insurerId, w.tpaId] })])
    expect(await listApprovedPreauthsForPatient(w.patientId, '2026-11-01')).toEqual([])
  })
})
