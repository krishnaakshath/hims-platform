// SP7: the RCM dashboard, claim worklists and "ready to claim" candidates. Reads only; patient
// fields are the RCM minimum (id, name, UHID). Ages and SLA dates are IST calendar dates.
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { admissions, claims, claimSettlements, encounters, patients, payerProfiles, payers, rcmQueries } from '@/db/schema'
import { paiseFromDb, sumPaise } from '@/lib/billing/amounts'
import { DEFAULT_TIMEZONE, istDateOf, todayIsoIn } from '@/lib/india-time'
import { insurerOutstandingPaise } from '@/lib/rcm/amounts'
import { CLAIM_WORKLISTS, claimWorklists, type ClaimStatus, type ClaimWorklist } from '@/lib/rcm/claim-status'
import type { ClaimType } from '@/lib/rcm/constants'
import { AGING_BUCKETS, SLA_FLAGS, agingBucketLabel, claimSlaFlags, daysBetweenIso, preauthDecisionOverdue, type SlaFlag } from '@/lib/rcm/sla'

const PAGE_SIZE = 50
const billingPayer = alias(payers, 'rcm_billing_payer')
const billingProfile = alias(payerProfiles, 'rcm_billing_profile')

// Hospital-side denial still open: absorbed deductions plus any short payment, less write-offs.
const openDenialSql = sql`greatest(0, ${claims.nonRecoverableDisallowedPaise} + case when ${claims.status} = 'settled' then greatest(0, coalesce(${claims.approvedPaise}, 0) - ${claims.settledPaise}) else 0 end - ${claims.writtenOffPaise})`
const unreconciledSql = sql`(select count(*)::int from claim_settlements s where s.claim_id = ${claims.id} and s.reconciled_at is null)`

/** The SQL predicate of one worklist (mirrors claimWorklists in src/lib/rcm/claim-status.ts). */
function worklistWhere(tab: ClaimWorklist): SQL {
  switch (tab) {
    case 'to_submit': return sql`${claims.status} = 'draft'`
    case 'queried': return sql`${claims.status} = 'queried'`
    case 'awaiting_insurer': return sql`${claims.status} in ('submitted', 'appealed', 'approved', 'partially_approved')`
    case 'to_reconcile': return sql`${unreconciledSql} > 0`
    case 'denied': return sql`(${claims.status} = 'rejected' or (${claims.status} in ('partially_approved', 'settled') and ${openDenialSql} > 0))`
  }
}

export interface ClaimListRow {
  id: number; claimNumber: string; status: ClaimStatus; claimType: ClaimType
  patient: { id: string; name: string; uhid: string | null }; payerName: string
  claimedPaise: number; approvedPaise: number | null; settledPaise: number; insurerOutstandingPaise: number
  ageDays: number | null; agingBucket: string | null; slaFlags: SlaFlag[]; worklists: ClaimWorklist[]
}

const rowSelect = {
  id: claims.id, claimNumber: claims.claimNumber, status: claims.status, claimType: claims.claimType,
  patientId: patients.id, patientName: patients.name, uhid: patients.uhid, payerName: billingPayer.name,
  claimedPaise: claims.claimedPaise, approvedPaise: claims.approvedPaise, settledPaise: claims.settledPaise, writtenOffPaise: claims.writtenOffPaise,
  nonRecoverableDisallowedPaise: claims.nonRecoverableDisallowedPaise, firstSubmittedAt: claims.firstSubmittedAt,
  admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt, encounterDate: encounters.encounterDate, completedAt: encounters.completedAt,
  submissionWindowDays: billingProfile.submissionWindowDays, claimSettlementSlaDays: billingProfile.claimSettlementSlaDays,
  unreconciled: sql<number>`${unreconciledSql}`, openDenial: sql<string>`${openDenialSql}`,
}
type RawRow = { [K in keyof typeof rowSelect]: unknown } & {
  id: number; claimNumber: string; status: ClaimStatus; claimType: ClaimType; patientId: string; patientName: string; uhid: string | null; payerName: string
  claimedPaise: number; approvedPaise: number | null; settledPaise: number; writtenOffPaise: number; nonRecoverableDisallowedPaise: number; firstSubmittedAt: Date | null
  admittedAt: Date | null; dischargedAt: Date | null; encounterDate: string | null; completedAt: Date | null
  submissionWindowDays: number | null; claimSettlementSlaDays: number | null; unreconciled: number; openDenial: string
}

function baseQuery() {
  return getDb().select(rowSelect).from(claims)
    .innerJoin(patients, eq(patients.id, claims.patientId))
    .innerJoin(billingPayer, eq(billingPayer.id, claims.billingPayerId))
    .leftJoin(billingProfile, eq(billingProfile.payerId, claims.billingPayerId))
    .leftJoin(admissions, eq(admissions.id, claims.admissionId))
    .leftJoin(encounters, eq(encounters.id, claims.encounterId))
}

function toRow(r: RawRow, dueDates: string[], today: string): ClaimListRow {
  const firstSubmittedOn = r.firstSubmittedAt ? istDateOf(r.firstSubmittedAt) : null
  // A stay ends at discharge (null while admitted); a visit at completion, else its date.
  const episodeEndDate = r.dischargedAt ? istDateOf(r.dischargedAt) : r.admittedAt ? null : r.completedAt ? istDateOf(r.completedAt) : r.encounterDate
  const ageDays = firstSubmittedOn ? Math.max(0, daysBetweenIso(firstSubmittedOn, today)) : null
  const money = {
    status: r.status, claimedPaise: r.claimedPaise, approvedPaise: r.approvedPaise, nonRecoverableDisallowedPaise: r.nonRecoverableDisallowedPaise,
    settledPaise: r.settledPaise, writtenOffPaise: r.writtenOffPaise, pendingWriteOffPaise: 0,
  }
  return {
    id: r.id, claimNumber: r.claimNumber, status: r.status, claimType: r.claimType,
    patient: { id: r.patientId, name: r.patientName, uhid: r.uhid }, payerName: r.payerName,
    claimedPaise: r.claimedPaise, approvedPaise: r.approvedPaise, settledPaise: r.settledPaise, insurerOutstandingPaise: insurerOutstandingPaise(money),
    ageDays, agingBucket: ageDays === null ? null : agingBucketLabel(ageDays),
    slaFlags: claimSlaFlags({
      status: r.status, episodeEndDate, firstSubmittedOn, openQueryDueDates: dueDates, today,
      payer: { submissionWindowDays: r.submissionWindowDays ?? 15, claimSettlementSlaDays: r.claimSettlementSlaDays ?? 30 },
    }),
    worklists: claimWorklists({ status: r.status, unreconciledSettlements: r.unreconciled, openDenialPaise: paiseFromDb(r.openDenial) }),
  }
}

async function openQueryDueDates(claimIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  if (claimIds.length === 0) return out
  const rows = await getDb().select({ claimId: rcmQueries.claimId, dueOn: rcmQueries.dueOn }).from(rcmQueries)
    .where(and(inArray(rcmQueries.claimId, claimIds), eq(rcmQueries.status, 'open')))
  for (const r of rows) if (r.claimId !== null) out.set(r.claimId, [...(out.get(r.claimId) ?? []), r.dueOn])
  return out
}

export async function listClaims(opts: { tab?: ClaimWorklist; status?: ClaimStatus; payerId?: number; q?: string; page?: number; now?: Date } = {}): Promise<{ rows: ClaimListRow[]; total: number }> {
  const now = opts.now ?? new Date()
  const page = Math.max(1, opts.page ?? 1)
  const term = opts.q?.trim()
  const escaped = term ? term.replace(/[\\%_]/g, (c) => `\\${c}`) : ''
  const where = and(
    opts.tab ? worklistWhere(opts.tab) : undefined,
    opts.status ? eq(claims.status, opts.status) : undefined,
    opts.payerId ? eq(claims.billingPayerId, opts.payerId) : undefined,
    term ? or(ilike(claims.claimNumber, `${escaped}%`), sql`upper(${patients.uhid}) = upper(${term})`) : undefined,
  )
  const [rows, count] = await Promise.all([
    baseQuery().where(where).orderBy(desc(claims.updatedAt), desc(claims.id)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE),
    getDb().select({ n: sql<number>`count(*)::int` }).from(claims).innerJoin(patients, eq(patients.id, claims.patientId)).where(where),
  ])
  const due = await openQueryDueDates(rows.map((r) => r.id))
  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  return { rows: rows.map((r) => toRow(r as RawRow, due.get(r.id) ?? [], today)), total: count[0]?.n ?? 0 }
}

export interface ClaimCandidate {
  patient: { id: string; name: string; uhid: string | null }; admissionId: number | null; encounterId: number | null; policyId: number
  payerName: string; invoiceCount: number; availablePaise: number; episodeEndDate: string | null; slaFlags: SlaFlag[]
}

/** Episodes with an active policy whose billing payer has finalised invoices not yet fully claimed. */
export async function listClaimCandidates(now: Date = new Date()): Promise<ClaimCandidate[]> {
  const r = await getDb().execute<{
    patient_id: string; name: string; uhid: string | null; admission_id: number | null; encounter_id: number | null; policy_id: number; payer_name: string
    invoice_count: number; available: string; discharged_at: Date | null; completed_at: Date | null; window_days: number | null
  }>(sql`
    with avail as (
      select i.id, i.patient_id, i.admission_id, case when i.admission_id is null then i.encounter_id end as encounter_id, i.payer_id,
        i.total_paise - coalesce((select sum(ci.claimed_paise) from claim_invoices ci join claims c on c.id = ci.claim_id
          where ci.invoice_id = i.id and c.status <> 'withdrawn'), 0) as available
      from invoices i where i.status = 'finalised' and i.payer_id is not null
    )
    select a.patient_id, p.name, p.uhid, a.admission_id, a.encounter_id, pp.id as policy_id, bp.name as payer_name,
      count(*)::int as invoice_count, sum(a.available)::text as available,
      ad.discharged_at, e.completed_at, prof.submission_window_days as window_days
    from avail a
    join patient_policies pp on pp.patient_id = a.patient_id and pp.status = 'active' and coalesce(pp.tpa_payer_id, pp.insurer_payer_id) = a.payer_id
    join patients p on p.id = a.patient_id
    join payers bp on bp.id = a.payer_id
    left join payer_profiles prof on prof.payer_id = a.payer_id
    left join admissions ad on ad.id = a.admission_id
    left join encounters e on e.id = a.encounter_id
    where a.available > 0
    group by a.patient_id, p.name, p.uhid, a.admission_id, a.encounter_id, pp.id, bp.name, ad.discharged_at, e.completed_at, prof.submission_window_days
    order by coalesce(ad.discharged_at, e.completed_at) asc nulls last, a.patient_id
    limit 200`)
  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  return r.rows.map((row) => {
    const end = row.discharged_at ? istDateOf(new Date(row.discharged_at)) : row.completed_at ? istDateOf(new Date(row.completed_at)) : null
    return {
      patient: { id: row.patient_id, name: row.name, uhid: row.uhid }, admissionId: row.admission_id, encounterId: row.encounter_id, policyId: row.policy_id,
      payerName: row.payer_name, invoiceCount: row.invoice_count, availablePaise: paiseFromDb(row.available), episodeEndDate: end,
      slaFlags: claimSlaFlags({ status: 'draft', episodeEndDate: end, firstSubmittedOn: null, openQueryDueDates: [], today, payer: { submissionWindowDays: row.window_days ?? 15, claimSettlementSlaDays: 30 } }),
    }
  })
}

export interface RcmDashboard {
  counts: Record<ClaimWorklist, number> & { candidates: number; preauthsOverdue: number }
  slaBreaches: Record<SlaFlag, number>
  insurerOutstandingPaise: number
  aging: { label: string; paise: number }[]
  settledThisMonthPaise: number
  tdsThisMonthPaise: number
}

export async function getRcmDashboard(now: Date = new Date()): Promise<RcmDashboard> {
  const db = getDb()
  const live = await baseQuery().where(sql`${claims.status} not in ('closed', 'withdrawn')`)
  const due = await openQueryDueDates(live.map((r) => r.id))
  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  const rows = live.map((r) => toRow(r as RawRow, due.get(r.id) ?? [], today))
  const counts = Object.fromEntries(CLAIM_WORKLISTS.map((w) => [w, rows.filter((r) => r.worklists.includes(w)).length])) as Record<ClaimWorklist, number>
  const slaBreaches = Object.fromEntries(SLA_FLAGS.map((f) => [f, rows.filter((r) => r.slaFlags.includes(f)).length])) as Record<SlaFlag, number>

  const pre = await db.execute<{ status: 'requested' | 'enhancement_requested'; last_requested_at: Date | null; sla: number | null }>(sql`
    select pa.status, pa.last_requested_at, prof.preauth_sla_hours as sla from preauths pa
    left join payer_profiles prof on prof.payer_id = coalesce(pa.tpa_payer_id, pa.insurer_payer_id)
    where pa.status in ('requested', 'enhancement_requested')`)
  const preauthsOverdue = pre.rows.filter((p) => preauthDecisionOverdue({
    status: p.status, lastRequestedAt: p.last_requested_at ? new Date(p.last_requested_at) : null, now, preauthSlaHours: p.sla ?? 1,
  })).length

  const monthStart = `${today.slice(0, 8)}01`
  const [month] = await db.select({
    settled: sql<string | null>`sum(${claimSettlements.settledPaise})`, tds: sql<string | null>`sum(${claimSettlements.tdsPaise})`,
  }).from(claimSettlements).where(and(sql`${claimSettlements.paymentDate} >= ${monthStart}`, sql`${claimSettlements.paymentDate} <= ${today}`))

  return {
    counts: { ...counts, candidates: (await listClaimCandidates(now)).length, preauthsOverdue },
    slaBreaches,
    insurerOutstandingPaise: sumPaise(rows.map((r) => r.insurerOutstandingPaise)),
    aging: AGING_BUCKETS.map((b) => ({ label: b.label, paise: sumPaise(rows.filter((r) => r.agingBucket === b.label).map((r) => r.insurerOutstandingPaise)) })),
    settledThisMonthPaise: paiseFromDb(month?.settled ?? null),
    tdsThisMonthPaise: paiseFromDb(month?.tds ?? null),
  }
}
