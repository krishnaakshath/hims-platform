import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, preauths } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { createPreauth, estimatePreauth } from '@/lib/queries/preauths'
import type { PreauthCreateInput } from '@/lib/rcm/validation'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from './preauth-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Preauth Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const NOW = new Date('2099-06-01T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('pre-authorisations (DB)', () => {
  let w: PreauthWorld
  const create = (over: Partial<PreauthCreateInput> = {}): PreauthCreateInput => ({
    policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1,
    treatingProviderId: w.providerId, diagnosisCodeIds: [w.dxId], procedureCodeIds: [w.pxId], estimate: [{ serviceId: w.pricedServiceId, quantity: 2 }], ...over,
  })
  beforeAll(async () => { w = await makePreauthWorld(RUN, 'A') })
  afterAll(async () => {
    await destroyPreauthWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('estimates from the payer tariff and refuses an unpriced service with its code', async () => {
    expect(await estimatePreauth({ payerId: w.tpaId, onDate: '2026-10-01', roomCategoryCode: null, items: [{ serviceId: w.pricedServiceId, quantity: 2 }] }))
      .toMatchObject({ ok: true, value: { totalPaise: 100_000_00, lines: [{ quantity: 2, unitPricePaise: 50_000_00, amountPaise: 100_000_00, priceSource: 'base' }] } })
    expect(await estimatePreauth({ payerId: w.tpaId, onDate: '2026-10-01', roomCategoryCode: null, items: [{ serviceId: w.unpricedServiceId, quantity: 1 }] }))
      .toEqual({ ok: false, error: 'price_unresolved', message: `No tariff rate covers ${w.unpricedCode}` })
    expect(await estimatePreauth({ payerId: w.tpaId, onDate: '2026-10-01', roomCategoryCode: null, items: [{ serviceId: 2147483000, quantity: 1 }] })).toEqual({ ok: false, error: 'service_not_found' })
  })

  it('creates a draft pre-auth with a PA number, snapshotted codes and the estimate', async () => {
    const r = await createPreauth(create(), RCM, NOW)
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.value.preauthNumber).toMatch(/^PA-2099-\d{6}$/)
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, r.value.preauthId))
    expect(row).toMatchObject({ status: 'draft', estimatedPaise: 100_000_00, requestedPaise: 100_000_00, insurerPayerId: w.insurerId, tpaPayerId: w.tpaId })
    expect(row.diagnoses).toEqual([{ kind: 'icd10', code: 'U1Z.1', display: 'TEST fictional diagnosis', version: `TEST-SP7-${RUN}A-dx` }])
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: created pre-authorisation')))
    expect(audit.details).toBe(`preauth=${row.id} number=${row.preauthNumber} estimate=10000000`)
  })

  it('refuses a diagnosis id of a procedure kind, another patient\'s visit and a missing policy', async () => {
    expect(await createPreauth(create({ diagnosisCodeIds: [w.pxId] }), RCM, NOW)).toEqual({ ok: false, error: 'code_not_found' })
    expect(await createPreauth(create({ encounterId: 2147483000 }), RCM, NOW)).toEqual({ ok: false, error: 'context_mismatch' })
    expect(await createPreauth(create({ policyId: 2147483000 }), RCM, NOW)).toEqual({ ok: false, error: 'policy_not_found' })
  })
})
