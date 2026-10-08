import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { claimEvents, claims, nhcxExchanges, preauths, type NhcxExchangeRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { openPayload } from '@/lib/integrations/payload-vault'
import { readNhcxConfig } from '@/lib/integrations/config'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import type { NhcxResponseSummary } from '@/lib/nhcx/constants'
import { parseClaimResponseBundle, parseCommunicationRequestTaskBundle, parsePaymentNoticeTaskBundle, buildPaymentAckTaskBundle } from '@/lib/fhir/nhcx/responses'
import { recipientCodeFor } from '@/lib/nhcx/claim-gateway'
import { lockPatientBilling } from './charge-capture'
import { defaultSchedule, dispatchExchange, listExchangesFor, senderCode, type OutboundBuild } from './nhcx-exchanges'
import { loadPolicyContext, loadSnapshotHospital } from './rcm-context'

// SP8 Task 15: an RCM user reviews each insurer response (ruling 6). The
// payload view decrypts server-side and returns only what the review form
// needs; confirming records the review after the user has applied the
// pre-filled SP7 action themselves; nothing here moves status or money.

export interface PayloadView {
  exchangeId: number
  action: string
  reviewState: string
  claimId: number | null
  preauthId: number | null
  summary: NhcxResponseSummary | null
  dispositionText: string | null
  preAuthRef: string | null
  queryText: string | null
  paymentAmountPaise: number | null
  paymentDate: string | null
  isMock: boolean
}

export async function getExchangePayloadView(exchangeId: number, session: Session): Promise<PayloadView | null> {
  const [row] = await getDb().select().from(nhcxExchanges).where(eq(nhcxExchanges.id, exchangeId)).limit(1)
  if (!row || row.direction !== 'inbound') return null
  let dispositionText: string | null = null
  let preAuthRef: string | null = null
  let queryText: string | null = null
  if (row.payloadEncrypted) {
    const fhir = JSON.parse(openPayload(row.payloadEncrypted)) as unknown
    if (row.action === 'claim/on_submit' || row.action === 'preauth/on_submit') {
      const r = parseClaimResponseBundle(fhir)
      if (r.ok) { dispositionText = r.dispositionText; preAuthRef = r.preAuthRef }
    } else if (row.action === 'communication/request') {
      const r = parseCommunicationRequestTaskBundle(fhir)
      if (r.ok) queryText = r.text
    } else if (row.action === 'paymentnotice/request') {
      parsePaymentNoticeTaskBundle(fhir)
    }
  }
  await logAudit(session, 'nhcx: viewed response', row.patientId, `exchange=${exchangeId}`)
  return {
    exchangeId, action: row.action, reviewState: row.reviewState, claimId: row.claimId, preauthId: row.preauthId, summary: row.summary,
    dispositionText, preAuthRef, queryText, paymentAmountPaise: row.summary?.paymentAmountPaise ?? null, paymentDate: row.summary?.paymentDate ?? null, isMock: row.isMock,
  }
}

export interface ReviewDeps { schedule?: (fn: () => Promise<unknown>) => void; dispatch?: (id: number) => Promise<unknown>; now?: () => Date }

export async function reviewExchange(
  exchangeId: number,
  input: { decision: 'confirmed' | 'dismissed'; note?: string; sendPaymentAck?: boolean },
  session: Session, deps: ReviewDeps = {},
): Promise<RcmWriteResult<{ reviewState: 'confirmed' | 'dismissed'; ackExchangeId: number | null }>> {
  const now = (deps.now ?? (() => new Date()))()
  const db = getDb()
  const [peek] = await db.select({ patientId: nhcxExchanges.patientId }).from(nhcxExchanges).where(eq(nhcxExchanges.id, exchangeId)).limit(1)
  if (!peek) return rcmFail('submission_not_found', 'Exchange not found')
  const result = await db.transaction(async (tx) => {
    await lockPatientBilling(tx, peek.patientId)
    const [row] = await tx.select().from(nhcxExchanges).where(eq(nhcxExchanges.id, exchangeId)).for('update')
    if (!row || row.direction !== 'inbound') return rcmFail('submission_not_found', 'Exchange not found')
    if (row.reviewState !== 'pending') return rcmFail('already_decided', 'Already reviewed')
    await tx.update(nhcxExchanges).set({ reviewState: input.decision, reviewedByName: session.name, reviewedAt: now, state: 'acknowledged', updatedAt: now }).where(eq(nhcxExchanges.id, exchangeId))
    if (input.note && row.claimId) {
      const [claim] = await tx.select().from(claims).where(eq(claims.id, row.claimId)).for('update')
      if (claim) {
        await tx.insert(claimEvents).values({ claimId: claim.id, action: 'note', fromStatus: claim.status, toStatus: claim.status, note: `NHCX response ${input.decision}: ${input.note}`, byName: session.name, byUserId: session.userId, at: now })
        await tx.update(claims).set({ rowVersion: claim.rowVersion + 1, lastStatusAt: now, updatedAt: now }).where(eq(claims.id, claim.id))
      }
    }
    let ackExchangeId: number | null = null
    if (input.decision === 'confirmed' && input.sendPaymentAck && row.action === 'paymentnotice/request') {
      const [ack] = await tx.insert(nhcxExchanges).values({
        entityType: 'paymentnotice', direction: 'outbound', action: 'paymentnotice/on_request', correlationId: row.correlationId, apiCallId: randomUUID(),
        senderCode: senderCode(), recipientCode: row.senderCode, state: 'pending_send', patientId: row.patientId, policyId: row.policyId, claimId: row.claimId,
        relatedExchangeId: row.id, nextAttemptAt: now, bodySha256: row.bodySha256, isMock: row.isMock, createdAt: now, updatedAt: now,
      }).returning({ id: nhcxExchanges.id })
      ackExchangeId = ack.id
    }
    await logAudit(session, 'nhcx: reviewed response', row.patientId, `exchange=${exchangeId} decision=${input.decision}`, tx)
    return rcmOk({ reviewState: input.decision, ackExchangeId })
  })
  if (result.ok && result.value.ackExchangeId !== null) {
    const id = result.value.ackExchangeId
    ;(deps.schedule ?? defaultSchedule)(() => (deps.dispatch ?? dispatchExchange)(id))
  }
  return result
}

/** The payment acknowledgement bundle for an outbound paymentnotice/on_request row. */
export async function buildPaymentAckOutbound(row: NhcxExchangeRow, now: Date): Promise<OutboundBuild> {
  if (!row.policyId) return { ok: false, code: 'snapshot_missing' }
  const db = getDb()
  const ctx = await loadPolicyContext(db, row.policyId)
  if (!ctx) return { ok: false, code: 'snapshot_missing' }
  const hospital = await loadSnapshotHospital(db)
  if (!hospital.hfrId && !hospital.rohiniId) return { ok: false, code: 'hospital_ids_missing' }
  const payer = ctx.policy.tpa?.nhcxParticipantCode ? ctx.policy.tpa : ctx.policy.insurer
  return { ok: true, profile: 'TaskBundle', abhaId: null, fhir: buildPaymentAckTaskBundle({ created: now, hospital, payer }) }
}

/** Whether the NHCX submission channel can be used for this claim, and why not. */
export async function claimNhcxChannel(claimId: number): Promise<{ enabled: boolean; label: string }> {
  const cfg = readNhcxConfig()
  if (cfg.state === 'not_configured') return { enabled: false, label: 'NHCX not connected' }
  const [c] = await getDb().select({ policyId: claims.policyId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  const ctx = c ? await loadPolicyContext(getDb(), c.policyId) : null
  if (!ctx || !recipientCodeFor(ctx.policy)) return { enabled: false, label: 'NHCX (this insurer or TPA has no NHCX participant code)' }
  return { enabled: true, label: cfg.state === 'mock' ? 'NHCX (sandbox mock - not real)' : 'NHCX' }
}

/** Whether a pre-auth can be sent through NHCX now. */
export async function preauthNhcxState(preauthId: number): Promise<{ canSend: boolean; reason: string | null }> {
  const cfg = readNhcxConfig()
  if (cfg.state === 'not_configured') return { canSend: false, reason: 'NHCX not connected' }
  const [p] = await getDb().select({ status: preauths.status, policyId: preauths.policyId }).from(preauths).where(eq(preauths.id, preauthId)).limit(1)
  if (!p) return { canSend: false, reason: null }
  const ctx = await loadPolicyContext(getDb(), p.policyId)
  if (!ctx || !recipientCodeFor(ctx.policy)) return { canSend: false, reason: 'This insurer or TPA has no NHCX participant code' }
  if (p.status !== 'requested' && p.status !== 'enhancement_requested') return { canSend: false, reason: 'Only a requested pre-authorisation can be sent' }
  return { canSend: true, reason: null }
}

/** The last exchanges for the settings page (ids, actions and states only). */
export async function recentExchanges(limit = 10): Promise<{ id: number; action: string; direction: string; state: string; createdAt: string; isMock: boolean }[]> {
  const rows = await getDb().select({ id: nhcxExchanges.id, action: nhcxExchanges.action, direction: nhcxExchanges.direction, state: nhcxExchanges.state, createdAt: nhcxExchanges.createdAt, isMock: nhcxExchanges.isMock })
    .from(nhcxExchanges).orderBy(desc(nhcxExchanges.id)).limit(limit)
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}

export { listExchangesFor }
