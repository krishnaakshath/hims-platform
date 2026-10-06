import { getDb } from '@/db/client'
import { appointments, patients, providers } from '@/db/schema'
import { and, asc, eq, gt, gte, inArray, lt, lte, ne } from 'drizzle-orm'

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show'

export interface AppointmentWithDetails {
  id: number
  patientId: string
  patientName: string
  providerId: number
  providerName: string
  providerColorTag: string
  startsAt: Date
  endsAt: Date
  visitReason: string
  status: AppointmentStatus
  notes: string | null
}

function mapAppointmentRow(r: { appointment: typeof appointments.$inferSelect; patient: typeof patients.$inferSelect; provider: typeof providers.$inferSelect }): AppointmentWithDetails {
  return {
    id: r.appointment.id,
    patientId: r.appointment.patientId,
    patientName: r.patient.name,
    providerId: r.appointment.providerId,
    providerName: r.provider.name,
    providerColorTag: r.provider.colorTag,
    startsAt: r.appointment.startsAt,
    endsAt: r.appointment.endsAt,
    visitReason: r.appointment.visitReason,
    status: r.appointment.status,
    notes: r.appointment.notes,
  }
}

/**
 * `providerIds === undefined` means "no provider filter" (all providers).
 * `providerIds === []` means the caller explicitly deselected every
 * provider (the calendar's "Uncheck All") — that must return zero
 * appointments, not fall back to "no filter", so it's short-circuited
 * before the query is built.
 */
export async function listAppointmentsInRange(start: Date, end: Date, providerIds?: number[]): Promise<AppointmentWithDetails[]> {
  if (providerIds && providerIds.length === 0) return []

  const conditions = [gte(appointments.startsAt, start), lte(appointments.startsAt, end)]
  if (providerIds && providerIds.length > 0) conditions.push(inArray(appointments.providerId, providerIds))

  const rows = await getDb()
    .select({ appointment: appointments, patient: patients, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(...conditions))
    .orderBy(asc(appointments.startsAt))

  return rows.map(mapAppointmentRow)
}

export async function listUpcomingAppointments(limit: number): Promise<AppointmentWithDetails[]> {
  const rows = await getDb()
    .select({ appointment: appointments, patient: patients, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(gte(appointments.startsAt, new Date()), eq(appointments.status, 'scheduled')))
    .orderBy(asc(appointments.startsAt))
    .limit(limit)

  return rows.map(mapAppointmentRow)
}

export async function getAppointment(id: number): Promise<AppointmentWithDetails | null> {
  const [row] = await getDb()
    .select({ appointment: appointments, patient: patients, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(eq(appointments.id, id))
  return row ? mapAppointmentRow(row) : null
}

export async function hasSchedulingConflict(providerId: number, startsAt: Date, endsAt: Date, excludeAppointmentId?: number): Promise<boolean> {
  const conditions = [
    eq(appointments.providerId, providerId),
    ne(appointments.status, 'cancelled'),
    lt(appointments.startsAt, endsAt),
    gt(appointments.endsAt, startsAt),
  ]
  // Excludes the appointment being rescheduled from its own conflict check --
  // without this, PUT /api/appointments/[id] would always see itself and
  // reject every reschedule as a "conflict" with the pre-change row.
  if (excludeAppointmentId !== undefined) conditions.push(ne(appointments.id, excludeAppointmentId))

  const rows = await getDb()
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(...conditions))
  return rows.length > 0
}
