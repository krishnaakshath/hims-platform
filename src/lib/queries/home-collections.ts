// SP5 home sample collection: booking context, window availability, book / reschedule / cancel,
// collector dispatch, the day board, and the collector's route and mark-collected.
//
// Every write is ONE transaction with its audit row on the same `tx`. Audit details carry ids,
// dates and reason codes only: never the address, the phone number or a free-text note.
//
// Capacity: each (IST visit date, window) slot is serialised by a transaction-scoped advisory
// lock, `hashtext('home_collection:' || date || ':' || windowId)`. The capacity count and the
// insert/move happen under it, so concurrent bookings can never overbook a window.
//
// Lock order (shared with lab-lifecycle.ts; never reverse it -- a deadlock/serialization failure
// surfaces as 40P01/40001, which the routes map to a 409 retry):
//   1. lab_requisitions row (not taken here)
//   2. lab_orders rows, `for update`, by ascending id
//   3. the slot advisory lock above, then the per-IST-date sample-sequence advisory lock
//   4. home_collection_visits row, `for update`
//   5. encounters (collect inserts one, last)
// Booking, visit cancel and collect lock the order rows before the visit row. Reschedule and assign touch
// only the visit row (plus the slot lock), never order rows.
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import {
  encounters, homeCollectionVisits, homeCollectionWindows, labOrders, labTests, patients, providers, users,
  type HomeCollectionVisitRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { ageOnDate, istDateOf } from '@/lib/india-time'
import {
  COLLECTOR_CANCEL_REASONS, bookingDateProblem, windowClosed,
  type RescheduleReason, type VisitCancelReason,
} from '@/lib/home-collection/rules'
import { isLocalPin } from '@/lib/labs/service-area'
import { parseSampleId } from '@/lib/labs/sample-id'
import type { LabOrderStatus } from '@/lib/labs/status'
import type { SampleContainer, SampleType } from '@/lib/labs/catalog'
import type { BookHomeCollectionRequest } from '@/lib/labs/validation'
import type { WriteExecutor } from '@/lib/queries/executor'
import { ensureSampleIds } from '@/lib/queries/lab-lifecycle'
import { getActiveServicePins, isLocalPatientPin } from '@/lib/queries/lab-setup'

export type { HomeCollectionVisitRow }

/** At most this many tests are offered in one booking (the request schema's cap). */
export const MAX_BOOKABLE_ORDERS = 20
/** At most this many visits are loaded onto the day board. */
export const MAX_BOARD_VISITS = 300
const MAX_ACTIVE_VISITS = 20

const ACTIVE_STATUSES = ['booked', 'collected'] as const

function slotLockKey(visitDate: string, windowId: number): string {
  return `home_collection:${visitDate}:${windowId}`
}

async function lockSlot(ex: WriteExecutor, visitDate: string, windowId: number): Promise<void> {
  await ex.execute(sql`select pg_advisory_xact_lock(hashtext(${slotLockKey(visitDate, windowId)}))`)
}

async function slotCount(ex: Pick<WriteExecutor, 'select'>, visitDate: string, windowId: number, excludeVisitId?: number): Promise<number> {
  const [row] = await ex
    .select({ n: count() })
    .from(homeCollectionVisits)
    .where(and(
      eq(homeCollectionVisits.visitDate, visitDate),
      eq(homeCollectionVisits.windowId, windowId),
      inArray(homeCollectionVisits.status, [...ACTIVE_STATUSES]),
      excludeVisitId === undefined ? undefined : ne(homeCollectionVisits.id, excludeVisitId),
    ))
  return Number(row.n)
}

async function patientHasBookedSlot(ex: Pick<WriteExecutor, 'select'>, patientId: string, visitDate: string, windowId: number, excludeVisitId?: number): Promise<boolean> {
  const [row] = await ex
    .select({ id: homeCollectionVisits.id })
    .from(homeCollectionVisits)
    .where(and(
      eq(homeCollectionVisits.patientId, patientId),
      eq(homeCollectionVisits.visitDate, visitDate),
      eq(homeCollectionVisits.windowId, windowId),
      eq(homeCollectionVisits.status, 'booked'),
      excludeVisitId === undefined ? undefined : ne(homeCollectionVisits.id, excludeVisitId),
    ))
    .limit(1)
  return row !== undefined
}

async function activeWindow(ex: Pick<WriteExecutor, 'select'>, windowId: number) {
  const [w] = await ex
    .select()
    .from(homeCollectionWindows)
    .where(and(eq(homeCollectionWindows.id, windowId), eq(homeCollectionWindows.isActive, true)))
  return w ?? null
}

// ── Availability ─────────────────────────────────────────────────────────────

export interface WindowAvailability {
  windowId: number
  label: string
  startTime: string
  endTime: string
  capacity: number
  booked: number
  remaining: number
  closed: boolean
}

/** Active windows for an IST date with their booked (booked|collected) counts, by start time. */
export async function listWindowAvailability(dateIso: string, now = new Date()): Promise<WindowAvailability[]> {
  const db = getDb()
  const windows = await db
    .select()
    .from(homeCollectionWindows)
    .where(eq(homeCollectionWindows.isActive, true))
    .orderBy(asc(homeCollectionWindows.startTime), asc(homeCollectionWindows.sortOrder), asc(homeCollectionWindows.id))
  if (windows.length === 0) return []
  const counts = await db
    .select({ windowId: homeCollectionVisits.windowId, n: count() })
    .from(homeCollectionVisits)
    .where(and(eq(homeCollectionVisits.visitDate, dateIso), inArray(homeCollectionVisits.status, [...ACTIVE_STATUSES])))
    .groupBy(homeCollectionVisits.windowId)
  const booked = new Map(counts.map((c) => [c.windowId, Number(c.n)]))
  return windows.map((w) => {
    const n = booked.get(w.id) ?? 0
    return {
      windowId: w.id,
      label: w.label,
      startTime: w.startTime,
      endTime: w.endTime,
      capacity: w.capacity,
      booked: n,
      remaining: Math.max(0, w.capacity - n),
      closed: windowClosed(dateIso, w.startTime, now),
    }
  })
}

// ── Booking context ──────────────────────────────────────────────────────────

export interface HomeCollectionContext {
  patient: {
    id: string
    name: string
    uhid: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    city: string | null
    district: string | null
    stateCode: string | null
    pinCode: string | null
    notificationOptOut: boolean
  }
  /** Registered (SP1) PIN in the active service area. Booking itself is decided by the visit PIN. */
  isLocal: boolean
  /** The first MAX_BOOKABLE_ORDERS bookable orders (oldest first). */
  bookableOrders: { id: number; testName: string; sampleType: SampleType | null; container: SampleContainer | null }[]
  /** Raw count of bookable orders, for a "showing first N" notice. */
  bookableOrderCount: number
  activeVisits: { id: number; visitDate: string; windowLabel: string }[]
}

const contextPatientColumns = {
  id: patients.id,
  name: patients.name,
  uhid: patients.uhid,
  phone: patients.phone,
  addressLine1: patients.addressLine1,
  addressLine2: patients.addressLine2,
  city: patients.city,
  district: patients.district,
  stateCode: patients.stateCode,
  pinCode: patients.pinCode,
  notificationOptOut: patients.notificationOptOut,
}

/** A patient by internal id, or else by UHID. Named columns only. */
async function findPatient(ex: Pick<WriteExecutor, 'select'>, idOrUhid: string) {
  const key = idOrUhid.trim()
  if (!key) return null
  const [byId] = await ex.select(contextPatientColumns).from(patients).where(eq(patients.id, key)).limit(1)
  if (byId) return byId
  const [byUhid] = await ex.select(contextPatientColumns).from(patients).where(eq(patients.uhid, key)).limit(1)
  return byUhid ?? null
}

const bookableWhere = (patientId: string) =>
  and(eq(labOrders.patientId, patientId), eq(labOrders.status, 'ordered'), eq(labTests.category, 'lab'))

export async function getHomeCollectionContext(patientIdOrUhid: string): Promise<HomeCollectionContext | null> {
  const db = getDb()
  const patient = await findPatient(db, patientIdOrUhid)
  if (!patient) return null
  const [active, bookableOrders, [total], activeVisits] = await Promise.all([
    getActiveServicePins(db),
    db
      .select({ id: labOrders.id, testName: labTests.name, sampleType: labTests.sampleType, container: labTests.container })
      .from(labOrders)
      .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
      .where(bookableWhere(patient.id))
      .orderBy(asc(labOrders.id))
      .limit(MAX_BOOKABLE_ORDERS),
    db
      .select({ n: count() })
      .from(labOrders)
      .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
      .where(bookableWhere(patient.id)),
    db
      .select({ id: homeCollectionVisits.id, visitDate: homeCollectionVisits.visitDate, windowLabel: homeCollectionVisits.windowLabel })
      .from(homeCollectionVisits)
      .where(and(eq(homeCollectionVisits.patientId, patient.id), eq(homeCollectionVisits.status, 'booked')))
      .orderBy(asc(homeCollectionVisits.visitDate), asc(homeCollectionVisits.windowStart), asc(homeCollectionVisits.id))
      .limit(MAX_ACTIVE_VISITS),
  ])
  return {
    patient,
    isLocal: isLocalPin(patient.pinCode, active),
    bookableOrders,
    bookableOrderCount: Number(total.n),
    activeVisits,
  }
}

// ── Book ─────────────────────────────────────────────────────────────────────

export type BookHomeCollectionResult =
  | { ok: true; visit: HomeCollectionVisitRow; sampleIds: Map<number, string> }
  | {
      ok: false
      error: 'invalid_date' | 'window_not_found' | 'window_closed' | 'not_in_service_area' | 'order_not_bookable' | 'slot_full' | 'already_booked' | 'patient_not_found'
      message?: string
    }

type BookFailure = Extract<BookHomeCollectionResult, { ok: false }>
const fail = <E extends BookFailure['error']>(error: E, message?: string) =>
  (message === undefined ? { ok: false as const, error } : { ok: false as const, error, message })

export async function bookHomeCollection(input: BookHomeCollectionRequest, session: Session, now = new Date()): Promise<BookHomeCollectionResult> {
  const dateProblem = bookingDateProblem(input.visitDate, istDateOf(now))
  if (dateProblem) return fail('invalid_date', dateProblem)
  const orderIds = [...new Set(input.labOrderIds)].sort((a, b) => a - b)

  return getDb().transaction(async (tx): Promise<BookHomeCollectionResult> => {
    const patient = await findPatient(tx, input.patientId)
    if (!patient) return fail('patient_not_found')

    const window = await activeWindow(tx, input.windowId)
    if (!window) return fail('window_not_found')
    if (windowClosed(input.visitDate, window.startTime, now)) return fail('window_closed')

    // The visit's own address decides (Ruling 3), not the registered one.
    if (!(await isLocalPatientPin(input.address.pinCode, tx))) return fail('not_in_service_area')

    // Lock order 2: the order rows, ascending id.
    const orders = orderIds.length === 0 ? [] : await tx
      .select({ id: labOrders.id, patientId: labOrders.patientId, status: labOrders.status, labTestId: labOrders.labTestId })
      .from(labOrders)
      .where(inArray(labOrders.id, orderIds))
      .orderBy(asc(labOrders.id))
      .for('update')
    if (orders.length !== orderIds.length) return fail('order_not_bookable')
    const testIds = [...new Set(orders.map((o) => o.labTestId))]
    const tests = await tx.select({ id: labTests.id, category: labTests.category }).from(labTests).where(inArray(labTests.id, testIds))
    const category = new Map(tests.map((t) => [t.id, t.category]))
    if (orders.some((o) => o.patientId !== patient.id || o.status !== 'ordered' || category.get(o.labTestId) !== 'lab')) return fail('order_not_bookable')

    // Lock order 3: the slot lock; capacity and the patient's own slot are checked under it.
    await lockSlot(tx, input.visitDate, window.id)
    if (await patientHasBookedSlot(tx, patient.id, input.visitDate, window.id)) return fail('already_booked')
    if ((await slotCount(tx, input.visitDate, window.id)) >= window.capacity) return fail('slot_full')

    // Sample IDs before the visit row is written (Ruling: sample-ID lock before the visit row).
    const sampleIds = await ensureSampleIds(tx, orderIds, now)

    const [visit] = await tx
      .insert(homeCollectionVisits)
      .values({
        patientId: patient.id,
        visitDate: input.visitDate,
        windowId: window.id,
        windowLabel: window.label,
        windowStart: window.startTime,
        windowEnd: window.endTime,
        status: 'booked',
        addressLine1: input.address.line1,
        addressLine2: input.address.line2 || null,
        city: input.address.city,
        district: input.address.district || null,
        stateCode: input.address.stateCode,
        pinCode: input.address.pinCode,
        landmark: input.address.landmark || null,
        contactPhone: input.contactPhone,
        notes: input.notes || null,
        bookedByName: session.name,
        bookedByUserId: session.userId,
        bookedAt: now,
        updatedAt: now,
      })
      .returning()

    await tx
      .update(labOrders)
      .set({ status: 'scheduled', homeCollectionVisitId: visit.id, statusChangedAt: now })
      .where(inArray(labOrders.id, orderIds))

    await logAudit(session, 'booked home sample collection', patient.id, `visit=${visit.id} orders=${orderIds.join(',')} date=${input.visitDate} window=${window.id}`, tx)
    return { ok: true, visit, sampleIds }
  })
}

// ── Reschedule ───────────────────────────────────────────────────────────────

export type RescheduleHomeCollectionResult =
  | { ok: true; visit: HomeCollectionVisitRow }
  | {
      ok: false
      error: 'not_found' | 'not_reschedulable' | 'same_slot' | 'invalid_date' | 'window_not_found' | 'window_closed' | 'slot_full' | 'already_booked'
      message?: string
    }

export async function rescheduleHomeCollection(
  visitId: number,
  input: { visitDate: string; windowId: number; reason: RescheduleReason; note?: string },
  session: Session,
  now = new Date(),
): Promise<RescheduleHomeCollectionResult> {
  return getDb().transaction(async (tx): Promise<RescheduleHomeCollectionResult> => {
    const [visit] = await tx.select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, visitId)).for('update')
    if (!visit) return { ok: false, error: 'not_found' }
    if (visit.status !== 'booked') return { ok: false, error: 'not_reschedulable' }
    if (visit.visitDate === input.visitDate && visit.windowId === input.windowId) return { ok: false, error: 'same_slot' }

    const dateProblem = bookingDateProblem(input.visitDate, istDateOf(now))
    if (dateProblem) return { ok: false, error: 'invalid_date', message: dateProblem }
    const window = await activeWindow(tx, input.windowId)
    if (!window) return { ok: false, error: 'window_not_found' }
    if (windowClosed(input.visitDate, window.startTime, now)) return { ok: false, error: 'window_closed' }

    await lockSlot(tx, input.visitDate, window.id)
    if (await patientHasBookedSlot(tx, visit.patientId, input.visitDate, window.id, visit.id)) return { ok: false, error: 'already_booked' }
    if ((await slotCount(tx, input.visitDate, window.id, visit.id)) >= window.capacity) return { ok: false, error: 'slot_full' }

    const dateChanged = visit.visitDate !== input.visitDate
    const [updated] = await tx
      .update(homeCollectionVisits)
      .set({
        visitDate: input.visitDate,
        windowId: window.id,
        windowLabel: window.label,
        windowStart: window.startTime,
        windowEnd: window.endTime,
        rescheduleCount: visit.rescheduleCount + 1,
        lastRescheduleReason: input.reason,
        lastRescheduleNote: input.note?.trim() || null,
        ...(dateChanged ? { collectorUserId: null, collectorAssignedAt: null, collectorAssignedByName: null } : {}),
        updatedAt: now,
      })
      .where(eq(homeCollectionVisits.id, visit.id))
      .returning()
    await logAudit(session, 'rescheduled home sample collection', visit.patientId, `visit=${visit.id} date=${input.visitDate} window=${window.id} reason=${input.reason}`, tx)
    return { ok: true, visit: updated }
  })
}

// ── Cancel ───────────────────────────────────────────────────────────────────

export type CancelHomeCollectionResult =
  | { ok: true; visit: HomeCollectionVisitRow; releasedOrderIds: number[] }
  | { ok: false; error: 'not_found' | 'not_cancellable' | 'not_assigned' | 'reason_not_allowed' }

const COLLECTOR_REASONS: readonly VisitCancelReason[] = COLLECTOR_CANCEL_REASONS

export async function cancelHomeCollection(
  visitId: number,
  input: { reason: VisitCancelReason; note?: string },
  session: Session,
  now = new Date(),
): Promise<CancelHomeCollectionResult> {
  return getDb().transaction(async (tx): Promise<CancelHomeCollectionResult> => {
    // Lock order: the visit's scheduled order rows (ascending id) BEFORE the visit row, the same
    // order cancelLabOrder takes. No path adds an order to an existing visit, so this set can only
    // shrink while we wait; it is re-read under the visit lock.
    const linked = await tx
      .select({ id: labOrders.id })
      .from(labOrders)
      .where(and(eq(labOrders.homeCollectionVisitId, visitId), eq(labOrders.status, 'scheduled')))
      .orderBy(asc(labOrders.id))
    if (linked.length > 0) {
      await tx.select({ id: labOrders.id }).from(labOrders).where(inArray(labOrders.id, linked.map((o) => o.id))).orderBy(asc(labOrders.id)).for('update')
    }
    const [visit] = await tx.select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, visitId)).for('update')
    if (!visit) return { ok: false, error: 'not_found' }
    if (session.role === 'collector') {
      // A collector acts only on their own visits, and only with a doorstep reason.
      if (session.userId === null || visit.collectorUserId !== session.userId) return { ok: false, error: 'not_assigned' }
      if (!COLLECTOR_REASONS.includes(input.reason)) return { ok: false, error: 'reason_not_allowed' }
    }
    if (visit.status !== 'booked') return { ok: false, error: 'not_cancellable' }

    const released = await tx
      .update(labOrders)
      .set({ status: 'ordered', homeCollectionVisitId: null, statusChangedAt: now })
      .where(and(eq(labOrders.homeCollectionVisitId, visitId), eq(labOrders.status, 'scheduled')))
      .returning({ id: labOrders.id })
    const releasedOrderIds = released.map((r) => r.id).sort((a, b) => a - b)

    const [updated] = await tx
      .update(homeCollectionVisits)
      .set({
        status: 'cancelled',
        cancelledAt: now,
        cancelledByName: session.name,
        cancelReason: input.reason,
        cancelNote: input.note?.trim() || null,
        updatedAt: now,
      })
      .where(eq(homeCollectionVisits.id, visitId))
      .returning()
    await logAudit(session, 'cancelled home sample collection', visit.patientId, `visit=${visitId} reason=${input.reason} orders=${releasedOrderIds.join(',')}`, tx)
    return { ok: true, visit: updated, releasedOrderIds }
  })
}

// ── Collector dispatch ───────────────────────────────────────────────────────

export type AssignCollectorResult =
  | { ok: true; visit: HomeCollectionVisitRow }
  | { ok: false; error: 'not_found' | 'not_assignable' | 'collector_not_found' }

export async function assignCollector(visitId: number, collectorUserId: number | null, session: Session, now = new Date()): Promise<AssignCollectorResult> {
  return getDb().transaction(async (tx): Promise<AssignCollectorResult> => {
    const [visit] = await tx.select({ id: homeCollectionVisits.id, status: homeCollectionVisits.status, patientId: homeCollectionVisits.patientId })
      .from(homeCollectionVisits).where(eq(homeCollectionVisits.id, visitId)).for('update')
    if (!visit) return { ok: false, error: 'not_found' }
    if (visit.status !== 'booked') return { ok: false, error: 'not_assignable' }
    if (collectorUserId !== null) {
      const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, collectorUserId), eq(users.role, 'collector')))
      if (!user) return { ok: false, error: 'collector_not_found' }
    }
    const [updated] = await tx
      .update(homeCollectionVisits)
      .set(collectorUserId === null
        ? { collectorUserId: null, collectorAssignedAt: null, collectorAssignedByName: null, updatedAt: now }
        : { collectorUserId, collectorAssignedAt: now, collectorAssignedByName: session.name, updatedAt: now })
      .where(eq(homeCollectionVisits.id, visitId))
      .returning()
    await logAudit(session, 'assigned home collection collector', visit.patientId, `visit=${visitId} collector=${collectorUserId ?? 'none'}`, tx)
    return { ok: true, visit: updated }
  })
}

/** Users with the collector role (id + display name only). */
export async function listCollectors(): Promise<{ id: number; name: string }[]> {
  return getDb().select({ id: users.id, name: users.name }).from(users).where(eq(users.role, 'collector')).orderBy(asc(users.name), asc(users.id))
}

// ── Day board ────────────────────────────────────────────────────────────────

export interface BoardVisit {
  id: number
  status: HomeCollectionVisitRow['status']
  visitDate: string
  windowId: number
  windowLabel: string
  patientId: string
  patientName: string
  uhid: string | null
  city: string
  pinCode: string
  contactPhone: string
  collector: { userId: number; name: string } | null
  rescheduleCount: number
  tests: { orderId: number; testName: string; sampleId: string | null; container: SampleContainer | null; status: LabOrderStatus }[]
}

/**
 * One IST day: window availability, and up to MAX_BOARD_VISITS visits (all statuses) sorted by
 * window start then id, each with its tests. Two queries for the visits and their orders (no N+1);
 * `totalVisits` is the raw count for a "showing first N" notice.
 */
export async function listHomeCollectionBoard(
  dateIso: string,
  now = new Date(),
): Promise<{ windows: WindowAvailability[]; visits: BoardVisit[]; totalVisits: number }> {
  const db = getDb()
  const collector = alias(users, 'collector')
  const [windows, rows, [total]] = await Promise.all([
    listWindowAvailability(dateIso, now),
    db
      .select({
        id: homeCollectionVisits.id,
        status: homeCollectionVisits.status,
        visitDate: homeCollectionVisits.visitDate,
        windowId: homeCollectionVisits.windowId,
        windowLabel: homeCollectionVisits.windowLabel,
        patientId: homeCollectionVisits.patientId,
        patientName: patients.name,
        uhid: patients.uhid,
        city: homeCollectionVisits.city,
        pinCode: homeCollectionVisits.pinCode,
        contactPhone: homeCollectionVisits.contactPhone,
        collectorUserId: homeCollectionVisits.collectorUserId,
        collectorName: collector.name,
        rescheduleCount: homeCollectionVisits.rescheduleCount,
      })
      .from(homeCollectionVisits)
      .innerJoin(patients, eq(patients.id, homeCollectionVisits.patientId))
      .leftJoin(collector, eq(collector.id, homeCollectionVisits.collectorUserId))
      .where(eq(homeCollectionVisits.visitDate, dateIso))
      .orderBy(asc(homeCollectionVisits.windowStart), asc(homeCollectionVisits.id))
      .limit(MAX_BOARD_VISITS),
    db.select({ n: count() }).from(homeCollectionVisits).where(eq(homeCollectionVisits.visitDate, dateIso)),
  ])
  const ids = rows.map((r) => r.id)
  const orders = ids.length === 0 ? [] : await db
    .select({
      visitId: labOrders.homeCollectionVisitId,
      orderId: labOrders.id,
      testName: labTests.name,
      sampleId: labOrders.sampleId,
      container: labTests.container,
      status: labOrders.status,
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .where(inArray(labOrders.homeCollectionVisitId, ids))
    .orderBy(asc(labOrders.id))
  const testsByVisit = new Map<number, BoardVisit['tests']>()
  for (const o of orders) {
    if (o.visitId === null) continue
    const list = testsByVisit.get(o.visitId) ?? []
    list.push({ orderId: o.orderId, testName: o.testName, sampleId: o.sampleId, container: o.container, status: o.status })
    testsByVisit.set(o.visitId, list)
  }
  const visits: BoardVisit[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    visitDate: r.visitDate,
    windowId: r.windowId,
    windowLabel: r.windowLabel,
    patientId: r.patientId,
    patientName: r.patientName,
    uhid: r.uhid,
    city: r.city,
    pinCode: r.pinCode,
    contactPhone: r.contactPhone,
    collector: r.collectorUserId !== null && r.collectorName !== null ? { userId: r.collectorUserId, name: r.collectorName } : null,
    rescheduleCount: r.rescheduleCount,
    tests: testsByVisit.get(r.id) ?? [],
  }))
  return { windows, visits, totalVisits: Number(total.n) }
}


// ── Collector route (Task 12) ────────────────────────────────────────────────

/**
 * One stop on a collector's route. A minimal projection for field staff: the patient's first name
 * and last initial, UHID (to match the tube labels), age and gender (never the DOB), the visit's
 * contact phone and address snapshot, and the tubes to draw. No Aadhaar, ABHA or clinical history.
 */
export interface RouteStop {
  visitId: number
  status: HomeCollectionVisitRow['status']
  windowLabel: string
  windowStart: string
  windowEnd: string
  patient: { id: string; name: string; uhid: string | null; ageYears: number; gender: string | null }
  contactPhone: string
  address: { line1: string; line2: string | null; city: string; district: string | null; stateCode: string; pinCode: string; landmark: string | null }
  notes: string | null
  tests: { orderId: number; testName: string; sampleType: SampleType | null; container: SampleContainer | null; sampleId: string | null; status: LabOrderStatus }[]
}

/** "Asha Devi Rao" → "Asha R."; a single name is shown as is. */
export function shortPatientName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts[0]} ${Array.from(parts[parts.length - 1])[0]}.`
}

/** At most this many stops are loaded for one day. */
export const MAX_ROUTE_STOPS = 200

/**
 * The stops for one IST date, by window start then id, in every status (a collector also sees
 * what they finished). `collectorUserId` filters to that collector's visits server-side; null
 * is the admin view of every visit. The caller must never pass null for a collector session.
 */
export async function listCollectorRoute(collectorUserId: number | null, dateIso: string): Promise<RouteStop[]> {
  const db = getDb()
  const rows = await db
    .select({
      visitId: homeCollectionVisits.id,
      status: homeCollectionVisits.status,
      windowLabel: homeCollectionVisits.windowLabel,
      windowStart: homeCollectionVisits.windowStart,
      windowEnd: homeCollectionVisits.windowEnd,
      patientId: patients.id,
      patientName: patients.name,
      uhid: patients.uhid,
      dob: patients.dob,
      gender: patients.gender,
      contactPhone: homeCollectionVisits.contactPhone,
      line1: homeCollectionVisits.addressLine1,
      line2: homeCollectionVisits.addressLine2,
      city: homeCollectionVisits.city,
      district: homeCollectionVisits.district,
      stateCode: homeCollectionVisits.stateCode,
      pinCode: homeCollectionVisits.pinCode,
      landmark: homeCollectionVisits.landmark,
      notes: homeCollectionVisits.notes,
    })
    .from(homeCollectionVisits)
    .innerJoin(patients, eq(patients.id, homeCollectionVisits.patientId))
    .where(and(
      eq(homeCollectionVisits.visitDate, dateIso),
      collectorUserId === null ? undefined : eq(homeCollectionVisits.collectorUserId, collectorUserId),
    ))
    .orderBy(asc(homeCollectionVisits.windowStart), asc(homeCollectionVisits.id))
    .limit(MAX_ROUTE_STOPS)
  if (rows.length === 0) return []
  const orders = await db
    .select({
      visitId: labOrders.homeCollectionVisitId,
      orderId: labOrders.id,
      testName: labTests.name,
      sampleType: labTests.sampleType,
      container: labTests.container,
      sampleId: labOrders.sampleId,
      status: labOrders.status,
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .where(inArray(labOrders.homeCollectionVisitId, rows.map((r) => r.visitId)))
    .orderBy(asc(labOrders.id))
  const testsByVisit = new Map<number, RouteStop['tests']>()
  for (const { visitId, ...t } of orders) {
    if (visitId === null) continue
    const list = testsByVisit.get(visitId) ?? []
    list.push(t)
    testsByVisit.set(visitId, list)
  }
  return rows.map((r) => ({
    visitId: r.visitId,
    status: r.status,
    windowLabel: r.windowLabel,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    patient: { id: r.patientId, name: shortPatientName(r.patientName), uhid: r.uhid, ageYears: ageOnDate(r.dob, dateIso), gender: r.gender },
    contactPhone: r.contactPhone,
    address: { line1: r.line1, line2: r.line2, city: r.city, district: r.district, stateCode: r.stateCode, pinCode: r.pinCode, landmark: r.landmark },
    notes: r.notes,
    tests: testsByVisit.get(r.visitId) ?? [],
  }))
}

// ── Mark collected by sample ID (Task 12) ────────────────────────────────────

export type CollectHomeVisitResult =
  | { ok: true; collectedOrderIds: number[]; notCollectedOrderIds: number[]; encounterId: number }
  | { ok: false; error: 'not_found' | 'not_collectable' | 'not_assigned' | 'invalid_sample_id' | 'sample_not_on_visit'; sampleId?: string }

/**
 * The collector at the door: the tubes drawn are identified by their scanned/typed sample IDs.
 * Each input is check-digit validated (and de-duplicated) BEFORE any DB read. Then ONE
 * transaction, in the module's lock order: the visit's scheduled order rows (ascending id), then
 * the visit row, then the encounter insert. Matched orders become `collected`; the rest go back to
 * `ordered` (visit link cleared, sample ID kept). A completed `lab` encounter is written and
 * linked to the visit, and the audit row is on the same transaction. Every refusal writes nothing.
 * A concurrent second collect waits on the order/visit locks and then sees `not_collectable`.
 */
export async function collectHomeVisit(visitId: number, sampleIds: string[], session: Session, now = new Date()): Promise<CollectHomeVisitResult> {
  const canonical: string[] = []
  for (const input of sampleIds) {
    const parsed = parseSampleId(input)
    if (!parsed || canonical.includes(parsed.canonical)) return { ok: false, error: 'invalid_sample_id', sampleId: input }
    canonical.push(parsed.canonical)
  }
  if (canonical.length === 0) return { ok: false, error: 'invalid_sample_id', sampleId: '' }

  return getDb().transaction(async (tx): Promise<CollectHomeVisitResult> => {
    // Lock order 2: the visit's scheduled order rows, ascending id, before the visit row. No path
    // adds an order to an existing visit, so this set can only shrink; it is re-read below.
    const linked = await tx
      .select({ id: labOrders.id })
      .from(labOrders)
      .where(and(eq(labOrders.homeCollectionVisitId, visitId), eq(labOrders.status, 'scheduled')))
      .orderBy(asc(labOrders.id))
    if (linked.length > 0) {
      await tx.select({ id: labOrders.id }).from(labOrders).where(inArray(labOrders.id, linked.map((o) => o.id))).orderBy(asc(labOrders.id)).for('update')
    }
    // Lock order 4: the visit row.
    const [visit] = await tx
      .select({ id: homeCollectionVisits.id, patientId: homeCollectionVisits.patientId, status: homeCollectionVisits.status, collectorUserId: homeCollectionVisits.collectorUserId })
      .from(homeCollectionVisits)
      .where(eq(homeCollectionVisits.id, visitId))
      .for('update')
    if (!visit) return { ok: false, error: 'not_found' }
    // A collector acts only on their own visits; checked before the status so a collector
    // learns nothing about another collector's visit.
    if (session.role === 'collector' && (session.userId === null || visit.collectorUserId !== session.userId)) {
      return { ok: false, error: 'not_assigned' }
    }
    if (visit.status !== 'booked') return { ok: false, error: 'not_collectable' }

    const scheduled = await tx
      .select({ id: labOrders.id, sampleId: labOrders.sampleId, orderedByProviderId: labOrders.orderedByProviderId })
      .from(labOrders)
      .where(and(eq(labOrders.homeCollectionVisitId, visitId), eq(labOrders.status, 'scheduled')))
      .orderBy(asc(labOrders.id))
    const bySample = new Map(scheduled.filter((o) => o.sampleId !== null).map((o) => [o.sampleId as string, o]))
    for (const sid of canonical) {
      if (!bySample.has(sid)) return { ok: false, error: 'sample_not_on_visit', sampleId: sid }
    }
    const collected = scheduled.filter((o) => o.sampleId !== null && canonical.includes(o.sampleId))
    const missed = scheduled.filter((o) => !collected.includes(o))
    const collectedOrderIds = collected.map((o) => o.id)
    const notCollectedOrderIds = missed.map((o) => o.id)

    await tx
      .update(labOrders)
      .set({ status: 'collected', collectedAt: now, collectedByName: session.name, statusChangedAt: now })
      .where(inArray(labOrders.id, collectedOrderIds))
    if (notCollectedOrderIds.length > 0) {
      await tx
        .update(labOrders)
        .set({ status: 'ordered', homeCollectionVisitId: null, statusChangedAt: now })
        .where(inArray(labOrders.id, notCollectedOrderIds))
    }

    // Lock order 5: the encounter (Ruling 13), under the first collected order's prescriber.
    const providerId = collected[0].orderedByProviderId
    const [provider] = await tx.select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, providerId))
    const [encounter] = await tx
      .insert(encounters)
      .values({
        patientId: visit.patientId,
        encounterType: 'lab',
        visitType: 'new',
        status: 'completed',
        encounterDate: istDateOf(now),
        opdToken: null,
        providerId,
        departmentId: provider?.departmentId ?? null,
        checkedInByName: session.name,
        checkedInAt: now,
        completedAt: now,
        statusChangedAt: now,
        statusChangedByName: session.name,
      })
      .returning({ id: encounters.id })

    await tx
      .update(homeCollectionVisits)
      .set({ status: 'collected', collectedAt: now, collectedByName: session.name, encounterId: encounter.id, updatedAt: now })
      .where(eq(homeCollectionVisits.id, visitId))

    await logAudit(
      session, 'collected home samples', visit.patientId,
      `visit=${visitId} orders=${collectedOrderIds.join(',')} missed=${notCollectedOrderIds.join(',')} encounter=${encounter.id}`, tx,
    )
    return { ok: true, collectedOrderIds, notCollectedOrderIds, encounterId: encounter.id }
  })
}
