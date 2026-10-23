// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'rcm'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `TEST-SP8-review`, userId: null })) }
})
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, after: vi.fn() }
})

import { getDb } from '@/db/client'
import { auditLog, billingSettings, claimEvents, claims, nhcxExchanges, patients, payerProfiles, preauthEvents, providers } from '@/db/schema'
import { applyPreauthAction, createPreauth } from '@/lib/queries/preauths'
import { createPreauthExchange, staleSnapshotReason } from '@/lib/queries/nhcx-exchanges'
import { preauthNhcxState } from '@/lib/queries/nhcx-review'
import { makePreauthWorld, destroyPreauthWorld, type PreauthWorld } from '../lib/queries/preauth-world'
import { sealPayload } from '@/lib/integrations/payload-vault'
import { GET as payload } from '@/app/api/rcm/nhcx/exchanges/[id]/payload/route'
import { POST as review } from '@/app/api/rcm/nhcx/exchanges/[id]/review/route'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../db/sp8-fixtures'
import { fixture } from '../lib/fhir/nhcx/fixtures'

const RUN = `${Date.now()}`.slice(-7)
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })
const get = (id: number) => payload(new NextRequest(`http://localhost/x/${id}`), ctx(id))
const post = (id: number, body: unknown) => review(new NextRequest(`http://localhost/x/${id}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ctx(id))

describe.skipIf(!process.env.DATABASE_URL)('NHCX response review (DB)', () => {
  let b: RcmBase
  let claimId = 0
  beforeAll(async () => {
    process.env.INTEGRATION_PAYLOAD_KEY = process.env.INTEGRATION_PAYLOAD_KEY || randomBytes(32).toString('base64')
    b = await makeRcmBase(RUN, 'RV')
    const [c] = await getDb().insert(claims).values({
      claimNumber: `CLM-2099-RV${RUN}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, billingPayerId: b.tpaId,
      claimType: 'opd', encounterId: b.encounterId, createdByName: 'Test', status: 'submitted', claimedPaise: 100,
    }).returning()
    claimId = c.id
  })
  afterAll(async () => {
    await getDb().delete(auditLog).where(eq(auditLog.userName, 'TEST-SP8-review'))
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })
  beforeEach(() => { sessionRole = 'rcm' })
  const inbound = async (action: string, fhir: unknown, summary: Record<string, unknown> = {}) => (await getDb().insert(nhcxExchanges).values({
    entityType: action.startsWith('payment') ? 'paymentnotice' : 'claim', direction: 'inbound', action, correlationId: randomUUID(), apiCallId: randomUUID(), senderCode: 'TPA1@sbx',
    recipientCode: 'P1@sbx', state: 'received', patientId: b.patientId, policyId: b.policyId, claimId, bodySha256: 'a'.repeat(64), payloadEncrypted: sealPayload(JSON.stringify(fhir)),
    summary: { outcome: 'complete', use: 'claim', submittedPaise: 9_000_000, benefitPaise: null, preAuthRefPresent: true, inforce: null, errorCodes: [], adjudicationReasonCodes: [], paymentAmountPaise: null, paymentDate: null, hasQueryText: false, ...summary },
    reviewState: 'pending',
  }).returning())[0]

  it('rcm and admin only; a second review is a 409; dismiss needs a note', async () => {
    const x = await inbound('claim/on_submit', fixture('Bundle-ClaimResponseBundle-settlement-example-01'))
    for (const r of ['frontdesk', 'billing', 'coder', 'crc'] as Role[]) {
      sessionRole = r
      expect((await post(x.id, '{not json')).status).toBe(403); expect((await get(x.id)).status).toBe(403)
    }
    sessionRole = 'rcm'
    const noNote = await post(x.id, { decision: 'dismissed' })
    expect(noNote.status).toBe(400)
    const ok = await post(x.id, { decision: 'dismissed', note: 'Duplicate of the portal update' })
    expect(await ok.json()).toEqual({ reviewState: 'dismissed', ackExchangeId: null })
    const again = await post(x.id, { decision: 'confirmed' })
    expect(again.status).toBe(409); expect(await again.json()).toEqual({ error: 'Already reviewed' })
    const [ev] = await getDb().select().from(claimEvents).where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.action, 'note')))
    expect(ev.note).toBe('NHCX response dismissed: Duplicate of the portal update')
    const [c] = await getDb().select().from(claims).where(eq(claims.id, claimId))
    expect(c.status).toBe('submitted')
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'TEST-SP8-review'), eq(auditLog.action, 'nhcx: reviewed response')))
    expect(a.details).toBe(`exchange=${x.id} decision=dismissed`)
  })

  it('payload view is audited and returns no JWE or raw bundle', async () => {
    const x = await inbound('claim/on_submit', fixture('Bundle-ClaimResponseBundle-settlement-example-01'))
    const r = await get(x.id)
    const body = await r.json()
    expect(body).toMatchObject({ exchangeId: x.id, action: 'claim/on_submit', claimId, preAuthRef: '96785763', dispositionText: expect.stringMatching(/processed within 30 days/) })
    expect(JSON.stringify(body)).not.toMatch(/resourceType|payload|jwe/i)
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'TEST-SP8-review'), eq(auditLog.details, `exchange=${x.id}`)))
    expect(a.action).toBe('nhcx: viewed response')
  })

  it('confirming a payment notice can queue the payment acknowledgement on its correlation', async () => {
    const x = await inbound('paymentnotice/request', fixture('Bundle-TaskBundleForPaymentNoticeRequest-example-01'), { paymentAmountPaise: 18_000_000, paymentDate: '2025-03-07' })
    const r = await post(x.id, { decision: 'confirmed', sendPaymentAck: true })
    const body = await r.json()
    expect(body.reviewState).toBe('confirmed'); expect(body.ackExchangeId).toEqual(expect.any(Number))
    const [ack] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, body.ackExchangeId))
    expect(ack).toMatchObject({ action: 'paymentnotice/on_request', direction: 'outbound', state: 'pending_send', correlationId: x.correlationId, recipientCode: 'TPA1@sbx', relatedExchangeId: x.id })
  })
})

// ---- WS12 T7: a pre-auth requested before the TPA got its NHCX code ---------------------------
const STALE_PAYER = 'This request was saved before the insurer\'s NHCX code was added. Use "Refresh snapshot", then send.'
const STALE_HOSPITAL = 'This request was saved before the hospital\'s HFR or ROHINI ID was added. Use "Refresh snapshot", then send.'

describe('staleSnapshotReason (WS12 T7)', () => {
  const payer = (code: string | null) => ({ payerId: 1, name: 'P', kind: 'insurer' as const, irdaiRegistrationNo: null, nhcxParticipantCode: code })
  const hospital = (hfrId: string | null) => ({ legalName: 'H', gstin: null, stateCode: null, rohiniId: null, hfrId })
  const side = (code: string | null, hfr: string | null) => ({ policy: { insurer: payer(null), tpa: payer(code) }, hospital: hospital(hfr) })
  it('names the payer code first, then the hospital IDs; nothing when the snapshot is current or live data lacks them too', () => {
    expect(staleSnapshotReason(side(null, null), side('T@sbx', 'IN1'))).toBe(STALE_PAYER)
    expect(staleSnapshotReason(side('T@sbx', null), side('T@sbx', 'IN1'))).toBe(STALE_HOSPITAL)
    expect(staleSnapshotReason(side('T@sbx', 'IN1'), side('T@sbx', 'IN1'))).toBeNull()
    expect(staleSnapshotReason(side(null, null), side(null, null))).toBeNull()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('pre-auth NHCX state and refresh (DB, WS12 T7)', () => {
  const SESSION = { role: 'rcm' as const, name: `TEST-WS12-T7-${RUN}`, userId: null }
  const NOW = new Date('2099-06-01T06:00:00Z')
  let w: PreauthWorld
  let preauthId = 0
  let savedSettings: { hfrId: string | null; rohiniId: string | null } | null = null
  let savedReg: { council: 'nmc' | 'smc' | null; number: string | null } | null = null
  const saved = process.env.ABDM_USE_MOCKS
  beforeAll(async () => {
    process.env.INTEGRATION_PAYLOAD_KEY = process.env.INTEGRATION_PAYLOAD_KEY || randomBytes(32).toString('base64')
    w = await makePreauthWorld(RUN, 'T7')
    await getDb().update(patients).set({ uhid: `UHT${RUN}T7` }).where(eq(patients.id, w.patientId))
    const [pr] = await getDb().select({ council: providers.registrationCouncil, number: providers.registrationNumber }).from(providers).where(eq(providers.id, w.providerId))
    savedReg = { council: pr.council, number: pr.number }
    if (!pr.number) await getDb().update(providers).set({ registrationCouncil: 'nmc', registrationNumber: `T${RUN}` }).where(eq(providers.id, w.providerId))
    const [s] = await getDb().select({ hfrId: billingSettings.hfrId, rohiniId: billingSettings.rohiniId }).from(billingSettings).where(eq(billingSettings.id, 1))
    savedSettings = s ?? null
    await getDb().update(billingSettings).set({ hfrId: 'IN2710000123' }).where(eq(billingSettings.id, 1))
    await getDb().update(payerProfiles).set({ nhcxParticipantCode: null }).where(inArray(payerProfiles.payerId, [w.insurerId, w.tpaId]))
    const created = await createPreauth({
      policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1,
      treatingProviderId: w.providerId, diagnosisCodeIds: [w.dxId], procedureCodeIds: [w.pxId], estimate: [{ serviceId: w.pricedServiceId, quantity: 1 }],
    }, SESSION, NOW)
    if (!created.ok) throw new Error(created.error)
    preauthId = created.value.preauthId
    const r = await applyPreauthAction(preauthId, { action: 'request' }, SESSION, NOW)
    if (!r.ok) throw new Error(r.error)
  })
  afterAll(async () => {
    if (saved === undefined) delete process.env.ABDM_USE_MOCKS; else process.env.ABDM_USE_MOCKS = saved
    if (savedReg) await getDb().update(providers).set({ registrationCouncil: savedReg.council, registrationNumber: savedReg.number }).where(eq(providers.id, w.providerId))
    if (savedSettings) await getDb().update(billingSettings).set(savedSettings).where(eq(billingSettings.id, 1))
    await getDb().delete(auditLog).where(eq(auditLog.userName, SESSION.name))
    await purgeSp8Fixtures([w.patientId])
    await destroyPreauthWorld(w)
  })
  beforeEach(() => { process.env.ABDM_USE_MOCKS = '1' })

  it('says the snapshot is stale once the TPA has a code, sends the refreshed snapshot after "Refresh snapshot"', async () => {
    delete process.env.ABDM_USE_MOCKS
    expect(await preauthNhcxState(preauthId)).toEqual({ canSend: false, reason: 'NHCX not connected', snapshotStale: false })
    process.env.ABDM_USE_MOCKS = '1'
    expect(await preauthNhcxState(preauthId)).toEqual({ canSend: false, reason: 'This insurer or TPA has no NHCX participant code', snapshotStale: false })

    await getDb().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}T7@sbx` }).where(eq(payerProfiles.payerId, w.tpaId))
    expect(await preauthNhcxState(preauthId)).toEqual({ canSend: false, reason: STALE_PAYER, snapshotStale: true })
    const schedule = vi.fn()
    expect(await createPreauthExchange(preauthId, SESSION, { now: () => NOW, schedule })).toEqual({ ok: false, error: 'not_ready', message: STALE_PAYER })

    expect(await applyPreauthAction(preauthId, { action: 'refresh_snapshot' }, SESSION, NOW)).toEqual({ ok: true, value: { status: 'requested' } })
    expect(await preauthNhcxState(preauthId)).toEqual({ canSend: true, reason: null, snapshotStale: false })
    const sent = await createPreauthExchange(preauthId, SESSION, { now: () => NOW, schedule })
    expect(sent.ok).toBe(true); if (!sent.ok) return
    expect(schedule).toHaveBeenCalledTimes(1)
    const [refresh] = await getDb().select().from(preauthEvents)
      .where(and(eq(preauthEvents.preauthId, preauthId), eq(preauthEvents.action, 'refresh_snapshot')))
    const [x] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, sent.value.exchangeId))
    expect(x).toMatchObject({ recipientCode: `TPA${RUN}T7@sbx`, preauthEventId: refresh.id, state: 'pending_send', isMock: true, action: 'preauth/submit' })
  })
})
