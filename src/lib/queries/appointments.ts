import { getDb } from '@/db/client'
import { appointments, patients, providers } from '@/db/schema'
import { and, asc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm'
import { publicPatientColumns, type PublicPatientRow } from '@/lib/queries/patient-columns'

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

function mapAppointmentRow(r: { appointment: typeof appointments.$inferSelect; patient: PublicPatientRow; provider: typeof providers.$inferSelect }): AppointmentWithDetails {
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
    .select({ appointment: appointments, patient: publicPatientColumns, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(and(...conditions))
    .orderBy(asc(appointments.startsAt))

  return rows.map(mapAppointmentRow)
}

export async function listUpcomingAppointments(limit: number): Promise<AppointmentWithDetails[]> {
  const rows = await getDb()
    .select({ appointment: appointments, patient: publicPatientColumns, provider: providers })
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
    .select({ appointment: appointments, patient: publicPatientColumns, provider: providers })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(providers, eq(appointments.providerId, providers.id))
    .where(eq(appointments.id, id))
  return row ? mapAppointmentRow(row) : null
}

// `executor` lets a caller run the check inside its own transaction, after
// lockProviderSchedule (every booking writer does); omitted -> the shared db
// (read-only callers).
export async function hasSchedulingConflict(
  providerId: number,
  startsAt: Date,
  endsAt: Date,
  excludeAppointmentId?: number,
  executor: Pick<ReturnType<typeof getDb>, 'select'> = getDb(),
): Promise<boolean> {
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

  const rows = await executor
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(...conditions))
  return rows.length > 0
}

/**
 * The per-provider schedule lock (I7). Every write that books or moves a
 * doctor's time -- calendar POST/PUT, front-desk schedule, booking-request
 * confirmation, follow-up booking, discharge follow-up -- takes it inside its
 * transaction before its conflict check, so the check sees every booking
 * committed before it and two writers can never double-book a slot.
 * Transaction-scoped: released on commit or rollback. Several providers (a
 * reschedule that changes doctor) are locked once each in ascending id order,
 * so two such writers can never deadlock on each other.
 */
export async function lockProviderSchedule(executor: Pick<ReturnType<typeof getDb>, 'execute'>, ...providerIds: number[]): Promise<void> {
  for (const id of [...new Set(providerIds)].sort((a, b) => a - b)) {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${'appointments.provider:' + id}))`)
  }
}

export type AppointmentRow = typeof appointments.$inferSelect

/** Calendar booking: lock, conflict check and insert in one transaction. */
export async function insertAppointmentIfFree(
  values: typeof appointments.$inferInsert,
): Promise<{ ok: true; appointment: AppointmentRow } | { ok: false; error: 'conflict' }> {
  return getDb().transaction(async (tx) => {
    await lockProviderSchedule(tx, values.providerId)
    if (await hasSchedulingConflict(values.providerId, values.startsAt, values.endsAt, undefined, tx)) return { ok: false as const, error: 'conflict' as const }
    const [appointment] = await tx.insert(appointments).values(values).returning()
    return { ok: true as const, appointment }
  })
}

/** Calendar reschedule: lock, conflict check (excluding itself) and update in one transaction. */
export async function rescheduleAppointmentIfFree(
  id: number,
  providerId: number,
  startsAt: Date,
  endsAt: Date,
  patch: Partial<typeof appointments.$inferInsert>,
): Promise<{ ok: true } | { ok: false; error: 'conflict' }> {
  return getDb().transaction(async (tx) => {
    await lockProviderSchedule(tx, providerId)
    if (await hasSchedulingConflict(providerId, startsAt, endsAt, id, tx)) return { ok: false as const, error: 'conflict' as const }
    await tx.update(appointments).set(patch).where(eq(appointments.id, id))
    return { ok: true as const }
  })
}
