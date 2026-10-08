import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claimDocuments, claimInvoices, claims, invoices, labReports, labRequisitions, patientPolicies } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn() }))

import { createClaimDraft, getClaimReadiness, listClaimableInvoices, episodeOf, setClaimInvoices } from '@/lib/queries/claims'
import { attachLabReport, getClaimDocumentBlob, removeClaimDocument, uploadClaimDocument, waiveClaimDocument } from '@/lib/queries/claim-documents'
import { cancelInvoice } from '@/lib/queries/invoices'
import { purgeRcmFixtures } from '../../db/rcm-fixtures'
import { makeClaimWorld, destroyClaimWorld, finalisedInvoice, finaliseCoding, BILLING_SESSION, FINALISE_NOW, type ClaimWorld } from './claim-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Claim Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const NOW = new Date('2099-06-02T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('claim drafts (DB)', () => {
  let w: ClaimWorld
  const draft = (invoiceId: number, claimedPaise?: number) => createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, invoices: [{ invoiceId, ...(claimedPaise ? { claimedPaise } : {}) }] }, RCM, NOW)
  beforeAll(async () => { w = await makeClaimWorld(RUN, 'C'); await finaliseCoding(w) })
  afterAll(async () => {
    await purgeRcmFixtures([w.patientId], [])
    await getDb().delete(labReports).where(eq(labReports.patientId, w.patientId))
    await getDb().delete(labRequisitions).where(eq(labRequisitions.patientId, w.patientId))
    await destroyClaimWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('creates a draft claim from a finalised invoice and auto-attaches the itemised bill', async () => {
    const inv = await finalisedInvoice(w)
    const r = await draft(inv)
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.value.claimNumber).toMatch(/^CLM-2099-\d{6}$/)
    const [c] = await getDb().select().from(claims).where(eq(claims.id, r.value.claimId))
    expect(c).toMatchObject({ status: 'draft', claimedPaise: 50_000_00, billingPayerId: w.tpaId, insurerPayerId: w.insurerId })
    const docs = await getDb().select().from(claimDocuments).where(eq(claimDocuments.claimId, c.id))
    expect(docs.map((d) => `${d.kind}:${d.source}`)).toEqual(['itemised_bill:invoice'])
    const [audit] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), eq(auditLog.action, 'rcm: created claim')))
    expect(audit.details).toBe(`claim=${c.id} number=${c.claimNumber} invoices=1 claimed=5000000`)
  })

  it('refuses a self-pay invoice, a draft invoice and another visit\'s claim context', async () => {
    const selfPay = await finalisedInvoice(w, { billTo: 'patient' })
    expect(await draft(selfPay)).toEqual({ ok: false, error: 'invoice_unavailable' })
    const notFinal = await finalisedInvoice(w, { finalise: false })
    expect(await draft(notFinal)).toEqual({ ok: false, error: 'invoice_unavailable' })
    expect(await createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: 2147483000, invoices: [{ invoiceId: selfPay }] }, RCM, NOW)).toEqual({ ok: false, error: 'context_mismatch' })
  })

  it('two concurrent claims on one invoice never exceed its total', async () => {
    const inv = await finalisedInvoice(w)
    const [a, b] = await Promise.all([draft(inv), draft(inv)])
    expect([a.ok, b.ok].sort()).toEqual([false, true]); expect(a.ok ? b : a).toMatchObject({ ok: false, error: 'invoice_over_claimed' })
  })

  it('a top-up claim may take the remainder; a withdrawn claim frees its invoices', async () => {
    const inv = await finalisedInvoice(w)
    const first = await draft(inv, 30_000_00)
    expect(first.ok).toBe(true); if (!first.ok) return
    const ep = (await episodeOf(getDb(), { encounterId: w.encounterId }))!
    expect((await listClaimableInvoices(getDb(), ep, w.tpaId)).find((i) => i.invoiceId === inv)).toMatchObject({ claimedElsewherePaise: 30_000_00, availablePaise: 20_000_00 })
    const second = await draft(inv)
    expect(second.ok).toBe(true); if (!second.ok) return
    const [ci] = await getDb().select().from(claimInvoices).where(eq(claimInvoices.claimId, second.value.claimId))
    expect(ci.claimedPaise).toBe(20_000_00)
    await getDb().update(claims).set({ status: 'withdrawn' }).where(eq(claims.id, second.value.claimId))
    expect((await listClaimableInvoices(getDb(), ep, w.tpaId)).find((i) => i.invoiceId === inv)?.availablePaise).toBe(20_000_00)
    expect(await setClaimInvoices(first.value.claimId, [{ invoiceId: inv }], RCM)).toEqual({ ok: true, value: null })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, first.value.claimId))
    expect(c.claimedPaise).toBe(50_000_00); expect(c.rowVersion).toBe(1)
  })

  it('cancelInvoice refuses an invoice on a submitted claim; a draft claim does not block it but then is not ready', async () => {
    const inv = await finalisedInvoice(w)
    const r = await draft(inv)
    if (!r.ok) throw new Error(r.error)
    await getDb().update(claims).set({ status: 'submitted' }).where(eq(claims.id, r.value.claimId))
    expect(await cancelInvoice(inv, 'wrong patient', BILLING_SESSION, FINALISE_NOW)).toEqual({ ok: false, error: 'on_claim' })
    await getDb().update(claims).set({ status: 'draft' }).where(eq(claims.id, r.value.claimId))
    expect((await cancelInvoice(inv, 'wrong patient', BILLING_SESSION, FINALISE_NOW)).ok).toBe(true)
    const ready = await getClaimReadiness(r.value.claimId)
    expect(ready?.items.map((i) => i.code)).toContain('invoice_cancelled')
    const [i] = await getDb().select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv))
    expect(i.status).toBe('cancelled')
  })

  it('readiness lists missing documents until uploaded or waived, and needs finalised coding', async () => {
    const inv = await finalisedInvoice(w)
    const r = await draft(inv)
    if (!r.ok) throw new Error(r.error)
    const id = r.value.claimId
    const codes = async () => (await getClaimReadiness(id))!.items.filter((i) => i.severity === 'block').map((i) => `${i.code}${i.documentKind ? ':' + i.documentKind : ''}`)
    expect(await codes()).toEqual(['document_missing:id_proof', 'document_missing:policy_card', 'document_missing:prescription'])
    expect((await uploadClaimDocument(id, { kind: 'id_proof', title: 'PAN', idProofType: 'pan' }, { bytes: new TextEncoder().encode('id'), contentType: 'image/png' }, RCM)).ok).toBe(true)
    expect((await waiveClaimDocument(id, 'policy_card', 'e-card only', RCM)).ok).toBe(true)
    expect((await waiveClaimDocument(id, 'prescription', 'not applicable', RCM)).ok).toBe(true)
    expect(await getClaimReadiness(id)).toMatchObject({ ready: true })
    await finaliseCoding(w, 'in_progress')
    expect(await codes()).toEqual(['coding_not_finalised'])
    await finaliseCoding(w)
  })

  it('documents are superseded, never deleted', async () => {
    const inv = await finalisedInvoice(w)
    const r = await draft(inv)
    if (!r.ok) throw new Error(r.error)
    const up = await uploadClaimDocument(r.value.claimId, { kind: 'claim_form', title: 'Form' }, { bytes: new TextEncoder().encode('f'), contentType: 'application/pdf' }, RCM)
    if (!up.ok) throw new Error(up.error)
    expect(await removeClaimDocument(r.value.claimId, up.value.documentId, RCM)).toEqual({ ok: true, value: null })
    expect(await removeClaimDocument(r.value.claimId, up.value.documentId, RCM)).toEqual({ ok: false, error: 'document_not_found' })
    const [row] = await getDb().select().from(claimDocuments).where(eq(claimDocuments.id, up.value.documentId))
    expect(row.supersededAt).not.toBeNull()
    const live = await getDb().select().from(claimDocuments).where(and(eq(claimDocuments.claimId, r.value.claimId), isNull(claimDocuments.supersededAt)))
    expect(live.map((d) => d.kind)).toEqual(['itemised_bill'])
  })

  it('auto-attaches a lab report released during the visit; attaches another only when current', async () => {
    const db = getDb()
    const [req] = await db.insert(labRequisitions).values({ patientId: w.patientId, orderedByProviderId: w.providerId, createdByName: 'TEST-SP7' }).returning()
    const report = async (n: string, releasedAt: Date, supersededAt: Date | null = null) => (await db.insert(labReports).values({
      reportNumber: `LR-T${RUN}${n}`, requisitionId: req.id, patientId: w.patientId, version: Number(n), orderIds: [], testSummary: 'CBC', blobUrl: `https://blob.test/lr${n}`,
      byteSize: 10, sha256: 'e'.repeat(64), releasedByName: 'TEST-SP7', releasedAt, supersededAt,
    }).returning())[0].id
    const during = await report('1', new Date('2026-10-01T08:00:00Z'))
    const later = await report('2', new Date('2026-10-05T08:00:00Z'))
    const old = await report('3', new Date('2026-10-05T09:00:00Z'), new Date('2026-10-06T09:00:00Z'))
    const inv = await finalisedInvoice(w)
    const r = await draft(inv)
    if (!r.ok) throw new Error(r.error)
    const docs = await db.select().from(claimDocuments).where(eq(claimDocuments.claimId, r.value.claimId))
    expect(docs.find((d) => d.source === 'lab_report')).toMatchObject({ kind: 'investigation_reports', sourceId: during, sha256: 'e'.repeat(64) })
    expect(await attachLabReport(r.value.claimId, old, RCM)).toEqual({ ok: false, error: 'lab_report_unavailable' })
    const att = await attachLabReport(r.value.claimId, later, RCM)
    expect(att.ok).toBe(true); if (!att.ok) return
    expect(await getClaimDocumentBlob(att.value.documentId)).toMatchObject({ url: 'https://blob.test/lr2', contentType: 'application/pdf', patientId: w.patientId })
  })

  // Whole-branch review findings 2 and 9.
  it('a policy card replaced after attach does not change the claim document; re-attaching a report changes nothing', async () => {
    const db = getDb()
    await db.update(patientPolicies).set({ cardFrontBlobUrl: 'https://blob.test/card-v1.png', cardFrontSha256: 'a'.repeat(64) }).where(eq(patientPolicies.id, w.policyId))
    const inv = await finalisedInvoice(w)
    const r = await draft(inv)
    if (!r.ok) throw new Error(r.error)
    const [card] = await db.select().from(claimDocuments).where(and(eq(claimDocuments.claimId, r.value.claimId), eq(claimDocuments.source, 'policy_card')))
    await db.update(patientPolicies).set({ cardFrontBlobUrl: 'https://blob.test/card-v2.png', cardFrontSha256: 'b'.repeat(64) }).where(eq(patientPolicies.id, w.policyId))
    expect(await getClaimDocumentBlob(card.id)).toMatchObject({ url: 'https://blob.test/card-v1.png' })
    const [report] = await db.select({ id: labReports.id }).from(labReports).where(and(eq(labReports.patientId, w.patientId), isNull(labReports.supersededAt))).limit(1)
    await attachLabReport(r.value.claimId, report.id, RCM)
    const [before] = await db.select({ v: claims.rowVersion }).from(claims).where(eq(claims.id, r.value.claimId))
    expect((await attachLabReport(r.value.claimId, report.id, RCM)).ok).toBe(true)
    const [after] = await db.select({ v: claims.rowVersion }).from(claims).where(eq(claims.id, r.value.claimId))
    expect(after.v).toBe(before.v)
  })
})

