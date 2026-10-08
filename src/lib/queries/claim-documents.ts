// SP7: a claim's supporting documents. Rows are never deleted: removal supersedes them, so an
// earlier submission snapshot keeps the hashes it listed. Uploads are hashed and stored in the
// private blob store before the transaction; URLs never leave the server.
import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { claimDocuments, claims, labReports, patientPolicies, preauthDocuments, type ClaimRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { putPrivateBlob } from '@/lib/blob-store'
import type { ClaimDocumentKind } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import { sha256Hex } from '@/lib/rcm/hash'
import type { ClaimDocumentMeta } from '@/lib/rcm/validation'
import { lockPatientBilling } from './billing-lock'

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]
const EXTENSION: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }
const LOCKED_STATUSES: readonly ClaimRow['status'][] = ['closed', 'withdrawn']

/** Runs `fn` under the patient's billing lock with the claim row locked; refuses closed or withdrawn claims. */
async function withOpenClaim<T>(claimId: number, fn: (tx: Tx, claim: ClaimRow) => Promise<RcmWriteResult<T>>): Promise<RcmWriteResult<T>> {
  const [found] = await getDb().select({ patientId: claims.patientId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!found) return rcmFail('claim_not_found')
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, found.patientId)
    const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId)).for('update')
    if (!claim) return rcmFail('claim_not_found')
    if (LOCKED_STATUSES.includes(claim.status)) return rcmFail('invalid_transition')
    const r = await fn(tx, claim)
    // A document change changes the next snapshot: bump the row version (stale detection, Task 12).
    if (r.ok) await tx.update(claims).set({ rowVersion: claim.rowVersion + 1, updatedAt: new Date() }).where(eq(claims.id, claimId))
    return r
  })
}

export async function uploadClaimDocument(
  claimId: number, meta: ClaimDocumentMeta, file: { bytes: Uint8Array; contentType: string }, session: Session,
): Promise<RcmWriteResult<{ documentId: number }>> {
  const ext = EXTENSION[file.contentType]
  if (!ext) return rcmFail('upload_invalid')
  const [found] = await getDb().select({ id: claims.id }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!found) return rcmFail('claim_not_found')
  const sha256 = sha256Hex(file.bytes)
  const { url } = await putPrivateBlob(`rcm/claims/${claimId}/docs/${randomUUID()}.${ext}`, file.bytes, file.contentType)
  return withOpenClaim(claimId, async (tx, claim) => {
    const [row] = await tx.insert(claimDocuments).values({
      claimId, kind: meta.kind, source: 'upload', title: meta.title, blobUrl: url, contentType: file.contentType, byteSize: file.bytes.byteLength, sha256,
      idProofType: meta.kind === 'id_proof' ? meta.idProofType ?? null : null, uploadedByName: session.name,
    }).returning({ id: claimDocuments.id })
    await logAudit(session, 'rcm: uploaded claim document', claim.patientId, `claim=${claimId} document=${row.id} kind=${meta.kind}`, tx)
    return rcmOk({ documentId: row.id })
  })
}

/** Attaches one of the patient's current (not superseded) lab reports. */
export async function attachLabReport(claimId: number, labReportId: number, session: Session): Promise<RcmWriteResult<{ documentId: number }>> {
  return withOpenClaim(claimId, async (tx, claim) => {
    const [r] = await tx.select({ patientId: labReports.patientId, supersededAt: labReports.supersededAt, number: labReports.reportNumber, sha: labReports.sha256 })
      .from(labReports).where(eq(labReports.id, labReportId)).limit(1)
    if (!r || r.patientId !== claim.patientId || r.supersededAt !== null) return rcmFail('lab_report_unavailable')
    const [live] = await tx.select({ id: claimDocuments.id }).from(claimDocuments).where(and(
      eq(claimDocuments.claimId, claimId), eq(claimDocuments.source, 'lab_report'), eq(claimDocuments.sourceId, labReportId), isNull(claimDocuments.supersededAt),
    )).limit(1)
    if (live) return rcmOk({ documentId: live.id })
    const [row] = await tx.insert(claimDocuments).values({
      claimId, kind: 'investigation_reports', source: 'lab_report', title: `Lab report ${r.number}`, sourceId: labReportId, sha256: r.sha, contentType: 'application/pdf', uploadedByName: session.name,
    }).returning({ id: claimDocuments.id })
    await logAudit(session, 'rcm: attached lab report', claim.patientId, `claim=${claimId} document=${row.id} lab_report=${labReportId}`, tx)
    return rcmOk({ documentId: row.id })
  })
}

/** Records that a required document is waived for this claim (the reason stays on the row, never in the audit). */
export async function waiveClaimDocument(claimId: number, kind: ClaimDocumentKind, reason: string, session: Session): Promise<RcmWriteResult<{ documentId: number }>> {
  return withOpenClaim(claimId, async (tx, claim) => {
    const [row] = await tx.insert(claimDocuments).values({ claimId, kind, source: 'waiver', title: 'Waived', waiverReason: reason, uploadedByName: session.name })
      .returning({ id: claimDocuments.id })
    await logAudit(session, 'rcm: waived claim document', claim.patientId, `claim=${claimId} kind=${kind}`, tx)
    return rcmOk({ documentId: row.id })
  })
}

/** Supersedes a live document (rows are never deleted). */
export async function removeClaimDocument(claimId: number, documentId: number, session: Session): Promise<RcmWriteResult<null>> {
  return withOpenClaim(claimId, async (tx, claim) => {
    const [doc] = await tx.select({ id: claimDocuments.id, supersededAt: claimDocuments.supersededAt }).from(claimDocuments)
      .where(and(eq(claimDocuments.id, documentId), eq(claimDocuments.claimId, claimId))).for('update')
    if (!doc || doc.supersededAt !== null) return rcmFail('document_not_found')
    await tx.update(claimDocuments).set({ supersededAt: new Date(), supersededByName: session.name }).where(eq(claimDocuments.id, documentId))
    await logAudit(session, 'rcm: removed claim document', claim.patientId, `claim=${claimId} document=${documentId}`, tx)
    return rcmOk(null)
  })
}

/** Server-side only: the stored bytes of a document (an upload, or the source of a system document). */
export async function getClaimDocumentBlob(documentId: number): Promise<{ url: string; claimId: number; patientId: string; contentType: string; title: string } | null> {
  const db = getDb()
  const [d] = await db.select({ claimId: claimDocuments.claimId, patientId: claims.patientId, source: claimDocuments.source, sourceId: claimDocuments.sourceId, url: claimDocuments.blobUrl, contentType: claimDocuments.contentType, title: claimDocuments.title })
    .from(claimDocuments).innerJoin(claims, eq(claims.id, claimDocuments.claimId)).where(eq(claimDocuments.id, documentId)).limit(1)
  if (!d) return null
  const base = { claimId: d.claimId, patientId: d.patientId, title: d.title }
  if (d.source === 'upload' && d.url) return { ...base, url: d.url, contentType: d.contentType ?? 'application/octet-stream' }
  if (d.sourceId === null) return null
  if (d.source === 'lab_report') {
    const [r] = await db.select({ url: labReports.blobUrl, patientId: labReports.patientId }).from(labReports).where(eq(labReports.id, d.sourceId)).limit(1)
    return r && r.patientId === d.patientId ? { ...base, url: r.url, contentType: 'application/pdf' } : null
  }
  if (d.source === 'preauth_letter') {
    const [r] = await db.select({ url: preauthDocuments.blobUrl, contentType: preauthDocuments.contentType }).from(preauthDocuments).where(eq(preauthDocuments.id, d.sourceId)).limit(1)
    return r ? { ...base, url: r.url, contentType: r.contentType } : null
  }
  if (d.source === 'policy_card') {
    const [r] = await db.select({ url: patientPolicies.cardFrontBlobUrl, patientId: patientPolicies.patientId }).from(patientPolicies).where(eq(patientPolicies.id, d.sourceId)).limit(1)
    return r?.url && r.patientId === d.patientId ? { ...base, url: r.url, contentType: d.contentType ?? 'image/jpeg' } : null
  }
  return null
}
