// WS12 R15: what needs insurance attention today (IST), for the /rcm dashboard tiles.
// Counts and UHIDs only; no insurer references or documents.
import { and, asc, between, eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, claims, coverageVerifications, patientPolicies, patients, payers } from '@/db/schema'
import { istDayBounds, todayIsoIn } from '@/lib/india-time'
import { getHospitalIdentifiers } from './rcm-payers'

export interface ExpiringPolicy { policyId: number; patientId: string; uhid: string | null; name: string; payerName: string; validTo: string }
export interface UnverifiedAdmission { admissionId: number; patientId: string; uhid: string | null; name: string; payerName: string }
export interface InsuranceAttention {
  policiesExpiringIn7Days: number
  admissionsTodayUnverified: UnverifiedAdmission[]
  claimsBlockedByIdentifiers: number
}

export const EXPIRING_DAYS = 7

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Active policies whose valid_to falls in [today, today+7] (IST), soonest first. */
export async function listExpiringPolicies(now: Date = new Date()): Promise<ExpiringPolicy[]> {
  const today = todayIsoIn(undefined, now)
  const rows = await getDb()
    .select({ policyId: patientPolicies.id, patientId: patientPolicies.patientId, uhid: patients.uhid, name: patients.name, payerName: payers.name, validTo: patientPolicies.validTo })
    .from(patientPolicies)
    .innerJoin(patients, eq(patients.id, patientPolicies.patientId))
    .innerJoin(payers, eq(payers.id, patientPolicies.insurerPayerId))
    .where(and(eq(patientPolicies.status, 'active'), between(patientPolicies.validTo, today, addDaysIso(today, EXPIRING_DAYS))))
    .orderBy(asc(patientPolicies.validTo), asc(patientPolicies.id))
  return rows
}

export async function getInsuranceAttention(now: Date = new Date()): Promise<InsuranceAttention> {
  const db = getDb()
  const { start, end } = istDayBounds(now)
  const [expiring, unverified, ids] = await Promise.all([
    listExpiringPolicies(now),
    db.select({ admissionId: admissions.id, patientId: admissions.patientId, uhid: patients.uhid, name: patients.name, payerName: payers.name })
      .from(admissionCoverage)
      .innerJoin(admissions, eq(admissions.id, admissionCoverage.admissionId))
      .innerJoin(patients, eq(patients.id, admissions.patientId))
      .innerJoin(patientPolicies, eq(patientPolicies.id, admissionCoverage.policyId))
      .innerJoin(payers, eq(payers.id, patientPolicies.insurerPayerId))
      .where(and(
        eq(admissionCoverage.mode, 'cashless'),
        sql`${admissions.admittedAt} >= ${start} AND ${admissions.admittedAt} < ${end}`,
        // Verified means the current answer (newest unexpired non-error one, as currentVerification
        // picks it) is active; a current inactive answer leaves the admission on the list.
        sql`NOT COALESCE((SELECT cv.result = 'active' FROM ${coverageVerifications} cv WHERE cv.policy_id = ${admissionCoverage.policyId} AND cv.valid_until > ${now} AND cv.result <> 'error' ORDER BY cv.verified_at DESC, cv.id DESC LIMIT 1), false)`,
      ))
      .orderBy(asc(admissions.admittedAt), asc(admissions.id)),
    getHospitalIdentifiers(),
  ])
  let claimsBlockedByIdentifiers = 0
  if (!ids.rohiniId?.trim() && !ids.hfrId?.trim()) {
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(claims).where(eq(claims.status, 'draft'))
    claimsBlockedByIdentifiers = c?.n ?? 0
  }
  return { policiesExpiringIn7Days: expiring.length, admissionsTodayUnverified: unverified, claimsBlockedByIdentifiers }
}
