import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claims, preauthEvents, preauths, rcmQueries } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { applyPreauthAction, createPreauth, estimatePreauth } from '@/lib/queries/preauths'
import { snapshotSha256 } from '@/lib/rcm/hash'
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

  const newPreauth = async () => { const r = await createPreauth(create(), RCM, NOW); if (!r.ok) throw new Error(r.error); return r.value.preauthId }
  const approve = (ref: string) => ({ action: 'approve' as const, approvedPaise: 80_000_00, approvalReference: ref, validUntil: '2026-10-31', decidedOn: '2026-10-01' })

  it('walks draft -> requested -> queried -> requested -> approved and snapshots the request', async () => {
    const id = await newPreauth()
    expect(await applyPreauthAction(id, { action: 'request' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'requested' } })
    expect((await applyPreauthAction(id, { action: 'record_query', question: 'Send the scan', raisedOn: '2026-10-01', dueOn: '2026-10-03' }, RCM, NOW)).ok).toBe(true)
    const [q] = await getDb().select().from(rcmQueries).where(eq(rcmQueries.preauthId, id))
    expect(await applyPreauthAction(id, { action: 'respond_query', queryId: 2147483000, body: 'x', respondedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: false, error: 'query_not_found' })
    expect(await applyPreauthAction(id, { action: 'respond_query', queryId: q.id, body: 'Scan attached', respondedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'requested' } })
    expect(await applyPreauthAction(id, { action: 'respond_query', queryId: q.id, body: 'again', respondedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: false, error: 'invalid_transition' })
    expect(await applyPreauthAction(id, approve(`AR/${RUN}/1`), RCM, NOW)).toEqual({ ok: true, value: { status: 'approved' } })
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id))
    expect(row).toMatchObject({ approvedPaise: 80_000_00, approvalReference: `AR/${RUN}/1`, validUntil: '2026-10-31', firstRequestedAt: NOW })
    const events = await getDb().select().from(preauthEvents).where(eq(preauthEvents.preauthId, id))
    const req = events.find((e) => e.action === 'request')!
    expect(req.snapshot?.preauthNumber).toBe(row.preauthNumber); expect(req.snapshotSha256).toBe(snapshotSha256(req.snapshot))
    expect(req.snapshot?.patient.abhaNumber).toBeNull(); expect(JSON.stringify(req.snapshot)).not.toMatch(/phone|email|address/i)
    expect(events.map((e) => e.action)).toEqual(['request', 'record_query', 'respond_query', 'approve'])
  })

  it('an enhancement must exceed the approval; a rejected enhancement keeps the approval', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    await applyPreauthAction(id, approve(`AR/${RUN}/2`), RCM, NOW)
    expect(await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 80_000_00, note: 'longer stay' }, RCM, NOW))
      .toEqual({ ok: false, error: 'amounts_invalid', message: 'The enhancement must be more than the approved ₹80,000.00' })
    expect((await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'longer stay' }, RCM, NOW)).ok).toBe(true)
    expect(await applyPreauthAction(id, { action: 'reject_enhancement', reasonCode: 'NME', decidedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: false, error: 'code_not_found' })
    expect(await applyPreauthAction(id, { action: 'reject_enhancement', reasonCode: 'EXCL', decidedOn: '2026-10-02' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'approved' } })
    await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'longer stay' }, RCM, NOW)
    expect(await applyPreauthAction(id, { action: 'approve_enhancement', approvedPaise: 90_000_00, validUntil: '2026-11-15', decidedOn: '2026-10-03' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'enhanced' } })
    await applyPreauthAction(id, { action: 'request_enhancement', requestedPaise: 1_00_000_00, note: 'even longer' }, RCM, NOW)
    expect(await applyPreauthAction(id, { action: 'reject_enhancement', reasonCode: 'EXCL', decidedOn: '2026-10-04' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'enhanced' } })
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id))
    expect(row).toMatchObject({ approvedPaise: 90_000_00, validUntil: '2026-11-15' })
  })

  it('the same approval reference for the same insurer is duplicate_reference', async () => {
    const a = await newPreauth(); const b = await newPreauth()
    for (const id of [a, b]) await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    expect((await applyPreauthAction(a, approve(`AR/${RUN}/DUP`), RCM, NOW)).ok).toBe(true)
    expect(await applyPreauthAction(b, approve(`ar/${RUN}/dup`), RCM, NOW)).toEqual({ ok: false, error: 'duplicate_reference' })
  })

  it('a pre-auth on a submitted claim cannot be cancelled', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    await applyPreauthAction(id, approve(`AR/${RUN}/3`), RCM, NOW)
    await getDb().insert(claims).values({
      claimNumber: `CLM-2099-P${RUN}`, patientId: w.patientId, policyId: w.policyId, insurerPayerId: w.insurerId, tpaPayerId: w.tpaId, billingPayerId: w.tpaId,
      claimType: 'opd', encounterId: w.encounterId, preauthId: id, status: 'submitted', createdByName: 'T',
    })
    expect(await applyPreauthAction(id, { action: 'cancel', note: 'patient left' }, RCM, NOW)).toEqual({ ok: false, error: 'preauth_in_use' })
  })

  it('concurrent approvals: one wins, the other is invalid_transition; approve and cancel never lose an update', async () => {
    const id = await newPreauth()
    await applyPreauthAction(id, { action: 'request' }, RCM, NOW)
    const [x, y] = await Promise.all([applyPreauthAction(id, approve(`AR/${RUN}/4`), RCM, NOW), applyPreauthAction(id, approve(`AR/${RUN}/5`), RCM, NOW)])
    expect([x.ok, y.ok].sort()).toEqual([false, true]); expect(x.ok ? y : x).toEqual({ ok: false, error: 'invalid_transition' })
    const id2 = await newPreauth()
    await applyPreauthAction(id2, { action: 'request' }, RCM, NOW)
    await Promise.all([applyPreauthAction(id2, approve(`AR/${RUN}/6`), RCM, NOW), applyPreauthAction(id2, { action: 'cancel', note: 'no longer needed' }, RCM, NOW)])
    const [row] = await getDb().select().from(preauths).where(eq(preauths.id, id2))
    expect(row.status).toBe('cancelled')
    const events = await getDb().select().from(preauthEvents).where(eq(preauthEvents.preauthId, id2))
    expect(events.at(-1)?.toStatus).toBe('cancelled')
  })

  it('audit details carry no reference, question or note', async () => {
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: pre-authorisation %')))
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) expect(`${r.details}`).not.toMatch(/AR\/|scan|stay|patient left|needed/i)
    expect(rows.find((r) => r.action === 'rcm: pre-authorisation approve')?.details).toMatch(/^preauth=\d+ from=(requested|queried) to=approved amount=8000000$/)
  })
})

