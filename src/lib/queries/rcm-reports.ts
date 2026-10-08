// SP7: RCM reports. Ranges are inclusive IST calendar dates on the claim's first submission.
// Patient fields are UHID and name only; no policy number, member id, UTR or diagnosis.
import { sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { paiseFromDb } from '@/lib/billing/amounts'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'
import { AGING_BUCKETS, agingBucketLabel, daysBetweenIso } from '@/lib/rcm/sla'
import type { ReasonCategory } from '@/lib/rcm/constants'
import { paiseToRupeeString, type CsvCell } from '@/lib/rcm/csv'

export interface DateRange { from: string; to: string }

const firstSubmittedIst = sql`(c.first_submitted_at at time zone 'UTC' at time zone 'Asia/Kolkata')::date`
const inRange = (r: DateRange) => sql`${firstSubmittedIst} between ${r.from}::date and ${r.to}::date`

/** Insurer outstanding per live claim, bucketed by days since first submission, per billing payer. */
export async function agingByPayer(now: Date = new Date()): Promise<{ payerId: number; payerName: string; buckets: Record<string, number>; totalPaise: number }[]> {
  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  const r = await getDb().execute<{ payer_id: number; payer_name: string; first_on: string; outstanding: string }>(sql`
    select c.billing_payer_id as payer_id, p.name as payer_name, ${firstSubmittedIst}::text as first_on,
      greatest(0, coalesce(c.approved_paise, c.claimed_paise) - c.settled_paise)::text as outstanding
    from claims c join payers p on p.id = c.billing_payer_id
    where c.status in ('submitted', 'queried', 'approved', 'partially_approved', 'appealed', 'settled') and c.first_submitted_at is not null`)
  const out = new Map<number, { payerId: number; payerName: string; buckets: Record<string, number>; totalPaise: number }>()
  for (const row of r.rows) {
    const paise = paiseFromDb(row.outstanding)
    if (paise <= 0) continue
    const e = out.get(row.payer_id) ?? { payerId: row.payer_id, payerName: row.payer_name, buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b.label, 0])), totalPaise: 0 }
    const label = agingBucketLabel(daysBetweenIso(row.first_on, today))
    e.buckets[label] += paise
    e.totalPaise += paise
    out.set(row.payer_id, e)
  }
  return [...out.values()].sort((a, b) => b.totalPaise - a.totalPaise || a.payerName.localeCompare(b.payerName))
}

/** The current decision's deductions, grouped by reason, with the patient-recoverable split. */
export async function denialAnalysis(range: DateRange): Promise<{ reasonCode: string; label: string; category: ReasonCategory; claims: number; amountPaise: number; patientRecoverablePaise: number }[]> {
  const r = await getDb().execute<{ code: string; label: string; category: ReasonCategory; claims: number; amount: string; recoverable: string }>(sql`
    select d.reason_code as code, rc.label, rc.category, count(distinct d.claim_id)::int as claims, sum(d.amount_paise)::text as amount,
      coalesce(sum(case when d.patient_recoverable then d.amount_paise else 0 end), 0)::text as recoverable
    from claim_disallowances d
    join claims c on c.id = d.claim_id and c.current_decision_event_id = d.event_id
    join rcm_reason_codes rc on rc.code = d.reason_code
    where ${inRange(range)}
    group by d.reason_code, rc.label, rc.category, rc.sort_order
    order by sum(d.amount_paise) desc, rc.sort_order`)
  return r.rows.map((x) => ({ reasonCode: x.code, label: x.label, category: x.category, claims: x.claims, amountPaise: paiseFromDb(x.amount), patientRecoverablePaise: paiseFromDb(x.recoverable) }))
}

/** Per billing payer: volumes, approval rate (basis points, exact) and average days from first submission to first settlement. */
export async function payerPerformance(range: DateRange): Promise<{
  payerId: number; payerName: string; claims: number; claimedPaise: number; approvedPaise: number; settledPaise: number; tdsPaise: number; disallowedPaise: number
  writtenOffPaise: number; approvalRateBp: number; avgDaysToSettle: number | null
}[]> {
  const r = await getDb().execute<{
    payer_id: number; payer_name: string; claims: number; claimed: string; approved: string; settled: string; tds: string; disallowed: string; written_off: string; avg_days: string | null
  }>(sql`
    select c.billing_payer_id as payer_id, p.name as payer_name, count(*)::int as claims, sum(c.claimed_paise)::text as claimed,
      coalesce(sum(c.approved_paise), 0)::text as approved, sum(c.settled_paise)::text as settled,
      coalesce(sum((select sum(s.tds_paise) from claim_settlements s where s.claim_id = c.id)), 0)::text as tds,
      sum(c.disallowed_paise)::text as disallowed, sum(c.written_off_paise)::text as written_off,
      avg(((select min(s.recorded_at) from claim_settlements s where s.claim_id = c.id) at time zone 'UTC' at time zone 'Asia/Kolkata')::date - ${firstSubmittedIst})::text as avg_days
    from claims c join payers p on p.id = c.billing_payer_id
    where ${inRange(range)} and c.status <> 'withdrawn'
    group by c.billing_payer_id, p.name
    order by p.name`)
  return r.rows.map((x) => {
    const claimed = paiseFromDb(x.claimed)
    const approved = paiseFromDb(x.approved)
    return {
      payerId: x.payer_id, payerName: x.payer_name, claims: x.claims, claimedPaise: claimed, approvedPaise: approved, settledPaise: paiseFromDb(x.settled),
      tdsPaise: paiseFromDb(x.tds), disallowedPaise: paiseFromDb(x.disallowed), writtenOffPaise: paiseFromDb(x.written_off),
      approvalRateBp: claimed === 0 ? 0 : Number((BigInt(approved) * BigInt(10000) + BigInt(claimed) / BigInt(2)) / BigInt(claimed)),
      avgDaysToSettle: x.avg_days === null ? null : Math.round(Number(x.avg_days) * 10) / 10,
    }
  })
}

export const CLAIM_REGISTER_HEADER = ['Claim number', 'Status', 'Claim type', 'UHID', 'Patient', 'Payer', 'First submitted', 'Claimed (Rs)', 'Approved (Rs)', 'Settled (Rs)', 'TDS (Rs)', 'Written off (Rs)', 'Insurer reference']

export async function claimRegisterRows(range: DateRange): Promise<CsvCell[][]> {
  const r = await getDb().execute<{
    claim_number: string; status: string; claim_type: string; uhid: string | null; name: string; payer: string; first_on: string
    claimed: string; approved: string | null; settled: string; tds: string; written_off: string; insurer_ref: string | null
  }>(sql`
    select c.claim_number, c.status, c.claim_type, pt.uhid, pt.name, p.name as payer, ${firstSubmittedIst}::text as first_on,
      c.claimed_paise::text as claimed, c.approved_paise::text as approved, c.settled_paise::text as settled,
      coalesce((select sum(s.tds_paise) from claim_settlements s where s.claim_id = c.id), 0)::text as tds, c.written_off_paise::text as written_off,
      c.insurer_claim_reference as insurer_ref
    from claims c join patients pt on pt.id = c.patient_id join payers p on p.id = c.billing_payer_id
    where ${inRange(range)}
    order by c.first_submitted_at, c.id`)
  return [
    CLAIM_REGISTER_HEADER,
    ...r.rows.map((x): CsvCell[] => [
      x.claim_number, x.status, x.claim_type, x.uhid, x.name, x.payer, x.first_on,
      paiseToRupeeString(paiseFromDb(x.claimed)), x.approved === null ? null : paiseToRupeeString(paiseFromDb(x.approved)), paiseToRupeeString(paiseFromDb(x.settled)),
      paiseToRupeeString(paiseFromDb(x.tds)), paiseToRupeeString(paiseFromDb(x.written_off)), x.insurer_ref,
    ]),
  ]
}

/** Validates a report range: real dates, from ≤ to, at most 366 days. */
export function rangeProblem(from: string, to: string): string | null {
  const ok = (s: string) => isoDateSchema.safeParse(s).success
  if (!ok(from) || !ok(to) || from > to) return 'Choose a valid date range'
  if (daysBetweenIso(from, to) > 366) return 'Choose at most one year'
  return null
}
