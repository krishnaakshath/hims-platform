import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, encounters, patients, providers } from '@/db/schema'
import { ageOnDate } from '@/lib/india-time'
import { ENCOUNTER_STATUSES, type EncounterStatus } from '@/lib/encounters/status'
import { REGISTER_ROW_LIMIT, type EncounterRegisterRow, type RegisterFilters } from '@/lib/encounters/register'

// Wave F P1-04: the OPD register over SP3 `encounters` (not appointments).
// Explicit minimal projection: the patient's name, UHID, DOB (only to derive
// the age on the visit date; not returned), gender and chart id. Never the
// phone, address, ABHA or any national ID.

export interface EncounterRegister {
  rows: EncounterRegisterRow[]
  /** Rows matching every filter (may exceed rows.length when truncated). */
  total: number
  truncated: boolean
  /** Counts per status over every filter except the status filter. */
  statusCounts: Record<EncounterStatus, number>
}

function conditions(f: RegisterFilters, withStatus: boolean): SQL {
  const parts: SQL[] = [gte(encounters.encounterDate, f.from), lte(encounters.encounterDate, f.to)]
  if (f.type) parts.push(eq(encounters.encounterType, f.type))
  if (withStatus && f.status) parts.push(eq(encounters.status, f.status))
  if (f.departmentId !== null) parts.push(eq(encounters.departmentId, f.departmentId))
  if (f.providerId !== null) parts.push(eq(encounters.providerId, f.providerId))
  return and(...parts) as SQL
}

export async function listEncounterRegister(f: RegisterFilters, { limit = REGISTER_ROW_LIMIT }: { limit?: number } = {}): Promise<EncounterRegister> {
  const db = getDb()
  const raw = await db
    .select({
      id: encounters.id,
      encounterDate: sql<string>`${encounters.encounterDate}::text`,
      opdToken: encounters.opdToken,
      encounterType: encounters.encounterType,
      visitType: encounters.visitType,
      status: encounters.status,
      checkedInAt: encounters.checkedInAt,
      completedAt: encounters.completedAt,
      patientId: patients.id,
      patientName: patients.name,
      uhid: patients.uhid,
      dob: sql<string>`${patients.dob}::text`,
      gender: patients.gender,
      departmentName: departments.name,
      doctorName: providers.name,
    })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .where(conditions(f, true))
    .orderBy(desc(encounters.encounterDate), sql`${encounters.opdToken} asc nulls last`, asc(encounters.checkedInAt), asc(encounters.id))
    .limit(limit + 1)

  const counts = await db
    .select({ status: encounters.status, n: sql<number>`count(*)::int` })
    .from(encounters)
    .where(conditions(f, false))
    .groupBy(encounters.status)
  const statusCounts = Object.fromEntries(ENCOUNTER_STATUSES.map((s) => [s, 0])) as Record<EncounterStatus, number>
  for (const c of counts) statusCounts[c.status] = Number(c.n)
  const total = f.status ? statusCounts[f.status] : Object.values(statusCounts).reduce((a, b) => a + b, 0)

  const truncated = raw.length > limit
  const rows: EncounterRegisterRow[] = raw.slice(0, limit).map((r) => ({
    id: r.id,
    encounterDate: r.encounterDate,
    opdToken: r.opdToken,
    encounterType: r.encounterType,
    visitType: r.visitType,
    status: r.status,
    checkedInAt: r.checkedInAt,
    completedAt: r.completedAt,
    patientId: r.patientId,
    patientName: r.patientName.trim(),
    uhid: r.uhid,
    ageYears: ageOnDate(r.dob, r.encounterDate),
    gender: r.gender,
    departmentName: r.departmentName ?? null,
    doctorName: r.doctorName,
  }))
  return { rows, total, truncated, statusCounts }
}
