// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claimEvents, claims, claimSubmissions, coverageVerifications, nhcxEligibilityChecks, nhcxExchanges, nhcxInboundCalls } from '@/db/schema'
import { handleNhcxCallback, synthesizeMockResponse, type InboundDeps } from '@/lib/nhcx/inbound'
import { openPayload } from '@/lib/integrations/payload-vault'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'
import { purgeCoverageFixtures } from '../../db/ws12-fixtures'
import { getEligibilityCheck } from '@/lib/queries/nhcx-eligibility'
import { makeCallbackKit } from '../../helpers/nhcx-callback'
import { SNAP, fixture } from '../fhir/nhcx/fixtures'

const RUN = `${Date.now()}`.slice(-7)
const kit = makeCallbackKit()
const deps: Partial<InboundDeps> = { config: () => ({ state: 'configured', config: kit.cfg }), now: () => new Date(), rateLimit: async () => ({ allowed: true }) }

describe.skipIf(!process.env.DATABASE_URL)('NHCX inbound (DB)', () => {
  let b: RcmBase
  let seq = 0
  beforeAll(async () => {
    process.env.INTEGRATION_PAYLOAD_KEY = process.env.INTEGRATION_PAYLOAD_KEY || randomBytes(32).toString('base64')
    b = await makeRcmBase(RUN, 'IN')
  })
  afterAll(async () => {
    await purgeCoverageFixtures([b.patientId])
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  async function sentClaim() {
    seq++
    const [c] = await getDb().insert(claims).values({
      claimNumber: `CLM-2099-IN${RUN}${seq}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, billingPayerId: b.tpaId,
      claimType: 'opd', encounterId: b.encounterId, createdByName: 'Test', status: 'submitted', claimedPaise: 10_000_000,
    }).returning()
    const [s] = await getDb().insert(claimSubmissions).values({
      claimId: c.id, version: 1, kind: 'initial', snapshot: SNAP, snapshotSha256: 'a'.repeat(64), rcmCopyBlobUrl: 'u', rcmCopySha256: 'b', insurerCopyBlobUrl: 'u', insurerCopySha256: 'c', createdByName: 'T',
    }).returning()
    const correlationId = randomUUID()
    const [ex] = await getDb().insert(nhcxExchanges).values({
      entityType: 'claim', direction: 'outbound', action: 'claim/submit', correlationId, apiCallId: randomUUID(), senderCode: 'P1@sbx', recipientCode: 'TPA1@sbx',
      state: 'sent', patientId: b.patientId, policyId: b.policyId, claimId: c.id, claimSubmissionId: s.id, bodySha256: 'a'.repeat(64),
    }).returning()
    return { claim: c, outbound: ex, correlationId }
  }
  const inboundFor = (id: number) => getDb().select().from(nhcxExchanges).where(and(eq(nhcxExchanges.relatedExchangeId, id), eq(nhcxExchanges.direction, 'inbound')))
  const notes = (claimId: number) => getDb().select().from(claimEvents).where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.action, 'note')))
  const response = () => {
    const f = fixture('Bundle-ClaimResponseBundle-settlement-example-01')
    f.entry[0].resource.total.push({ category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] }, amount: { value: 80000, currency: 'INR' } })
    return f
  }

  it('a replayed api_call_id is acknowledged once and written once', async () => {
    const x = await sentClaim()
    const apiCallId = randomUUID()
    const a = await handleNhcxCallback((await kit.request('claim/on_submit', response(), { headers: { correlationId: x.correlationId, apiCallId } })).req, 'claim/on_submit', deps)
    const bReq = await kit.request('claim/on_submit', response(), { headers: { correlationId: x.correlationId, apiCallId } })
    const b2 = await handleNhcxCallback(bReq.req, 'claim/on_submit', deps)
    expect([a.http, b2.http]).toEqual([202, 202])
    expect(b2.body).toMatchObject({ api_call_id: apiCallId, correlation_id: x.correlationId })
    expect(await getDb().select().from(nhcxInboundCalls).where(eq(nhcxInboundCalls.apiCallId, apiCallId))).toHaveLength(1)
    expect(await inboundFor(x.outbound.id)).toHaveLength(1)
    expect(await notes(x.claim.id)).toHaveLength(1)
  })

  it('an unknown correlation id is refused without a write', async () => {
    const apiCallId = randomUUID()
    const r = await handleNhcxCallback((await kit.request('claim/on_submit', response(), { headers: { correlationId: randomUUID(), apiCallId } })).req, 'claim/on_submit', deps)
    expect(r).toEqual({ http: 409, body: { error: 'Unknown correlation' } })
    expect(await getDb().select().from(nhcxInboundCalls).where(eq(nhcxInboundCalls.apiCallId, apiCallId))).toHaveLength(0)
    expect(await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.apiCallId, apiCallId))).toHaveLength(0)
  })

  it('a ClaimResponse records a note and a pending review but leaves status and money unchanged', async () => {
    const x = await sentClaim()
    const r = await handleNhcxCallback((await kit.request('claim/on_submit', response(), { headers: { correlationId: x.correlationId } })).req, 'claim/on_submit', deps)
    expect(r.http).toBe(202)
    const [c] = await getDb().select().from(claims).where(eq(claims.id, x.claim.id))
    expect(c).toMatchObject({ status: 'submitted', approvedPaise: null, settledPaise: 0, rowVersion: x.claim.rowVersion + 1 })
    const ns = await notes(x.claim.id)
    expect(ns).toHaveLength(1); expect(ns[0]).toMatchObject({ byName: 'NHCX gateway', byUserId: null, note: 'NHCX response received (complete); review it in the NHCX panel' })
    const [inb] = await inboundFor(x.outbound.id)
    expect(inb).toMatchObject({ reviewState: 'pending', state: 'received', summary: { benefitPaise: 8_000_000, submittedPaise: 9_000_000 } })
    expect(JSON.parse(openPayload(inb.payloadEncrypted!)).entry[0].resource.resourceType).toBe('ClaimResponse')
    expect(JSON.stringify(inb.summary)).not.toMatch(/processed within/)
    const [out] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, x.outbound.id))
    expect(out).toMatchObject({ state: 'responded', protocolStatus: 'response.complete' })
  })

  it('the payload is stored encrypted and the audit row has ids only', async () => {
    const x = await sentClaim()
    await handleNhcxCallback((await kit.request('claim/on_submit', response(), { headers: { correlationId: x.correlationId } })).req, 'claim/on_submit', deps)
    const [inb] = await inboundFor(x.outbound.id)
    expect(inb.payloadEncrypted).not.toMatch(/ClaimResponse|processed/)
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'NHCX gateway'), eq(auditLog.details, `exchange=${inb.id} related=${x.outbound.id} outcome=complete`)))
    expect(a).toMatchObject({ action: 'nhcx: received claim/on_submit', role: null, patientId: b.patientId })
  })

  it('an eligibility response marks the check eligible', async () => {
    const [chk] = await getDb().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'manual', requestedByName: 'T' }).returning()
    const correlationId = randomUUID()
    const [out] = await getDb().insert(nhcxExchanges).values({
      entityType: 'coverageeligibility', direction: 'outbound', action: 'coverageeligibility/check', correlationId, apiCallId: randomUUID(), senderCode: 'P1@sbx', recipientCode: 'TPA1@sbx',
      state: 'sent', patientId: b.patientId, policyId: b.policyId, eligibilityCheckId: chk.id, bodySha256: 'a'.repeat(64),
    }).returning()
    const r = await handleNhcxCallback((await kit.request('coverageeligibility/on_check', fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01'), { headers: { correlationId } })).req, 'coverageeligibility/on_check', deps)
    expect(r.http).toBe(202)
    const [c2] = await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, chk.id))
    expect(c2).toMatchObject({ status: 'eligible', inforce: true })
    const [inb] = await inboundFor(out.id)
    expect(inb.reviewState).toBe('not_needed')
  })

  it('a communication request for a claim we sent is stored for review', async () => {
    const x = await sentClaim()
    const req = fixture('Bundle-TaskBundleForCommunicationRequest-example-01')
    const claimEntry = req.entry.find((e: { resource: { resourceType: string } }) => e.resource.resourceType === 'Claim')
    claimEntry.resource.identifier = [{ value: `${x.claim.claimNumber}/v1` }]
    const r = await handleNhcxCallback((await kit.request('communication/request', req, { status: 'request.initiated' })).req, 'communication/request', deps)
    expect(r.http).toBe(202)
    const [inb] = await inboundFor(x.outbound.id)
    expect(inb).toMatchObject({ entityType: 'communication', reviewState: 'pending', claimId: x.claim.id, summary: { hasQueryText: true } })
    expect((await notes(x.claim.id))[0].note).toBe('Insurer query received via NHCX; review it in the NHCX panel')
    const [out] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, x.outbound.id))
    expect(out.state).toBe('sent')
  })
  // WS12 T2 (R1, R2, R6): every answered eligibility check leaves one coverage_verifications row.
  async function eligibilityCheck(isMock: boolean, context: 'checkin' | 'manual' = 'checkin') {
    const [chk] = await getDb().insert(nhcxEligibilityChecks).values({
      patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context, requestedByName: `Desk ${RUN}`, isMock,
    }).returning()
    const correlationId = randomUUID()
    const [out] = await getDb().insert(nhcxExchanges).values({
      entityType: 'coverageeligibility', direction: 'outbound', action: 'coverageeligibility/check', correlationId, apiCallId: randomUUID(), senderCode: 'P1@sbx', recipientCode: 'TPA1@sbx',
      state: 'sent', patientId: b.patientId, policyId: b.policyId, eligibilityCheckId: chk.id, bodySha256: 'a'.repeat(64), isMock,
    }).returning()
    return { chk, out, correlationId }
  }
  const verificationsFor = (checkId: number) => getDb().select().from(coverageVerifications).where(eq(coverageVerifications.nhcxCheckId, checkId))

  it('the mock answer writes one nhcx_mock verification with the fixed limits, current for 24 h; a second answer writes none', async () => {
    const { chk, out } = await eligibilityCheck(true)
    await synthesizeMockResponse(out)
    const rows = await verificationsFor(chk.id)
    expect(rows).toHaveLength(1)
    const v = rows[0]
    expect(v).toMatchObject({
      patientId: b.patientId, policyId: b.policyId, source: 'nhcx_mock', result: 'active', context: 'checkin', verifiedByName: `Desk ${RUN}`, method: null,
      sumInsuredPaise: 50_000_000, balancePaise: 45_000_000, copayBp: 1000, roomRentLimitPaise: 400_000, icuLimitPaise: 800_000, reportedValidTo: '2099-12-31',
      documentBlobUrl: null,
    })
    expect(v.validUntil.getTime() - v.verifiedAt.getTime()).toBe(24 * 3_600_000)
    const [c] = await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, chk.id))
    expect(c.status).toBe('eligible')
    expect((await getEligibilityCheck(chk.id))!.limits).toEqual({ sumInsuredPaise: 50_000_000, balancePaise: 45_000_000, copayBp: 1000, roomRentLimitPaise: 400_000, icuLimitPaise: 800_000 })
    await synthesizeMockResponse(out)
    expect(await verificationsFor(chk.id)).toHaveLength(1)
  })

  it('a live answer writes an nhcx verification with the insurer reference; replays write no second row', async () => {
    const { chk, correlationId } = await eligibilityCheck(false, 'manual')
    const fhir = fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01')
    fhir.entry.find((e: { resource: { resourceType: string } }) => e.resource.resourceType === 'CoverageEligibilityResponse').resource.identifier = [{ value: `ELIG-${RUN}` }]
    const apiCallId = randomUUID()
    const first = await handleNhcxCallback((await kit.request('coverageeligibility/on_check', fhir, { headers: { correlationId, apiCallId } })).req, 'coverageeligibility/on_check', deps)
    const replay = await handleNhcxCallback((await kit.request('coverageeligibility/on_check', fhir, { headers: { correlationId, apiCallId } })).req, 'coverageeligibility/on_check', deps)
    const again = await handleNhcxCallback((await kit.request('coverageeligibility/on_check', fhir, { headers: { correlationId } })).req, 'coverageeligibility/on_check', deps)
    expect([first.http, replay.http, again.http]).toEqual([202, 202, 202])
    const rows = await verificationsFor(chk.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'nhcx', result: 'active', context: 'manual', insurerReference: `ELIG-${RUN}`, reportedValidTo: '2026-08-07', sumInsuredPaise: null })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.patientId, b.patientId))
    expect(JSON.stringify(audits)).not.toContain(`ELIG-${RUN}`)
  })

  it('an error answer and a not-in-force answer: error writes no row, not in force writes an inactive row', async () => {
    const err = await eligibilityCheck(false)
    const r = await handleNhcxCallback((await kit.request('coverageeligibility/on_check', fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01'), { headers: { correlationId: err.correlationId }, status: 'response.error' })).req, 'coverageeligibility/on_check', deps)
    expect(r.http).toBe(202)
    const [c] = await getDb().select().from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, err.chk.id))
    expect(c.status).toBe('error')
    expect(await verificationsFor(err.chk.id)).toHaveLength(0)

    const off = await eligibilityCheck(false)
    const fhir = fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01')
    fhir.entry.find((e: { resource: { resourceType: string } }) => e.resource.resourceType === 'CoverageEligibilityResponse').resource.insurance[0].inforce = false
    await handleNhcxCallback((await kit.request('coverageeligibility/on_check', fhir, { headers: { correlationId: off.correlationId } })).req, 'coverageeligibility/on_check', deps)
    expect(await verificationsFor(off.chk.id)).toMatchObject([{ result: 'inactive', source: 'nhcx' }])
  })
})
