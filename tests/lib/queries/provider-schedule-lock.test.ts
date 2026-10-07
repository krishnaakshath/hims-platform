// I7: every write that books a doctor's time takes the same per-provider
// schedule lock (`appointments.provider:<id>`) and runs its conflict check and
// insert/update in ONE transaction, so a calendar booking, a front-desk
// schedule, a confirmed booking request and a follow-up booking can never
// double-book a slot between them.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { appointments, auditLog, bookingRequests, doctorAssignments, followUpOrders, patients, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { insertAppointmentIfFree, lockProviderSchedule, rescheduleAppointmentIfFree } from '@/lib/queries/appointments'
import { bookFollowUp } from '@/lib/queries/follow-up-recall'
import { confirmBookingRequest } from '@/lib/queries/booking-requests'
import { scheduleAssignmentIntoAppointment } from '@/lib/queries/doctor-assignments'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP3_LOCK-${RUN}`
const S: Session = { role: 'frontdesk', name: PROBE_USER, userId: null }
const PATIENT = `TEST-SP3-${RUN}-LK`
let providerId = 0
let otherProviderId = 0

const slot = (day: number, hour = 4) => {
  const startsAt = new Date(Date.UTC(2099, 8, day, hour, 30))
  return { startsAt, endsAt: new Date(startsAt.getTime() + 15 * 60_000) }
}
const appt = (s: { startsAt: Date; endsAt: Date }, pid = providerId) => ({ patientId: PATIENT, providerId: pid, ...s, visitReason: 'TEST_SP3 lock', status: 'scheduled' as const })

describe.skipIf(!process.env.DATABASE_URL)('provider schedule lock (DB)', () => {
  const requestIds: number[] = []
  const assignmentIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [p1] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Lock', specialty: 'Test', colorTag: '#000000' }).returning()
    const [p2] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Lock Two', specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p1.id
    otherProviderId = p2.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP3 Lock Patient', dob: '1985-01-01' })
  })

  afterEach(async () => {
    const db = getDb()
    if (requestIds.length) await db.delete(bookingRequests).where(inArray(bookingRequests.id, requestIds.splice(0)))
    if (assignmentIds.length) await db.delete(doctorAssignments).where(inArray(doctorAssignments.id, assignmentIds.splice(0)))
    await db.delete(followUpOrders).where(eq(followUpOrders.patientId, PATIENT))
    await db.delete(appointments).where(eq(appointments.patientId, PATIENT))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerId, otherProviderId]))
  })

  const inSlot = (s: { startsAt: Date }, pid = providerId) => getDb().select().from(appointments)
    .where(and(eq(appointments.providerId, pid), eq(appointments.startsAt, s.startsAt), eq(appointments.status, 'scheduled')))

  async function makeOrder() {
    const [o] = await getDb().insert(followUpOrders).values({
      patientId: PATIENT, source: 'manual', status: 'planned', prescribedByProviderId: providerId,
      baseDate: '2099-08-20', dueDate: '2099-09-03', windowStart: '2099-08-31', windowEnd: '2099-09-10',
      reason: 'TEST_SP3 lock review', createdByName: PROBE_USER,
    }).returning()
    return o
  }

  async function makeRequest() {
    const [r] = await getDb().insert(bookingRequests).values({
      requesterName: 'TEST_SP3 Requester', requesterDob: '1985-01-01', preferredDateRangeStart: '2099-09-01', preferredDateRangeEnd: '2099-09-30', reason: 'TEST_SP3 lock',
    }).returning()
    requestIds.push(r.id)
    return r
  }

  /** Another writer holds the provider's schedule lock with an uncommitted appointment in the slot. */
  async function holdSlot(s: { startsAt: Date; endsAt: Date }) {
    let markHeld!: () => void
    const held = new Promise<void>((r) => { markHeld = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const writer = getDb().transaction(async (tx) => {
      await lockProviderSchedule(tx, providerId)
      await tx.insert(appointments).values(appt(s))
      markHeld()
      await gate
    })
    await held
    return async <T>(contender: Promise<T>): Promise<T> => {
      await new Promise((r) => setTimeout(r, 200))
      release()
      await writer
      return contender
    }
  }

  it('lockProviderSchedule takes each provider once, in ascending id order', async () => {
    const dialect = new PgDialect()
    const seen: unknown[][] = []
    const fake = { execute: async (q: Parameters<PgDialect['sqlToQuery']>[0]) => { seen.push(dialect.sqlToQuery(q).params) } }
    await lockProviderSchedule(fake as never, 9, 3, 9, 5)
    expect(seen).toEqual([['appointments.provider:3'], ['appointments.provider:5'], ['appointments.provider:9']])
  })

  it('a calendar booking waits for an in-flight booking of the same doctor, then reports the conflict', async () => {
    const s = slot(1)
    const settle = await holdSlot(s)
    expect(await settle(insertAppointmentIfFree(appt(s)))).toEqual({ ok: false, error: 'conflict' })
    expect(await inSlot(s)).toHaveLength(1)
  })

  it('a calendar reschedule waits for the lock too', async () => {
    const s = slot(2)
    const [mine] = await getDb().insert(appointments).values(appt(slot(2, 8))).returning()
    const settle = await holdSlot(s)
    expect(await settle(rescheduleAppointmentIfFree(mine.id, providerId, s.startsAt, s.endsAt, { startsAt: s.startsAt, endsAt: s.endsAt }))).toEqual({ ok: false, error: 'conflict' })
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, mine.id))
    expect(after.startsAt.toISOString()).toBe(slot(2, 8).startsAt.toISOString())
  })

  it('a booking-request confirmation waits for the lock and leaves the request pending on conflict', async () => {
    const s = slot(3)
    const req = await makeRequest()
    const settle = await holdSlot(s)
    const r = await settle(confirmBookingRequest(req.id, { patientId: PATIENT, providerId, ...s, visitReason: 'TEST_SP3 lock', reviewedByName: PROBE_USER }))
    expect(r.ok).toBe(false)
    const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, req.id))
    expect(row.status).toBe('pending')
    expect(await inSlot(s)).toHaveLength(1)
  })

  it('a doctor scheduling an assignment waits for the lock; on conflict the assignment stays pending and no appointment is left', async () => {
    const s = slot(4)
    const [a] = await getDb().insert(doctorAssignments).values({ patientId: PATIENT, providerId, visitType: 'outpatient', urgency: 'routine', reason: 'TEST_SP3 lock', assignedByName: PROBE_USER }).returning()
    assignmentIds.push(a.id)
    const settle = await holdSlot(s)
    expect(await settle(scheduleAssignmentIntoAppointment(a.id, { patientId: PATIENT, providerId, ...s, visitReason: 'TEST_SP3 lock' }))).toEqual({ ok: false, error: 'conflict' })
    const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, a.id))
    expect(row).toMatchObject({ status: 'pending', appointmentId: null })
    expect(await inSlot(s)).toHaveLength(1)
  })

  it('calendar booking vs follow-up booking of the same slot: exactly one wins, every time', async () => {
    for (let day = 10; day < 16; day++) {
      const s = slot(day)
      const o = await makeOrder()
      const [cal, fu] = await Promise.all([insertAppointmentIfFree(appt(s)), bookFollowUp(o.id, { providerId, ...s }, S)])
      expect([cal.ok, fu.ok].filter(Boolean)).toHaveLength(1)
      expect(await inSlot(s)).toHaveLength(1)
      if (!fu.ok) expect(fu.error).toBe('conflict')
      if (!cal.ok) expect(cal.error).toBe('conflict')
    }
  })

  it('front-desk schedule vs booking-request confirmation vs calendar on one slot: exactly one wins', async () => {
    const s = slot(20)
    const [a] = await getDb().insert(doctorAssignments).values({ patientId: PATIENT, providerId, visitType: 'outpatient', urgency: 'routine', reason: 'TEST_SP3 lock', assignedByName: PROBE_USER }).returning()
    assignmentIds.push(a.id)
    const req = await makeRequest()
    const rs = await Promise.all([
      scheduleAssignmentIntoAppointment(a.id, { patientId: PATIENT, providerId, ...s, visitReason: 'TEST_SP3 lock' }),
      confirmBookingRequest(req.id, { patientId: PATIENT, providerId, ...s, visitReason: 'TEST_SP3 lock', reviewedByName: PROBE_USER }),
      insertAppointmentIfFree(appt(s)),
    ])
    expect(rs.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1)
    expect(await inSlot(s)).toHaveLength(1)
  })

  it('a follow-up rescheduled to another doctor locks both doctors and moves the one appointment', async () => {
    const o = await makeOrder()
    const first = await bookFollowUp(o.id, { providerId, ...slot(25) }, S)
    expect(first.ok).toBe(true)
    const moved = await bookFollowUp(o.id, { providerId: otherProviderId, ...slot(26) }, S)
    expect(moved).toMatchObject({ ok: true, kind: 'rescheduled' })
    expect(await getDb().select().from(appointments).where(eq(appointments.patientId, PATIENT))).toHaveLength(1)
    // The lock is transaction-scoped: nothing is left held afterwards.
    const [{ n }] = (await getDb().execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()`)).rows as { n: number }[]
    expect(n).toBe(0)
  })
})
