// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claimDispatches, claimDocuments, claimEvents, claims, claimSubmissions, diagnoses, nhcxExchanges, payerProfiles } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn(), getPrivateBlobBytes: vi.fn(async () => null) }))

import { dispatchExchange, insertOutboundClaimExchange, listExchangesFor, type DispatchDeps } from '@/lib/queries/nhcx-exchanges'
import { createClaimDraft } from '@/lib/queries/claims'
import { waiveClaimDocument } from '@/lib/queries/claim-documents'
import { defaultSubmissionDeps, submitClaimVersion, type SubmissionDeps } from '@/lib/queries/claim-submissions'
import type { PostOutcome } from '@/lib/nhcx/client'
import { openHcxPayload } from '@/lib/nhcx/jwe'
import type { AbdmConfig, NhcxConfig } from '@/lib/integrations/config'
import type { ClaimGateway } from '@/lib/rcm/gateway'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures } from '../../db/sp8-fixtures'
import { makeTestKeyPairAndCert } from '../../helpers/selfsigned'
import { SNAP } from '../fhir/nhcx/fixtures'
import { makeClaimWorld, destroyClaimWorld, finalisedInvoice, finaliseCoding, type ClaimWorld } from './claim-world'

const RUN = `${Date.now()}`.slice(-7)
const KEYS = makeTestKeyPairAndCert('TPA1@sbx', 30)
const NCFG: NhcxConfig = {
  apiBaseUrl: 'https://hcx.example', participantServiceUrl: 'https://hcx.example/p', participantCode: 'P1@sbx', encryptionPrivateKeyPem: KEYS.privateKeyPem,
  previousEncryptionPrivateKeyPem: null, encryptionCertPem: KEYS.certPem, gatewaySigningCertPem: null, callbackIpAllowlist: [], maxAttachmentBytes: 10_000_000,
}
const ACFG: AbdmConfig = { gatewayBaseUrl: 'https://gw.example', abhaBaseUrl: 'https://abha.example', clientId: 'c', clientSecret: 's', cmId: 'sbx', hipId: null, gatewayJwksUrl: null, consentTextPath: null }

let clock = new Date('2099-07-01T06:00:00Z')
function deps(client: (jwe: string) => Promise<PostOutcome>, over: Partial<DispatchDeps> = {}): Partial<DispatchDeps> {
  return {
    now: () => clock,
    config: () => ({ nhcx: { state: 'configured', config: NCFG }, abdm: { state: 'configured', config: ACFG } }),
    client: (_c, _a, _action, jwe) => client(jwe),
    certs: async () => ({ ok: true, certPem: KEYS.certPem }),
    invalidateCert: async () => {},
    blobs: async () => null,
    ...over,
  }
}
const accepted = (): PostOutcome => ({ kind: 'accepted', httpStatus: 202, apiCallId: 'x', correlationId: 'y' })
const retryable = (code: string | null = null): PostOutcome => ({ kind: 'retryable', httpStatus: 503, errorCode: code })

describe.skipIf(!process.env.DATABASE_URL)('NHCX outbox and dispatch (DB)', () => {
  let b: RcmBase
  let seq = 0
  beforeAll(async () => {
    process.env.INTEGRATION_PAYLOAD_KEY = process.env.INTEGRATION_PAYLOAD_KEY || randomBytes(32).toString('base64')
    b = await makeRcmBase(RUN, 'NX')
  })
  afterAll(async () => {
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  async function claimWithExchange(snapshot = SNAP, kind: 'initial' | 'query_response' = 'initial') {
    seq++
    const [c] = await getDb().insert(claims).values({
      claimNumber: `CLM-2099-NX${RUN}${seq}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, billingPayerId: b.tpaId,
      claimType: 'opd', encounterId: b.encounterId, createdByName: 'Test', status: 'submitted', claimedPaise: 18_000_000,
    }).returning()
    const [s] = await getDb().insert(claimSubmissions).values({
      claimId: c.id, version: 1, kind, snapshot, snapshotSha256: 'a'.repeat(64), rcmCopyBlobUrl: 'u', rcmCopySha256: 'b'.repeat(64), insurerCopyBlobUrl: 'u', insurerCopySha256: 'c'.repeat(64), createdByName: 'Test',
    }).returning()
    const ex = await getDb().transaction((tx) => insertOutboundClaimExchange(tx, {
      claimId: c.id, claimSubmissionId: s.id, patientId: b.patientId, policyId: b.policyId, correlationId: crypto.randomUUID(), kind,
      recipientCode: 'TPA1@sbx', senderCode: 'P1@sbx', isMock: false, bodySha256: 'a'.repeat(64), now: clock,
    }))
    return { claimId: c.id, submissionId: s.id, ...ex }
  }
  const exchange = async (id: number) => (await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, id)))[0]
  const notes = async (claimId: number) => getDb().select().from(claimEvents).where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.action, 'note')))

  it('dispatch sends once, stores state sent and drops the stored JWE', async () => {
    const x = await claimWithExchange()
    const seen: string[] = []
    expect(await dispatchExchange(x.exchangeId, deps(async (jwe) => { seen.push(jwe); return accepted() }))).toBe('sent')
    const row = await exchange(x.exchangeId)
    expect(row).toMatchObject({ state: 'sent', protocolStatus: 'request.queued', jweEncrypted: null, attempts: 1, nextAttemptAt: null })
    const opened = await openHcxPayload(seen[0], [KEYS.privateKeyPem])
    expect(opened).toMatchObject({ ok: true, protectedHeader: { 'x-hcx-api_call_id': row.apiCallId, 'x-hcx-correlation_id': row.correlationId, 'x-hcx-recipient_code': 'TPA1@sbx' }, fhir: { resourceType: 'Bundle' } })
    expect(await dispatchExchange(x.exchangeId, deps(async () => accepted()))).toBe('skipped')
    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'NHCX gateway'), eq(auditLog.details, `exchange=${x.exchangeId} outcome=accepted attempt=1`)))
    expect(audit).toHaveLength(1); expect(audit[0].role).toBeNull()
    expect((await listExchangesFor({ claimId: x.claimId }))[0]).toMatchObject({ id: x.exchangeId, state: 'sent', correlationPrefix: x.correlationId.slice(0, 8) })
    expect(JSON.stringify(await listExchangesFor({ claimId: x.claimId }))).not.toMatch(/jwe|payload/i)
  })

  it('a failed send is retried with the same api_call_id and identical JWE', async () => {
    const x = await claimWithExchange()
    const seen: string[] = []
    const outcomes = [retryable(), accepted()]
    const client = async (jwe: string) => { seen.push(jwe); return outcomes.shift()! }
    expect(await dispatchExchange(x.exchangeId, deps(client))).toBe('retry')
    const mid = await exchange(x.exchangeId)
    expect(mid.jweEncrypted).not.toBeNull(); expect(mid.state).toBe('pending_send')
    expect(mid.nextAttemptAt!.getTime() - clock.getTime()).toBeGreaterThanOrEqual(60_000)
    expect(await dispatchExchange(x.exchangeId, deps(client))).toBe('skipped') // not due yet
    clock = new Date(mid.nextAttemptAt!.getTime() + 1)
    expect(await dispatchExchange(x.exchangeId, deps(client))).toBe('sent')
    expect(seen).toHaveLength(2); expect(seen[0]).toBe(seen[1])
    const done = await exchange(x.exchangeId)
    expect(done).toMatchObject({ apiCallId: mid.apiCallId, attempts: 2, state: 'sent', jweEncrypted: null })
  })

  it('after the last retry the exchange is send_failed and the claim gets a note event', async () => {
    const x = await claimWithExchange()
    let n = 0
    for (;;) {
      const r = await dispatchExchange(x.exchangeId, deps(async () => { n++; return retryable() }))
      const row = await exchange(x.exchangeId)
      if (r === 'failed') break
      expect(r).toBe('retry')
      clock = new Date(row.nextAttemptAt!.getTime() + 1)
    }
    expect(n).toBe(6)
    expect(await exchange(x.exchangeId)).toMatchObject({ state: 'send_failed', lastErrorCode: 'max_attempts', jweEncrypted: null })
    const ns = await notes(x.claimId)
    expect(ns).toHaveLength(1); expect(ns[0]).toMatchObject({ byName: 'NHCX gateway', fromStatus: 'submitted', toStatus: 'submitted' })
    expect(ns[0].note).toMatch(/send it through another channel/)
    const [c] = await getDb().select().from(claims).where(eq(claims.id, x.claimId))
    expect(c.status).toBe('submitted')
  })

  it('a rejection fails at once with the sanitised code and a note', async () => {
    const x = await claimWithExchange()
    expect(await dispatchExchange(x.exchangeId, deps(async () => ({ kind: 'rejected', httpStatus: 400, errorCode: 'ERR_INVALID_PAYLOAD' })))).toBe('failed')
    expect(await exchange(x.exchangeId)).toMatchObject({ state: 'send_failed', lastErrorCode: 'ERR_INVALID_PAYLOAD' })
    expect((await notes(x.claimId))[0].note).toBe('NHCX refused the submission (ERR_INVALID_PAYLOAD); send it through another channel')
  })

  it('concurrent dispatches of one exchange send once', async () => {
    const x = await claimWithExchange()
    let calls = 0
    const client = async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return accepted() }
    const results = await Promise.all([dispatchExchange(x.exchangeId, deps(client)), dispatchExchange(x.exchangeId, deps(client))])
    expect(results.sort()).toEqual(['sent', 'skipped']); expect(calls).toBe(1)
  })

  it('attachments over the cap fail with attachments_too_large and never call the client', async () => {
    const x = await claimWithExchange()
    await getDb().insert(claimDocuments).values({ claimId: x.claimId, kind: 'discharge_summary', source: 'upload', title: 'DS', blobUrl: 'https://blob.test/ds', contentType: 'application/pdf', byteSize: 5000, sha256: 'a'.repeat(64), uploadedByName: 'Test' })
    const client = vi.fn(async () => accepted())
    expect(await dispatchExchange(x.exchangeId, deps(client, { config: () => ({ nhcx: { state: 'configured', config: { ...NCFG, maxAttachmentBytes: 1000 } }, abdm: { state: 'configured', config: ACFG } }) }))).toBe('failed')
    expect(client).not.toHaveBeenCalled()
    expect(await exchange(x.exchangeId)).toMatchObject({ state: 'send_failed', lastErrorCode: 'attachments_too_large' })
  })

  it('a mock row is never sent to NHCX; the labelled mock answers queued without an amount', async () => {
    const x = await claimWithExchange()
    await getDb().update(nhcxExchanges).set({ isMock: true }).where(eq(nhcxExchanges.id, x.exchangeId))
    const client = vi.fn(async () => accepted())
    expect(await dispatchExchange(x.exchangeId, { ...deps(client), config: () => ({ nhcx: { state: 'mock' }, abdm: { state: 'mock' } }) })).toBe('sent')
    expect(client).not.toHaveBeenCalled()
    const [inb] = await getDb().select().from(nhcxExchanges).where(and(eq(nhcxExchanges.relatedExchangeId, x.exchangeId), eq(nhcxExchanges.direction, 'inbound')))
    expect(inb).toMatchObject({ isMock: true, summary: { outcome: 'queued', benefitPaise: null } })
    expect(await exchange(x.exchangeId)).toMatchObject({ state: 'responded' })
    const real = await claimWithExchange()
    expect(await dispatchExchange(real.exchangeId, { ...deps(client), config: () => ({ nhcx: { state: 'mock' }, abdm: { state: 'mock' } }) })).toBe('failed')
    expect(await exchange(real.exchangeId)).toMatchObject({ state: 'send_failed', lastErrorCode: 'mode_mismatch' })
  })

  it('a query response goes out as communication/on_request on the insurer correlation id', async () => {
    const first = await claimWithExchange()
    const insurerCorrelation = crypto.randomUUID()
    await getDb().insert(nhcxExchanges).values({
      entityType: 'communication', direction: 'inbound', action: 'communication/request', correlationId: insurerCorrelation, apiCallId: crypto.randomUUID(),
      senderCode: 'TPA1@sbx', recipientCode: 'P1@sbx', state: 'received', patientId: b.patientId, claimId: first.claimId, bodySha256: 'd'.repeat(64),
    })
    const [s2] = await getDb().insert(claimSubmissions).values({
      claimId: first.claimId, version: 2, kind: 'query_response', snapshot: SNAP, snapshotSha256: 'a'.repeat(64), rcmCopyBlobUrl: 'u', rcmCopySha256: 'b', insurerCopyBlobUrl: 'u', insurerCopySha256: 'c', createdByName: 'Test',
    }).returning()
    const ex = await getDb().transaction((tx) => insertOutboundClaimExchange(tx, {
      claimId: first.claimId, claimSubmissionId: s2.id, patientId: b.patientId, policyId: b.policyId, correlationId: crypto.randomUUID(), kind: 'query_response',
      recipientCode: 'TPA1@sbx', senderCode: 'P1@sbx', isMock: false, bodySha256: 'a'.repeat(64),
    }))
    expect(ex).toMatchObject({ action: 'communication/on_request', correlationId: insurerCorrelation })
    expect((await exchange(ex.exchangeId)).entityType).toBe('communication')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('NHCX submission through SP7 (DB)', () => {
  const PROBE = `TEST-SP8-${RUN} NHCX Probe`
  const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
  const NOW = new Date('2099-06-02T06:00:00Z')
  let w: ClaimWorld
  const nhcxGw: ClaimGateway = { channel: 'nhcx', status: () => ({ configured: true, label: 'NHCX connected' }), submit: async () => ({ ok: true, transport: 'nhcx', trackingReference: crypto.randomUUID() }) }
  beforeAll(async () => {
    w = await makeClaimWorld(RUN, 'N')
    await finaliseCoding(w)
    await getDb().insert(diagnoses).values({
      patientId: w.patientId, code: 'U1Z.1', description: 'TEST fictional diagnosis', encounterId: w.encounterId, codeId: w.dxId, codeSystemKind: 'icd10',
      codeDisplay: 'TEST fictional diagnosis', diagnosisType: 'primary', codingStatus: 'coded', sequence: 1, codedByName: 'TEST', codedAt: new Date(),
    })
    await getDb().update(payerProfiles).set({ nhcxParticipantCode: `TPA${RUN}@sbx` }).where(eq(payerProfiles.payerId, w.tpaId))
  })
  afterAll(async () => {
    await purgeSp8Fixtures([w.patientId])
    await destroyClaimWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })
  const readyClaim = async () => {
    const inv = await finalisedInvoice(w)
    const r = await createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, invoices: [{ invoiceId: inv }] }, RCM, NOW)
    if (!r.ok) throw new Error(r.error)
    for (const kind of ['id_proof', 'policy_card', 'prescription'] as const) await waiveClaimDocument(r.value.claimId, kind, 'test waiver', RCM)
    return r.value.claimId
  }

  it('the outbox row commits with the claim version and nothing is sent inside the transaction', async () => {
    const id = await readyClaim()
    const scheduled: (() => Promise<unknown>)[] = []
    const dispatch = vi.fn(async () => 'sent')
    const d: SubmissionDeps = { ...defaultSubmissionDeps, putBlob: async (p) => ({ url: `mem://${p}` }), gateway: () => nhcxGw, schedule: (fn) => { scheduled.push(fn) }, dispatch }
    const r = await submitClaimVersion(id, { action: 'submit', channel: 'nhcx' }, RCM, d, NOW)
    expect(r).toMatchObject({ ok: true, value: { version: 1 } })
    if (!r.ok) return
    expect(dispatch).not.toHaveBeenCalled()
    const [ex] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.claimSubmissionId, r.value.submissionId))
    expect(ex).toMatchObject({ state: 'pending_send', action: 'claim/submit', direction: 'outbound', recipientCode: `TPA${RUN}@sbx`, isMock: false })
    const [disp] = await getDb().select().from(claimDispatches).where(eq(claimDispatches.submissionId, r.value.submissionId))
    expect(disp).toMatchObject({ transport: 'nhcx', trackingReference: ex.correlationId })
    expect(scheduled).toHaveLength(1)
    await scheduled[0]()
    expect(dispatch).toHaveBeenCalledWith(ex.id)
  })

  it('concurrent submits create one version and one exchange', async () => {
    const id = await readyClaim()
    const d: SubmissionDeps = { ...defaultSubmissionDeps, putBlob: async (p) => ({ url: `mem://${p}` }), gateway: () => nhcxGw, schedule: () => {} }
    const rs = await Promise.all([submitClaimVersion(id, { action: 'submit', channel: 'nhcx' }, RCM, d, NOW), submitClaimVersion(id, { action: 'submit', channel: 'nhcx' }, RCM, d, NOW)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    const subs = await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.claimId, id))
    const exs = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.claimId, id))
    expect(subs).toHaveLength(1); expect(exs).toHaveLength(1)
  })
})
