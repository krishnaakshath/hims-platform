import { and, asc, count, desc, eq, getTableColumns, gte, inArray, lt, lte, or, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { appointments, departments, followUpContactAttempts, followUpOrders, patients, providers, type FollowUpContactAttemptRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { todayIsoIn } from '@/lib/india-time'
import { MISSED_GRACE_DAYS, UPCOMING_HORIZON_DAYS, addDaysIso, followUpVisitReason } from '@/lib/follow-ups/rules'
import type { ContactAttemptRequest } from '@/lib/follow-ups/validation'
import { toFollowUpView, type ContactAttemptView, type FollowUpJoinedRow } from '@/lib/follow-ups/view'
import { MISSED_ROW_CAP, WORKLIST_ROW_CAP, type WorklistRow } from '@/lib/follow-ups/worklist'
import { hasSchedulingConflict, lockProviderSchedule } from './appointments'
import { deriveOnExecutor, type FollowUpOrder } from './follow-ups'

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
 * Every other booking writer (calendar, front-desk schedule, booking-request
 * confirmation, discharge) takes the same lock (lockProviderSchedule).
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
    const { status, appointment } = await deriveOnExecutor(tx, order, todayIsoIn(undefined, now))
    if (status !== 'planned' && status !== 'scheduled' && status !== 'missed') return { ok: false, error: 'not_bookable' }

    // 3. The provider must exist and be active.
    const [provider] = await tx.select({ isActive: providers.isActive }).from(providers).where(eq(providers.id, slot.providerId))
    if (!provider || !provider.isActive) return { ok: false, error: 'provider_not_found' }

    // 4. No slot in the past.
    if (slot.startsAt.getTime() <= now.getTime()) return { ok: false, error: 'slot_in_past' }

    // 5. Per-provider schedule lock, held until commit/rollback. A reschedule
    //    to another doctor locks both (ascending id order).
    const existing = appointment?.status === 'scheduled' ? appointment : null
    await lockProviderSchedule(tx, slot.providerId, ...(existing ? [existing.providerId] : []))

    // 6. Conflict check under the lock, excluding the appointment being moved.
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
    const { status } = await deriveOnExecutor(tx, order, todayIsoIn())
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


// Plan notes and the cancel reason are never selected for the worklist.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { planNotes: _planNotes, cancelReason: _cancelReason, ...worklistOrderColumns } = getTableColumns(followUpOrders)
const worklistApptProvider = alias(providers, 'worklist_appt_provider')

export interface WorklistResult {
  rows: WorklistRow[]
  /** The live query hit its cap (raw SQL rows, before closed ones are dropped). */
  capped: boolean
  /** The separate missed query hit its own cap. */
  missedCapped: boolean
}

/** Live rows whose window ended longer ago than this are served only by the missed query. */
const LIVE_LOOKBACK_DAYS = MISSED_GRACE_DAYS + 90

function selectWorklistRows(where: SQL | undefined, orderBy: SQL[], limit: number) {
  return getDb()
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
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
}

/**
 * The recall worklist, as two SQL-narrowed queries so long-missed orders can
 * never crowd live ones out of the cap (I2):
 * - **live**: open stored statuses, windows starting within
 *   UPCOMING_HORIZON_DAYS and ending no more than MISSED_GRACE_DAYS + 90 days
 *   ago, due-date order, capped at `caps.main`;
 * - **missed**: open or missed stored statuses whose window ended more than
 *   MISSED_GRACE_DAYS ago (or whose appointment was a no-show), most recent
 *   first, capped at `caps.missed`.
 * Both take the optional department / prescriber filters. Each cap flag comes
 * from the raw SQL row count (one extra row is fetched), not from the rows
 * left after dropping derived-closed ones. Patients contribute only id, name,
 * UHID and phone. Contact attempts add two queries (count, latest), never N+1.
 * Bucket filtering and per-bucket sorting are `filterAndSortWorklist`.
 */
export async function listFollowUpWorklist(
  today = todayIsoIn(),
  filters: { departmentId?: number | null; providerId?: number | null } = {},
  caps: { main: number; missed: number } = { main: WORKLIST_ROW_CAP, missed: MISSED_ROW_CAP },
): Promise<WorklistResult> {
  const db = getDb()
  const scope: SQL[] = []
  if (filters.departmentId != null) scope.push(eq(followUpOrders.departmentId, filters.departmentId))
  if (filters.providerId != null) scope.push(eq(followUpOrders.prescribedByProviderId, filters.providerId))

  const liveRaw = await selectWorklistRows(
    and(
      inArray(followUpOrders.status, ['planned', 'scheduled']),
      lte(followUpOrders.windowStart, addDaysIso(today, UPCOMING_HORIZON_DAYS)),
      gte(followUpOrders.windowEnd, addDaysIso(today, -LIVE_LOOKBACK_DAYS)),
      ...scope,
    ),
    [asc(followUpOrders.dueDate), asc(followUpOrders.id)],
    caps.main + 1,
  )
  const missedRaw = await selectWorklistRows(
    and(
      inArray(followUpOrders.status, ['planned', 'scheduled', 'missed']),
      or(lt(followUpOrders.windowEnd, addDaysIso(today, -MISSED_GRACE_DAYS)), eq(appointments.status, 'no_show')),
      ...scope,
    ),
    [desc(followUpOrders.windowEnd), desc(followUpOrders.id)],
    caps.missed + 1,
  )
  const capped = liveRaw.length > caps.main
  const missedCapped = missedRaw.length > caps.missed
  const seen = new Set<number>()
  const rows = [...liveRaw.slice(0, caps.main), ...missedRaw.slice(0, caps.missed)].filter((r) => {
    if (seen.has(r.order.id)) return false
    seen.add(r.order.id)
    return true
  })
  if (rows.length === 0) return { rows: [], capped, missedCapped }

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
  return { rows: out, capped, missedCapped }
}
