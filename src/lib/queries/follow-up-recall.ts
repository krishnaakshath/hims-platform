import { and, asc, count, desc, eq, getTableColumns, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { appointments, departments, followUpContactAttempts, followUpOrders, patients, providers, type FollowUpContactAttemptRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { todayIsoIn } from '@/lib/india-time'
import { UPCOMING_HORIZON_DAYS, addDaysIso, deriveFollowUpStatus, followUpVisitReason, type ApptStatus, type FollowUpStatus } from '@/lib/follow-ups/rules'
import type { ContactAttemptRequest } from '@/lib/follow-ups/validation'
import { toFollowUpView, type ContactAttemptView, type FollowUpJoinedRow } from '@/lib/follow-ups/view'
import type { WorklistRow } from '@/lib/follow-ups/worklist'
import { hasSchedulingConflict } from './appointments'
import type { WriteExecutor } from './executor'
import type { FollowUpOrder } from './follow-ups'

type LinkedAppointment = { id: number; status: ApptStatus; startsAt: Date }

/** The order's derived status (IST today) and its linked appointment, read on the caller's executor. */
async function derive(ex: WriteExecutor, order: FollowUpOrder, todayIso: string): Promise<{ status: FollowUpStatus; appointment: LinkedAppointment | null }> {
  let appointment: LinkedAppointment | null = null
  if (order.appointmentId !== null) {
    const [a] = await ex
      .select({ id: appointments.id, status: appointments.status, startsAt: appointments.startsAt })
      .from(appointments)
      .where(eq(appointments.id, order.appointmentId))
    appointment = a ?? null
  }
  return { status: deriveFollowUpStatus({ status: order.status, windowEnd: order.windowEnd, appointment }, todayIso), appointment }
}

// ---------------------------------------------------------------------------
// Book / reschedule / unbook
// ---------------------------------------------------------------------------

export type BookFollowUpResult =
  | { ok: true; order: FollowUpOrder; appointmentId: number; kind: 'booked' | 'rescheduled' }
  | { ok: false; error: 'not_found' | 'not_bookable' | 'provider_not_found' | 'slot_in_past' | 'conflict' }

/**
 * Books (or reschedules) the follow-up's appointment in ONE transaction.
 *
 * Concurrency: the order row lock serialises two clerks on the same follow-up
 * (the second sees the first's appointment and reschedules it, so no orphan
 * row). The transaction-scoped advisory lock on the provider serialises every
 * follow-up booking for that doctor, so the conflict check below sees any
 * booking committed before it and two clerks cannot double-book a slot.
 * Calendar bookings (POST /api/appointments) do not take this lock (plan:
 * pre-existing hazard).
 */
export async function bookFollowUp(
  id: number,
  slot: { providerId: number; startsAt: Date; endsAt: Date },
  session: Session,
  now: Date = new Date(),
): Promise<BookFollowUpResult> {
  return getDb().transaction(async (tx): Promise<BookFollowUpResult> => {
    // 1-2. Lock the order and derive its status.
    const [order] = await tx.select().from(followUpOrders).where(eq(followUpOrders.id, id)).for('update')
    if (!order) return { ok: false, error: 'not_found' }
    const { status, appointment } = await derive(tx, order, todayIsoIn(undefined, now))
    if (status !== 'planned' && status !== 'scheduled' && status !== 'missed') return { ok: false, error: 'not_bookable' }

    // 3. The provider must exist and be active.
    const [provider] = await tx.select({ isActive: providers.isActive }).from(providers).where(eq(providers.id, slot.providerId))
    if (!provider || !provider.isActive) return { ok: false, error: 'provider_not_found' }

    // 4. No slot in the past.
    if (slot.startsAt.getTime() <= now.getTime()) return { ok: false, error: 'slot_in_past' }

    // 5. Per-provider booking lock, held until commit/rollback.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'appointments.provider:' + slot.providerId}))`)

    // 6. Conflict check under the lock, excluding the appointment being moved.
    const existing = appointment?.status === 'scheduled' ? appointment : null
    if (await hasSchedulingConflict(slot.providerId, slot.startsAt, slot.endsAt, existing?.id, tx)) return { ok: false, error: 'conflict' }

    // 7. Move the still-scheduled appointment, or create one.
    let appointmentId: number
    let kind: 'booked' | 'rescheduled'
    if (existing) {
      await tx.update(appointments)
        .set({ providerId: slot.providerId, startsAt: slot.startsAt, endsAt: slot.endsAt })
        .where(eq(appointments.id, existing.id))
      appointmentId = existing.id
      kind = 'rescheduled'
    } else {
      const [created] = await tx.insert(appointments).values({
        patientId: order.patientId,
        providerId: slot.providerId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        visitReason: followUpVisitReason(order.reason),
        status: 'scheduled',
      }).returning({ id: appointments.id })
      appointmentId = created.id
      kind = 'booked'
    }

    // 8. The order points at it.
    const at = new Date()
    const [updated] = await tx.update(followUpOrders).set({
      status: 'scheduled', appointmentId, scheduledAt: at, scheduledByName: session.name, scheduledByUserId: session.userId, updatedAt: at,
    }).where(eq(followUpOrders.id, id)).returning()

    // 9. Ids only.
    await logAudit(session, kind === 'booked' ? 'booked follow-up appointment' : 'rescheduled follow-up appointment', order.patientId, `followUp=${id} appointment=${appointmentId}`, tx)
    return { ok: true, order: updated, appointmentId, kind }
  })
}

export type UnbookFollowUpResult =
  | { ok: true; order: FollowUpOrder; cancelledAppointmentId: number }
  | { ok: false; error: 'not_found' | 'not_booked' }

/**
 * Cancels the booking but keeps the follow-up open (back to `planned`). The
 * front desk's free-text reason is appended to the appointment's notes, never the
 * audit log; the order's cancelReason is for cancelling the order itself.
 */
export async function unbookFollowUp(id: number, reason: string, session: Session): Promise<UnbookFollowUpResult> {
  return getDb().transaction(async (tx): Promise<UnbookFollowUpResult> => {
    const [order] = await tx.select().from(followUpOrders).where(eq(followUpOrders.id, id)).for('update')
    if (!order) return { ok: false, error: 'not_found' }
    // A completed order keeps its (checked-in) appointment; only a live booking can be undone.
    if (order.status !== 'scheduled' || order.appointmentId === null) return { ok: false, error: 'not_booked' }
    const [appt] = await tx
      .select({ id: appointments.id, status: appointments.status, notes: appointments.notes })
      .from(appointments)
      .where(eq(appointments.id, order.appointmentId))
      .for('update')
    if (!appt || appt.status !== 'scheduled') return { ok: false, error: 'not_booked' }

    // Ruling 3: append to the appointment's notes (row is locked), never overwrite them.
    const line = `Follow-up booking cancelled: ${reason}`
    await tx.update(appointments)
      .set({ status: 'cancelled', notes: appt.notes?.trim() ? `${appt.notes}\n${line}` : line })
      .where(eq(appointments.id, appt.id))

    const at = new Date()
    const [updated] = await tx.update(followUpOrders).set({
      status: 'planned', appointmentId: null, scheduledAt: null, scheduledByName: null, scheduledByUserId: null, updatedAt: at,
    }).where(eq(followUpOrders.id, id)).returning()

    await logAudit(session, 'cancelled follow-up booking', order.patientId, `followUp=${id} appointment=${appt.id}`, tx)
    return { ok: true, order: updated, cancelledAppointmentId: appt.id }
  })
}

// ---------------------------------------------------------------------------
// Contact attempts (append-only: there is no update or delete)
// ---------------------------------------------------------------------------

export type RecordContactAttemptResult =
  | { ok: true; attempt: FollowUpContactAttemptRow }
  | { ok: false; error: 'not_found' | 'closed' }

export async function recordContactAttempt(id: number, input: ContactAttemptRequest, session: Session): Promise<RecordContactAttemptResult> {
  return getDb().transaction(async (tx): Promise<RecordContactAttemptResult> => {
    // Share lock: a concurrent cancel/complete waits until this attempt is in.
    const [order] = await tx.select().from(followUpOrders).where(eq(followUpOrders.id, id)).for('share')
    if (!order) return { ok: false, error: 'not_found' }
    const { status } = await derive(tx, order, todayIsoIn())
    if (status === 'completed' || status === 'cancelled') return { ok: false, error: 'closed' }

    const note = input.note?.trim() ? input.note.trim() : null
    const [attempt] = await tx.insert(followUpContactAttempts).values({
      followUpOrderId: id,
      channel: input.channel,
      outcome: input.outcome,
      note,
      attemptedByName: session.name,
      attemptedByUserId: session.userId,
    }).returning()

    // Codes only -- never the note.
    await logAudit(session, 'logged follow-up contact attempt', order.patientId, `followUp=${id} channel=${input.channel} outcome=${input.outcome}`, tx)
    return { ok: true, attempt }
  })
}

// ---------------------------------------------------------------------------
// Recall worklist
// ---------------------------------------------------------------------------

export const WORKLIST_ROW_CAP = 500

// Plan notes and the cancel reason are never selected for the worklist.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { planNotes: _planNotes, cancelReason: _cancelReason, ...worklistOrderColumns } = getTableColumns(followUpOrders)
const worklistApptProvider = alias(providers, 'worklist_appt_provider')

/**
 * The recall worklist. SQL does the narrowing: open stored statuses, windows
 * starting within UPCOMING_HORIZON_DAYS, the optional department / prescriber
 * filters, due-date order and the row cap. Patients contribute only id, name,
 * UHID and phone. Contact attempts add two queries (count, latest), never N+1.
 * Rows whose derived status is closed are dropped; bucket filtering and
 * per-bucket sorting are `filterAndSortWorklist`.
 */
export async function listFollowUpWorklist(
  today = todayIsoIn(),
  filters: { departmentId?: number | null; providerId?: number | null } = {},
): Promise<WorklistRow[]> {
  const db = getDb()
  const conditions: SQL[] = [
    inArray(followUpOrders.status, ['planned', 'scheduled']),
    lte(followUpOrders.windowStart, addDaysIso(today, UPCOMING_HORIZON_DAYS)),
  ]
  if (filters.departmentId != null) conditions.push(eq(followUpOrders.departmentId, filters.departmentId))
  if (filters.providerId != null) conditions.push(eq(followUpOrders.prescribedByProviderId, filters.providerId))

  const rows = await db
    .select({
      order: worklistOrderColumns,
      patientName: patients.name,
      uhid: patients.uhid,
      phone: patients.phone,
      prescriberName: providers.name,
      departmentName: departments.name,
      apptId: appointments.id,
      apptStartsAt: appointments.startsAt,
      apptEndsAt: appointments.endsAt,
      apptStatus: appointments.status,
      apptProviderId: appointments.providerId,
      apptProviderName: worklistApptProvider.name,
    })
    .from(followUpOrders)
    .innerJoin(patients, eq(patients.id, followUpOrders.patientId))
    .innerJoin(providers, eq(providers.id, followUpOrders.prescribedByProviderId))
    .leftJoin(departments, eq(departments.id, followUpOrders.departmentId))
    .leftJoin(appointments, eq(appointments.id, followUpOrders.appointmentId))
    .leftJoin(worklistApptProvider, eq(worklistApptProvider.id, appointments.providerId))
    .where(and(...conditions))
    .orderBy(asc(followUpOrders.dueDate), asc(followUpOrders.id))
    .limit(WORKLIST_ROW_CAP)
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.order.id)
  const counts = await db
    .select({ orderId: followUpContactAttempts.followUpOrderId, n: count() })
    .from(followUpContactAttempts)
    .where(inArray(followUpContactAttempts.followUpOrderId, ids))
    .groupBy(followUpContactAttempts.followUpOrderId)
  const latest = await db
    .selectDistinctOn([followUpContactAttempts.followUpOrderId], {
      orderId: followUpContactAttempts.followUpOrderId,
      id: followUpContactAttempts.id,
      channel: followUpContactAttempts.channel,
      outcome: followUpContactAttempts.outcome,
      note: followUpContactAttempts.note,
      attemptedByName: followUpContactAttempts.attemptedByName,
      attemptedAt: followUpContactAttempts.attemptedAt,
    })
    .from(followUpContactAttempts)
    .where(inArray(followUpContactAttempts.followUpOrderId, ids))
    .orderBy(followUpContactAttempts.followUpOrderId, desc(followUpContactAttempts.attemptedAt), desc(followUpContactAttempts.id))
  const countBy = new Map(counts.map((c) => [c.orderId, Number(c.n)]))
  const latestBy = new Map<number, ContactAttemptView>(latest.map(({ orderId, ...a }) => [orderId, a]))

  const out: WorklistRow[] = []
  for (const r of rows) {
    const last = latestBy.get(r.order.id)
    const joined: FollowUpJoinedRow = {
      ...r.order,
      planNotes: null,
      cancelReason: null,
      prescriberName: r.prescriberName,
      departmentName: r.departmentName,
      appointment: r.apptId !== null && r.apptStartsAt && r.apptEndsAt && r.apptStatus && r.apptProviderId !== null
        ? { id: r.apptId, startsAt: r.apptStartsAt, endsAt: r.apptEndsAt, status: r.apptStatus, providerId: r.apptProviderId, providerName: r.apptProviderName ?? '' }
        : null,
      contactAttempts: last ? [last] : [],
    }
    // The front-desk view: plan notes are null by role as well as never selected.
    const v = toFollowUpView(joined, today, 'frontdesk')
    if (v.status === 'completed' || v.status === 'cancelled') continue
    out.push({
      id: v.id,
      status: v.status,
      bucket: v.bucket,
      dueDate: v.dueDate,
      windowStart: v.windowStart,
      windowEnd: v.windowEnd,
      reason: v.reason,
      appointment: v.appointment,
      prescribedBy: v.prescribedBy,
      department: v.department,
      lastContact: v.lastContact,
      patientId: v.patientId,
      patientName: r.patientName,
      uhid: r.uhid,
      phone: r.phone,
      contactAttemptCount: countBy.get(v.id) ?? 0,
    })
  }
  return out
}
