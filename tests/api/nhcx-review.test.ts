// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
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
import { auditLog, claimEvents, claims, nhcxExchanges } from '@/db/schema'
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
