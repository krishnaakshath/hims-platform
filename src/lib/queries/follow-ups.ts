import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { appointments, departments, followUpContactAttempts, followUpOrders, patients, providers, type FollowUpOrderRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Role, Session } from '@/lib/auth'
import { istDateOf, todayIsoIn } from '@/lib/india-time'
import {
  DEFAULT_WINDOW_DAYS_AFTER, DEFAULT_WINDOW_DAYS_BEFORE, addDaysIso, deriveFollowUpStatus, dueDateProblem, isOpenFollowUp, resolveFollowUpDates,
  type FollowUpStatus, type FollowUpTiming,
} from '@/lib/follow-ups/rules'
import type { UpdateFollowUpPlanRequest } from '@/lib/follow-ups/validation'
import { toFollowUpView, toPortalFollowUp, type ContactAttemptView, type FollowUpJoinedRow, type FollowUpView, type PortalFollowUp } from '@/lib/follow-ups/view'
import { getEncounterById } from './encounters'
import type { WriteExecutor } from './executor'

export type FollowUpOrder = FollowUpOrderRow

const DAY_MS = 24 * 60 * 60 * 1000
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS)
}

/** Empty plan notes are stored as NULL. */
function normalizeNotes(notes: string | null | undefined): string | null {
  const t = notes?.trim()
  return t ? t : null
}

/** The derived status of a locked order, read on the same executor. */
async function deriveOnExecutor(ex: WriteExecutor, order: FollowUpOrder, todayIso: string): Promise<{ status: FollowUpStatus; appointment: { id: number; status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'; startsAt: Date } | null }> {
  let appointment: { id: number; status: 'scheduled' | 'completed' | 'cancelled' | 'no_show'; startsAt: Date } | null = null
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
// Create
// ---------------------------------------------------------------------------

export interface CreateFollowUpOrderInput {
  patientId: string
  source: 'encounter' | 'discharge' | 'manual'
  prescribedByProviderId: number
  departmentId: number | null
  timing: FollowUpTiming
  windowDaysBefore?: number
  windowDaysAfter?: number
  reason: string
  planNotes: string | null
  originatingEncounterId: number | null
  originatingAdmissionId: number | null
  appointmentId?: number | null
}

export type CreateFollowUpResult =
  | { ok: true; order: FollowUpOrder }
  | { ok: false; error: 'patient_not_found' | 'provider_not_found' | 'encounter_not_found' | 'encounter_mismatch' | 'due_date_invalid'; message?: string }

/**
 * Creates a follow-up order. With `opts.executor` it runs inside the caller's
 * transaction (discharge, Task 10); otherwise it opens its own. The audit row
 * is written on the same executor and carries ids, the source and the due date
 * only: never the reason or the plan notes.
 */
export async function createFollowUpOrder(
  input: CreateFollowUpOrderInput,
  session: Session,
  opts: { executor?: WriteExecutor; today?: string; baseDate?: string } = {},
): Promise<CreateFollowUpResult> {
  const today = opts.today ?? todayIsoIn()
  const run = async (ex: WriteExecutor): Promise<CreateFollowUpResult> => {
    const [patient] = await ex.select({ id: patients.id }).from(patients).where(eq(patients.id, input.patientId))
    if (!patient) return { ok: false, error: 'patient_not_found' }

    const [provider] = await ex
      .select({ id: providers.id, departmentId: providers.departmentId, isActive: providers.isActive })
      .from(providers)
      .where(eq(providers.id, input.prescribedByProviderId))
    if (!provider || !provider.isActive) return { ok: false, error: 'provider_not_found' }

    let baseDate = today
    if (input.originatingEncounterId !== null) {
      const encounter = await getEncounterById(input.originatingEncounterId, ex)
      if (!encounter) return { ok: false, error: 'encounter_not_found' }
      if (encounter.patientId !== input.patientId) return { ok: false, error: 'encounter_mismatch' }
      baseDate = encounter.encounterDate
    }
    // Discharge (Task 10) counts an interval from the discharge day, not from
    // the IPD encounter's (admission) date.
    if (opts.baseDate) baseDate = opts.baseDate

    const dates = resolveFollowUpDates(input.timing, baseDate, input.windowDaysBefore ?? DEFAULT_WINDOW_DAYS_BEFORE, input.windowDaysAfter ?? DEFAULT_WINDOW_DAYS_AFTER)
    const problem = dueDateProblem(dates.dueDate, today)
    if (problem) return { ok: false, error: 'due_date_invalid', message: problem }

    const now = new Date()
    const booked = input.appointmentId != null
    const [order] = await ex.insert(followUpOrders).values({
      patientId: input.patientId,
      source: input.source,
      status: booked ? 'scheduled' : 'planned',
      prescribedByProviderId: provider.id,
      departmentId: input.departmentId ?? provider.departmentId,
      baseDate,
      dueDate: dates.dueDate,
      windowStart: dates.windowStart,
      windowEnd: dates.windowEnd,
      intervalValue: dates.interval?.value ?? null,
      intervalUnit: dates.interval?.unit ?? null,
      reason: input.reason,
      planNotes: normalizeNotes(input.planNotes),
      originatingEncounterId: input.originatingEncounterId,
      originatingAdmissionId: input.originatingAdmissionId,
      appointmentId: booked ? input.appointmentId : null,
      createdByName: session.name,
      createdByUserId: session.userId,
      createdAt: now,
      updatedAt: now,
      ...(booked ? { scheduledAt: now, scheduledByName: session.name, scheduledByUserId: session.userId } : {}),
    }).returning()

    await logAudit(session, 'set follow-up plan', input.patientId, `followUp=${order.id} source=${input.source} due=${order.dueDate}`, ex)
    return { ok: true, order }
  }
  return opts.executor ? run(opts.executor) : getDb().transaction((tx) => run(tx))
}

// ---------------------------------------------------------------------------
// Change the plan
// ---------------------------------------------------------------------------

export type UpdateFollowUpPlanInput = UpdateFollowUpPlanRequest

export type UpdateFollowUpPlanResult =
  | { ok: true; order: FollowUpOrder; changedFields: string[]; bookingOutsideWindow: boolean }
  | { ok: false; error: 'not_found' | 'not_owner' | 'not_editable' | 'provider_not_found' | 'due_date_invalid'; message?: string }

/**
 * Changes the clinical plan of an open order. A new timing is resolved from
 * the stored base date; a window-only change is recomputed around the stored
 * due date. A booked appointment is never moved: `bookingOutsideWindow`
 * reports when it now falls outside the window (by its IST date).
 *
 * `actingProviderId` is the doctor acting (a pi's own provider profile); only
 * the prescriber may change the plan. `null` means an admin (no ownership check).
 */
export async function updateFollowUpPlan(
  id: number,
  patch: UpdateFollowUpPlanInput,
  session: Session,
  actingProviderId: number | null,
  today = todayIsoIn(),
): Promise<UpdateFollowUpPlanResult> {
  return getDb().transaction(async (tx): Promise<UpdateFollowUpPlanResult> => {
    const [order] = await tx.select().from(followUpOrders).where(eq(followUpOrders.id, id)).for('update')
    if (!order) return { ok: false, error: 'not_found' }
    if (actingProviderId !== null && order.prescribedByProviderId !== actingProviderId) return { ok: false, error: 'not_owner' }
    const { status, appointment } = await deriveOnExecutor(tx, order, today)
    if (!isOpenFollowUp(status)) return { ok: false, error: 'not_editable' }

    const changed = new Set<string>()
    const currentBefore = daysBetween(order.windowStart, order.dueDate)
    const currentAfter = daysBetween(order.dueDate, order.windowEnd)
    const before = patch.windowDaysBefore ?? currentBefore
    const after = patch.windowDaysAfter ?? currentAfter
    if (before !== currentBefore) changed.add('windowDaysBefore')
    if (after !== currentAfter) changed.add('windowDaysAfter')

    let dueDate = order.dueDate
    let intervalValue = order.intervalValue
    let intervalUnit = order.intervalUnit
    if (patch.timing !== undefined) {
      const resolved = resolveFollowUpDates(patch.timing, order.baseDate, before, after)
      if (resolved.dueDate !== order.dueDate) {
        const problem = dueDateProblem(resolved.dueDate, today)
        if (problem) return { ok: false, error: 'due_date_invalid', message: problem }
      }
      dueDate = resolved.dueDate
      intervalValue = resolved.interval?.value ?? null
      intervalUnit = resolved.interval?.unit ?? null
      if (dueDate !== order.dueDate || intervalValue !== order.intervalValue || intervalUnit !== order.intervalUnit) changed.add('timing')
    }
    const windowStart = addDaysIso(dueDate, -before)
    const windowEnd = addDaysIso(dueDate, after)

    const reason = patch.reason ?? order.reason
    if (reason !== order.reason) changed.add('reason')
    const planNotes = patch.planNotes !== undefined ? normalizeNotes(patch.planNotes) : order.planNotes
    if (planNotes !== order.planNotes) changed.add('planNotes')

    let prescribedByProviderId = order.prescribedByProviderId
    if (patch.prescribedByProviderId !== undefined && patch.prescribedByProviderId !== order.prescribedByProviderId) {
      const [provider] = await tx.select({ isActive: providers.isActive }).from(providers).where(eq(providers.id, patch.prescribedByProviderId))
      if (!provider || !provider.isActive) return { ok: false, error: 'provider_not_found' }
      prescribedByProviderId = patch.prescribedByProviderId
      changed.add('prescribedByProviderId')
    }
    const departmentId = patch.departmentId !== undefined ? patch.departmentId : order.departmentId
    if (departmentId !== order.departmentId) changed.add('departmentId')

    const booked = order.status === 'scheduled' && appointment?.status === 'scheduled' ? appointment : null
    const bookingDay = booked ? istDateOf(booked.startsAt) : null
    const bookingOutsideWindow = bookingDay !== null && (bookingDay < windowStart || bookingDay > windowEnd)

    const changedFields = [...changed].sort()
    if (changedFields.length === 0) return { ok: true, order, changedFields, bookingOutsideWindow }

    const now = new Date()
    const [updated] = await tx.update(followUpOrders).set({
      dueDate, windowStart, windowEnd, intervalValue, intervalUnit, reason, planNotes, prescribedByProviderId, departmentId,
      planUpdatedAt: now, planUpdatedByName: session.name, updatedAt: now,
    }).where(eq(followUpOrders.id, id)).returning()

    // Field names only -- never the old or new reason/notes text.
    await logAudit(session, 'changed follow-up plan', order.patientId, `followUp=${id} fields=${changedFields.join(',')}`, tx)
    return { ok: true, order: updated, changedFields, bookingOutsideWindow }
  })
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export type CancelFollowUpResult =
  | { ok: true; order: FollowUpOrder; cancelledAppointmentId: number | null }
  | { ok: false; error: 'not_found' | 'not_owner' | 'not_cancellable' }

/**
 * Cancels an open order. A linked appointment that is still `scheduled` is
 * cancelled in the same transaction. The cancel reason stays on the row; the
 * audit row carries ids only. `actingProviderId`: as for updateFollowUpPlan
 * (only the prescriber, or an admin with `null`).
 */
export async function cancelFollowUpOrder(id: number, reason: string, session: Session, actingProviderId: number | null): Promise<CancelFollowUpResult> {
  return getDb().transaction(async (tx): Promise<CancelFollowUpResult> => {
    const [order] = await tx.select().from(followUpOrders).where(eq(followUpOrders.id, id)).for('update')
    if (!order) return { ok: false, error: 'not_found' }
    if (actingProviderId !== null && order.prescribedByProviderId !== actingProviderId) return { ok: false, error: 'not_owner' }
    const { status, appointment } = await deriveOnExecutor(tx, order, todayIsoIn())
    if (!isOpenFollowUp(status)) return { ok: false, error: 'not_cancellable' }

    let cancelledAppointmentId: number | null = null
    if (appointment?.status === 'scheduled') {
      const [a] = await tx.update(appointments)
        .set({ status: 'cancelled' })
        .where(and(eq(appointments.id, appointment.id), eq(appointments.status, 'scheduled')))
        .returning({ id: appointments.id })
      cancelledAppointmentId = a?.id ?? null
    }

    const now = new Date()
    const [updated] = await tx.update(followUpOrders).set({
      status: 'cancelled', cancelledAt: now, cancelledByName: session.name, cancelReason: reason, updatedAt: now,
    }).where(eq(followUpOrders.id, id)).returning()

    const details = cancelledAppointmentId !== null ? `followUp=${id} appointment=${cancelledAppointmentId}` : `followUp=${id}`
    await logAudit(session, 'cancelled follow-up', order.patientId, details, tx)
    return { ok: true, order: updated, cancelledAppointmentId }
  })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getFollowUpById(id: number): Promise<FollowUpOrder | null> {
  const [row] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, id))
  return row ?? null
}

const apptProvider = alias(providers, 'follow_up_appt_provider')

/** Orders joined with prescriber, department and appointment (+ its provider). No contact attempts. */
async function selectJoinedOrders(where: SQL | undefined, orderBy: SQL[], limit: number): Promise<Omit<FollowUpJoinedRow, 'contactAttempts'>[]> {
  const rows = await getDb()
    .select({
      order: followUpOrders,
      prescriberName: providers.name,
      departmentName: departments.name,
      apptId: appointments.id,
      apptStartsAt: appointments.startsAt,
      apptEndsAt: appointments.endsAt,
      apptStatus: appointments.status,
      apptProviderId: appointments.providerId,
      apptProviderName: apptProvider.name,
    })
    .from(followUpOrders)
    .innerJoin(providers, eq(providers.id, followUpOrders.prescribedByProviderId))
    .leftJoin(departments, eq(departments.id, followUpOrders.departmentId))
    .leftJoin(appointments, eq(appointments.id, followUpOrders.appointmentId))
    .leftJoin(apptProvider, eq(apptProvider.id, appointments.providerId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
  return rows.map((r) => ({
    ...r.order,
    prescriberName: r.prescriberName,
    departmentName: r.departmentName,
    appointment: r.apptId !== null && r.apptStartsAt && r.apptEndsAt && r.apptStatus && r.apptProviderId !== null
      ? { id: r.apptId, startsAt: r.apptStartsAt, endsAt: r.apptEndsAt, status: r.apptStatus, providerId: r.apptProviderId, providerName: r.apptProviderName ?? '' }
      : null,
  }))
}

/** All contact attempts of the given orders in one query, grouped by order id. */
async function contactAttemptsByOrder(orderIds: number[]): Promise<Map<number, ContactAttemptView[]>> {
  const byOrder = new Map<number, ContactAttemptView[]>()
  if (orderIds.length === 0) return byOrder
  const rows = await getDb()
    .select({
      id: followUpContactAttempts.id,
      followUpOrderId: followUpContactAttempts.followUpOrderId,
      channel: followUpContactAttempts.channel,
      outcome: followUpContactAttempts.outcome,
      note: followUpContactAttempts.note,
      attemptedByName: followUpContactAttempts.attemptedByName,
      attemptedAt: followUpContactAttempts.attemptedAt,
    })
    .from(followUpContactAttempts)
    .where(inArray(followUpContactAttempts.followUpOrderId, orderIds))
  for (const { followUpOrderId, ...a } of rows) {
    const list = byOrder.get(followUpOrderId) ?? []
    list.push(a)
    byOrder.set(followUpOrderId, list)
  }
  return byOrder
}

/** The patient page list: newest first, closed orders included, plan notes by role. */
export async function listFollowUpsForPatient(patientId: string, role: Role, today = todayIsoIn()): Promise<FollowUpView[]> {
  const rows = await selectJoinedOrders(eq(followUpOrders.patientId, patientId), [desc(followUpOrders.createdAt), desc(followUpOrders.id)], 50)
  const attempts = await contactAttemptsByOrder(rows.map((r) => r.id))
  return rows.map((r) => toFollowUpView({ ...r, contactAttempts: attempts.get(r.id) ?? [] }, today, role))
}

/** One order as the given role may see it (the response body of the SP3 write routes), or null. */
export async function getFollowUpView(id: number, role: Role, today = todayIsoIn()): Promise<FollowUpView | null> {
  const [row] = await selectJoinedOrders(eq(followUpOrders.id, id), [asc(followUpOrders.id)], 1)
  if (!row) return null
  const attempts = await contactAttemptsByOrder([row.id])
  return toFollowUpView({ ...row, contactAttempts: attempts.get(row.id) ?? [] }, today, role)
}

/**
 * The portal card: open orders only (derived), soonest due first. Built through
 * the full view and then the portal projection, so no clinical field or reason
 * can leak past `toPortalFollowUp`.
 */
export async function getPortalFollowUps(patientId: string, today = todayIsoIn()): Promise<PortalFollowUp[]> {
  const rows = await selectJoinedOrders(
    and(eq(followUpOrders.patientId, patientId), inArray(followUpOrders.status, ['planned', 'scheduled', 'missed'])),
    [asc(followUpOrders.dueDate), asc(followUpOrders.id)],
    50,
  )
  return rows
    .map((r) => toFollowUpView({ ...r, contactAttempts: [] }, today, 'admin'))
    .filter((v) => isOpenFollowUp(v.status))
    .map(toPortalFollowUp)
}
