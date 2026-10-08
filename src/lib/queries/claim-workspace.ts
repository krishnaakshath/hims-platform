// SP7: everything the claim workspace page shows, in one read. Blob URLs never leave the server;
// the patient is the RCM minimum, plus ABHA only for a payer that requires it and a role in
// CLAIM_ABHA_READ_ROLES (ruling 9).
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  claimDispatches, claimDisallowances, claimDocuments, claimEvents, claimInvoices, claims, claimSettlements, claimSubmissions, claimWriteOffs,
  invoices, patients, payerProfiles, payers, preauths, rcmQueries, rcmQueryResponses, type ClaimRow, type RcmReasonCodeRow,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { formatAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import { DEFAULT_TIMEZONE, ageOnDate, istDateOf, todayIsoIn } from '@/lib/india-time'
import { CLAIM_ABHA_READ_ROLES } from '@/lib/role-policy'
import { claimCoveredPendingPaise, insurerOutstandingPaise, writeOffCeilingPaise, type ClaimMoney } from '@/lib/rcm/amounts'
import { CLAIM_ACTIONS, nextClaimStatus, type ClaimAction } from '@/lib/rcm/claim-status'
import type { PayerKind, SubmissionChannel } from '@/lib/rcm/constants'
import type { checkClaimReadiness } from '@/lib/rcm/readiness'
import { claimSlaFlags, type SlaFlag } from '@/lib/rcm/sla'
import { episodeOf, loadClaimReadiness } from './claims'
import { claimCodingDrift } from './claim-submissions'
import { loadClaimMoney } from './claim-updates'
import { getPolicyView, type PolicyView } from './rcm-policies'
import { listReasonCodes } from './rcm-payers'

export interface ClaimWorkspace {
  claim: ClaimRow
  patient: { id: string; name: string; uhid: string | null; gender: string | null; dob: string | null; ageYears: number | null; abhaNumber?: string }
  policy: PolicyView | null
  payer: { name: string; kind: PayerKind | null; channel: SubmissionChannel; slaHours: number; settlementSlaDays: number; requiresAbha: boolean }
  preauth: { id: number; preauthNumber: string; status: string; approvedPaise: number | null; validUntil: string | null } | null
  invoices: { invoiceId: number; number: string | null; date: string | null; status: string; totalPaise: number | null; claimedPaise: number }[]
  documents: { id: number; kind: string; source: string; title: string; contentType: string | null; sha256: string | null; waived: boolean; supersededAt: Date | null }[]
  readiness: ReturnType<typeof checkClaimReadiness>
  versions: {
    id: number; version: number; kind: string; createdAt: Date; createdByName: string; snapshotSha256: string
    dispatch: { id: number; channel: string; transport: string; trackingReference: string | null; dispatchedOn: string; insurerReference: string | null; acknowledgedOn: string | null } | null
  }[]
  events: { id: number; action: string; fromStatus: string | null; toStatus: string; amountPaise: number | null; note: string | null; portalCheckedOn: string | null; byName: string; at: Date }[]
  queries: { id: number; question: string; raisedOn: string; dueOn: string; status: string; responses: { id: number; body: string; respondedOn: string; byName: string }[] }[]
  disallowances: { id: number; reasonCode: string; amountPaise: number; patientRecoverable: boolean; note: string | null }[]
  settlements: { id: number; utr: string; paymentDate: string; receivedPaise: number; tdsPaise: number; bankChargesPaise: number; settledPaise: number; bankCreditDate: string | null; reconciledAt: Date | null; recordedByName: string }[]
  writeOffs: { id: number; amountPaise: number; reasonCode: string; note: string; status: string; requestedByName: string; requestedByUserId: number | null; decidedByName: string | null; decidedAt: Date | null }[]
  money: ClaimMoney & { coveredPendingPaise: number; writeOffCeilingPaise: number; insurerOutstandingPaise: number; unreconciledSettlements: number; openQueries: number }
  slaFlags: SlaFlag[]
  codingDrift: { drifted: boolean; codingFinalised: boolean }
  allowedActions: (ClaimAction | 'note')[]
  reasonCodes: RcmReasonCodeRow[]
}

export async function getClaimWorkspace(claimId: number, session: Session, now: Date = new Date()): Promise<ClaimWorkspace | null> {
  const db = getDb()
  const [claim] = await db.select().from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!claim) return null
  const [[patient], [payer], readiness, money, policy, drift, reasonCodes, episode] = await Promise.all([
    db.select({ id: patients.id, name: patients.name, uhid: patients.uhid, gender: patients.gender, dob: patients.dob, abha: patients.abhaNumber }).from(patients).where(eq(patients.id, claim.patientId)).limit(1),
    db.select({ name: payers.name, kind: payerProfiles.kind, channel: payerProfiles.defaultChannel, slaHours: payerProfiles.preauthSlaHours, settlementSlaDays: payerProfiles.claimSettlementSlaDays, submissionWindowDays: payerProfiles.submissionWindowDays, requiresAbha: payerProfiles.requiresAbha })
      .from(payers).leftJoin(payerProfiles, eq(payerProfiles.payerId, payers.id)).where(eq(payers.id, claim.billingPayerId)).limit(1),
    loadClaimReadiness(db, claimId),
    loadClaimMoney(db, claimId),
    getPolicyView(claim.policyId),
    claimCodingDrift(db, claimId),
    listReasonCodes(),
    episodeOf(db, claim.admissionId !== null ? { admissionId: claim.admissionId } : { encounterId: claim.encounterId! }),
  ])
  if (!patient || !readiness || !money) return null

  const [preauth] = claim.preauthId === null ? [] : await db.select({ id: preauths.id, preauthNumber: preauths.preauthNumber, status: preauths.status, approvedPaise: preauths.approvedPaise, validUntil: preauths.validUntil })
    .from(preauths).where(eq(preauths.id, claim.preauthId)).limit(1)
  const invoiceRows = await db.select({ invoiceId: invoices.id, number: invoices.invoiceNumber, date: invoices.invoiceDate, status: invoices.status, totalPaise: invoices.totalPaise, claimedPaise: claimInvoices.claimedPaise })
    .from(claimInvoices).innerJoin(invoices, eq(invoices.id, claimInvoices.invoiceId)).where(eq(claimInvoices.claimId, claimId)).orderBy(asc(invoices.id))
  const docs = await db.select({ id: claimDocuments.id, kind: claimDocuments.kind, source: claimDocuments.source, title: claimDocuments.title, contentType: claimDocuments.contentType, sha256: claimDocuments.sha256, supersededAt: claimDocuments.supersededAt })
    .from(claimDocuments).where(eq(claimDocuments.claimId, claimId)).orderBy(asc(claimDocuments.id))
  const versions = await db.select({
    id: claimSubmissions.id, version: claimSubmissions.version, kind: claimSubmissions.kind, createdAt: claimSubmissions.createdAt, createdByName: claimSubmissions.createdByName, snapshotSha256: claimSubmissions.snapshotSha256,
    dId: claimDispatches.id, channel: claimDispatches.channel, transport: claimDispatches.transport, trackingReference: claimDispatches.trackingReference, dispatchedOn: claimDispatches.dispatchedOn,
    insurerReference: claimDispatches.insurerReference, acknowledgedOn: claimDispatches.acknowledgedOn,
  }).from(claimSubmissions).leftJoin(claimDispatches, eq(claimDispatches.submissionId, claimSubmissions.id)).where(eq(claimSubmissions.claimId, claimId)).orderBy(desc(claimSubmissions.version))
  const events = await db.select({ id: claimEvents.id, action: claimEvents.action, fromStatus: claimEvents.fromStatus, toStatus: claimEvents.toStatus, amountPaise: claimEvents.amountPaise, note: claimEvents.note, portalCheckedOn: claimEvents.portalCheckedOn, byName: claimEvents.byName, at: claimEvents.at })
    .from(claimEvents).where(eq(claimEvents.claimId, claimId)).orderBy(asc(claimEvents.at), asc(claimEvents.id))
  const queries = await db.select().from(rcmQueries).where(eq(rcmQueries.claimId, claimId)).orderBy(asc(rcmQueries.id))
  const responses = queries.length === 0 ? [] : await db.select().from(rcmQueryResponses).where(inArray(rcmQueryResponses.queryId, queries.map((q) => q.id)))
  const disallowances = claim.currentDecisionEventId === null ? [] : await db.select({ id: claimDisallowances.id, reasonCode: claimDisallowances.reasonCode, amountPaise: claimDisallowances.amountPaise, patientRecoverable: claimDisallowances.patientRecoverable, note: claimDisallowances.note })
    .from(claimDisallowances).where(and(eq(claimDisallowances.claimId, claimId), eq(claimDisallowances.eventId, claim.currentDecisionEventId)))
  const settlements = await db.select({ id: claimSettlements.id, utr: claimSettlements.utr, paymentDate: claimSettlements.paymentDate, receivedPaise: claimSettlements.receivedPaise, tdsPaise: claimSettlements.tdsPaise, bankChargesPaise: claimSettlements.bankChargesPaise, settledPaise: claimSettlements.settledPaise, bankCreditDate: claimSettlements.bankCreditDate, reconciledAt: claimSettlements.reconciledAt, recordedByName: claimSettlements.recordedByName })
    .from(claimSettlements).where(eq(claimSettlements.claimId, claimId)).orderBy(asc(claimSettlements.id))
  const writeOffs = await db.select({ id: claimWriteOffs.id, amountPaise: claimWriteOffs.amountPaise, reasonCode: claimWriteOffs.reasonCode, note: claimWriteOffs.note, status: claimWriteOffs.status, requestedByName: claimWriteOffs.requestedByName, requestedByUserId: claimWriteOffs.requestedByUserId, decidedByName: claimWriteOffs.decidedByName, decidedAt: claimWriteOffs.decidedAt })
    .from(claimWriteOffs).where(eq(claimWriteOffs.claimId, claimId)).orderBy(asc(claimWriteOffs.id))

  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  const requiresAbha = payer?.requiresAbha ?? false
  const showAbha = requiresAbha && CLAIM_ABHA_READ_ROLES.includes(session.role) && patient.abha
  const allowed = CLAIM_ACTIONS.filter((a) => nextClaimStatus(claim.status, a, { hasSettlement: money.hasSettlement }) !== null)

  return {
    claim,
    patient: {
      id: patient.id, name: patient.name, uhid: patient.uhid, gender: patient.gender, dob: patient.dob, ageYears: patient.dob ? ageOnDate(patient.dob, today) : null,
      ...(showAbha ? { abhaNumber: formatAbhaNumber(normalizeAbhaNumber(patient.abha!)) } : {}),
    },
    policy,
    payer: { name: payer?.name ?? '', kind: payer?.kind ?? null, channel: payer?.channel ?? 'portal', slaHours: payer?.slaHours ?? 1, settlementSlaDays: payer?.settlementSlaDays ?? 30, requiresAbha },
    preauth: preauth ?? null,
    invoices: invoiceRows,
    documents: docs.map((d) => ({ ...d, waived: d.source === 'waiver' })),
    readiness: readiness.result,
    versions: versions.map((v) => ({
      id: v.id, version: v.version, kind: v.kind, createdAt: v.createdAt, createdByName: v.createdByName, snapshotSha256: v.snapshotSha256,
      dispatch: v.dId === null ? null : { id: v.dId, channel: v.channel!, transport: v.transport!, trackingReference: v.trackingReference, dispatchedOn: v.dispatchedOn!, insurerReference: v.insurerReference, acknowledgedOn: v.acknowledgedOn },
    })),
    events,
    queries: queries.map((q) => ({ id: q.id, question: q.question, raisedOn: q.raisedOn, dueOn: q.dueOn, status: q.status, responses: responses.filter((r) => r.queryId === q.id).map((r) => ({ id: r.id, body: r.body, respondedOn: r.respondedOn, byName: r.byName })) })),
    disallowances,
    settlements,
    writeOffs,
    money: { ...money, coveredPendingPaise: claimCoveredPendingPaise(money), writeOffCeilingPaise: writeOffCeilingPaise(money), insurerOutstandingPaise: insurerOutstandingPaise(money) },
    slaFlags: claimSlaFlags({
      status: claim.status, episodeEndDate: episode?.endDate ?? null, firstSubmittedOn: claim.firstSubmittedAt ? istDateOf(claim.firstSubmittedAt) : null,
      openQueryDueDates: queries.filter((q) => q.status === 'open').map((q) => q.dueOn), today,
      payer: { submissionWindowDays: payer?.submissionWindowDays ?? 15, claimSettlementSlaDays: payer?.settlementSlaDays ?? 30 },
    }),
    codingDrift: drift,
    allowedActions: [...allowed, 'note'],
    reasonCodes,
  }
}
