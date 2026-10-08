// SP7 (ruling 3): claim submission versions — "two copies". Every outbound package freezes an
// immutable canonical snapshot with its SHA-256; the RCM copy (retained, ending with the hash) and
// the insurer copy are rendered from that one snapshot and stored privately; the dispatch is
// recorded through the ClaimGateway. Side effects that can fail (render, blob put) happen before
// the transaction, which rebuilds the snapshot and refuses with `stale` if anything changed.
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { get } from '@vercel/blob'
import { getDb } from '@/db/client'
import {
  admissions, claimDispatches, claimDocuments, claimEvents, claimInvoices, claimSubmissions, claims, codeSystems, codes, departments, diagnoses,
  encounterProcedures, encounters, invoiceLines, invoices, preauths, providers, rcmQueries, rcmQueryResponses,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { daysBetweenIso } from '@/lib/rcm/sla'
import { istDateOf } from '@/lib/india-time'
import { putPrivateBlob } from '@/lib/blob-store'
import type { SubmissionChannel, SubmissionKind } from '@/lib/rcm/constants'
import { nextClaimStatus, type ClaimStatus } from '@/lib/rcm/claim-status'
import { renderClaimCopyPdf } from '@/lib/rcm/claim-pdf'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import { getClaimGateway, type ClaimGateway } from '@/lib/rcm/gateway'
import { sha256Hex, snapshotSha256 } from '@/lib/rcm/hash'
import type { checkClaimReadiness, ReadinessItem } from '@/lib/rcm/readiness'
import {
  buildClaimSnapshot, codingFingerprintSource, type ClaimSnapshot, type SnapshotDiagnosis, type SnapshotDocument, type SnapshotItem, type SnapshotProcedure,
} from '@/lib/rcm/snapshot'
import type { ClaimSubmitRequest } from '@/lib/rcm/validation'
// SP8
import { readNhcxConfig } from '@/lib/integrations/config'
import { NHCX_BUILD_ERROR_COPY } from '@/lib/fhir/nhcx/resources'
import { recipientCodeFor, resolveNhcxClaimGateway } from '@/lib/nhcx/claim-gateway'
import { defaultSchedule, dispatchExchange, insertOutboundClaimExchange, senderCode } from './nhcx-exchanges'
import { lockPatientBilling } from './billing-lock'
import { episodeOf, loadClaimReadiness } from './claims'
import { getEncounterCodingGate } from './coding'
import { getDischargeSummaryData } from './discharge-summary'
import type { WriteExecutor } from './executor'
import { loadPolicyContext, loadRcmPatient, loadSnapshotHospital } from './rcm-context'

export function registrationOf(p: { council: 'nmc' | 'smc' | null; state: string | null; number: string | null }): string | null {
  if (!p.number) return null
  if (p.council === 'nmc') return `NMC ${p.number}`
  if (p.council === 'smc' && p.state) return `SMC ${p.state} ${p.number}`
  return null
}

/** The episode's live coded diagnoses and procedures, with the code-set version. */
async function loadCoding(executor: WriteExecutor, encounterId: number | null): Promise<{ dx: SnapshotDiagnosis[]; px: SnapshotProcedure[] }> {
  if (encounterId === null) return { dx: [], px: [] }
  const dxRows = await executor.select({
    kind: codeSystems.kind, code: codes.code, display: diagnoses.codeDisplay, fallback: codes.display, version: codeSystems.version, type: diagnoses.diagnosisType, sequence: diagnoses.sequence,
  }).from(diagnoses).innerJoin(codes, eq(codes.id, diagnoses.codeId)).innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(and(eq(diagnoses.encounterId, encounterId), eq(diagnoses.codingStatus, 'coded'), isNull(diagnoses.voidedAt)))
  const pxRows = await executor.select({
    kind: codeSystems.kind, code: codes.code, display: encounterProcedures.codeDisplay, fallback: codes.display, version: codeSystems.version, sequence: encounterProcedures.sequence, performedOn: encounterProcedures.performedOn,
  }).from(encounterProcedures).innerJoin(codes, eq(codes.id, encounterProcedures.codeId)).innerJoin(codeSystems, eq(codeSystems.id, codes.codeSystemId))
    .where(and(eq(encounterProcedures.encounterId, encounterId), eq(encounterProcedures.codingStatus, 'coded'), isNull(encounterProcedures.voidedAt)))
  return {
    dx: dxRows.map((r) => ({ kind: r.kind, code: r.code, display: r.display ?? r.fallback, version: r.version, sequence: r.sequence ?? 0, type: r.type ?? 'secondary' })),
    px: pxRows.map((r) => ({ kind: r.kind, code: r.code, display: r.display ?? r.fallback, version: r.version, sequence: r.sequence ?? 0, performedOn: r.performedOn })),
  }
}

/**
 * The snapshot the next version would freeze, its hash, the claim's row version and readiness.
 * Pure over the database state and `now` (so the transaction can rebuild and compare it).
 */
export async function buildClaimSnapshotFor(
  executor: WriteExecutor, claimId: number, kind: SubmissionKind, coverNote: string | null, now: Date,
): Promise<{ snapshot: ClaimSnapshot; sha256: string; rowVersion: number; readiness: ReturnType<typeof checkClaimReadiness> } | null> {
  const [claim] = await executor.select().from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!claim) return null
  const ref = claim.admissionId !== null ? { admissionId: claim.admissionId } : { encounterId: claim.encounterId! }
  const [episode, ctx, patient, hospital, readiness] = await Promise.all([
    episodeOf(executor, ref), loadPolicyContext(executor, claim.policyId), loadRcmPatient(executor, claim.patientId), loadSnapshotHospital(executor), loadClaimReadiness(executor, claimId),
  ])
  if (!episode || !ctx || !patient || !readiness) return null

  // Attending doctor and department: the admission's attending, else the visit's provider.
  let providerId: number | null = null
  let departmentId: number | null = null
  if (claim.admissionId !== null) {
    const [a] = await executor.select({ providerId: admissions.attendingProviderId }).from(admissions).where(eq(admissions.id, claim.admissionId)).limit(1)
    providerId = a?.providerId ?? null
  } else {
    const [e] = await executor.select({ providerId: encounters.providerId, departmentId: encounters.departmentId }).from(encounters).where(eq(encounters.id, claim.encounterId!)).limit(1)
    providerId = e?.providerId ?? null
    departmentId = e?.departmentId ?? null
  }
  const [doctor] = providerId === null ? [] : await executor.select({
    name: providers.name, council: providers.registrationCouncil, state: providers.registrationStateCode, number: providers.registrationNumber, departmentId: providers.departmentId,
  }).from(providers).where(eq(providers.id, providerId)).limit(1)
  const deptId = departmentId ?? doctor?.departmentId ?? null
  const [dept] = deptId === null ? [] : await executor.select({ name: departments.name }).from(departments).where(eq(departments.id, deptId)).limit(1)

  const [preauth] = claim.preauthId === null ? [] : await executor.select({
    preauthNumber: preauths.preauthNumber, approvalReference: preauths.approvalReference, approvedPaise: preauths.approvedPaise, validUntil: preauths.validUntil,
  }).from(preauths).where(eq(preauths.id, claim.preauthId)).limit(1)

  const { dx, px } = await loadCoding(executor, episode.codingEncounterId)

  const linked = await executor.select({ id: invoices.id, number: invoices.invoiceNumber, date: invoices.invoiceDate, total: invoices.totalPaise, claimed: claimInvoices.claimedPaise })
    .from(claimInvoices).innerJoin(invoices, eq(invoices.id, claimInvoices.invoiceId)).where(eq(claimInvoices.claimId, claimId)).orderBy(asc(invoices.invoiceDate), asc(invoices.id))
  const lines = linked.length === 0 ? [] : await executor.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, linked.map((l) => l.id))).orderBy(asc(invoiceLines.invoiceId), asc(invoiceLines.lineNo))
  const numberOf = new Map(linked.map((l) => [l.id, l.number ?? `Invoice ${l.id}`]))
  const items: Omit<SnapshotItem, 'sequence'>[] = lines.map((l) => ({
    invoiceNumber: numberOf.get(l.invoiceId)!, lineNo: l.lineNo, itemCode: l.itemCode, itemName: l.itemName, hsnSac: l.hsnSac, serviceDate: l.serviceDate,
    quantity: l.quantity, unitPricePaise: l.unitPricePaise, taxablePaise: l.taxablePaise, taxPaise: l.cgstPaise + l.sgstPaise + l.igstPaise, totalPaise: l.totalPaise,
  }))

  const docs = await executor.select({ kind: claimDocuments.kind, source: claimDocuments.source, title: claimDocuments.title, contentType: claimDocuments.contentType, sha256: claimDocuments.sha256 })
    .from(claimDocuments).where(and(eq(claimDocuments.claimId, claimId), isNull(claimDocuments.supersededAt))).orderBy(asc(claimDocuments.id))
  const documents: SnapshotDocument[] = docs.map((d) => ({ kind: d.kind, source: d.source, title: d.title, contentType: d.contentType, sha256: d.sha256, waived: d.source === 'waiver' }))

  // The discharge summary's clinical sections travel inside the claim (ruling 1: read-only coded
  // clinical content inside a claim), so they are loaded with a clinical viewer role here.
  const discharge = claim.admissionId !== null ? await getDischargeSummaryData(claim.admissionId, { now, viewerRole: 'admin' }) : null

  const snapshot = buildClaimSnapshot({
    claim: { claimNumber: claim.claimNumber, claimType: claim.claimType, version: claim.currentVersion + 1, kind, preparedAt: now.toISOString() },
    hospital, patient: patient.patient, includeAbha: ctx.billingProfile?.requiresAbha ?? false, patientAbhaNumber: patient.abhaNumber,
    policy: ctx.policy,
    episode: {
      admissionId: episode.admissionId, encounterId: episode.encounterId, startDate: episode.startDate, endDate: episode.endDate,
      lengthOfStayDays: episode.admissionId !== null && episode.endDate ? daysBetweenIso(episode.startDate, episode.endDate) : null,
      attendingName: doctor?.name ?? null, attendingRegistration: doctor ? registrationOf(doctor) : null, departmentName: dept?.name ?? null,
    },
    preauth: preauth ?? null,
    diagnoses: dx, procedures: px, discharge,
    invoices: linked.map((l) => ({ number: l.number ?? `Invoice ${l.id}`, date: l.date ?? '', totalPaise: l.total ?? 0, claimedPaise: l.claimed })),
    items, documents, coverNote,
    codingFingerprint: sha256Hex(codingFingerprintSource(dx, px)),
  })
  return { snapshot, sha256: snapshotSha256(snapshot), rowVersion: claim.rowVersion, readiness: readiness.result }
}

/** Coding drift (ruling 10): a submission exists and the coding changed since, or it is no longer finalised. */
export async function claimCodingDrift(executor: WriteExecutor, claimId: number): Promise<{ drifted: boolean; codingFinalised: boolean }> {
  const [claim] = await executor.select({ admissionId: claims.admissionId, encounterId: claims.encounterId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!claim) return { drifted: false, codingFinalised: false }
  const episode = await episodeOf(executor, claim.admissionId !== null ? { admissionId: claim.admissionId } : { encounterId: claim.encounterId! })
  const gate = episode?.codingEncounterId ? await getEncounterCodingGate(episode.codingEncounterId, executor) : null
  const codingFinalised = gate?.finalised ?? false
  const [latest] = await executor.select({ snapshot: claimSubmissions.snapshot }).from(claimSubmissions).where(eq(claimSubmissions.claimId, claimId)).orderBy(desc(claimSubmissions.version)).limit(1)
  if (!latest) return { drifted: false, codingFinalised }
  const { dx, px } = await loadCoding(executor, episode?.codingEncounterId ?? null)
  const current = sha256Hex(codingFingerprintSource(dx, px))
  return { drifted: !codingFinalised || latest.snapshot.codingFingerprint !== current, codingFinalised }
}

// ---- submission ---------------------------------------------------------------------------------

export interface SubmissionDeps {
  render: typeof renderClaimCopyPdf
  putBlob: (path: string, bytes: Uint8Array) => Promise<{ url: string }>
  gateway: (channel: SubmissionChannel) => ClaimGateway
  // SP8: the NHCX outbox row is dispatched after commit through `schedule`.
  schedule?: (fn: () => Promise<unknown>) => void
  dispatch?: (exchangeId: number) => Promise<unknown>
}

export const defaultSubmissionDeps: SubmissionDeps = {
  render: renderClaimCopyPdf,
  putBlob: (path, bytes) => putPrivateBlob(path, bytes, 'application/pdf'),
  gateway: (channel) => getClaimGateway(channel, { nhcx: resolveNhcxClaimGateway() }), // SP8
}

const KIND_OF: Record<ClaimSubmitRequest['action'], (r: ClaimSubmitRequest) => SubmissionKind> = {
  submit: () => 'initial',
  respond_query: () => 'query_response',
  appeal: (r) => (r.action === 'appeal' ? r.appealKind : 'appeal'),
}
const coverNoteOf = (r: ClaimSubmitRequest): string | null =>
  r.action === 'submit' ? r.coverNote ?? null : r.action === 'respond_query' ? r.body : r.grounds

export async function submitClaimVersion(
  claimId: number, req: ClaimSubmitRequest, session: Session, deps: SubmissionDeps = defaultSubmissionDeps, now: Date = new Date(),
): Promise<RcmWriteResult<{ version: number; submissionId: number; status: ClaimStatus; warnings: ReadinessItem[] }>> {
  const db = getDb()
  const [pre] = await db.select({ status: claims.status, patientId: claims.patientId, settled: claims.settledPaise }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!pre) return rcmFail('claim_not_found')
  if (nextClaimStatus(pre.status, req.action, { hasSettlement: pre.settled > 0 }) === null) return rcmFail('invalid_transition')
  const gateway = deps.gateway(req.channel)
  if (!gateway.status().configured) return rcmFail('gateway_not_configured')

  // 1. Before the transaction: snapshot, readiness, both copies rendered, stored and hashed.
  const kind = KIND_OF[req.action](req)
  const coverNote = coverNoteOf(req)
  const built = await buildClaimSnapshotFor(db, claimId, kind, coverNote, now)
  if (!built) return rcmFail('claim_not_found')
  if (!built.readiness.ready) return { ok: false, error: 'not_ready', items: built.readiness.items }
  const version = built.snapshot.claim.version
  const rcmBytes = await deps.render(built.snapshot, 'rcm', { snapshotSha256: built.sha256 })
  const insurerBytes = await deps.render(built.snapshot, 'insurer')
  const rcmPath = `rcm/claims/${claimId}/v${version}/rcm-${randomUUID()}.pdf`
  const insurerPath = `rcm/claims/${claimId}/v${version}/insurer-${randomUUID()}.pdf`
  const [rcmBlob, insurerBlob] = [await deps.putBlob(rcmPath, rcmBytes), await deps.putBlob(insurerPath, insurerBytes)]
  const rcmCopySha256 = sha256Hex(rcmBytes)
  const insurerCopySha256 = sha256Hex(insurerBytes)
  const orphaned = () => { console.warn(`[rcm] orphaned claim copy ${rcmPath}`); console.warn(`[rcm] orphaned claim copy ${insurerPath}`) }

  let outboxId: number | null = null // SP8
  try {
    const result = await db.transaction(async (tx) => {
      // 2. Lock, then rebuild with the same `now` and compare.
      await lockPatientBilling(tx, pre.patientId)
      const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId)).for('update')
      if (!claim) return rcmFail('claim_not_found')
      const again = await buildClaimSnapshotFor(tx, claimId, kind, coverNote, now)
      if (!again || again.rowVersion !== built.rowVersion || again.sha256 !== built.sha256) return rcmFail('stale')
      const to = nextClaimStatus(claim.status, req.action, { hasSettlement: claim.settledPaise > 0 })
      if (to === null) return rcmFail('invalid_transition')
      let queryId: number | null = null
      if (req.action === 'respond_query') {
        const [q] = await tx.select().from(rcmQueries).where(eq(rcmQueries.id, req.queryId)).for('update')
        if (!q || q.claimId !== claimId) return rcmFail('query_not_found')
        if (q.status !== 'open') return rcmFail('query_closed')
        queryId = q.id
      }
      // 3. The gateway records (manual) or sends (SP8 NHCX) the package.
      const sent = await gateway.submit({ claimNumber: claim.claimNumber, version, kind, snapshot: again.snapshot, insurerCopySha256, trackingReference: req.trackingReference ?? null })
      if (!sent.ok) return sent.error === 'not_configured' ? rcmFail('gateway_not_configured') : rcmFail('invalid_transition', sent.message)
      // 4. The immutable rows.
      const [submission] = await tx.insert(claimSubmissions).values({
        claimId, version, kind, snapshot: again.snapshot, snapshotSha256: again.sha256, rcmCopyBlobUrl: rcmBlob.url, rcmCopySha256,
        insurerCopyBlobUrl: insurerBlob.url, insurerCopySha256, createdByName: session.name, createdByUserId: session.userId, createdAt: now,
      }).returning({ id: claimSubmissions.id })
      // SP8: an NHCX send is an outbox row in this transaction; the dispatch's tracking reference is its correlation id.
      let trackingReference = sent.trackingReference
      if (sent.transport === 'nhcx') {
        const recipientCode = recipientCodeFor(again.snapshot.policy)
        if (!recipientCode) return rcmFail('invalid_transition', NHCX_BUILD_ERROR_COPY.payer_not_on_nhcx)
        const ex = await insertOutboundClaimExchange(tx, {
          claimId, claimSubmissionId: submission.id, patientId: claim.patientId, policyId: claim.policyId, correlationId: sent.trackingReference ?? randomUUID(),
          kind, recipientCode, senderCode: senderCode(), isMock: readNhcxConfig().state === 'mock', bodySha256: again.sha256, now,
        })
        trackingReference = ex.correlationId
        outboxId = ex.exchangeId
      }
      // end SP8
      await tx.insert(claimDispatches).values({
        submissionId: submission.id, channel: req.channel, transport: sent.transport, trackingReference,
        dispatchedOn: istDateOf(now), dispatchedByName: session.name, dispatchedAt: now,
      })
      await tx.insert(claimEvents).values({ claimId, action: req.action, fromStatus: claim.status, toStatus: to, submissionId: submission.id, byName: session.name, byUserId: session.userId, at: now })
      if (req.action === 'respond_query' && queryId !== null) {
        await tx.insert(rcmQueryResponses).values({ queryId, body: req.body, respondedOn: req.respondedOn, submissionId: submission.id, byName: session.name, at: now })
        await tx.update(rcmQueries).set({ status: 'answered', answeredAt: now }).where(eq(rcmQueries.id, queryId))
      }
      // 5. The claim moves on.
      await tx.update(claims).set({
        status: to, currentVersion: version, rowVersion: claim.rowVersion + 1, firstSubmittedAt: claim.firstSubmittedAt ?? now, lastStatusAt: now, updatedAt: now,
      }).where(eq(claims.id, claimId))
      // 6. Audit: ids, version, kind, channel and the first 12 hex of the snapshot hash.
      await logAudit(session, 'rcm: submitted claim version', claim.patientId, `claim=${claimId} version=${version} kind=${kind} channel=${req.channel} sha=${again.sha256.slice(0, 12)}`, tx)
      return rcmOk({ version, submissionId: submission.id, status: to, warnings: again.readiness.items.filter((i) => i.severity === 'warn') })
    })
    if (!result.ok) orphaned()
    // SP8: nothing is sent inside the transaction; the committed outbox row goes out now.
    if (result.ok && outboxId !== null) {
      const id = outboxId
      ;(deps.schedule ?? defaultSchedule)(() => (deps.dispatch ?? dispatchExchange)(id))
    }
    return result
  } catch (err) {
    orphaned()
    if (isUniqueViolation(err, 'claim_submissions_claim_version_unique')) return rcmFail('stale')
    throw err
  }
}

/** Records the insurer's own claim reference for a dispatch, once. */
export async function acknowledgeDispatch(dispatchId: number, input: { insurerReference: string; acknowledgedOn: string }, session: Session): Promise<RcmWriteResult<null>> {
  const [found] = await getDb().select({ claimId: claimSubmissions.claimId, patientId: claims.patientId }).from(claimDispatches)
    .innerJoin(claimSubmissions, eq(claimSubmissions.id, claimDispatches.submissionId)).innerJoin(claims, eq(claims.id, claimSubmissions.claimId))
    .where(eq(claimDispatches.id, dispatchId)).limit(1)
  if (!found) return rcmFail('dispatch_not_found')
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, found.patientId)
    const [claim] = await tx.select({ ref: claims.insurerClaimReference }).from(claims).where(eq(claims.id, found.claimId)).for('update')
    const [d] = await tx.select({ ref: claimDispatches.insurerReference }).from(claimDispatches).where(eq(claimDispatches.id, dispatchId)).for('update')
    if (!d) return rcmFail('dispatch_not_found')
    if (d.ref !== null) return rcmFail('already_acknowledged')
    await tx.update(claimDispatches).set({ insurerReference: input.insurerReference, acknowledgedOn: input.acknowledgedOn, acknowledgedByName: session.name }).where(eq(claimDispatches.id, dispatchId))
    if (claim && claim.ref === null) await tx.update(claims).set({ insurerClaimReference: input.insurerReference, updatedAt: new Date() }).where(eq(claims.id, found.claimId))
    await logAudit(session, 'rcm: recorded insurer acknowledgement', found.patientId, `claim=${found.claimId} dispatch=${dispatchId}`, tx)
    return rcmOk(null)
  })
}

/** A draft copy of the next version (nothing stored). Audited. */
export async function renderDraftCopy(claimId: number, session: Session, now: Date = new Date()): Promise<{ bytes: Uint8Array; claimNumber: string } | null> {
  const built = await buildClaimSnapshotFor(getDb(), claimId, 'initial', null, now)
  if (!built) return null
  const bytes = await renderClaimCopyPdf(built.snapshot, 'draft')
  const [c] = await getDb().select({ patientId: claims.patientId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  await logAudit(session, 'rcm: previewed claim copy', c?.patientId ?? null, `claim=${claimId}`)
  return { bytes, claimNumber: built.snapshot.claim.claimNumber }
}

/** Server-side only: a stored copy's blob. */
export async function getSubmissionCopy(submissionId: number, copy: 'rcm' | 'insurer'): Promise<{ url: string; claimId: number; claimNumber: string; version: number; patientId: string } | null> {
  const [r] = await getDb().select({ rcm: claimSubmissions.rcmCopyBlobUrl, insurer: claimSubmissions.insurerCopyBlobUrl, claimId: claims.id, claimNumber: claims.claimNumber, version: claimSubmissions.version, patientId: claims.patientId })
    .from(claimSubmissions).innerJoin(claims, eq(claims.id, claimSubmissions.claimId)).where(eq(claimSubmissions.id, submissionId)).limit(1)
  if (!r) return null
  return { url: copy === 'rcm' ? r.rcm : r.insurer, claimId: r.claimId, claimNumber: r.claimNumber, version: r.version, patientId: r.patientId }
}

async function fetchPrivateBytes(url: string): Promise<Uint8Array | null> {
  try {
    const blob = await get(url, { access: 'private' })
    if (!blob || blob.statusCode !== 200 || !blob.stream) return null
    return new Uint8Array(await new Response(blob.stream).arrayBuffer())
  } catch (err) {
    console.warn(`[rcm] copy read failed (${err instanceof Error ? err.name : 'UnknownError'})`)
    return null
  }
}

/** Recomputes the snapshot hash and both copy hashes against the stored ones (ruling 3). */
export async function verifySubmission(
  submissionId: number, deps: { fetchBytes(url: string): Promise<Uint8Array | null> } = { fetchBytes: fetchPrivateBytes },
): Promise<{ snapshotOk: boolean; rcmCopyOk: boolean; insurerCopyOk: boolean; claimId: number; patientId: string } | null> {
  const [r] = await getDb().select({ s: claimSubmissions, patientId: claims.patientId }).from(claimSubmissions).innerJoin(claims, eq(claims.id, claimSubmissions.claimId))
    .where(eq(claimSubmissions.id, submissionId)).limit(1)
  if (!r) return null
  const [rcm, insurer] = await Promise.all([deps.fetchBytes(r.s.rcmCopyBlobUrl), deps.fetchBytes(r.s.insurerCopyBlobUrl)])
  return {
    snapshotOk: snapshotSha256(r.s.snapshot) === r.s.snapshotSha256,
    rcmCopyOk: rcm !== null && sha256Hex(rcm) === r.s.rcmCopySha256,
    insurerCopyOk: insurer !== null && sha256Hex(insurer) === r.s.insurerCopySha256,
    claimId: r.s.claimId,
    patientId: r.patientId,
  }
}
