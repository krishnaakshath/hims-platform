import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claimDispatches, claimEvents, claims, claimSubmissions, diagnoses, patients, payerProfiles, rcmQueries } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn() }))

import { createClaimDraft } from '@/lib/queries/claims'
import { waiveClaimDocument } from '@/lib/queries/claim-documents'
import {
  acknowledgeDispatch, buildClaimSnapshotFor, claimCodingDrift, defaultSubmissionDeps, submitClaimVersion, verifySubmission, type SubmissionDeps,
} from '@/lib/queries/claim-submissions'
import { snapshotSha256 } from '@/lib/rcm/hash'
import { makeClaimWorld, destroyClaimWorld, finalisedInvoice, finaliseCoding, type ClaimWorld } from './claim-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Submission Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const NOW = new Date('2099-06-02T06:00:00Z')

const store = new Map<string, Uint8Array>()
const deps: SubmissionDeps = {
  ...defaultSubmissionDeps,
  putBlob: async (path, bytes) => { const url = `mem://${path}`; store.set(url, bytes); return { url } },
}
const fetchBytes = async (url: string) => store.get(url) ?? null

describe.skipIf(!process.env.DATABASE_URL)('claim submissions (DB)', () => {
  let w: ClaimWorld
  const readyClaim = async (waive = true) => {
    const inv = await finalisedInvoice(w)
    const r = await createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, invoices: [{ invoiceId: inv }] }, RCM, NOW)
    if (!r.ok) throw new Error(r.error)
    if (waive) for (const kind of ['id_proof', 'policy_card', 'prescription'] as const) await waiveClaimDocument(r.value.claimId, kind, 'test waiver', RCM)
    return r.value.claimId
  }
  beforeAll(async () => {
    w = await makeClaimWorld(RUN, 'S')
    await finaliseCoding(w)
    await getDb().insert(diagnoses).values({
      patientId: w.patientId, code: 'U1Z.1', description: 'TEST fictional diagnosis', encounterId: w.encounterId, codeId: w.dxId, codeSystemKind: 'icd10',
      codeDisplay: 'TEST fictional diagnosis', diagnosisType: 'primary', codingStatus: 'coded', sequence: 1, codedByName: 'TEST', codedAt: new Date(),
    })
  })
  afterAll(async () => {
    await destroyClaimWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('submits v1: two copies stored with hashes, dispatch recorded, claim submitted', async () => {
    const id = await readyClaim()
    const r = await submitClaimVersion(id, { action: 'submit', channel: 'portal', trackingReference: 'TPA/77' }, RCM, deps, NOW)
    expect(r).toMatchObject({ ok: true, value: { version: 1, status: 'submitted' } })
    if (!r.ok) return
    const [s] = await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.id, r.value.submissionId))
    expect(s.snapshotSha256).toBe(snapshotSha256(s.snapshot))
    expect(s.snapshot.diagnoses[0]).toMatchObject({ code: 'U1Z.1', type: 'primary' })
    expect(store.get(s.rcmCopyBlobUrl)).toBeDefined(); expect(store.get(s.insurerCopyBlobUrl)).toBeDefined()
    const [d] = await getDb().select().from(claimDispatches).where(eq(claimDispatches.submissionId, s.id))
    expect(d).toMatchObject({ channel: 'portal', transport: 'manual', trackingReference: 'TPA/77', dispatchedOn: '2099-06-02' })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, id))
    expect(c).toMatchObject({ status: 'submitted', currentVersion: 1, firstSubmittedAt: NOW })
    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'rcm: submitted claim version')))
    expect(a.details).toBe(`claim=${id} version=1 kind=initial channel=portal sha=${s.snapshotSha256.slice(0, 12)}`)
  })

  it('verify recomputes the stored hashes', async () => {
    const id = await readyClaim()
    const r = await submitClaimVersion(id, { action: 'submit', channel: 'email' }, RCM, deps, NOW)
    if (!r.ok) throw new Error(r.error)
    expect(await verifySubmission(r.value.submissionId, { fetchBytes })).toMatchObject({ snapshotOk: true, rcmCopyOk: true, insurerCopyOk: true })
    const [s] = await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.id, r.value.submissionId))
    store.set(s.insurerCopyBlobUrl, new TextEncoder().encode('tampered'))
    expect(await verifySubmission(r.value.submissionId, { fetchBytes })).toMatchObject({ snapshotOk: true, rcmCopyOk: true, insurerCopyOk: false })
  })

  it('a not-ready claim is refused with readiness items and stores nothing', async () => {
    const id = await readyClaim(false)
    const r = await submitClaimVersion(id, { action: 'submit', channel: 'portal' }, RCM, deps, NOW)
    expect(r).toMatchObject({ ok: false, error: 'not_ready' })
    if (!r.ok) expect(r.items?.map((i) => i.code)).toContain('document_missing')
    expect(await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.claimId, id))).toEqual([])
  })

  it('NHCX is refused as not configured and stores nothing', async () => {
    const id = await readyClaim()
    expect(await submitClaimVersion(id, { action: 'submit', channel: 'nhcx' }, RCM, deps, NOW)).toEqual({ ok: false, error: 'gateway_not_configured' })
    expect(await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.claimId, id))).toEqual([])
  })

  it('a change between render and commit is refused as stale', async () => {
    const id = await readyClaim()
    const racing: SubmissionDeps = { ...deps, render: async (snap, copy, opts) => {
      if (copy === 'insurer') await waiveClaimDocument(id, 'claim_form', 'changed meanwhile', RCM)
      return defaultSubmissionDeps.render(snap, copy, opts)
    } }
    expect(await submitClaimVersion(id, { action: 'submit', channel: 'portal' }, RCM, racing, NOW)).toEqual({ ok: false, error: 'stale' })
    expect(await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.claimId, id))).toEqual([])
  })

  it('responding to a query creates v2 of kind query_response and answers the query', async () => {
    const id = await readyClaim()
    await submitClaimVersion(id, { action: 'submit', channel: 'portal' }, RCM, deps, NOW)
    const [q] = await getDb().insert(rcmQueries).values({ claimId: id, question: 'Send the scan', raisedOn: '2099-06-02', dueOn: '2099-06-05', createdByName: 'T' }).returning()
    await getDb().update(claims).set({ status: 'queried' }).where(eq(claims.id, id))
    const r = await submitClaimVersion(id, { action: 'respond_query', queryId: q.id, body: 'Scan attached', channel: 'portal', respondedOn: '2099-06-03' }, RCM, deps, NOW)
    expect(r).toMatchObject({ ok: true, value: { version: 2, status: 'submitted' } })
    const [s2] = await getDb().select().from(claimSubmissions).where(and(eq(claimSubmissions.claimId, id), eq(claimSubmissions.version, 2)))
    expect(s2.kind).toBe('query_response'); expect(s2.snapshot.coverNote).toBe('Scan attached')
    const [q2] = await getDb().select().from(rcmQueries).where(eq(rcmQueries.id, q.id))
    expect(q2.status).toBe('answered')
  })

  it('coding reopened after submission flags the claim and blocks resubmission', async () => {
    const id = await readyClaim()
    await submitClaimVersion(id, { action: 'submit', channel: 'portal' }, RCM, deps, NOW)
    expect(await claimCodingDrift(getDb(), id)).toEqual({ drifted: false, codingFinalised: true })
    await finaliseCoding(w, 'in_progress')
    try {
      expect(await claimCodingDrift(getDb(), id)).toEqual({ drifted: true, codingFinalised: false })
      const [q] = await getDb().insert(rcmQueries).values({ claimId: id, question: 'Clarify', raisedOn: '2099-06-02', dueOn: '2099-06-05', createdByName: 'T' }).returning()
      await getDb().update(claims).set({ status: 'queried' }).where(eq(claims.id, id))
      const r = await submitClaimVersion(id, { action: 'respond_query', queryId: q.id, body: 'Clarified', channel: 'portal', respondedOn: '2099-06-03' }, RCM, deps, NOW)
      expect(r).toMatchObject({ ok: false, error: 'not_ready' })
      if (!r.ok) expect(r.items?.map((i) => i.code)).toContain('coding_not_finalised')
    } finally {
      await finaliseCoding(w)
    }
  })

  it('concurrent submits of one draft create one version', async () => {
    const id = await readyClaim()
    const [a, b] = await Promise.all([
      submitClaimVersion(id, { action: 'submit', channel: 'portal' }, RCM, deps, NOW),
      submitClaimVersion(id, { action: 'submit', channel: 'portal' }, RCM, deps, NOW),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(await getDb().select().from(claimSubmissions).where(eq(claimSubmissions.claimId, id))).toHaveLength(1)
    expect(await getDb().select().from(claimEvents).where(and(eq(claimEvents.claimId, id), eq(claimEvents.action, 'submit')))).toHaveLength(1)
  })

  it('snapshot has no contact keys and ABHA only for a payer that requires it', async () => {
    const id = await readyClaim()
    await getDb().update(patients).set({ abhaNumber: `91${RUN}12345`.slice(0, 14).padEnd(14, '0'), phone: '9845013210' }).where(eq(patients.id, w.patientId))
    const plain = await buildClaimSnapshotFor(getDb(), id, 'initial', null, NOW)
    expect(plain?.snapshot.patient.abhaNumber).toBeNull()
    expect(JSON.stringify(plain?.snapshot)).not.toMatch(/phone|email|address|9845013210/i)
    await getDb().update(payerProfiles).set({ requiresAbha: true }).where(eq(payerProfiles.payerId, w.tpaId))
    const withAbha = await buildClaimSnapshotFor(getDb(), id, 'initial', null, NOW)
    expect(withAbha?.snapshot.patient.abhaNumber).toMatch(/^\d{2}-\d{4}-\d{4}-\d{4}$/)
    await getDb().update(payerProfiles).set({ requiresAbha: false }).where(eq(payerProfiles.payerId, w.tpaId))
    await getDb().update(patients).set({ abhaNumber: null }).where(eq(patients.id, w.patientId))
  })

  it('the acknowledgement is recorded once', async () => {
    const id = await readyClaim()
    const r = await submitClaimVersion(id, { action: 'submit', channel: 'courier' }, RCM, deps, NOW)
    if (!r.ok) throw new Error(r.error)
    const [d] = await getDb().select().from(claimDispatches).where(eq(claimDispatches.submissionId, r.value.submissionId))
    expect(await acknowledgeDispatch(d.id, { insurerReference: 'INS-CLM-1', acknowledgedOn: '2099-06-04' }, RCM)).toEqual({ ok: true, value: null })
    expect(await acknowledgeDispatch(d.id, { insurerReference: 'INS-CLM-2', acknowledgedOn: '2099-06-04' }, RCM)).toEqual({ ok: false, error: 'already_acknowledged' })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, id))
    expect(c.insurerClaimReference).toBe('INS-CLM-1')
  })
})
