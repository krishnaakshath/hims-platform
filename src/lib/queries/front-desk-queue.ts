// WS6 T9 (spec D6): the check-in dialog's queue length per clinical doctor. Waiting is today's
// (IST) OPD encounters still `checked_in` for that doctor; `in_consultation` is counted apart.
// Availability: on leave today; outside hours when the doctor has weekly sessions set up and the
// current IST time is in none of today's; otherwise available (a doctor with no sessions set up
// counts as available, as in the booking working-hours check, Ruling R16).
// A constant number of queries for the whole roster: doctors, sessions, leave, counts.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, encounters, providerLeave, providerSchedules, providers } from '@/db/schema'
import { istDateOf } from '@/lib/india-time'
import { withinWorkingHours, type Weekday, type WeeklySession } from '@/lib/scheduling/slots'
import { estimateWaitMinutes } from '@/lib/front-desk/wait-estimate'
import { clinicalDoctorCondition, type ClinicalDoctor } from './providers'

export type DoctorAvailability = 'available' | 'on_leave' | 'outside_hours'

export interface ProviderQueueSummary {
  providerId: number
  departmentId: number | null
  waiting: number
  inConsultation: number
  /** null while the doctor is not available (on leave or outside hours). */
  estimatedWaitMinutes: number | null
  availability: DoctorAvailability
}

/** Postgres `time` comes back as HH:MM:SS; sessions are HH:MM. */
const hhmm = (t: string) => t.slice(0, 5)

/** The one availability rule (summary and token slip): two queries for any number of doctors. */
export async function providerAvailability(ids: number[], now: Date = new Date()): Promise<Map<number, DoctorAvailability>> {
  const result = new Map<number, DoctorAvailability>()
  if (ids.length === 0) return result
  const db = getDb()
  const today = istDateOf(now)
  const [sessionRows, leaveRows] = await Promise.all([
    db.select({ providerId: providerSchedules.providerId, weekday: providerSchedules.weekday, startTime: providerSchedules.startTime, endTime: providerSchedules.endTime })
      .from(providerSchedules).where(inArray(providerSchedules.providerId, ids)),
    db.select({ providerId: providerLeave.providerId }).from(providerLeave)
      .where(and(inArray(providerLeave.providerId, ids), eq(providerLeave.leaveDate, today))),
  ])
  const sessionsOf = new Map<number, WeeklySession[]>()
  for (const r of sessionRows) {
    const list = sessionsOf.get(r.providerId) ?? []
    list.push({ weekday: r.weekday as Weekday, start: hhmm(r.startTime), end: hhmm(r.endTime) })
    sessionsOf.set(r.providerId, list)
  }
  const onLeave = new Set(leaveRows.map((r) => r.providerId))
  for (const id of ids) {
    const sessions = sessionsOf.get(id) ?? []
    result.set(id, onLeave.has(id)
      ? 'on_leave'
      : sessions.length > 0 && !withinWorkingHours({ startsAt: now, endsAt: now, sessions, onLeave: false })
        ? 'outside_hours'
        : 'available')
  }
  return result
}

export async function getFrontDeskQueueSummary(now: Date = new Date()): Promise<ProviderQueueSummary[]> {
  const db = getDb()
  const today = istDateOf(now)
  const doctors = await db
    .select({ id: providers.id, departmentId: providers.departmentId, slotMinutes: providers.slotMinutes })
    .from(providers)
    .innerJoin(departments, eq(providers.departmentId, departments.id))
    .where(clinicalDoctorCondition)
    .orderBy(providers.id)
  if (doctors.length === 0) return []
  const ids = doctors.map((d) => d.id)

  const [availabilityOf, countRows] = await Promise.all([
    providerAvailability(ids, now),
    db.select({ providerId: encounters.providerId, status: encounters.status, count: sql<number>`count(*)::int` })
      .from(encounters)
      .where(and(
        inArray(encounters.providerId, ids),
        eq(encounters.encounterType, 'opd'),
        eq(encounters.encounterDate, today),
        inArray(encounters.status, ['checked_in', 'in_consultation']),
      ))
      .groupBy(encounters.providerId, encounters.status),
  ])
  const count = (providerId: number, status: 'checked_in' | 'in_consultation') =>
    countRows.find((r) => r.providerId === providerId && r.status === status)?.count ?? 0

  return doctors.map((d) => {
    const availability = availabilityOf.get(d.id) ?? 'available'
    const waiting = count(d.id, 'checked_in')
    return {
      providerId: d.id,
      departmentId: d.departmentId,
      waiting,
      inConsultation: count(d.id, 'in_consultation'),
      estimatedWaitMinutes: availability === 'available' ? estimateWaitMinutes(waiting, d.slotMinutes) : null,
      availability,
    }
  })
}

/** The check-in dialog's department choices: the clinical departments that have a doctor, by name. */
export function checkInDepartments(doctors: ClinicalDoctor[]): { id: number; name: string }[] {
  const byId = new Map<number, string>()
  for (const d of doctors) byId.set(d.departmentId, d.departmentName)
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}
