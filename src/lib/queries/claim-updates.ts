// SP7: insurer-portal updates recorded by hand — queries, decisions with reason-coded deductions,
// rejections, close/reopen/withdraw and notes — plus settlements with TDS, bank reconciliation and
// two-person write-offs (ruling 12). Every write: the SP4 per-patient billing lock, then the claim
// row FOR UPDATE, then an append-only event and the audit row. Audit details carry ids, statuses
// and paise only: never a UTR, note, reason or question.
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { claimDisallowances, claimEvents, claims, claimSettlements, claimWriteOffs, rcmQueries, rcmReasonCodes, type ClaimRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { paiseFromDb, sumPaise } from '@/lib/billing/amounts'
import { isUniqueViolation } from '@/lib/db-errors'
import { formatPaise } from '@/lib/format'
import {
  approvalProblems, closeProblems, settlementProblems, settlementWarnings, writeOffCeilingPaise, type ClaimMoney,
} from '@/lib/rcm/amounts'
import { approvalActionFor, nextClaimStatus, type ClaimAction, type ClaimStatus } from '@/lib/rcm/claim-status'
import type { ReasonCategory } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import type { ClaimUpdateRequest, SettlementInput } from '@/lib/rcm/validation'
import { lockPatientBilling } from './billing-lock'
import type { WriteExecutor } from './executor'

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

export type ClaimMoneyState = ClaimMoney & { unreconciledSettlements: number; openQueries: number; hasSettlement: boolean }

export async function loadClaimMoney(executor: WriteExecutor, claimId: number): Promise<ClaimMoneyState | null> {
  const [c] = await executor.select().from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!c) return null
  const r = await executor.execute<{ pending: string | null; unreconciled: number; settlements: number; open_queries: number }>(sql`select
    (select sum(amount_paise) from claim_write_offs where claim_id = ${claimId} and status = 'requested')::text as pending,
    (select count(*)::int from claim_settlements where claim_id = ${claimId} and reconciled_at is null) as unreconciled,
    (select count(*)::int from claim_settlements where claim_id = ${claimId}) as settlements,
    (select count(*)::int from rcm_queries where claim_id = ${claimId} and status = 'open') as open_queries`)
  const row = r.rows[0]
  return {
    status: c.status, claimedPaise: c.claimedPaise, approvedPaise: c.approvedPaise, nonRecoverableDisallowedPaise: c.nonRecoverableDisallowedPaise,
    settledPaise: c.settledPaise, writtenOffPaise: c.writtenOffPaise, pendingWriteOffPaise: paiseFromDb(row?.pending ?? null),
    unreconciledSettlements: row?.unreconciled ?? 0, openQueries: row?.open_queries ?? 0, hasSettlement: (row?.settlements ?? 0) > 0,
  }
}

/** Runs `fn` with the patient's billing lock taken and the claim row locked. */
async function withClaim<T>(claimId: number, fn: (tx: Tx, claim: ClaimRow) => Promise<RcmWriteResult<T>>): Promise<RcmWriteResult<T>> {
  const [found] = await getDb().select({ patientId: claims.patientId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!found) return rcmFail('claim_not_found')
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, found.patientId)
    const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId)).for('update')
    if (!claim) return rcmFail('claim_not_found')
    return fn(tx, claim)
  })
}

async function reasonIs(executor: WriteExecutor, code: string, category: ReasonCategory): Promise<boolean> {
  const [r] = await executor.select({ category: rcmReasonCodes.category }).from(rcmReasonCodes).where(and(eq(rcmReasonCodes.code, code), eq(rcmReasonCodes.active, true))).limit(1)
  return r?.category === category
}

export async function applyClaimUpdate(claimId: number, req: ClaimUpdateRequest, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ status: ClaimStatus; warnings: string[] }>> {
  return withClaim(claimId, async (tx, claim) => {
    const money = (await loadClaimMoney(tx, claimId))!
    const from = claim.status
    let action: ClaimAction | 'note'
    let to: ClaimStatus
    if (req.action === 'note') {
      action = 'note'
      to = from
    } else {
      action = req.action === 'record_decision' ? approvalActionFor(claim.claimedPaise, req.approvedPaise) : req.action
      const next = nextClaimStatus(from, action, { hasSettlement: money.hasSettlement })
      if (next === null) return rcmFail('invalid_transition')
      to = next
    }
    const set: Partial<ClaimRow> = { status: to, rowVersion: claim.rowVersion + 1, lastStatusAt: now, updatedAt: now }
    const event: typeof claimEvents.$inferInsert = { claimId, action, fromStatus: from, toStatus: to, byName: session.name, byUserId: session.userId, at: now }
    let auditExtra = ''
    const disallowances: { reasonCode: string; amountPaise: number; patientRecoverable: boolean; note: string | null }[] = []

    switch (req.action) {
      case 'record_query':
        await tx.insert(rcmQueries).values({ claimId, question: req.question, raisedOn: req.raisedOn, dueOn: req.dueOn, createdByName: session.name, createdAt: now })
        if (req.insurerClaimReference && claim.insurerClaimReference === null) set.insurerClaimReference = req.insurerClaimReference
        break
      case 'record_decision': {
        const problem = approvalProblems({ claimedPaise: claim.claimedPaise, approvedPaise: req.approvedPaise, disallowances: req.disallowances })
        if (problem) return rcmFail('amounts_invalid', problem)
        // An appeal decided after a settlement can never approve less than is already paid.
        if (req.approvedPaise < claim.settledPaise) return rcmFail('amounts_invalid', `The approved amount cannot be less than the ${formatPaise(claim.settledPaise)} already settled`)
        for (const d of req.disallowances) if (!(await reasonIs(tx, d.reasonCode, 'disallowance'))) return rcmFail('code_not_found')
        const disallowed = claim.claimedPaise - req.approvedPaise
        const nonRecoverable = sumPaise(req.disallowances.filter((d) => !d.patientRecoverable).map((d) => d.amountPaise))
        for (const d of req.disallowances) disallowances.push({ reasonCode: d.reasonCode, amountPaise: d.amountPaise, patientRecoverable: d.patientRecoverable, note: d.note ?? null })
        Object.assign(set, { approvedPaise: req.approvedPaise, disallowedPaise: disallowed, nonRecoverableDisallowedPaise: nonRecoverable })
        if (req.insurerClaimReference && claim.insurerClaimReference === null) set.insurerClaimReference = req.insurerClaimReference
        event.amountPaise = req.approvedPaise
        auditExtra = ` approved=${req.approvedPaise} disallowed=${disallowed}`
        break
      }
      case 'record_rejection': {
        if (!(await reasonIs(tx, req.reasonCode, 'rejection'))) return rcmFail('code_not_found')
        // Ruling 13: a rejection is approved 0 with one full-amount deduction.
        disallowances.push({ reasonCode: req.reasonCode, amountPaise: claim.claimedPaise, patientRecoverable: req.patientRecoverable, note: req.note ?? null })
        Object.assign(set, { approvedPaise: 0, disallowedPaise: claim.claimedPaise, nonRecoverableDisallowedPaise: req.patientRecoverable ? 0 : claim.claimedPaise })
        event.amountPaise = 0
        event.note = req.note ?? null
        auditExtra = ` approved=0 disallowed=${claim.claimedPaise}`
        break
      }
      case 'close': {
        const problem = closeProblems(money)
        if (problem) return rcmFail('close_blocked', problem)
        set.closedAt = now
        break
      }
      case 'reopen':
        event.note = req.reason
        set.closedAt = null
        break
      case 'withdraw':
        event.note = req.reason
        break
      case 'note':
        Object.assign(event, { note: req.note, portalCheckedOn: req.portalCheckedOn })
        break
    }

    const [ev] = await tx.insert(claimEvents).values(event).returning({ id: claimEvents.id })
    if (disallowances.length > 0) {
      await tx.insert(claimDisallowances).values(disallowances.filter((d) => d.amountPaise > 0).map((d) => ({ claimId, eventId: ev.id, ...d })))
    }
    if (req.action === 'record_decision' || req.action === 'record_rejection') set.currentDecisionEventId = ev.id
    await tx.update(claims).set(set).where(eq(claims.id, claimId))
    await logAudit(session, `rcm: claim ${action}`, claim.patientId, `claim=${claimId} from=${from} to=${to}${auditExtra}`, tx)
    return rcmOk({ status: to, warnings: [] })
  })
}

/** One remittance against a claim (ruling 5): bounded by the approved amount still due, unique per claim and UTR. */
export async function recordSettlement(claimId: number, input: SettlementInput, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ settlementId: number; warnings: string[] }>> {
  try {
    return await withClaim(claimId, async (tx, claim) => {
      const money = (await loadClaimMoney(tx, claimId))!
      // The same remittance twice (a double click, or two clerks) is reported as a duplicate first.
      const [dup] = await tx.select({ id: claimSettlements.id }).from(claimSettlements)
        .where(and(eq(claimSettlements.claimId, claimId), sql`lower(${claimSettlements.utr}) = lower(${input.utr})`)).limit(1)
      if (dup) return rcmFail('duplicate_utr')
      const to = nextClaimStatus(claim.status, 'record_settlement', { hasSettlement: money.hasSettlement })
      if (to === null) return rcmFail('invalid_transition')
      const amounts = { approvedPaise: claim.approvedPaise ?? 0, alreadySettledPaise: claim.settledPaise, receivedPaise: input.receivedPaise, tdsPaise: input.tdsPaise, bankChargesPaise: input.bankChargesPaise }
      const problem = settlementProblems(amounts)
      if (problem) return rcmFail('amounts_invalid', problem)
      const settled = sumPaise([input.receivedPaise, input.tdsPaise, input.bankChargesPaise])
      const [ev] = await tx.insert(claimEvents).values({
        claimId, action: 'record_settlement', fromStatus: claim.status, toStatus: to, amountPaise: settled, byName: session.name, byUserId: session.userId, at: now,
      }).returning({ id: claimEvents.id })
      const [st] = await tx.insert(claimSettlements).values({
        claimId, eventId: ev.id, utr: input.utr, paymentDate: input.paymentDate, receivedPaise: input.receivedPaise, tdsPaise: input.tdsPaise,
        bankChargesPaise: input.bankChargesPaise, settledPaise: settled, recordedByName: session.name, recordedAt: now,
      }).returning({ id: claimSettlements.id })
      await tx.update(claims).set({ status: to, settledPaise: claim.settledPaise + settled, rowVersion: claim.rowVersion + 1, lastStatusAt: now, updatedAt: now }).where(eq(claims.id, claimId))
      await logAudit(session, 'rcm: recorded settlement', claim.patientId, `claim=${claimId} settlement=${st.id} received=${input.receivedPaise} tds=${input.tdsPaise} bank=${input.bankChargesPaise}`, tx)
      return rcmOk({ settlementId: st.id, warnings: settlementWarnings(amounts) })
    })
  } catch (err) {
    if (isUniqueViolation(err, 'claim_settlements_claim_utr_unique')) return rcmFail('duplicate_utr')
    throw err
  }
}

export async function reconcileSettlement(settlementId: number, input: { bankCreditDate: string }, session: Session): Promise<RcmWriteResult<null>> {
  const [found] = await getDb().select({ claimId: claimSettlements.claimId }).from(claimSettlements).where(eq(claimSettlements.id, settlementId)).limit(1)
  if (!found) return rcmFail('settlement_not_found')
  return withClaim(found.claimId, async (tx, claim) => {
    const [st] = await tx.select({ reconciledAt: claimSettlements.reconciledAt }).from(claimSettlements).where(eq(claimSettlements.id, settlementId)).for('update')
    if (!st) return rcmFail('settlement_not_found')
    if (st.reconciledAt !== null) return rcmFail('already_reconciled')
    await tx.update(claimSettlements).set({ bankCreditDate: input.bankCreditDate, reconciledAt: new Date(), reconciledByName: session.name }).where(eq(claimSettlements.id, settlementId))
    await tx.update(claims).set({ rowVersion: claim.rowVersion + 1, updatedAt: new Date() }).where(eq(claims.id, claim.id))
    await logAudit(session, 'rcm: reconciled settlement', claim.patientId, `claim=${claim.id} settlement=${settlementId}`, tx)
    return rcmOk(null)
  })
}

export async function requestWriteOff(claimId: number, input: { amountPaise: number; reasonCode: string; note: string }, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ writeOffId: number }>> {
  return withClaim(claimId, async (tx, claim) => {
    if (claim.status === 'draft' || claim.status === 'withdrawn' || claim.status === 'closed') return rcmFail('invalid_transition')
    if (!(await reasonIs(tx, input.reasonCode, 'write_off'))) return rcmFail('code_not_found')
    const ceiling = writeOffCeilingPaise((await loadClaimMoney(tx, claimId))!)
    if (input.amountPaise > ceiling) return rcmFail('write_off_exceeds', `The write-off is more than the ${formatPaise(ceiling)} still open on this claim`)
    const [w] = await tx.insert(claimWriteOffs).values({
      claimId, amountPaise: input.amountPaise, reasonCode: input.reasonCode, note: input.note, requestedByName: session.name, requestedByUserId: session.userId, requestedAt: now,
    }).returning({ id: claimWriteOffs.id })
    await tx.update(claims).set({ rowVersion: claim.rowVersion + 1, updatedAt: now }).where(eq(claims.id, claimId))
    await logAudit(session, 'rcm: requested write-off', claim.patientId, `claim=${claimId} write_off=${w.id} amount=${input.amountPaise}`, tx)
    return rcmOk({ writeOffId: w.id })
  })
}

/** Ruling 12: a different person with a staff account decides; only approved write-offs credit the ledger. */
export async function decideWriteOff(writeOffId: number, input: { decision: 'approve' | 'reject'; note?: string }, session: Session, now: Date = new Date()): Promise<RcmWriteResult<null>> {
  if (session.userId === null) return rcmFail('no_user_account')
  const [found] = await getDb().select({ claimId: claimWriteOffs.claimId }).from(claimWriteOffs).where(eq(claimWriteOffs.id, writeOffId)).limit(1)
  if (!found) return rcmFail('write_off_not_found')
  return withClaim(found.claimId, async (tx, claim) => {
    const [w] = await tx.select().from(claimWriteOffs).where(eq(claimWriteOffs.id, writeOffId)).for('update')
    if (!w) return rcmFail('write_off_not_found')
    if (w.requestedByUserId !== null && w.requestedByUserId === session.userId) return rcmFail('same_approver')
    if (w.status !== 'requested') return rcmFail('already_decided')
    if (input.decision === 'approve') {
      const money = (await loadClaimMoney(tx, claim.id))!
      const ceiling = writeOffCeilingPaise({ ...money, pendingWriteOffPaise: money.pendingWriteOffPaise - w.amountPaise })
      if (w.amountPaise > ceiling) return rcmFail('write_off_exceeds', `The write-off is more than the ${formatPaise(ceiling)} still open on this claim`)
    }
    const status = input.decision === 'approve' ? 'approved' : 'rejected'
    await tx.update(claimWriteOffs).set({ status, decidedByName: session.name, decidedByUserId: session.userId, decidedAt: now, decisionNote: input.note ?? null }).where(eq(claimWriteOffs.id, writeOffId))
    await tx.update(claims).set({
      writtenOffPaise: status === 'approved' ? claim.writtenOffPaise + w.amountPaise : claim.writtenOffPaise, rowVersion: claim.rowVersion + 1, updatedAt: now,
    }).where(eq(claims.id, claim.id))
    await logAudit(session, `rcm: ${status} write-off`, claim.patientId, `claim=${claim.id} write_off=${writeOffId} amount=${w.amountPaise}`, tx)
    return rcmOk(null)
  })
}
