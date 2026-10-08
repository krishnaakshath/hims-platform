// Wave G P2-01: the staff notification feed, computed from live events, plus the per-user
// read state (staff_notification_reads). Which sources run is decided by feedSourcesFor
// (src/lib/notifications/staff-feed.ts); a source a role cannot see is never queried.
// Each source is one small bounded query; aggregate sources ("N follow-ups due") produce
// one item per IST day so a count changing during the day does not re-notify.
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  bookingRequests, chargeLines, doctorAssignments, encounterCoding, followUpOrders, homeCollectionVisits,
  labOrders, labReports, labResults, labTests, medicationInventory, medications, notificationDeliveries,
  patients, providers, staffNotificationReads,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { formatCalendarDate, startOfIstDay, todayIsoIn } from '@/lib/india-time'
import { addDaysIso, MISSED_GRACE_DAYS } from '@/lib/follow-ups/rules'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import {
  FEED_LOOKBACK_DAYS, FEED_SOURCE_LIMIT, READ_RETENTION_DAYS, feedSourcesFor, mergeFeed, showsPatientNames,
  sourceHref, userKeyFor, withReadState, type FeedSource, type StaffFeed, type StaffNotification,
} from '@/lib/notifications/staff-feed'

type Ctx = { session: Session; now: Date; today: string; since: Date; names: boolean }

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString()
const patientLabel = (name: string, uhid: string | null) => (uhid ? `${name.trim()} (${uhid})` : name.trim())
const dayStamp = (today: string) => startOfIstDay(today).toISOString()

const NOTICE_LABEL: Record<string, string> = {
  lab_tests_ordered: 'Lab tests ordered',
  home_collection_booked: 'Home collection booked',
  home_collection_rescheduled: 'Home collection moved',
  home_collection_cancelled: 'Home collection cancelled',
  lab_report_ready: 'Lab report ready',
}

const SOURCES: Record<FeedSource, (c: Ctx) => Promise<StaffNotification[]>> = {
  async lab_critical(c) {
    const rows = await getDb()
      .select({ id: labResults.id, resultedAt: labResults.resultedAt, test: labTests.name, orderId: labOrders.id, sampleId: labOrders.sampleId, patientId: patients.id, name: patients.name, uhid: patients.uhid })
      .from(labResults)
      .innerJoin(labOrders, eq(labOrders.id, labResults.labOrderId))
      .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
      .innerJoin(patients, eq(patients.id, labOrders.patientId))
      .where(and(eq(labResults.flag, 'critical'), gte(labResults.resultedAt, c.since)))
      .orderBy(desc(labResults.resultedAt), desc(labResults.id))
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      key: `lab_critical:${r.id}`, kind: 'lab_critical', severity: 'critical', title: 'Critical lab result',
      detail: c.names ? `${r.test} · ${patientLabel(r.name, r.uhid)}` : `${r.test} · sample ${r.sampleId ?? `order ${r.orderId}`}`,
      href: sourceHref('lab_critical', c.session.role, r.patientId), occurredAt: iso(r.resultedAt),
    }))
  },

  async lab_report(c) {
    const rows = await getDb()
      .select({ id: labReports.id, releasedAt: labReports.releasedAt, summary: labReports.testSummary, reportNumber: labReports.reportNumber, patientId: patients.id, name: patients.name, uhid: patients.uhid })
      .from(labReports)
      .innerJoin(patients, eq(patients.id, labReports.patientId))
      .where(and(isNull(labReports.supersededAt), gte(labReports.releasedAt, c.since)))
      .orderBy(desc(labReports.releasedAt), desc(labReports.id))
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      key: `lab_report:${r.id}`, kind: 'lab_report', severity: 'info', title: 'Lab report released',
      detail: c.names ? `${r.summary} · ${patientLabel(r.name, r.uhid)}` : `${r.summary} · ${r.reportNumber}`,
      href: sourceHref('lab_report', c.session.role, r.patientId), occurredAt: iso(r.releasedAt),
    }))
  },

  async follow_up_due(c) {
    // Stored 'planned' whose recall window has opened and is not yet past the missed grace.
    const [row] = await getDb()
      .select({
        due: sql<number>`count(*) filter (where ${followUpOrders.windowEnd} >= ${c.today})::int`,
        overdue: sql<number>`count(*) filter (where ${followUpOrders.windowEnd} < ${c.today})::int`,
      })
      .from(followUpOrders)
      .where(and(
        eq(followUpOrders.status, 'planned'),
        lte(followUpOrders.windowStart, c.today),
        gte(followUpOrders.windowEnd, addDaysIso(c.today, -MISSED_GRACE_DAYS)),
      ))
    const due = row?.due ?? 0
    const overdue = row?.overdue ?? 0
    if (due + overdue === 0) return []
    return [{
      key: `follow_up_due:${c.today}`, kind: 'follow_up_due', severity: overdue > 0 ? 'warning' : 'info',
      title: 'Follow-ups to book', detail: `${due} due, ${overdue} overdue — call and book`,
      href: sourceHref('follow_up_due', c.session.role), occurredAt: dayStamp(c.today),
    }]
  },

  async booking_request(c) {
    const rows = await getDb()
      .select({ id: bookingRequests.id, submittedAt: bookingRequests.submittedAt, name: bookingRequests.requesterName, start: bookingRequests.preferredDateRangeStart, end: bookingRequests.preferredDateRangeEnd })
      .from(bookingRequests)
      .where(and(eq(bookingRequests.status, 'pending'), gte(bookingRequests.submittedAt, c.since)))
      .orderBy(desc(bookingRequests.submittedAt), desc(bookingRequests.id))
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      key: `booking_request:${r.id}`, kind: 'booking_request', severity: 'info', title: 'New appointment request',
      detail: `${r.name.trim()} · prefers ${formatCalendarDate(r.start)}${r.end !== r.start ? ` – ${formatCalendarDate(r.end)}` : ''}`,
      href: sourceHref('booking_request', c.session.role), occurredAt: iso(r.submittedAt),
    }))
  },

  async assignment_declined(c) {
    const rows = await getDb()
      .select({ id: doctorAssignments.id, createdAt: doctorAssignments.createdAt, doctor: providers.name, name: patients.name, uhid: patients.uhid })
      .from(doctorAssignments)
      .innerJoin(providers, eq(providers.id, doctorAssignments.providerId))
      .innerJoin(patients, eq(patients.id, doctorAssignments.patientId))
      .where(and(eq(doctorAssignments.status, 'declined'), isNull(doctorAssignments.declineAcknowledgedAt)))
      .orderBy(desc(doctorAssignments.createdAt), desc(doctorAssignments.id))
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      key: `assignment_declined:${r.id}`, kind: 'assignment_declined', severity: 'warning', title: 'Doctor declined an assignment',
      detail: `${r.doctor} · ${patientLabel(r.name, r.uhid)} — reassign`,
      href: sourceHref('assignment_declined', c.session.role), occurredAt: iso(r.createdAt),
    }))
  },

  async assignment_pending(c) {
    const provider = await resolveDoctorQueueProvider(c.session)
    if (!provider) return []
    const rows = await getDb()
      .select({ id: doctorAssignments.id, createdAt: doctorAssignments.createdAt, urgency: doctorAssignments.urgency, visitType: doctorAssignments.visitType, name: patients.name, uhid: patients.uhid })
      .from(doctorAssignments)
      .innerJoin(patients, eq(patients.id, doctorAssignments.patientId))
      .where(and(eq(doctorAssignments.status, 'pending'), eq(doctorAssignments.providerId, provider.id)))
      .orderBy(desc(doctorAssignments.createdAt), desc(doctorAssignments.id))
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      key: `assignment_pending:${r.id}`, kind: 'assignment_pending',
      severity: r.urgency === 'emergency' ? 'critical' : r.urgency === 'urgent' ? 'warning' : 'info',
      title: r.urgency === 'routine' ? 'New patient assigned to you' : `${r.urgency === 'emergency' ? 'Emergency' : 'Urgent'} patient assigned to you`,
      detail: `${patientLabel(r.name, r.uhid)} · ${r.visitType === 'inpatient' ? 'Inpatient' : 'Outpatient'}`,
      href: sourceHref('assignment_pending', c.session.role), occurredAt: iso(r.createdAt),
    }))
  },

  async low_stock(c) {
    const rows = await getDb()
      .select({ medicationId: medications.id, name: medications.name, qty: medicationInventory.quantityOnHand, threshold: medicationInventory.reorderThreshold, unit: medicationInventory.unit, updatedAt: medicationInventory.updatedAt })
      .from(medicationInventory)
      .innerJoin(medications, eq(medications.id, medicationInventory.medicationId))
      .where(lte(medicationInventory.quantityOnHand, medicationInventory.reorderThreshold))
      .orderBy(medicationInventory.quantityOnHand, medications.name)
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      // The stock level is part of the key: a further drop (or a restock and a new drop) notifies again.
      key: `low_stock:${r.medicationId}:${r.qty}`, kind: 'low_stock', severity: r.qty <= 0 ? 'critical' : 'warning',
      title: r.qty <= 0 ? 'Out of stock' : 'Low stock',
      detail: `${r.name}: ${r.qty} ${r.unit} left (reorder at ${r.threshold})`,
      href: sourceHref('low_stock', c.session.role), occurredAt: iso(r.updatedAt),
    }))
  },

  async notice_failed(c) {
    const rows = await getDb()
      .select({ id: notificationDeliveries.id, createdAt: notificationDeliveries.createdAt, templateKey: notificationDeliveries.templateKey, patientId: patients.id, name: patients.name, uhid: patients.uhid })
      .from(notificationDeliveries)
      .innerJoin(patients, eq(patients.id, notificationDeliveries.patientId))
      .where(and(eq(notificationDeliveries.status, 'failed'), gte(notificationDeliveries.createdAt, c.since)))
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => ({
      key: `notice_failed:${r.id}`, kind: 'notice_failed', severity: 'warning', title: 'Patient message not delivered',
      detail: `${NOTICE_LABEL[r.templateKey] ?? 'Patient notice'} · ${patientLabel(r.name, r.uhid)} — check the mobile number`,
      href: sourceHref('notice_failed', c.session.role, r.patientId), occurredAt: iso(r.createdAt),
    }))
  },

  async home_visit(c) {
    if (c.session.userId === null) return []
    const rows = await getDb()
      .select({ id: homeCollectionVisits.id, visitDate: homeCollectionVisits.visitDate, windowLabel: homeCollectionVisits.windowLabel, city: homeCollectionVisits.city, pinCode: homeCollectionVisits.pinCode, assignedAt: homeCollectionVisits.collectorAssignedAt, bookedAt: homeCollectionVisits.bookedAt })
      .from(homeCollectionVisits)
      .where(and(
        eq(homeCollectionVisits.collectorUserId, c.session.userId),
        eq(homeCollectionVisits.status, 'booked'),
        gte(homeCollectionVisits.visitDate, c.today),
        lte(homeCollectionVisits.visitDate, addDaysIso(c.today, 1)),
      ))
      .orderBy(homeCollectionVisits.visitDate, homeCollectionVisits.windowStart)
      .limit(FEED_SOURCE_LIMIT)
    return rows.map((r) => {
      const at = r.assignedAt ?? r.bookedAt
      return {
        key: `home_visit:${r.id}:${Math.floor(new Date(at).getTime() / 1000)}`, kind: 'home_visit', severity: 'info', title: 'Home collection on your route',
        detail: `${formatCalendarDate(r.visitDate)}, ${r.windowLabel} · ${r.city} ${r.pinCode}`,
        href: sourceHref('home_visit', c.session.role), occurredAt: iso(at),
      }
    })
  },

  async lab_receipt(c) {
    const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(labOrders).where(eq(labOrders.status, 'collected'))
    const n = row?.n ?? 0
    if (n === 0) return []
    return [{
      key: `lab_receipt:${c.today}`, kind: 'lab_receipt', severity: 'info', title: 'Samples to receive',
      detail: `${n} collected sample${n === 1 ? '' : 's'} not yet received in the lab`,
      href: sourceHref('lab_receipt', c.session.role), occurredAt: dayStamp(c.today),
    }]
  },

  async coding_queue(c) {
    const [row] = await getDb()
      .select({ uncoded: sql<number>`count(*) filter (where ${encounterCoding.status} = 'uncoded')::int`, queried: sql<number>`count(*) filter (where ${encounterCoding.status} = 'queried')::int` })
      .from(encounterCoding)
      .where(inArray(encounterCoding.status, ['uncoded', 'queried']))
    const uncoded = row?.uncoded ?? 0
    const queried = row?.queried ?? 0
    if (uncoded + queried === 0) return []
    return [{
      key: `coding_queue:${c.today}`, kind: 'coding_queue', severity: 'info', title: 'Visits to code',
      detail: `${uncoded} not yet coded, ${queried} waiting on a doctor's answer`,
      href: sourceHref('coding_queue', c.session.role), occurredAt: dayStamp(c.today),
    }]
  },

  async charges_uninvoiced(c) {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(chargeLines)
      .where(and(eq(chargeLines.status, 'captured'), lt(chargeLines.serviceDate, c.today)))
    const n = row?.n ?? 0
    if (n === 0) return []
    return [{
      key: `charges_uninvoiced:${c.today}`, kind: 'charges_uninvoiced', severity: 'info', title: 'Charges to invoice',
      detail: `${n} captured charge line${n === 1 ? '' : 's'} from earlier days not yet invoiced`,
      href: sourceHref('charges_uninvoiced', c.session.role), occurredAt: dayStamp(c.today),
    }]
  },
}

/** The role's feed, newest first. One failing source is logged and skipped, never fatal. */
export async function loadStaffNotifications(session: Session, now: Date = new Date()): Promise<StaffNotification[]> {
  const today = todayIsoIn('Asia/Kolkata', now)
  const ctx: Ctx = { session, now, today, since: new Date(now.getTime() - FEED_LOOKBACK_DAYS * 86_400_000), names: showsPatientNames(session.role) }
  const groups = await Promise.all(feedSourcesFor(session.role).map(async (s) => {
    try {
      return await SOURCES[s](ctx)
    } catch (err) {
      console.error(`[notifications] source ${s} failed`, err instanceof Error ? err.name : 'error')
      return []
    }
  }))
  return mergeFeed(groups)
}

async function readKeysFor(userKey: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set()
  const rows = await getDb()
    .select({ itemKey: staffNotificationReads.itemKey })
    .from(staffNotificationReads)
    .where(and(eq(staffNotificationReads.userKey, userKey), inArray(staffNotificationReads.itemKey, keys)))
  return new Set(rows.map((r) => r.itemKey))
}

export async function getStaffFeed(session: Session, now: Date = new Date()): Promise<StaffFeed> {
  const items = await loadStaffNotifications(session, now)
  return withReadState(items, await readKeysFor(userKeyFor(session), items.map((i) => i.key)))
}

/**
 * Marks items read for this user. Only keys present in the user's CURRENT feed are stored
 * (`keys` null = all of them), so nothing outside the feed can be written. Idempotent.
 * Prunes this user's read rows past the retention window in the same transaction.
 */
export async function markStaffNotificationsRead(session: Session, keys: string[] | null, now: Date = new Date()): Promise<StaffFeed> {
  const items = await loadStaffNotifications(session, now)
  const inFeed = new Set(items.map((i) => i.key))
  const toMark = keys === null ? [...inFeed] : [...new Set(keys)].filter((k) => inFeed.has(k))
  const userKey = userKeyFor(session)
  await getDb().transaction(async (tx) => {
    if (toMark.length > 0) {
      await tx.insert(staffNotificationReads).values(toMark.map((itemKey) => ({ userKey, itemKey, readAt: now }))).onConflictDoNothing()
    }
    await tx.delete(staffNotificationReads).where(and(
      eq(staffNotificationReads.userKey, userKey),
      lt(staffNotificationReads.readAt, new Date(now.getTime() - READ_RETENTION_DAYS * 86_400_000)),
    ))
  })
  return withReadState(items, await readKeysFor(userKey, [...inFeed]))
}
