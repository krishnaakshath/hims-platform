// Wave G P2-01: the staff notification feed against real Postgres. Fixtures are
// created per run and deleted by id; read-state rows by this run's user keys.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { inArray, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  bookingRequests, doctorAssignments, labOrders, labResults, medicationInventory, medications,
  notificationDeliveries, staffNotificationReads,
} from '@/db/schema'
import type { Session } from '@/lib/auth'

// The pi source resolves the doctor from the session; keep it deterministic.
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 1, name: 'Dr. Test' })) }))

import { getStaffFeed, loadStaffNotifications, markStaffNotificationsRead } from '@/lib/queries/staff-notifications'

const RUN = `${Date.now()}`
const PATIENT = 'RD-0001'
const s = (role: Session['role'], userId: number | null = null): Session => ({ role, name: `twg-${RUN}-${role}`, userId })

describe.skipIf(!process.env.DATABASE_URL)('staff notification feed (DB)', () => {
  const ids = { booking: 0, med: 0, delivery: 0, order: 0, result: 0, declined: 0, pending: 0 }

  beforeAll(async () => {
    const db = getDb()
    const [b] = await db.insert(bookingRequests).values({ requesterName: `TWG Requester ${RUN}`, requesterDob: '1990-01-01', requesterPhone: '+919876500000', preferredDateRangeStart: '2026-10-20', preferredDateRangeEnd: '2026-10-22', reason: 'checkup' }).returning()
    const [m] = await db.insert(medications).values({ name: `AAA TWG Med ${RUN}`, medicationClass: 'test' }).returning()
    await db.insert(medicationInventory).values({ medicationId: m.id, quantityOnHand: 0, reorderThreshold: 10, unit: 'tablets' })
    const [d] = await db.insert(notificationDeliveries).values({ patientId: PATIENT, templateKey: 'lab_report_ready', channel: 'sms', status: 'failed', destinationMasked: '+91XXXXXX0000', dedupeKey: `twg-${RUN}`, createdByName: 'test', errorCode: 'test' }).returning()
    const [o] = await db.insert(labOrders).values({ patientId: PATIENT, labTestId: 1, orderedByProviderId: 1, status: 'resulted' }).returning()
    const [r] = await db.insert(labResults).values({ labOrderId: o.id, value: '9.9', flag: 'critical', resultedByName: 'test' }).returning()
    const [dec] = await db.insert(doctorAssignments).values({ patientId: PATIENT, providerId: 1, visitType: 'outpatient', reason: 'twg', status: 'declined', assignedByName: 'test', declineReason: 'away' }).returning()
    const [pen] = await db.insert(doctorAssignments).values({ patientId: PATIENT, providerId: 1, visitType: 'inpatient', urgency: 'emergency', reason: 'twg', status: 'pending', assignedByName: 'test' }).returning()
    Object.assign(ids, { booking: b.id, med: m.id, delivery: d.id, order: o.id, result: r.id, declined: dec.id, pending: pen.id })
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(staffNotificationReads).where(like(staffNotificationReads.userKey, `%twg-${RUN}%`))
    await db.delete(staffNotificationReads).where(inArray(staffNotificationReads.userKey, [`u:${900000000 + Number(RUN.slice(-5))}`]))
    await db.delete(labResults).where(inArray(labResults.id, [ids.result]))
    await db.delete(labOrders).where(inArray(labOrders.id, [ids.order]))
    await db.delete(doctorAssignments).where(inArray(doctorAssignments.id, [ids.declined, ids.pending]))
    await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.id, [ids.delivery]))
    await db.delete(medicationInventory).where(inArray(medicationInventory.medicationId, [ids.med]))
    await db.delete(medications).where(inArray(medications.id, [ids.med]))
    await db.delete(bookingRequests).where(inArray(bookingRequests.id, [ids.booking]))
  })

  const keys = async (session: Session) => (await loadStaffNotifications(session)).map((n) => n.key)

  it('gives front desk its requests, declines and failed notices -- never clinical results or stock', async () => {
    const feed = await loadStaffNotifications(s('frontdesk'))
    const k = feed.map((n) => n.key)
    expect(k).toContain(`booking_request:${ids.booking}`)
    expect(k).toContain(`assignment_declined:${ids.declined}`)
    expect(k).toContain(`notice_failed:${ids.delivery}`)
    expect(k).not.toContain(`lab_critical:${ids.result}`)
    expect(k.some((x) => x.startsWith('low_stock:'))).toBe(false)
    const notice = feed.find((n) => n.key === `notice_failed:${ids.delivery}`)!
    expect(notice.href).toBe(`/patients/${PATIENT}`)
    // No phone number in any item, ever.
    expect(JSON.stringify(feed)).not.toMatch(/98765|XXXXXX/)
  })

  it('gives a coordinator the critical result with the patient, linked to the chart', async () => {
    const item = (await loadStaffNotifications(s('crc'))).find((n) => n.key === `lab_critical:${ids.result}`)!
    expect(item.severity).toBe('critical')
    expect(item.href).toBe(`/patients/${PATIENT}`)
    expect(item.detail).toMatch(/Maria Alvarez/)
    expect(item.detail).not.toMatch(/9\.9/) // never the value
  })

  it('gives the lab the critical result without the patient name, linked to the lab worklist', async () => {
    const item = (await loadStaffNotifications(s('labs'))).find((n) => n.key === `lab_critical:${ids.result}`)!
    expect(item.href).toBe('/labs')
    expect(item.detail).not.toMatch(/Maria/)
  })

  it('gives pharmacy only stock items', async () => {
    const k = await keys(s('pharmacy'))
    expect(k).toContain(`low_stock:${ids.med}:0`)
    expect(k.every((x) => x.startsWith('low_stock:'))).toBe(true)
  })

  it("gives a doctor the patients assigned to them, emergency first in severity", async () => {
    const item = (await loadStaffNotifications(s('pi'))).find((n) => n.key === `assignment_pending:${ids.pending}`)!
    expect(item.severity).toBe('critical')
    expect(item.href).toBe('/doctor')
  })

  it('collector and coder feeds never include patient-facing desk items', async () => {
    for (const role of ['collector', 'coder', 'billing'] as const) {
      const k = await keys(s(role))
      expect(k.some((x) => /^(booking_request|notice_failed|lab_critical|assignment_)/.test(x)), role).toBe(false)
    }
  })

  it('persists read state per user: mark one, mark all, ignore keys outside the feed', async () => {
    const me = s('frontdesk')
    const other = s('crc')
    const before = await getStaffFeed(me)
    expect(before.unreadCount).toBeGreaterThan(0)

    const after = await markStaffNotificationsRead(me, [`booking_request:${ids.booking}`, 'lab_critical:999999999', `booking_request:${ids.booking}`])
    expect(after.unreadCount).toBe(before.unreadCount - 1)
    expect(after.items.find((i) => i.key === `booking_request:${ids.booking}`)!.read).toBe(true)
    const stored = await getDb().select().from(staffNotificationReads).where(like(staffNotificationReads.userKey, `%${me.name}`))
    expect(stored.map((r) => r.itemKey)).toEqual([`booking_request:${ids.booking}`])

    // Another user's state is untouched.
    expect((await getStaffFeed(other)).items.find((i) => i.key === `assignment_declined:${ids.declined}`)!.read).toBe(false)

    const all = await markStaffNotificationsRead(me, null)
    expect(all.unreadCount).toBe(0)
    expect((await markStaffNotificationsRead(me, null)).unreadCount).toBe(0) // idempotent
  })

  it('keys a session with a user id by that id', async () => {
    const withId = s('frontdesk', 900000000 + Number(RUN.slice(-5)))
    await markStaffNotificationsRead(withId, [`booking_request:${ids.booking}`])
    const rows = await getDb().select().from(staffNotificationReads).where(inArray(staffNotificationReads.userKey, [`u:${withId.userId}`]))
    expect(rows.map((r) => r.itemKey)).toEqual([`booking_request:${ids.booking}`])
  })
})
