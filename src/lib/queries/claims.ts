// SP7: claim drafts built from finalised SP4 invoices (ruling 2), their system documents and
// the readiness loader. Every write takes the SP4 per-patient billing lock first, then the claim
// row FOR UPDATE, so two clerks can never claim more than an invoice's total.
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, claimDocuments, claimInvoices, claims, encounters, invoices, labReports, patientPolicies, patients, payerDocumentRequirements,
  payerNetworks, payerProfiles, preauthDocuments, preauths, type ClaimRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { paiseFromDb, sumPaise } from '@/lib/billing/amounts'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { istDateOf, startOfIstDay } from '@/lib/india-time'
import { formatRcmNumber, type ClaimDocumentKind, type DocumentSource } from '@/lib/rcm/constants'
import { rcmFail, rcmOk, type RcmWriteResult } from '@/lib/rcm/errors'
import { isLiveApprovedPreauth } from '@/lib/rcm/preauth-status'
import { checkClaimReadiness, requiredDocumentKinds, type ClaimReadinessInput } from '@/lib/rcm/readiness'
import type { ClaimCreateInput } from '@/lib/rcm/validation'
import { lockPatientBilling } from './billing-lock'
import { getDischargeSummaryData } from './discharge-summary'
import type { WriteExecutor } from './executor'
import { loadPolicyContext } from './rcm-context'
import { getEncounterCodingGate } from './coding'
import { getHospitalIdentifiers } from './rcm-payers'

// ---- episodes -----------------------------------------------------------------------------

export interface Episode { patientId: string; admissionId: number | null; encounterId: number | null; codingEncounterId: number | null; startDate: string; endDate: string | null }

/** An admission (IPD/daycare) or an OPD encounter, with IST start/end dates and the encounter coding is read from. */
export async function episodeOf(executor: WriteExecutor, ref: { admissionId: number } | { encounterId: number }): Promise<Episode | null> {
  if ('admissionId' in ref) {
    const [a] = await executor.select({ patientId: admissions.patientId, admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt })
      .from(admissions).where(eq(admissions.id, ref.admissionId)).limit(1)
    if (!a) return null
    const [e] = await executor.select({ id: encounters.id }).from(encounters).where(eq(encounters.admissionId, ref.admissionId)).limit(1)
    return {
      patientId: a.patientId, admissionId: ref.admissionId, encounterId: null, codingEncounterId: e?.id ?? null,
      startDate: istDateOf(a.admittedAt), endDate: a.dischargedAt ? istDateOf(a.dischargedAt) : null,
    }
  }
  const [e] = await executor.select({ patientId: encounters.patientId, date: encounters.encounterDate, completedAt: encounters.completedAt })
    .from(encounters).where(eq(encounters.id, ref.encounterId)).limit(1)
  if (!e) return null
  return { patientId: e.patientId, admissionId: null, encounterId: ref.encounterId, codingEncounterId: ref.encounterId, startDate: e.date, endDate: e.completedAt ? istDateOf(e.completedAt) : null }
}

const episodeRefOf = (c: { admissionId: number | null; encounterId: number | null }) =>
  c.admissionId !== null ? { admissionId: c.admissionId } : { encounterId: c.encounterId! }

// ---- claimable invoices ---------------------------------------------------------------------

export interface ClaimableInvoice { invoiceId: number; number: string; date: string; totalPaise: number; claimedElsewherePaise: number; availablePaise: number }

/** The episode's finalised invoices billed to `billingPayerId`, with what other live claims already claim. */
export async function listClaimableInvoices(executor: WriteExecutor, episode: Episode, billingPayerId: number, excludeClaimId?: number): Promise<ClaimableInvoice[]> {
  const scope = episode.admissionId !== null ? eq(invoices.admissionId, episode.admissionId) : and(eq(invoices.encounterId, episode.encounterId!), isNull(invoices.admissionId))
  const rows = await executor.select({ id: invoices.id, number: invoices.invoiceNumber, date: invoices.invoiceDate, total: invoices.totalPaise })
    .from(invoices).where(and(eq(invoices.patientId, episode.patientId), eq(invoices.status, 'finalised'), eq(invoices.payerId, billingPayerId), scope))
    .orderBy(asc(invoices.invoiceDate), asc(invoices.id))
  if (rows.length === 0) return []
  const claimed = await executor.select({ invoiceId: claimInvoices.invoiceId, sum: sql<string>`sum(${claimInvoices.claimedPaise})` })
    .from(claimInvoices).innerJoin(claims, eq(claims.id, claimInvoices.claimId))
    .where(and(inArray(claimInvoices.invoiceId, rows.map((r) => r.id)), ne(claims.status, 'withdrawn'), excludeClaimId === undefined ? undefined : ne(claims.id, excludeClaimId)))
    .groupBy(claimInvoices.invoiceId)
  const elsewhere = new Map(claimed.map((c) => [c.invoiceId, paiseFromDb(c.sum)]))
  return rows.map((r) => {
    const total = r.total ?? 0
    const other = elsewhere.get(r.id) ?? 0
    return { invoiceId: r.id, number: r.number ?? '', date: r.date ?? '', totalPaise: total, claimedElsewherePaise: other, availablePaise: Math.max(0, total - other) }
  })
}

/** Resolves the requested invoices against the claimable set (ruling 2: never past an invoice's total). */
function pickInvoices(claimable: ClaimableInvoice[], requested: ClaimCreateInput['invoices']): RcmWriteResult<{ invoice: ClaimableInvoice; claimedPaise: number }[]> {
  const byId = new Map(claimable.map((c) => [c.invoiceId, c]))
  const out: { invoice: ClaimableInvoice; claimedPaise: number }[] = []
  for (const r of requested) {
    const inv = byId.get(r.invoiceId)
    if (!inv) return rcmFail('invoice_unavailable')
    const claimedPaise = r.claimedPaise ?? inv.availablePaise
    if (claimedPaise < 1 || claimedPaise > inv.availablePaise) return rcmFail('invoice_over_claimed')
    out.push({ invoice: inv, claimedPaise })
  }
  return rcmOk(out)
}

// ---- system documents -------------------------------------------------------------------------

interface SystemDoc { kind: ClaimDocumentKind; source: DocumentSource; title: string; sourceId: number; sha256: string | null; contentType: string | null }

const contentTypeOfUrl = (url: string) => (url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')

/**
 * Attaches the documents the system already holds, idempotently (a kind+source+sourceId that is
 * already live is skipped): the itemised bill per invoice, the discharge summary of a discharged
 * stay, the policy card front, the pre-auth approval letters, and the patient's lab reports
 * released during the episode. Called inside the claim's transaction.
 */
export async function attachSystemDocuments(tx: WriteExecutor, claim: Pick<ClaimRow, 'id' | 'patientId' | 'admissionId' | 'encounterId' | 'policyId' | 'preauthId'>, byName: string): Promise<number> {
  const episode = await episodeOf(tx, episodeRefOf(claim))
  if (!episode) return 0
  const docs: SystemDoc[] = []
  const linked = await tx.select({ id: invoices.id, number: invoices.invoiceNumber }).from(claimInvoices)
    .innerJoin(invoices, eq(invoices.id, claimInvoices.invoiceId)).where(eq(claimInvoices.claimId, claim.id)).orderBy(asc(invoices.id))
  for (const inv of linked) docs.push({ kind: 'itemised_bill', source: 'invoice', title: inv.number ?? `Invoice ${inv.id}`, sourceId: inv.id, sha256: null, contentType: null })

  if (claim.admissionId !== null) {
    const [a] = await tx.select({ status: admissions.status }).from(admissions).where(eq(admissions.id, claim.admissionId)).limit(1)
    if (a?.status === 'discharged' && (await getDischargeSummaryData(claim.admissionId))) {
      docs.push({ kind: 'discharge_summary', source: 'discharge_summary', title: 'Discharge summary', sourceId: claim.admissionId, sha256: null, contentType: null })
    }
  }
  const [policy] = await tx.select({ url: patientPolicies.cardFrontBlobUrl, sha: patientPolicies.cardFrontSha256 }).from(patientPolicies).where(eq(patientPolicies.id, claim.policyId)).limit(1)
  if (policy?.url) docs.push({ kind: 'policy_card', source: 'policy_card', title: 'Policy card', sourceId: claim.policyId, sha256: policy.sha, contentType: contentTypeOfUrl(policy.url) })

  if (claim.preauthId !== null) {
    const letters = await tx.select({ id: preauthDocuments.id, title: preauthDocuments.title, sha: preauthDocuments.sha256, contentType: preauthDocuments.contentType })
      .from(preauthDocuments).where(and(eq(preauthDocuments.preauthId, claim.preauthId), eq(preauthDocuments.kind, 'preauth_approval'))).orderBy(asc(preauthDocuments.id))
    for (const l of letters) docs.push({ kind: 'preauth_approval', source: 'preauth_letter', title: l.title, sourceId: l.id, sha256: l.sha, contentType: l.contentType })
  }

  const from = startOfIstDay(episode.startDate)
  const to = startOfIstDay(addDaysIso(episode.endDate ?? episode.startDate, 1))
  const reports = await tx.select({ id: labReports.id, number: labReports.reportNumber, sha: labReports.sha256 }).from(labReports)
    .where(and(eq(labReports.patientId, claim.patientId), isNull(labReports.supersededAt), sql`${labReports.releasedAt} >= ${from}`, sql`${labReports.releasedAt} < ${to}`))
    .orderBy(asc(labReports.id))
  for (const r of reports) docs.push({ kind: 'investigation_reports', source: 'lab_report', title: `Lab report ${r.number}`, sourceId: r.id, sha256: r.sha, contentType: 'application/pdf' })

  const live = await tx.select({ kind: claimDocuments.kind, source: claimDocuments.source, sourceId: claimDocuments.sourceId }).from(claimDocuments)
    .where(and(eq(claimDocuments.claimId, claim.id), isNull(claimDocuments.supersededAt)))
  const key = (d: { kind: string; source: string; sourceId: number | null }) => `${d.kind}|${d.source}|${d.sourceId}`
  const have = new Set(live.map(key))
  const missing = docs.filter((d) => !have.has(key(d)))
  if (missing.length > 0) {
    await tx.insert(claimDocuments).values(missing.map((d) => ({
      claimId: claim.id, kind: d.kind, source: d.source, title: d.title, sourceId: d.sourceId, sha256: d.sha256, contentType: d.contentType, uploadedByName: byName,
    })))
  }
  return missing.length
}

// ---- drafts -----------------------------------------------------------------------------------

export async function createClaimDraft(input: ClaimCreateInput, session: Session, now: Date = new Date()): Promise<RcmWriteResult<{ claimId: number; claimNumber: string }>> {
  const db = getDb()
  const ctx = await loadPolicyContext(db, input.policyId)
  if (!ctx || ctx.row.status !== 'active') return rcmFail('policy_not_found')
  if (!ctx.payersActive) return rcmFail('payer_inactive')
  const ref = input.admissionId !== undefined ? { admissionId: input.admissionId } : { encounterId: input.encounterId! }
  const pre = await episodeOf(db, ref)
  if (!pre || pre.patientId !== ctx.row.patientId) return rcmFail('context_mismatch')
  const patientId = pre.patientId

  return db.transaction(async (tx) => {
    await lockPatientBilling(tx, patientId)
    const episode = (await episodeOf(tx, ref))!
    if (input.preauthId !== undefined) {
      const [p] = await tx.select({ patientId: preauths.patientId, policyId: preauths.policyId, status: preauths.status }).from(preauths).where(eq(preauths.id, input.preauthId)).limit(1)
      if (!p || p.patientId !== patientId || p.policyId !== input.policyId || !isLiveApprovedPreauth(p.status)) return rcmFail('preauth_unavailable')
    }
    const picked = pickInvoices(await listClaimableInvoices(tx, episode, ctx.billingPayerId), input.invoices)
    if (!picked.ok) return picked
    const claimedPaise = sumPaise(picked.value.map((p) => p.claimedPaise))
    const seq = await tx.execute<{ n: string }>(sql`select nextval('claim_number_seq')::text as n`)
    const claimNumber = formatRcmNumber('CLM', istDateOf(now).slice(0, 4), Number(seq.rows[0].n))
    const [claim] = await tx.insert(claims).values({
      claimNumber, patientId, policyId: input.policyId, insurerPayerId: ctx.row.insurerPayerId, tpaPayerId: ctx.row.tpaPayerId, billingPayerId: ctx.billingPayerId,
      claimType: input.claimType, admissionId: episode.admissionId, encounterId: episode.encounterId, preauthId: input.preauthId ?? null,
      claimedPaise, lastStatusAt: now, createdByName: session.name, createdByUserId: session.userId, createdAt: now, updatedAt: now,
    }).returning()
    await tx.insert(claimInvoices).values(picked.value.map((p) => ({
      claimId: claim.id, invoiceId: p.invoice.invoiceId, invoiceTotalPaise: p.invoice.totalPaise, claimedPaise: p.claimedPaise, addedByName: session.name, addedAt: now,
    })))
    await attachSystemDocuments(tx, claim, session.name)
    await logAudit(session, 'rcm: created claim', patientId, `claim=${claim.id} number=${claimNumber} invoices=${picked.value.length} claimed=${claimedPaise}`, tx)
    return rcmOk({ claimId: claim.id, claimNumber })
  })
}

/** Replaces a draft claim's invoices (same checks, excluding this claim's own amounts). */
export async function setClaimInvoices(claimId: number, requested: ClaimCreateInput['invoices'], session: Session, now: Date = new Date()): Promise<RcmWriteResult<null>> {
  const [found] = await getDb().select({ patientId: claims.patientId }).from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!found) return rcmFail('claim_not_found')
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, found.patientId)
    const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId)).for('update')
    if (!claim) return rcmFail('claim_not_found')
    if (claim.status !== 'draft') return rcmFail('not_draft')
    const episode = await episodeOf(tx, episodeRefOf(claim))
    if (!episode) return rcmFail('context_mismatch')
    const picked = pickInvoices(await listClaimableInvoices(tx, episode, claim.billingPayerId, claimId), requested)
    if (!picked.ok) return picked
    const claimedPaise = sumPaise(picked.value.map((p) => p.claimedPaise))
    const keep = new Set(picked.value.map((p) => p.invoice.invoiceId))
    await tx.delete(claimInvoices).where(eq(claimInvoices.claimId, claimId))
    await tx.insert(claimInvoices).values(picked.value.map((p) => ({
      claimId, invoiceId: p.invoice.invoiceId, invoiceTotalPaise: p.invoice.totalPaise, claimedPaise: p.claimedPaise, addedByName: session.name, addedAt: now,
    })))
    // The itemised bills of invoices no longer on the claim are superseded (never deleted).
    const bills = await tx.select({ id: claimDocuments.id, sourceId: claimDocuments.sourceId }).from(claimDocuments)
      .where(and(eq(claimDocuments.claimId, claimId), eq(claimDocuments.source, 'invoice'), isNull(claimDocuments.supersededAt)))
    const stale = bills.filter((b) => b.sourceId === null || !keep.has(b.sourceId)).map((b) => b.id)
    if (stale.length > 0) await tx.update(claimDocuments).set({ supersededAt: now, supersededByName: session.name }).where(inArray(claimDocuments.id, stale))
    await tx.update(claims).set({ claimedPaise, rowVersion: claim.rowVersion + 1, updatedAt: now }).where(eq(claims.id, claimId))
    await attachSystemDocuments(tx, claim, session.name)
    await logAudit(session, 'rcm: changed claim invoices', claim.patientId, `claim=${claimId} invoices=${picked.value.length} claimed=${claimedPaise}`, tx)
    return rcmOk(null)
  })
}

// ---- readiness ------------------------------------------------------------------------------

/** Builds the readiness input of a claim from its current rows (invoice status is read live). */
export async function loadClaimReadiness(executor: WriteExecutor, claimId: number): Promise<{ input: ClaimReadinessInput; result: ReturnType<typeof checkClaimReadiness> } | null> {
  const [claim] = await executor.select().from(claims).where(eq(claims.id, claimId)).limit(1)
  if (!claim) return null
  const episode = await episodeOf(executor, episodeRefOf(claim))
  const ctx = await loadPolicyContext(executor, claim.policyId)
  if (!episode || !ctx) return null
  const linked = await executor.select({ id: invoices.id, number: invoices.invoiceNumber, status: invoices.status, totalPaise: invoices.totalPaise, claimedPaise: claimInvoices.claimedPaise })
    .from(claimInvoices).innerJoin(invoices, eq(invoices.id, claimInvoices.invoiceId)).where(eq(claimInvoices.claimId, claimId)).orderBy(asc(invoices.id))
  const gate = episode.codingEncounterId === null ? null : await getEncounterCodingGate(episode.codingEncounterId, executor)
  const [network] = claim.tpaPayerId === null ? [] : await executor.select({ id: payerNetworks.id }).from(payerNetworks)
    .where(and(eq(payerNetworks.insurerPayerId, claim.insurerPayerId), eq(payerNetworks.tpaPayerId, claim.tpaPayerId))).limit(1)
  const [profile] = await executor.select({ requiresPreauthForIpd: payerProfiles.requiresPreauthForIpd, requiresAbha: payerProfiles.requiresAbha, empanelmentStatus: payerProfiles.empanelmentStatus })
    .from(payerProfiles).where(eq(payerProfiles.payerId, claim.billingPayerId)).limit(1)
  const overrides = await executor.select({ documentKind: payerDocumentRequirements.documentKind, required: payerDocumentRequirements.required })
    .from(payerDocumentRequirements).where(and(eq(payerDocumentRequirements.payerId, claim.billingPayerId), eq(payerDocumentRequirements.claimType, claim.claimType)))
  const [preauth] = claim.preauthId === null ? [] : await executor.select({ status: preauths.status, approvedPaise: preauths.approvedPaise, validUntil: preauths.validUntil })
    .from(preauths).where(eq(preauths.id, claim.preauthId)).limit(1)
  const docs = await executor.select({ kind: claimDocuments.kind }).from(claimDocuments).where(and(eq(claimDocuments.claimId, claimId), isNull(claimDocuments.supersededAt)))
  const [patient] = await executor.select({ dob: patients.dob, gender: patients.gender, abha: patients.abhaNumber }).from(patients).where(eq(patients.id, claim.patientId)).limit(1)
  const hospital = await getHospitalIdentifiers(executor)

  const input: ClaimReadinessInput = {
    claimType: claim.claimType,
    claimedPaise: claim.claimedPaise,
    episodeStartDate: episode.startDate,
    invoices: linked.map((l) => ({ id: l.id, number: l.number, status: l.status, totalPaise: l.totalPaise, claimedPaise: l.claimedPaise })),
    coding: gate === null ? null : { finalised: gate.finalised },
    policy: { status: ctx.row.status, validFrom: ctx.row.validFrom, validTo: ctx.row.validTo, sumInsuredPaise: ctx.row.sumInsuredPaise, hasTpa: ctx.row.tpaPayerId !== null },
    tpaLinkedToInsurer: Boolean(network),
    payer: profile ?? { requiresPreauthForIpd: true, requiresAbha: false, empanelmentStatus: 'not_empanelled' },
    preauth: preauth ?? null,
    requiredDocuments: requiredDocumentKinds(claim.claimType, overrides),
    presentDocuments: [...new Set(docs.map((d) => d.kind))],
    patient: { dob: patient?.dob ?? null, gender: patient?.gender ?? null, hasAbha: Boolean(patient?.abha) },
    hospital: { rohiniId: hospital.rohiniId },
  }
  return { input, result: checkClaimReadiness(input) }
}

export async function getClaimReadiness(claimId: number): Promise<ReturnType<typeof checkClaimReadiness> | null> {
  return (await loadClaimReadiness(getDb(), claimId))?.result ?? null
}

// ---- the "new claim" screen -----------------------------------------------------------------------

export interface NewClaimContext {
  patient: { id: string; name: string; uhid: string | null }
  policyId: number
  claimType: 'ipd' | 'opd'
  admissionId: number | null
  encounterId: number | null
  invoices: ClaimableInvoice[]
  preauths: { id: number; preauthNumber: string; approvedPaise: number | null; validUntil: string | null }[]
}

/** The invoices and approved pre-auths a new claim for this episode and policy can use, or null when they do not belong together. */
export async function getNewClaimContext(ref: { admissionId: number } | { encounterId: number }, policyId: number): Promise<NewClaimContext | null> {
  const db = getDb()
  const [episode, ctx] = await Promise.all([episodeOf(db, ref), loadPolicyContext(db, policyId)])
  if (!episode || !ctx || ctx.row.patientId !== episode.patientId || ctx.row.status !== 'active') return null
  const [patient] = await db.select({ id: patients.id, name: patients.name, uhid: patients.uhid }).from(patients).where(eq(patients.id, episode.patientId)).limit(1)
  const live = await db.select({ id: preauths.id, preauthNumber: preauths.preauthNumber, approvedPaise: preauths.approvedPaise, validUntil: preauths.validUntil, status: preauths.status })
    .from(preauths).where(and(eq(preauths.patientId, episode.patientId), eq(preauths.policyId, policyId))).orderBy(asc(preauths.id))
  return {
    patient, policyId, claimType: episode.admissionId !== null ? 'ipd' : 'opd', admissionId: episode.admissionId, encounterId: episode.encounterId,
    invoices: (await listClaimableInvoices(db, episode, ctx.billingPayerId)).filter((i) => i.availablePaise > 0),
    preauths: live.filter((p) => isLiveApprovedPreauth(p.status)).map((p) => ({ id: p.id, preauthNumber: p.preauthNumber, approvedPaise: p.approvedPaise, validUntil: p.validUntil })),
  }
}
