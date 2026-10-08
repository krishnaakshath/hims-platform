import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { captureChargeLine } from '@/lib/queries/charge-capture'
import { applyPreauthAction, createPreauth } from '@/lib/queries/preauths'
import { purgeRcmFixtures } from '../../db/rcm-fixtures'
import { purgeBillingFixtures } from '../../db/billing-fixtures'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from './preauth-world'

// SP7 (ruling 7): SP4 charge capture validates a typed pre-auth reference against the patient's pre-auths.
const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Capture Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const BILLING: Session = { role: 'billing', name: PROBE, userId: null }
const NOW = new Date('2026-10-02T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('charge capture with a pre-auth reference (DB)', () => {
  let w: PreauthWorld
  const approved = async (ref: string, validUntil: string, decidedOn: string) => {
    const r = await createPreauth({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1, treatingProviderId: w.providerId, diagnosisCodeIds: [w.dxId], procedureCodeIds: [], estimate: [{ serviceId: w.pricedServiceId, quantity: 1 }] }, RCM, NOW)
    if (!r.ok) throw new Error(r.error)
    await applyPreauthAction(r.value.preauthId, { action: 'request' }, RCM, NOW)
    const a = await applyPreauthAction(r.value.preauthId, { action: 'approve', approvedPaise: 50_000_00, approvalReference: ref, validUntil, decidedOn }, RCM, NOW)
    if (!a.ok) throw new Error(a.error)
    return r.value.preauthId
  }
  beforeAll(async () => {
    w = await makePreauthWorld(RUN, 'K')
    await getDb().update(patients).set({ primaryPayerId: w.tpaId }).where(eq(patients.id, w.patientId))
  })
  afterAll(async () => {
    await purgeRcmFixtures([w.patientId], [])
    await purgeBillingFixtures([w.patientId])
    await destroyPreauthWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('capture links the approved pre-auth and refuses an expired one', async () => {
    const good = await approved(`CC/${RUN}/1`, '2026-10-31', '2026-10-01')
    const ok = await captureChargeLine({ context: { encounterId: w.encounterId }, serviceId: w.pricedServiceId, quantity: 1, serviceDate: '2026-10-01', billTo: 'payer', preAuthReference: `cc/${RUN}/1` }, BILLING, NOW)
    expect(ok.ok).toBe(true); if (!ok.ok) return
    expect(ok.line.preauthId).toBe(good); expect(ok.line.payerId).toBe(w.tpaId)

    await approved(`CC/${RUN}/2`, '2026-09-30', '2026-09-01')
    const bad = await captureChargeLine({ context: { encounterId: w.encounterId }, serviceId: w.pricedServiceId, quantity: 1, serviceDate: '2026-10-01', billTo: 'payer', preAuthReference: `CC/${RUN}/2` }, BILLING, NOW)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.violations?.find((v) => v.code === 'preauth_invalid')).toMatchObject({ severity: 'block', message: 'This pre-authorisation expired before the service date' })

    const unknown = await captureChargeLine({ context: { encounterId: w.encounterId }, serviceId: w.pricedServiceId, quantity: 1, serviceDate: '2026-10-01', billTo: 'payer', preAuthReference: 'NOPE-1', overrides: [{ code: 'duplicate_charge', reason: 'second sitting' }] }, BILLING, NOW)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.violations?.map((v) => v.code)).toContain('preauth_invalid')
  })
})
