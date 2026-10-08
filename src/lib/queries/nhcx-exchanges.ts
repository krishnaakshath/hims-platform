import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { after } from 'next/server'
import { getDb } from '@/db/client'
import { claimDocuments, claimEvents, claims, claimSubmissions, nhcxExchanges, nhcxInboundCalls, preauthEvents, preauths, providers, type NhcxExchangeRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { getPrivateBlobBytes } from '@/lib/blob-store'
import { readAbdmConfig, readNhcxConfig, type AbdmConfig, type ConfigResult, type NhcxConfig } from '@/lib/integrations/config'
import { openPayload, sealPayload } from '@/lib/integrations/payload-vault'
import { safeLog } from '@/lib/integrations/safe-log'
import { logGatewayEvent } from '@/lib/integrations/system-audit'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import type { SubmissionKind } from '@/lib/rcm/constants'
import type { ClaimSnapshot, PayerRef, PreauthSnapshot } from '@/lib/rcm/snapshot'
import { buildClaimBundle, buildPreauthBundle, claimBundleProblems, type ClaimBundleContext } from '@/lib/fhir/nhcx/claim'
import { NHCX_BUILD_ERROR_COPY, type NhcxBuildErrorCode } from '@/lib/fhir/nhcx/resources'
import { buildCommunicationResponseTaskBundle, buildStatusTaskBundle, parseCommunicationRequestTaskBundle } from '@/lib/fhir/nhcx/responses'
import { validateNhcxBundle, type BundleProfile } from '@/lib/fhir/nhcx/validate'
import type { FhirBundle } from '@/lib/fhir/nhcx/types'
import { recipientCodeFor } from '@/lib/nhcx/claim-gateway'
import { nextAttemptAt, postSealed, type PostOutcome } from '@/lib/nhcx/client'
import type { NhcxAction, NhcxEntityType, NhcxResponseSummary } from '@/lib/nhcx/constants'
import { buildRequestHeaders } from '@/lib/nhcx/headers'
import { sealHcxPayload } from '@/lib/nhcx/jwe'
import { CERT_REFRESH_ERROR_CODES, getRecipientCert, invalidateRecipientCert, type CertResult } from '@/lib/nhcx/participants'
import { mockTransport, type MockTransport } from '@/lib/nhcx/mock-transport'
import { lockPatientBilling } from './charge-capture'
import { expireShares } from './abdm-profile-shares'
import { registrationOf } from './claim-submissions'
import type { WriteExecutor } from './executor'

// SP8 NHCX exchanges: the transactional outbox and its dispatcher (Task 11).
// - An outbound exchange row is written in the same transaction as the thing
//   it sends (a claim version, a pre-auth request, an eligibility check), in
//   state pending_send. Nothing is sent inside a transaction.
// - dispatchExchange (after commit, and from the cron sweep) leases the row
//   with FOR UPDATE SKIP LOCKED, builds the FHIR from the immutable snapshot,
//   seals it to the recipient, keeps the sealed JWE (vault) until NHCX accepts
//   it, and POSTs. A retry resends the identical JWE: same api_call_id, same
//   correlation id (ruling 5).
// - NHCX results never change claim status or money (ruling 6): a refusal is a
//   claim `note` event by "NHCX gateway"; responses arrive on the callback.

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
export const LEASE_MS = 5 * 60 * 1000
export const GATEWAY_NAME = 'NHCX gateway'

/** Runs `fn` after the response when inside a request, else right away (scripts, cron, tests). */
export function defaultSchedule(fn: () => Promise<unknown>): void {
  try {
    after(fn)
  } catch {
    void fn().catch(() => undefined)
  }
}

/** A claim `note` event by "NHCX gateway" (status and money unchanged), with the SP7 row-version bump. Inside the caller's transaction. */
export async function addGatewayClaimNote(tx: Tx, claimId: number, note: string, now: Date = new Date()): Promise<void> {
  const [found] = await tx.select({ patientId: claims.patientId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!found) return
  await lockPatientBilling(tx, found.patientId)
  const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId)).for('update')
  if (!claim) return
  await tx.insert(claimEvents).values({ claimId, action: 'note', fromStatus: claim.status, toStatus: claim.status, note, byName: GATEWAY_NAME, byUserId: null, at: now })
  await tx.update(claims).set({ rowVersion: claim.rowVersion + 1, lastStatusAt: now, updatedAt: now }).where(eq(claims.id, claimId))
}

// ---- outbox inserts ---------------------------------------------------------------------------

export async function insertOutboundClaimExchange(tx: WriteExecutor, i: {
  claimId: number; claimSubmissionId: number; patientId: string; policyId: number | null; correlationId: string; kind: SubmissionKind
  recipientCode: string; senderCode: string; isMock: boolean; bodySha256: string; now?: Date
}): Promise<{ exchangeId: number; correlationId: string; action: NhcxAction }> {
  const now = i.now ?? new Date()
  let action: NhcxAction = 'claim/submit'
  let entityType: NhcxEntityType = 'claim'
  let correlationId = i.correlationId
  let related: number | null = null
  if (i.kind === 'query_response') {
    // The reply goes on the insurer's communication correlation (ruling 11), when the query came through NHCX.
    const [q] = await tx.select({ id: nhcxExchanges.id, correlationId: nhcxExchanges.correlationId }).from(nhcxExchanges)
      .where(and(eq(nhcxExchanges.claimId, i.claimId), eq(nhcxExchanges.direction, 'inbound'), eq(nhcxExchanges.entityType, 'communication')))
      .orderBy(desc(nhcxExchanges.id)).limit(1)
    if (q) { action = 'communication/on_request'; entityType = 'communication'; correlationId = q.correlationId; related = q.id }
  }
  const [row] = await tx.insert(nhcxExchanges).values({
    entityType, direction: 'outbound', action, correlationId, apiCallId: randomUUID(), senderCode: i.senderCode, recipientCode: i.recipientCode,
    state: 'pending_send', patientId: i.patientId, policyId: i.policyId, claimId: i.claimId, claimSubmissionId: i.claimSubmissionId,
    relatedExchangeId: related, nextAttemptAt: now, bodySha256: i.bodySha256, isMock: i.isMock, createdAt: now, updatedAt: now,
  }).returning({ id: nhcxExchanges.id })
  return { exchangeId: row.id, correlationId, action }
}

/** Our participant code, or a placeholder for the labelled mock. */
export function senderCode(): string {
  const cfg = readNhcxConfig()
  return cfg.state === 'configured' ? cfg.config.participantCode : 'sandbox-mock@sbx'
}

async function preauthPractitioner(executor: WriteExecutor, preauthId: number): Promise<{ name: string; registrationNumber: string | null }> {
  const [p] = await executor.select({ name: providers.name, council: providers.registrationCouncil, state: providers.registrationStateCode, number: providers.registrationNumber })
    .from(preauths).innerJoin(providers, eq(providers.id, preauths.treatingProviderId)).where(eq(preauths.id, preauthId)).limit(1)
  return p ? { name: p.name, registrationNumber: registrationOf(p) } : { name: 'Treating doctor', registrationNumber: null }
}

export interface PreauthSendDeps { now?: () => Date; schedule?: (fn: () => Promise<unknown>) => void; dispatch?: (id: number) => Promise<unknown> }

/** Queues the latest pre-auth request (or enhancement request) for NHCX. */
export async function createPreauthExchange(preauthId: number, session: Session, deps: PreauthSendDeps = {}): Promise<RcmWriteResult<{ exchangeId: number; correlationId: string }>> {
  const cfg = readNhcxConfig()
  if (cfg.state === 'not_configured') return rcmFail('gateway_not_configured', 'NHCX is not configured')
  const now = (deps.now ?? (() => new Date()))()
  const db = getDb()
  const [pre] = await db.select({ patientId: preauths.patientId }).from(preauths).where(eq(preauths.id, preauthId)).limit(1)
  if (!pre) return rcmFail('preauth_not_found')
  const practitioner = await preauthPractitioner(db, preauthId)
  let result: RcmWriteResult<{ exchangeId: number; correlationId: string }>
  try {
    result = await db.transaction(async (tx) => {
      await lockPatientBilling(tx, pre.patientId)
      const [p] = await tx.select().from(preauths).where(eq(preauths.id, preauthId)).for('update')
      if (!p) return rcmFail('preauth_not_found')
      if (p.status !== 'requested' && p.status !== 'enhancement_requested') return rcmFail('invalid_transition')
      const [ev] = await tx.select().from(preauthEvents)
        .where(and(eq(preauthEvents.preauthId, preauthId), inArray(preauthEvents.action, ['request', 'request_enhancement'])))
        .orderBy(desc(preauthEvents.id)).limit(1)
      if (!ev?.snapshot) return rcmFail('invalid_transition')
      const [dupe] = await tx.select({ id: nhcxExchanges.id }).from(nhcxExchanges)
        .where(and(eq(nhcxExchanges.preauthEventId, ev.id), eq(nhcxExchanges.direction, 'outbound'))).limit(1)
      if (dupe) return rcmFail('duplicate_reference', 'Already sent through NHCX')
      const snap = ev.snapshot
      const recipient = recipientCodeFor(snap.policy)
      if (!recipient) return rcmFail('not_ready', NHCX_BUILD_ERROR_COPY.payer_not_on_nhcx)
      const ctx: ClaimBundleContext = { created: now, practitioner, priorPreauthRef: p.approvalReference }
      const problems = claimBundleProblems(snap, ctx)
      if (problems.length > 0) return rcmFail('not_ready', NHCX_BUILD_ERROR_COPY[problems[0]])
      if (validateNhcxBundle(buildPreauthBundle(snap, ctx), 'ClaimBundle').length > 0) return rcmFail('not_ready', 'The pre-authorisation could not be prepared for NHCX')
      const correlationId = randomUUID()
      const [row] = await tx.insert(nhcxExchanges).values({
        entityType: 'preauth', direction: 'outbound', action: 'preauth/submit', correlationId, apiCallId: randomUUID(), senderCode: senderCode(),
        recipientCode: recipient, state: 'pending_send', patientId: p.patientId, policyId: p.policyId, preauthId, preauthEventId: ev.id,
        nextAttemptAt: now, bodySha256: ev.snapshotSha256 ?? sha256(JSON.stringify(snap)), isMock: cfg.state === 'mock', createdAt: now, updatedAt: now,
      }).returning({ id: nhcxExchanges.id })
      await logAudit(session, 'nhcx: queued pre-authorisation', p.patientId, `preauth=${preauthId} exchange=${row.id} corr=${correlationId.slice(0, 8)}`, tx)
      return rcmOk({ exchangeId: row.id, correlationId })
    })
  } catch (e) {
    if (isUniqueViolation(e)) return rcmFail('duplicate_reference', 'Already sent through NHCX')
    throw e
  }
  if (result.ok) {
    const id = result.value.exchangeId
    ;(deps.schedule ?? defaultSchedule)(() => (deps.dispatch ?? dispatchExchange)(id))
  }
  return result
}

// ---- dispatch -------------------------------------------------------------------------------

export interface DispatchDeps {
  now: () => Date
  config: () => { nhcx: ConfigResult<NhcxConfig>; abdm: ConfigResult<AbdmConfig> }
  client: (cfg: NhcxConfig, abdm: AbdmConfig, action: NhcxAction, jwe: string) => Promise<PostOutcome>
  certs: (cfg: NhcxConfig, abdm: AbdmConfig, code: string) => Promise<CertResult>
  invalidateCert: (code: string) => Promise<void>
  blobs: (url: string) => Promise<Uint8Array | null>
  mock: MockTransport
}

export const defaultDispatchDeps = (): DispatchDeps => ({
  now: () => new Date(),
  config: () => ({ nhcx: readNhcxConfig(), abdm: readAbdmConfig() }),
  client: (cfg, abdm, action, jwe) => postSealed(cfg, abdm, action, jwe),
  certs: (cfg, abdm, code) => getRecipientCert(cfg, abdm, code),
  invalidateCert: (code) => invalidateRecipientCert(code),
  blobs: getPrivateBlobBytes,
  mock: mockTransport,
})

type Built = { ok: true; fhir: FhirBundle; profile: BundleProfile; abhaId: string | null } | { ok: false; code: NhcxBuildErrorCode | 'snapshot_missing' | 'build_invalid' }

const payerOf = (policy: { insurer: PayerRef; tpa: PayerRef | null }): PayerRef => (policy.tpa?.nhcxParticipantCode ? policy.tpa : policy.insurer)

async function claimAttachments(claimId: number, snap: ClaimSnapshot, maxBytes: number, blobs: DispatchDeps['blobs'], kinds?: string[]): Promise<Map<string, { contentType: string; dataBase64: string }> | 'too_large'> {
  const wanted = new Set(snap.documents.filter((d) => !d.waived && d.sha256 && (!kinds || kinds.includes(d.kind))).map((d) => d.sha256!))
  const out = new Map<string, { contentType: string; dataBase64: string }>()
  if (wanted.size === 0) return out
  const docs = await getDb().select({ sha256: claimDocuments.sha256, blobUrl: claimDocuments.blobUrl, contentType: claimDocuments.contentType, byteSize: claimDocuments.byteSize })
    .from(claimDocuments).where(and(eq(claimDocuments.claimId, claimId), isNull(claimDocuments.supersededAt)))
  const usable = docs.filter((d) => d.sha256 && wanted.has(d.sha256) && d.blobUrl)
  const total = usable.reduce((n, d) => n + (d.byteSize ?? 0), 0)
  if (total > maxBytes) return 'too_large'
  let read = 0
  for (const d of usable) {
    if (out.has(d.sha256!)) continue
    const bytes = await blobs(d.blobUrl!)
    if (!bytes || sha256(bytes) !== d.sha256) continue // a changed or missing file is not attached
    read += bytes.byteLength
    if (read > maxBytes) return 'too_large'
    out.set(d.sha256!, { contentType: d.contentType ?? 'application/octet-stream', dataBase64: Buffer.from(bytes).toString('base64') })
  }
  return out
}

async function buildOutbound(row: NhcxExchangeRow, cfg: NhcxConfig | null, deps: DispatchDeps, now: Date): Promise<Built> {
  const maxBytes = cfg?.maxAttachmentBytes ?? 10_000_000
  const db = getDb()
  if ((row.action === 'claim/submit' || row.action === 'communication/on_request') && row.claimSubmissionId) {
    const [sub] = await db.select({ snapshot: claimSubmissions.snapshot }).from(claimSubmissions).where(eq(claimSubmissions.id, row.claimSubmissionId)).limit(1)
    if (!sub) return { ok: false, code: 'snapshot_missing' }
    const snap = sub.snapshot
    const abhaId = snap.patient.abhaNumber
    if (row.action === 'claim/submit') {
      const atts = await claimAttachments(row.claimId!, snap, maxBytes, deps.blobs)
      if (atts === 'too_large') return { ok: false, code: 'attachments_too_large' }
      const ctx: ClaimBundleContext = { created: now, practitioner: { name: snap.episode.attendingName ?? 'Treating doctor', registrationNumber: snap.episode.attendingRegistration }, attachments: atts }
      const problems = claimBundleProblems(snap, ctx)
      if (problems.length > 0) return { ok: false, code: problems[0] }
      return { ok: true, fhir: buildClaimBundle(snap, ctx), profile: 'ClaimBundle', abhaId }
    }
    const [inbound] = row.relatedExchangeId
      ? await db.select({ payload: nhcxExchanges.payloadEncrypted }).from(nhcxExchanges).where(eq(nhcxExchanges.id, row.relatedExchangeId)).limit(1)
      : []
    if (!inbound?.payload) return { ok: false, code: 'snapshot_missing' }
    const requestBundle = JSON.parse(openPayload(inbound.payload)) as unknown
    const parsed = parseCommunicationRequestTaskBundle(requestBundle)
    const atts = await claimAttachments(row.claimId!, snap, maxBytes, deps.blobs, ['query_response'])
    if (atts === 'too_large') return { ok: false, code: 'attachments_too_large' }
    const docs = snap.documents.filter((d) => !d.waived && d.kind === 'query_response' && d.sha256 && atts.has(d.sha256))
    return {
      ok: true, profile: 'TaskBundle', abhaId,
      fhir: buildCommunicationResponseTaskBundle({
        request: { identifier: parsed.ok ? parsed.requestIdentifier ?? row.correlationId : row.correlationId, fullBundle: requestBundle },
        text: snap.coverNote ?? '',
        attachments: docs.map((d) => ({ contentType: atts.get(d.sha256!)!.contentType, title: d.title, dataBase64: atts.get(d.sha256!)!.dataBase64 })),
        created: now, hospital: snap.hospital, payer: payerOf(snap.policy),
      }),
    }
  }
  if (row.action === 'preauth/submit' && row.preauthEventId && row.preauthId) {
    const [ev] = await db.select({ snapshot: preauthEvents.snapshot }).from(preauthEvents).where(eq(preauthEvents.id, row.preauthEventId)).limit(1)
    const snap: PreauthSnapshot | null | undefined = ev?.snapshot
    if (!snap) return { ok: false, code: 'snapshot_missing' }
    const [p] = await db.select({ approvalReference: preauths.approvalReference }).from(preauths).where(eq(preauths.id, row.preauthId)).limit(1)
    const ctx: ClaimBundleContext = { created: now, practitioner: await preauthPractitioner(db, row.preauthId), priorPreauthRef: p?.approvalReference ?? null }
    const problems = claimBundleProblems(snap, ctx)
    if (problems.length > 0) return { ok: false, code: problems[0] }
    return { ok: true, fhir: buildPreauthBundle(snap, ctx), profile: 'ClaimBundle', abhaId: snap.patient.abhaNumber }
  }
  const extra = outboundBuilders[row.action as NhcxAction]
  if (extra) return extra(row, now)
  return { ok: false, code: 'snapshot_missing' }
}

/** Builders for further outbound actions (eligibility, payment acknowledgement), registered by their modules. */
export const outboundBuilders: Partial<Record<NhcxAction, (row: NhcxExchangeRow, now: Date) => Promise<Built>>> = {}
export type { Built as OutboundBuild }

async function lease(exchangeId: number, now: Date): Promise<NhcxExchangeRow | null> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(nhcxExchanges)
      .where(and(eq(nhcxExchanges.id, exchangeId), eq(nhcxExchanges.direction, 'outbound'), eq(nhcxExchanges.state, 'pending_send'),
        or(isNull(nhcxExchanges.nextAttemptAt), lte(nhcxExchanges.nextAttemptAt, now))))
      .for('update', { skipLocked: true })
    if (!row) return null
    if (row.attempts >= 10) return null
    const [leased] = await tx.update(nhcxExchanges).set({ attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + LEASE_MS), updatedAt: now })
      .where(eq(nhcxExchanges.id, exchangeId)).returning()
    return leased
  })
}

async function finish(row: NhcxExchangeRow, set: Partial<NhcxExchangeRow>, audit: { action: string; outcome: string }, claimNote: string | null, now: Date): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.update(nhcxExchanges).set({ ...set, updatedAt: now }).where(eq(nhcxExchanges.id, row.id))
    if (claimNote && row.claimId) await addGatewayClaimNote(tx, row.claimId, claimNote, now)
    await logGatewayEvent('NHCX gateway', audit.action, row.patientId, `exchange=${row.id} outcome=${audit.outcome} attempt=${row.attempts}`, tx)
  })
}

const refusalNote = (code: string | null) => `NHCX refused the submission (${code ?? 'no code'}); send it through another channel`

export type DispatchResult = 'sent' | 'retry' | 'failed' | 'skipped'

export async function dispatchExchange(exchangeId: number, partial: Partial<DispatchDeps> = {}): Promise<DispatchResult> {
  const deps = { ...defaultDispatchDeps(), ...partial }
  const now = deps.now()
  const { nhcx, abdm } = deps.config()
  const live = nhcx.state === 'configured' && abdm.state === 'configured'
  if (!live && nhcx.state !== 'mock') return 'skipped'

  const row = await lease(exchangeId, now)
  if (!row) return 'skipped'
  const log = (outcome: string) => safeLog('nhcx', { action: 'dispatch', exchangeId: row.id, outcome, attempt: row.attempts })

  if (row.isMock !== (nhcx.state === 'mock')) {
    // A mock row is never sent to the real NHCX, and a real row never to the mock.
    await finish(row, { state: 'send_failed', lastErrorCode: 'mode_mismatch', jweEncrypted: null, nextAttemptAt: null }, { action: 'nhcx: exchange send failed', outcome: 'mode_mismatch' }, null, now)
    log('mode_mismatch')
    return 'failed'
  }

  const failBuild = async (code: string) => {
    const copy = (NHCX_BUILD_ERROR_COPY as Record<string, string>)[code]
    await finish(row, { state: 'send_failed', lastErrorCode: code, jweEncrypted: null, nextAttemptAt: null }, { action: 'nhcx: exchange send failed', outcome: code },
      row.claimId ? (copy ? `NHCX could not send the claim: ${copy}` : refusalNote(code)) : null, now)
    log(code)
    return 'failed' as const
  }

  if (row.isMock) {
    const built = await buildOutbound(row, null, deps, now)
    if (!built.ok) return failBuild(built.code)
    await finish(row, { state: 'sent', protocolStatus: 'request.queued', jweEncrypted: null, nextAttemptAt: null, bodySha256: sha256(JSON.stringify(built.fhir)) },
      { action: 'nhcx: dispatched exchange', outcome: 'accepted' }, null, now)
    log('accepted')
    // The mock's synthesised answer arrives after the send is recorded, as a real callback would.
    await deps.mock.send(row, built.fhir)
    return 'sent'
  }

  const cfg = (nhcx as { config: NhcxConfig }).config
  const abdmCfg = (abdm as { config: AbdmConfig }).config
  let jwe: string
  if (row.jweEncrypted) {
    jwe = openPayload(row.jweEncrypted)
  } else {
    const built = await buildOutbound(row, cfg, deps, now)
    if (!built.ok) return failBuild(built.code)
    if (validateNhcxBundle(built.fhir, built.profile).length > 0) return failBuild('build_invalid')
    const cert = await deps.certs(cfg, abdmCfg, row.recipientCode)
    if (!cert.ok) {
      if (cert.error === 'cert_unavailable') return retryOrFail(row, deps, now, 'cert_unavailable', log)
      return failBuild(cert.error)
    }
    const headers = buildRequestHeaders({ sender: cfg.participantCode, recipient: row.recipientCode, apiCallId: row.apiCallId, correlationId: row.correlationId, abhaId: built.abhaId, now })
    const body = JSON.stringify(built.fhir)
    jwe = await sealHcxPayload(built.fhir, headers, cert.certPem)
    await getDb().update(nhcxExchanges).set({ jweEncrypted: sealPayload(jwe), bodySha256: sha256(body), updatedAt: now }).where(eq(nhcxExchanges.id, row.id))
  }

  const outcome = await deps.client(cfg, abdmCfg, row.action as NhcxAction, jwe)
  if (outcome.kind === 'accepted') {
    await finish(row, { state: 'sent', protocolStatus: 'request.queued', jweEncrypted: null, nextAttemptAt: null, lastErrorCode: null },
      { action: 'nhcx: dispatched exchange', outcome: 'accepted' }, null, now)
    log('accepted')
    return 'sent'
  }
  if (outcome.kind === 'rejected') {
    await finish(row, { state: 'send_failed', lastErrorCode: outcome.errorCode ?? `HTTP_${outcome.httpStatus}`, jweEncrypted: null, nextAttemptAt: null },
      { action: 'nhcx: exchange send failed', outcome: 'rejected' }, row.claimId ? refusalNote(outcome.errorCode) : null, now)
    log('rejected')
    return 'failed'
  }
  if (outcome.errorCode && (CERT_REFRESH_ERROR_CODES as readonly string[]).includes(outcome.errorCode)) {
    // The recipient could not decrypt: look its certificate up again and re-seal next time (same ids).
    await deps.invalidateCert(row.recipientCode)
    await getDb().update(nhcxExchanges).set({ jweEncrypted: null }).where(eq(nhcxExchanges.id, row.id))
  }
  return retryOrFail(row, deps, now, outcome.errorCode ?? (outcome.httpStatus ? `HTTP_${outcome.httpStatus}` : 'NETWORK'), log)
}

async function retryOrFail(row: NhcxExchangeRow, deps: DispatchDeps, now: Date, code: string, log: (o: string) => void): Promise<DispatchResult> {
  const next = nextAttemptAt(row.attempts, now)
  if (!next) {
    await finish(row, { state: 'send_failed', lastErrorCode: 'max_attempts', jweEncrypted: null, nextAttemptAt: null },
      { action: 'nhcx: exchange send failed', outcome: 'max_attempts' }, row.claimId ? refusalNote('max_attempts') : null, now)
    log('max_attempts')
    return 'failed'
  }
  await getDb().update(nhcxExchanges).set({ nextAttemptAt: next, lastErrorCode: code.slice(0, 64), updatedAt: now }).where(eq(nhcxExchanges.id, row.id))
  log('retry')
  return 'retry'
}

// ---- views ----------------------------------------------------------------------------------

export interface ExchangeView {
  id: number; entityType: NhcxEntityType; action: string; direction: 'outbound' | 'inbound'; state: string; protocolStatus: string | null
  correlationPrefix: string; attempts: number; lastErrorCode: string | null; createdAt: string; respondedAt: string | null
  reviewState: string; summary: NhcxResponseSummary | null; isMock: boolean
}

/** Exchanges of a claim, a pre-auth or a patient, newest first. No payloads, no JWE. */
export async function listExchangesFor(subject: { claimId?: number; preauthId?: number; patientId?: string }, limit = 50): Promise<ExchangeView[]> {
  const where = subject.claimId !== undefined ? eq(nhcxExchanges.claimId, subject.claimId)
    : subject.preauthId !== undefined ? eq(nhcxExchanges.preauthId, subject.preauthId)
      : subject.patientId !== undefined ? eq(nhcxExchanges.patientId, subject.patientId) : sql`false`
  const rows = await getDb().select({
    id: nhcxExchanges.id, entityType: nhcxExchanges.entityType, action: nhcxExchanges.action, direction: nhcxExchanges.direction, state: nhcxExchanges.state,
    protocolStatus: nhcxExchanges.protocolStatus, correlationId: nhcxExchanges.correlationId, attempts: nhcxExchanges.attempts, lastErrorCode: nhcxExchanges.lastErrorCode,
    createdAt: nhcxExchanges.createdAt, respondedAt: nhcxExchanges.respondedAt, reviewState: nhcxExchanges.reviewState, summary: nhcxExchanges.summary, isMock: nhcxExchanges.isMock,
  }).from(nhcxExchanges).where(where).orderBy(desc(nhcxExchanges.id)).limit(limit)
  return rows.map(({ correlationId, createdAt, respondedAt, ...r }) => ({
    ...r, correlationPrefix: correlationId.slice(0, 8), createdAt: createdAt.toISOString(), respondedAt: respondedAt ? respondedAt.toISOString() : null,
  }))
}

// ---- status polling and the sweep (Task 13) ---------------------------------------------------

export const MANUAL_POLL_INTERVAL_MS = 15 * 60 * 1000
export const SWEEP_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
const POLLABLE = ['sent', 'queued', 'dispatched'] as const
export type PollResult = 'sent' | 'too_soon' | 'not_pollable' | 'failed' | 'disabled'

/** Status polling sends unverified traffic (U9), so it is off unless NHCX_STATUS_POLLING=1. */
export const statusPollingEnabled = (env: Record<string, string | undefined> = process.env) => env.NHCX_STATUS_POLLING === '1'

/** Asks NHCX for the status of an exchange: a new api_call_id on the original correlation; the answer arrives on on_status. */
export async function pollExchangeStatus(exchangeId: number, partial: Partial<DispatchDeps> & { mode?: 'manual' | 'sweep'; enabled?: boolean } = {}): Promise<PollResult> {
  const deps = { ...defaultDispatchDeps(), ...partial }
  if (!(partial.enabled ?? statusPollingEnabled())) return 'disabled'
  const now = deps.now()
  const interval = partial.mode === 'sweep' ? SWEEP_POLL_INTERVAL_MS : MANUAL_POLL_INTERVAL_MS
  const { nhcx, abdm } = deps.config()
  if (nhcx.state !== 'configured' || abdm.state !== 'configured') return 'not_pollable'
  const claimed = await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(nhcxExchanges).where(eq(nhcxExchanges.id, exchangeId)).for('update', { skipLocked: true })
    if (!row || row.direction !== 'outbound' || !(POLLABLE as readonly string[]).includes(row.state) || row.isMock) return 'not_pollable' as const
    if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < interval) return 'too_soon' as const
    await tx.update(nhcxExchanges).set({ lastPolledAt: now, updatedAt: now }).where(eq(nhcxExchanges.id, exchangeId))
    return row
  })
  if (typeof claimed === 'string') return claimed
  const cert = await deps.certs(nhcx.config, abdm.config, claimed.recipientCode)
  if (!cert.ok) return 'failed'
  const headers = buildRequestHeaders({ sender: nhcx.config.participantCode, recipient: claimed.recipientCode, correlationId: claimed.correlationId, now })
  const jwe = await sealHcxPayload(buildStatusTaskBundle({ created: now, sender: nhcx.config.participantCode, recipient: claimed.recipientCode, correlationId: claimed.correlationId }), headers, cert.certPem)
  const outcome = await deps.client(nhcx.config, abdm.config, 'status', jwe)
  safeLog('nhcx', { action: 'status', exchangeId, outcome: outcome.kind })
  return outcome.kind === 'accepted' ? 'sent' : 'failed'
}

export const NO_RESPONSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
export const INBOUND_CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_BATCH = 25

export interface SweepDeps { dispatch: (id: number) => Promise<DispatchResult>; poll: (id: number) => Promise<PollResult>; pollingEnabled: boolean }

/** The cron safety net (ruling 5): due sends, optional polling, 7-day silence, share expiry, inbound-call purge. */
export async function runNhcxSweep(now: Date, partial: Partial<SweepDeps> = {}): Promise<{ dispatched: number; failed: number; polled: number; noResponse: number; sharesExpired: number; inboundPurged: number }> {
  const deps: SweepDeps = {
    dispatch: (id) => dispatchExchange(id, { now: () => now }),
    poll: (id) => pollExchangeStatus(id, { now: () => now, mode: 'sweep' }),
    pollingEnabled: statusPollingEnabled(),
    ...partial,
  }
  const db = getDb()
  const counts = { dispatched: 0, failed: 0, polled: 0, noResponse: 0, sharesExpired: 0, inboundPurged: 0 }

  const due = await db.select({ id: nhcxExchanges.id }).from(nhcxExchanges)
    .where(and(eq(nhcxExchanges.direction, 'outbound'), eq(nhcxExchanges.state, 'pending_send'), or(isNull(nhcxExchanges.nextAttemptAt), lte(nhcxExchanges.nextAttemptAt, now))))
    .orderBy(asc(nhcxExchanges.nextAttemptAt)).limit(SWEEP_BATCH)
  for (const { id } of due) {
    const r = await deps.dispatch(id)
    if (r === 'sent') counts.dispatched++
    if (r === 'failed') counts.failed++
  }

  if (deps.pollingEnabled) {
    const silent = await db.select({ id: nhcxExchanges.id }).from(nhcxExchanges)
      .where(and(eq(nhcxExchanges.direction, 'outbound'), inArray(nhcxExchanges.state, [...POLLABLE]), lt(nhcxExchanges.createdAt, new Date(now.getTime() - 2 * 60 * 60 * 1000))))
      .orderBy(asc(nhcxExchanges.lastPolledAt)).limit(SWEEP_BATCH)
    for (const { id } of silent) if ((await deps.poll(id)) === 'sent') counts.polled++
  }

  const stale = await db.select({ id: nhcxExchanges.id, claimId: nhcxExchanges.claimId, patientId: nhcxExchanges.patientId }).from(nhcxExchanges)
    .where(and(eq(nhcxExchanges.direction, 'outbound'), inArray(nhcxExchanges.state, [...POLLABLE]), lt(nhcxExchanges.createdAt, new Date(now.getTime() - NO_RESPONSE_AFTER_MS))))
    .limit(100)
  for (const s of stale) {
    await db.transaction(async (tx) => {
      const [updated] = await tx.update(nhcxExchanges).set({ state: 'no_response', updatedAt: now })
        .where(and(eq(nhcxExchanges.id, s.id), inArray(nhcxExchanges.state, [...POLLABLE]))).returning({ id: nhcxExchanges.id })
      if (!updated) return
      if (s.claimId) await addGatewayClaimNote(tx, s.claimId, 'No NHCX response after 7 days; check the insurer portal', now)
      await logGatewayEvent('NHCX gateway', 'nhcx: no response', s.patientId, `exchange=${s.id}`, tx)
      counts.noResponse++
    })
  }

  counts.sharesExpired = await expireShares(now)

  counts.inboundPurged = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
    const rows = await tx.delete(nhcxInboundCalls).where(lt(nhcxInboundCalls.receivedAt, new Date(now.getTime() - INBOUND_CALL_RETENTION_MS))).returning({ id: nhcxInboundCalls.apiCallId })
    return rows.length
  })

  safeLog('nhcx-sweep', { count: counts.dispatched, outcome: `failed:${counts.failed}`, state: `noResponse:${counts.noResponse}` })
  return counts
}
