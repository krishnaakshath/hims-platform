// WS7 T9 (spec D15): portal self-service policy and ABHA submissions, against the real database.
// A submission waits as 'pending' (one per patient and kind); the front desk approves it (the real
// policy through createPolicy, or the ABHA recorded on the chart as not verified with ABDM) or
// rejects it with a reason the patient sees. Audit details carry ids and kinds only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, documents, patientPolicies, patients, payerProfiles, payers, portalSubmissions } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  countPendingPortalSubmissions, createPortalSubmission, decidePortalSubmission, listPendingPortalSubmissions, listPortalSubmissionsForPatient,
} from '@/lib/queries/portal-submissions'
import { listPortalPolicies, getPortalAbhaStatus } from '@/lib/queries/patient-portal-records'
import { deleteDocument } from '@/lib/queries/documents'
import { readMigration, idempotencyProblems } from '../../db/migration-sql'
import { withTempBlobDir } from '../../helpers/temp-blob-dir'

withTempBlobDir()
const RUN = `${process.pid}`
const A = `WS7T9-L-${RUN}-A`
const B = `WS7T9-L-${RUN}-B`
const DESK: Session = { role: 'frontdesk', name: 'Desk Reviewer', userId: null }
const ABHA_A = `91${RUN.padStart(8, '0').slice(-8)}1234`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
let insurerId = 0
let tpaId = 0

const policyPayload = { insurerName: 'Star Health', policyNumber: `P/${RUN}/01`, validFrom: '2026-04-01', validTo: '2099-03-31', sumInsuredPaise: 50000000 }

async function purge() {
  const db = getDb()
  const subs = await db.select({ documentId: portalSubmissions.documentId }).from(portalSubmissions).where(inArray(portalSubmissions.patientId, [A, B]))
  await db.delete(portalSubmissions).where(inArray(portalSubmissions.patientId, [A, B]))
  const docIds = subs.map((s) => s.documentId).filter((x): x is number => x !== null)
  if (docIds.length) await db.delete(documents).where(inArray(documents.id, docIds))
  await db.update(patients).set({ primaryPayerId: null, abhaNumber: null, abhaAddress: null, abhaVerifiedAt: null, abhaVerificationSource: null, abhaVerifiedVia: null }).where(inArray(patients.id, [A, B]))
  await db.delete(patientPolicies).where(inArray(patientPolicies.patientId, [A, B]))
  await db.delete(auditLog).where(inArray(auditLog.patientId, [A, B]))
}

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values([{ id: A, name: 'Self Service A', dob: '1985-01-01' }, { id: B, name: 'Self Service B', dob: '1986-01-01' }])
  const [ins] = await db.insert(payers).values({ name: `WS7T9 Insurer ${RUN}`, payerId: `W79I${RUN}`, payerType: 'other' }).returning()
  const [tpa] = await db.insert(payers).values({ name: `WS7T9 TPA ${RUN}`, payerId: `W79T${RUN}`, payerType: 'other' }).returning()
  await db.insert(payerProfiles).values([
    { payerId: ins.id, kind: 'insurer', empanelmentStatus: 'empanelled', updatedByName: 'Test' },
    { payerId: tpa.id, kind: 'tpa', empanelmentStatus: 'empanelled', updatedByName: 'Test' },
  ])
  insurerId = ins.id
  tpaId = tpa.id
})
beforeEach(purge)
afterAll(async () => {
  await purge()
  const db = getDb()
  await db.delete(payerProfiles).where(inArray(payerProfiles.payerId, [insurerId, tpaId]))
  await db.delete(payers).where(inArray(payers.id, [insurerId, tpaId]))
  await db.delete(patients).where(inArray(patients.id, [A, B]))
})

const card = { bytes: PNG, contentType: 'image/png' as const, fileType: 'PNG' as const }

describe('portal_submissions migration', () => {
  it('is idempotent and declares the table, checks and the one-pending index', () => {
    const s = readMigration('2026-10-26-ws7-portal-submissions.sql')
    expect(idempotencyProblems(s)).toEqual([])
    for (const n of ['portal_submissions_kind_valid', 'portal_submissions_status_valid', 'portal_submissions_one_pending_per_kind', 'REFERENCES documents(id)']) expect(s).toContain(n)
  })

  it('the card document reference is ON DELETE SET NULL (follow-up migration); the only DROP is the guarded FK re-creation', () => {
    const s = readMigration('2026-10-26-ws7-submission-doc-fk.sql')
    const problems = idempotencyProblems(s)
    expect(problems.filter((p) => !p.startsWith('DROP is not allowed'))).toEqual([])
    expect(problems.filter((p) => p.startsWith('DROP is not allowed'))).toHaveLength(1)
    expect(s).toMatch(/confdeltype <> 'n'[\s\S]*?DROP CONSTRAINT portal_submissions_document_id_documents_id_fk/)
    expect(s).toContain('REFERENCES documents(id) ON DELETE SET NULL')
    // Sorts after the migration that creates the table.
    expect('2026-10-26-ws7-submission-doc-fk.sql' > '2026-10-26-ws7-portal-submissions.sql').toBe(true)
  })
})

describe('createPortalSubmission', () => {
  it('stores a pending policy with its card as a documents row and audits ids only', async () => {
    const r = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload }, card)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [row] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    expect(row).toMatchObject({ patientId: A, kind: 'policy', status: 'pending', reviewedAt: null })
    expect(row.documentId).not.toBeNull()
    const [doc] = await getDb().select().from(documents).where(eq(documents.id, row.documentId!))
    expect(doc).toMatchObject({ patientId: A, fileType: 'PNG', receivedFrom: 'Patient portal' })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.patientId, A))
    expect(audits.map((a) => a.action)).toContain('patient portal: submitted self-service')
    expect(JSON.stringify(audits)).not.toContain(policyPayload.policyNumber)
    expect(await countPendingPortalSubmissions()).toBeGreaterThanOrEqual(1)
  })

  it('a second pending submission of the same kind is refused; another kind is fine', async () => {
    expect((await createPortalSubmission(A, { kind: 'policy', payload: policyPayload })).ok).toBe(true)
    expect(await createPortalSubmission(A, { kind: 'policy', payload: policyPayload })).toEqual({ ok: false, error: 'pending_exists' })
    expect((await createPortalSubmission(A, { kind: 'abha', payload: { abhaNumber: ABHA_A } })).ok).toBe(true)
  })
})

describe('decidePortalSubmission', () => {
  it('approving a policy creates the real policy (primary, active), copies the card and the portal shows it', async () => {
    const r = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload }, card)
    if (!r.ok) throw new Error('setup')
    const d = await decidePortalSubmission(r.id, { decision: 'approve', insurerPayerId: insurerId, tpaPayerId: tpaId }, DESK)
    expect(d).toMatchObject({ ok: true })
    const [policy] = await getDb().select().from(patientPolicies).where(eq(patientPolicies.patientId, A))
    expect(policy).toMatchObject({ insurerPayerId: insurerId, tpaPayerId: tpaId, policyNumber: policyPayload.policyNumber, memberId: policyPayload.policyNumber, priority: 'primary', status: 'active', holderName: 'Self Service A', relationship: 'self', sumInsuredPaise: 50000000 })
    expect(policy.cardFrontBlobUrl).not.toBeNull()
    expect(policy.cardFrontSha256).toMatch(/^[0-9a-f]{64}$/)
    const [sub] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    expect(sub).toMatchObject({ status: 'approved', reviewedByName: 'Desk Reviewer' })
    const [doc] = await getDb().select().from(documents).where(eq(documents.id, sub.documentId!))
    expect(doc).toMatchObject({ documentType: 'insurance_card_primary_front', status: 'processed', filedByName: 'Desk Reviewer' })
    expect((await listPortalPolicies(A)).map((p) => p.policyNumber)).toEqual([policyPayload.policyNumber])
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, A), eq(auditLog.action, 'approved portal submission')))
    expect(audits).toHaveLength(1)
    expect(audits[0].details).toBe(`submission=${r.id} kind=policy policy=${policy.id}`)
    // Decided once only.
    expect(await decidePortalSubmission(r.id, { decision: 'reject', reason: 'Too late now' }, DESK)).toMatchObject({ ok: false, error: 'already_decided', status: 409 })
  })

  it('deleting the card document of an approved submission succeeds and leaves the submission without a card', async () => {
    const r = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload }, card)
    if (!r.ok) throw new Error('setup')
    expect(await decidePortalSubmission(r.id, { decision: 'approve', insurerPayerId: insurerId }, DESK)).toMatchObject({ ok: true })
    const [before] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    expect(await deleteDocument(before.documentId!)).not.toBeNull()
    const [after] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    expect(after).toMatchObject({ status: 'approved', documentId: null })
    expect((await listPortalSubmissionsForPatient(A)).map((x) => x.status)).toEqual(['approved'])
  })

  it('a pending submission whose card document was deleted lists without a card and can still be decided', async () => {
    const r = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload }, card)
    if (!r.ok) throw new Error('setup')
    const [row] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    await deleteDocument(row.documentId!)
    const listed = (await listPendingPortalSubmissions('frontdesk')).find((x) => x.id === r.id)
    expect(listed).toMatchObject({ hasCard: false, documentId: null })
    expect(await decidePortalSubmission(r.id, { decision: 'approve', insurerPayerId: insurerId }, DESK)).toMatchObject({ ok: true })
    const [policy] = await getDb().select().from(patientPolicies).where(eq(patientPolicies.patientId, A))
    expect(policy.cardFrontBlobUrl).toBeNull()
  })

  it('a second approved policy is secondary when an active primary exists', async () => {
    const first = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload })
    if (!first.ok) throw new Error('setup')
    await decidePortalSubmission(first.id, { decision: 'approve', insurerPayerId: insurerId }, DESK)
    const second = await createPortalSubmission(A, { kind: 'policy', payload: { ...policyPayload, policyNumber: `P/${RUN}/02` } })
    if (!second.ok) throw new Error('setup')
    expect(await decidePortalSubmission(second.id, { decision: 'approve', insurerPayerId: insurerId }, DESK)).toMatchObject({ ok: true })
    const rows = await getDb().select().from(patientPolicies).where(eq(patientPolicies.patientId, A))
    expect(rows.map((p) => p.priority).sort()).toEqual(['primary', 'secondary'])
  })

  it('a policy approval needs the insurer, and a TPA in the insurer field is refused with nothing written', async () => {
    const r = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload })
    if (!r.ok) throw new Error('setup')
    expect(await decidePortalSubmission(r.id, { decision: 'approve' }, DESK)).toMatchObject({ ok: false, error: 'insurer_required', status: 400 })
    expect(await decidePortalSubmission(r.id, { decision: 'approve', insurerPayerId: tpaId }, DESK)).toMatchObject({ ok: false, status: 400 })
    expect(await getDb().select().from(patientPolicies).where(eq(patientPolicies.patientId, A))).toEqual([])
    const [sub] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    expect(sub.status).toBe('pending')
  })

  it('approving an ABHA records it on the chart, not verified with ABDM', async () => {
    const r = await createPortalSubmission(A, { kind: 'abha', payload: { abhaNumber: ABHA_A } })
    if (!r.ok) throw new Error('setup')
    expect(await decidePortalSubmission(r.id, { decision: 'approve' }, DESK)).toMatchObject({ ok: true })
    const [p] = await getDb().select({ abhaNumber: patients.abhaNumber, abhaVerifiedAt: patients.abhaVerifiedAt }).from(patients).where(eq(patients.id, A))
    expect(p).toEqual({ abhaNumber: ABHA_A, abhaVerifiedAt: null })
    expect((await getPortalAbhaStatus(A))?.abhaNumberMasked).toBe(`XX-XXXX-XXXX-${ABHA_A.slice(-4)}`)
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.patientId, A))
    expect(audits.find((a) => a.action === 'approved portal submission')?.details).toBe(`submission=${r.id} kind=abha`)
    expect(JSON.stringify(audits.map((a) => a.details))).not.toContain(ABHA_A)
  })

  it('an ABHA already on another chart is refused with nothing written', async () => {
    await getDb().update(patients).set({ abhaNumber: ABHA_A }).where(eq(patients.id, B))
    const r = await createPortalSubmission(A, { kind: 'abha', payload: { abhaNumber: ABHA_A } })
    if (!r.ok) throw new Error('setup')
    expect(await decidePortalSubmission(r.id, { decision: 'approve' }, DESK)).toMatchObject({ ok: false, error: 'abha_in_use', status: 409 })
    const [sub] = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.id, r.id))
    expect(sub.status).toBe('pending')
    const [p] = await getDb().select({ abhaNumber: patients.abhaNumber }).from(patients).where(eq(patients.id, A))
    expect(p.abhaNumber).toBeNull()
  })

  it('an ABHA already verified with ABDM on this chart is not replaced from the portal', async () => {
    await getDb().update(patients).set({ abhaNumber: '91000000000001', abhaVerifiedAt: new Date(), abhaVerificationSource: 'abdm', abhaVerifiedVia: 'abha_number_mobile_otp' }).where(eq(patients.id, A))
    const r = await createPortalSubmission(A, { kind: 'abha', payload: { abhaNumber: ABHA_A } })
    if (!r.ok) throw new Error('setup')
    expect(await decidePortalSubmission(r.id, { decision: 'approve' }, DESK)).toMatchObject({ ok: false, error: 'abha_verified', status: 409 })
  })

  it('rejecting keeps master data untouched and the patient sees the reason', async () => {
    const r = await createPortalSubmission(A, { kind: 'policy', payload: policyPayload })
    if (!r.ok) throw new Error('setup')
    expect(await decidePortalSubmission(r.id, { decision: 'reject', reason: 'The card image is not readable' }, DESK)).toMatchObject({ ok: true })
    expect(await getDb().select().from(patientPolicies).where(eq(patientPolicies.patientId, A))).toEqual([])
    const mine = await listPortalSubmissionsForPatient(A)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ id: r.id, kind: 'policy', status: 'rejected', rejectReason: 'The card image is not readable' })
    const audit = (await getDb().select().from(auditLog).where(eq(auditLog.patientId, A))).find((a) => a.action === 'rejected portal submission')
    expect(audit?.details).toBe(`submission=${r.id} kind=policy`)
    // A new submission of that kind is allowed once the earlier one is decided.
    expect((await createPortalSubmission(A, { kind: 'policy', payload: policyPayload })).ok).toBe(true)
  })

  it('an unknown submission is not found', async () => {
    expect(await decidePortalSubmission(2_000_000_000, { decision: 'reject', reason: 'Nothing here' }, DESK)).toMatchObject({ ok: false, error: 'not_found', status: 404 })
  })
})

describe('listPendingPortalSubmissions', () => {
  it('lists pending rows with the patient UHID-facing fields; rcm sees the ABHA masked', async () => {
    await createPortalSubmission(A, { kind: 'abha', payload: { abhaNumber: ABHA_A } }, card)
    const desk = (await listPendingPortalSubmissions('frontdesk')).filter((r) => r.patientId === A)
    expect(desk).toHaveLength(1)
    expect(desk[0]).toMatchObject({ kind: 'abha', patientName: 'Self Service A', hasCard: true })
    expect(desk[0].details).toContainEqual({ label: 'ABHA number', value: `${ABHA_A.slice(0, 2)}-${ABHA_A.slice(2, 6)}-${ABHA_A.slice(6, 10)}-${ABHA_A.slice(10)}` })
    const rcm = (await listPendingPortalSubmissions('rcm')).filter((r) => r.patientId === A)
    expect(rcm[0].details).toContainEqual({ label: 'ABHA number', value: `XX-XXXX-XXXX-${ABHA_A.slice(-4)}` })
    expect(JSON.stringify(desk)).not.toMatch(/blob|data\/|file:/i)
  })
})
