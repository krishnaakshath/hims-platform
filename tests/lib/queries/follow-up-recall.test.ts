import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, auditLog, departments, followUpContactAttempts, followUpOrders, patients, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { bookFollowUp, listFollowUpWorklist, recordContactAttempt, unbookFollowUp } from '@/lib/queries/follow-up-recall'
import { getFollowUpById } from '@/lib/queries/follow-ups'

// Real logAudit by default; a test can make the audit insert itself fail.
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit')
  return { ...actual, logAudit: vi.fn(actual.logAudit) }
})
import { logAudit } from '@/lib/audit'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP3_RECALL-${RUN}`
const S: Session = { role: 'frontdesk', name: PROBE_USER, userId: null }
const PATIENT = `TEST-SP3-${RUN}-RA`
const PATIENT_B = `TEST-SP3-${RUN}-RB`
const DEPT_CODE = `TSP3R${RUN.slice(-8)}`

let deptId = 0
let providerId = 0
let otherProviderId = 0
let inactiveProviderId = 0

// Far-future IST slots: always after the real "now".
const at = (iso: string) => new Date(iso)
const SLOT = { startsAt: at('2099-07-15T04:30:00Z'), endsAt: at('2099-07-15T04:45:00Z') } // 10:00-10:15 IST
const SLOT2 = { startsAt: at('2099-07-16T05:30:00Z'), endsAt: at('2099-07-16T05:45:00Z') }

describe.skipIf(!process.env.DATABASE_URL)('follow-up booking (DB)', () => {
  const extraAppointmentIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_SP3 recall dept', kind: 'clinical' }).returning()
    deptId = d.id
    const [p1] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Recall', specialty: 'Test', colorTag: '#000000', departmentId: d.id }).returning()
    const [p2] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Other', specialty: 'Test', colorTag: '#000000' }).returning()
    const [p3] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Gone', specialty: 'Test', colorTag: '#000000', isActive: false }).returning()
    providerId = p1.id
    otherProviderId = p2.id
    inactiveProviderId = p3.id
    await db.insert(patients).values([
      { id: PATIENT, name: 'TEST_SP3 Recall Patient', dob: '1970-01-01', phone: '+919800000001', uhid: `TSP3-${RUN}-A` },
      { id: PATIENT_B, name: 'TEST_SP3 Recall Patient B', dob: '1971-01-01' },
    ])
  })

  afterEach(async () => {
    const db = getDb()
    // Children first: attempts cascade with orders; then every appointment of this file's
    // patients (bookings create them) and this run's audit rows.
    await db.delete(followUpOrders).where(inArray(followUpOrders.patientId, [PATIENT, PATIENT_B]))
    await db.delete(appointments).where(inArray(appointments.patientId, [PATIENT, PATIENT_B]))
    if (extraAppointmentIds.length) await db.delete(appointments).where(inArray(appointments.id, extraAppointmentIds.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    vi.mocked(logAudit).mockClear()
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(patients).where(inArray(patients.id, [PATIENT, PATIENT_B]))
    await db.delete(providers).where(inArray(providers.id, [providerId, otherProviderId, inactiveProviderId]))
    await db.delete(departments).where(eq(departments.id, deptId))
  })

  async function makeOrder(over: Partial<typeof followUpOrders.$inferInsert> = {}) {
    const [o] = await getDb().insert(followUpOrders).values({
      patientId: PATIENT, source: 'manual', status: 'planned', prescribedByProviderId: providerId, departmentId: deptId,
      baseDate: '2099-07-01', dueDate: '2099-07-15', windowStart: '2099-07-12', windowEnd: '2099-07-22',
      reason: 'TEST_SP3 BP review', planNotes: 'TEST_SP3 PLANSECRET titrate', createdByName: PROBE_USER, ...over,
    }).returning()
    return o
  }

  const apptsInSlot = (pid: number, slot = SLOT) => getDb().select().from(appointments)
    .where(and(eq(appointments.providerId, pid), eq(appointments.startsAt, slot.startsAt)))
  const auditRows = () => getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))

  it('books, then reschedules the same appointment row', async () => {
    const o = await makeOrder()
    const a = await bookFollowUp(o.id, { providerId, ...SLOT }, S)
    expect(a).toMatchObject({ ok: true, kind: 'booked' })
    if (!a.ok) return
    const [appt] = await getDb().select().from(appointments).where(eq(appointments.id, a.appointmentId))
    expect(appt).toMatchObject({ patientId: PATIENT, providerId, status: 'scheduled' })
    expect(appt.startsAt.toISOString()).toBe(SLOT.startsAt.toISOString())
    expect(appt.visitReason.startsWith('Follow-up: ')).toBe(true)
    expect(a.order).toMatchObject({ status: 'scheduled', appointmentId: a.appointmentId, scheduledByName: PROBE_USER })
    expect(a.order.scheduledAt).toBeInstanceOf(Date)

    const b = await bookFollowUp(o.id, { providerId: otherProviderId, ...SLOT2 }, S)
    expect(b).toMatchObject({ ok: true, kind: 'rescheduled', appointmentId: a.appointmentId })
    const [moved] = await getDb().select().from(appointments).where(eq(appointments.id, a.appointmentId))
    expect(moved.providerId).toBe(otherProviderId)
    expect(moved.startsAt.toISOString()).toBe(SLOT2.startsAt.toISOString())
    expect(moved.endsAt.toISOString()).toBe(SLOT2.endsAt.toISOString())
    expect(await getDb().select().from(appointments).where(eq(appointments.patientId, PATIENT))).toHaveLength(1)

    const audits = (await auditRows()).map((r) => [r.action, r.details])
    expect(audits).toEqual(expect.arrayContaining([
      ['booked follow-up appointment', `followUp=${o.id} appointment=${a.appointmentId}`],
      ['rescheduled follow-up appointment', `followUp=${o.id} appointment=${a.appointmentId}`],
    ]))
  })

  it('concurrent bookings of one slot: exactly one wins, one appointment row', async () => {
    const o1 = await makeOrder()
    const o2 = await makeOrder({ patientId: PATIENT_B })
    const [a, b] = await Promise.all([bookFollowUp(o1.id, { providerId, ...SLOT }, S), bookFollowUp(o2.id, { providerId, ...SLOT }, S)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ error: 'conflict' })
    expect(await apptsInSlot(providerId)).toHaveLength(1)
    const loser = !a.ok ? o1 : o2
    expect(await getFollowUpById(loser.id)).toMatchObject({ status: 'planned', appointmentId: null })
  })

  it('waits for an in-flight booking of the same doctor, then reports the conflict (the provider lock is load-bearing)', async () => {
    const o = await makeOrder()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let markHeld!: () => void
    const held = new Promise<void>((r) => { markHeld = r })
    // Another clerk's booking: holds the provider lock with an uncommitted appointment in the slot.
    const inFlight = getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'appointments.provider:' + providerId}))`)
      await tx.insert(appointments).values({ patientId: PATIENT_B, providerId, ...SLOT, visitReason: 'TEST_SP3 racing' })
      markHeld()
      await gate
    })
    await held
    const booking = bookFollowUp(o.id, { providerId, ...SLOT }, S)
    await new Promise((r) => setTimeout(r, 200))
    release()
    await inFlight
    expect(await booking).toEqual({ ok: false, error: 'conflict' })
    expect(await apptsInSlot(providerId)).toHaveLength(1)
  })

  it('many concurrent bookings of one slot: exactly one wins', async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, (_, i) => makeOrder({ patientId: i % 2 ? PATIENT : PATIENT_B })))
    const rs = await Promise.all(orders.map((o) => bookFollowUp(o.id, { providerId, ...SLOT }, S)))
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'conflict')).toBe(true)
    expect(await apptsInSlot(providerId)).toHaveLength(1)
  })

  it('an overlapping (not identical) slot also conflicts; a cancelled appointment does not block', async () => {
    const [blocker] = await getDb().insert(appointments).values({
      patientId: PATIENT_B, providerId, startsAt: at('2099-07-15T04:40:00Z'), endsAt: at('2099-07-15T05:00:00Z'), visitReason: 'TEST_SP3 other',
    }).returning()
    const o = await makeOrder()
    expect(await bookFollowUp(o.id, { providerId, ...SLOT }, S)).toEqual({ ok: false, error: 'conflict' })
    await getDb().update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, blocker.id))
    expect(await bookFollowUp(o.id, { providerId, ...SLOT }, S)).toMatchObject({ ok: true, kind: 'booked' })
  })

  it('the same follow-up booked twice at once leaves exactly one appointment', async () => {
    const o = await makeOrder()
    const rs = await Promise.all([bookFollowUp(o.id, { providerId, ...SLOT }, S), bookFollowUp(o.id, { providerId, ...SLOT }, S)])
    expect(rs.every((r) => r.ok)).toBe(true)
    expect(rs.map((r) => (r.ok ? r.kind : null)).sort()).toEqual(['booked', 'rescheduled'])
    const rows = await getDb().select().from(appointments).where(eq(appointments.patientId, PATIENT))
    expect(rows).toHaveLength(1)
    expect((await getFollowUpById(o.id))?.appointmentId).toBe(rows[0].id)
  })

  it('refuses to book a cancelled follow-up', async () => {
    const o = await makeOrder({ status: 'cancelled', cancelReason: 'TEST_SP3 x' })
    expect(await bookFollowUp(o.id, { providerId, ...SLOT }, S)).toEqual({ ok: false, error: 'not_bookable' })
    const done = await makeOrder({ status: 'completed' })
    expect(await bookFollowUp(done.id, { providerId, ...SLOT }, S)).toEqual({ ok: false, error: 'not_bookable' })
    expect(await bookFollowUp(2147483000, { providerId, ...SLOT }, S)).toEqual({ ok: false, error: 'not_found' })
    expect(await apptsInSlot(providerId)).toEqual([])
  })

  it('rejects a slot in the past and an inactive or unknown provider', async () => {
    const o = await makeOrder()
    expect(await bookFollowUp(o.id, { providerId, ...SLOT }, S, at('2099-07-15T04:30:00Z'))).toEqual({ ok: false, error: 'slot_in_past' })
    expect(await bookFollowUp(o.id, { providerId: inactiveProviderId, ...SLOT }, S)).toEqual({ ok: false, error: 'provider_not_found' })
    expect(await bookFollowUp(o.id, { providerId: 2147483000, ...SLOT }, S)).toEqual({ ok: false, error: 'provider_not_found' })
    expect(await getDb().select().from(appointments).where(eq(appointments.patientId, PATIENT))).toEqual([])
  })

  it('a failure inside the booking transaction leaves no orphan appointment', async () => {
    const o = await makeOrder()
    vi.mocked(logAudit).mockRejectedValueOnce(new Error('audit insert failed'))
    await expect(bookFollowUp(o.id, { providerId, ...SLOT }, S)).rejects.toThrow('audit insert failed')
    expect(await getDb().select().from(appointments).where(eq(appointments.patientId, PATIENT))).toEqual([])
    expect(await getFollowUpById(o.id)).toMatchObject({ status: 'planned', appointmentId: null })
  })

  it('a missed (no-show) follow-up can be rebooked into a new appointment', async () => {
    const [noShow] = await getDb().insert(appointments).values({
      patientId: PATIENT, providerId, startsAt: at('2099-07-14T04:30:00Z'), endsAt: at('2099-07-14T04:45:00Z'), visitReason: 'Follow-up: x', status: 'no_show',
    }).returning()
    const o = await makeOrder({ status: 'scheduled', appointmentId: noShow.id })
    const r = await bookFollowUp(o.id, { providerId, ...SLOT }, S)
    expect(r).toMatchObject({ ok: true, kind: 'booked' })
    expect(r.ok && r.appointmentId).not.toBe(noShow.id)
    const [old] = await getDb().select().from(appointments).where(eq(appointments.id, noShow.id))
    expect(old.status).toBe('no_show')
  })

  it('unbook cancels the appointment and returns the order to planned', async () => {
    const o = await makeOrder()
    const b = await bookFollowUp(o.id, { providerId, ...SLOT }, S)
    if (!b.ok) throw new Error('booking failed')
    const r = await unbookFollowUp(o.id, 'TEST_SP3 UNBOOKSECRET patient travelling', S)
    expect(r).toMatchObject({ ok: true, cancelledAppointmentId: b.appointmentId })
    expect(r.ok && r.order).toMatchObject({ status: 'planned', appointmentId: null, scheduledAt: null, scheduledByName: null, scheduledByUserId: null, cancelReason: null })
    const [appt] = await getDb().select().from(appointments).where(eq(appointments.id, b.appointmentId))
    expect(appt).toMatchObject({ status: 'cancelled', notes: 'Follow-up booking cancelled: TEST_SP3 UNBOOKSECRET patient travelling' })
    const audits = await auditRows()
    expect(audits.find((a) => a.action === 'cancelled follow-up booking')?.details).toBe(`followUp=${o.id} appointment=${b.appointmentId}`)
    expect(JSON.stringify(audits)).not.toContain('UNBOOKSECRET')
    expect(await unbookFollowUp(o.id, 'again', S)).toEqual({ ok: false, error: 'not_booked' })
    expect(await unbookFollowUp(2147483000, 'x', S)).toEqual({ ok: false, error: 'not_found' })
    // The slot is free again.
    expect(await bookFollowUp(o.id, { providerId, ...SLOT }, S)).toMatchObject({ ok: true, kind: 'booked' })
  })

  it('unbook refuses an order completed at check-in even though its appointment is still scheduled', async () => {
    const [appt] = await getDb().insert(appointments).values({ patientId: PATIENT, providerId, ...SLOT, visitReason: 'Follow-up: x' }).returning()
    const o = await makeOrder({ status: 'completed', appointmentId: appt.id })
    expect(await unbookFollowUp(o.id, 'x', S)).toEqual({ ok: false, error: 'not_booked' })
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id))
    expect(after.status).toBe('scheduled')
  })

  it('calendar cancel puts the order back in the due bucket', async () => {
    const o = await makeOrder()
    const b = await bookFollowUp(o.id, { providerId, ...SLOT }, S)
    if (!b.ok) throw new Error('booking failed')
    const before = (await listFollowUpWorklist('2099-07-14', { providerId })).find((r) => r.id === o.id)
    expect(before).toMatchObject({ status: 'scheduled', bucket: 'scheduled', appointment: { id: b.appointmentId, status: 'scheduled' } })
    await getDb().update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, b.appointmentId))
    const row = (await listFollowUpWorklist('2099-07-14', { providerId })).find((r) => r.id === o.id)
    expect(row).toMatchObject({ status: 'planned', bucket: 'due' })
  })

  it('records a contact attempt and refuses one on a completed order', async () => {
    const o = await makeOrder()
    const r = await recordContactAttempt(o.id, { channel: 'phone', outcome: 'no_answer', note: 'TEST_SP3 NOTESECRET rang twice' }, S)
    expect(r.ok && r.attempt).toMatchObject({ followUpOrderId: o.id, channel: 'phone', outcome: 'no_answer', note: 'TEST_SP3 NOTESECRET rang twice', attemptedByName: PROBE_USER })
    const r2 = await recordContactAttempt(o.id, { channel: 'sms', outcome: 'message_left' }, S)
    expect(r2.ok && r2.attempt.note).toBeNull()
    const audits = await auditRows()
    expect(audits.filter((a) => a.action === 'logged follow-up contact attempt').map((a) => a.details).sort()).toEqual([
      `followUp=${o.id} channel=phone outcome=no_answer`, `followUp=${o.id} channel=sms outcome=message_left`,
    ])
    expect(JSON.stringify(audits)).not.toContain('NOTESECRET')

    const done = await makeOrder({ status: 'completed' })
    expect(await recordContactAttempt(done.id, { channel: 'phone', outcome: 'no_answer' }, S)).toEqual({ ok: false, error: 'closed' })
    const cancelled = await makeOrder({ status: 'cancelled', cancelReason: 'x' })
    expect(await recordContactAttempt(cancelled.id, { channel: 'phone', outcome: 'no_answer' }, S)).toEqual({ ok: false, error: 'closed' })
    // A scheduled order whose appointment was completed is closed too (derived).
    const [doneAppt] = await getDb().insert(appointments).values({ patientId: PATIENT, providerId, ...SLOT2, visitReason: 'x', status: 'completed' }).returning()
    const derivedDone = await makeOrder({ status: 'scheduled', appointmentId: doneAppt.id })
    expect(await recordContactAttempt(derivedDone.id, { channel: 'phone', outcome: 'no_answer' }, S)).toEqual({ ok: false, error: 'closed' })
    expect(await recordContactAttempt(2147483000, { channel: 'phone', outcome: 'no_answer' }, S)).toEqual({ ok: false, error: 'not_found' })
    expect(await getDb().select().from(followUpContactAttempts).where(inArray(followUpContactAttempts.followUpOrderId, [done.id, cancelled.id, derivedDone.id]))).toEqual([])
  })

  it('worklist: buckets, horizon, closed rows dropped, counts and latest contact', async () => {
    const today = '2099-07-14'
    const due = await makeOrder()
    const overdue = await makeOrder({ dueDate: '2099-06-30', windowStart: '2099-06-27', windowEnd: '2099-07-07' })
    const upcoming = await makeOrder({ dueDate: '2099-08-10', windowStart: '2099-08-07', windowEnd: '2099-08-17' })
    const beyond = await makeOrder({ dueDate: '2099-09-30', windowStart: '2099-09-27', windowEnd: '2099-10-07' })
    const missed = await makeOrder({ dueDate: '2099-06-01', windowStart: '2099-05-29', windowEnd: '2099-06-08' })
    const cancelled = await makeOrder({ status: 'cancelled', cancelReason: 'x' })
    const [doneAppt] = await getDb().insert(appointments).values({ patientId: PATIENT, providerId, ...SLOT2, visitReason: 'x', status: 'completed' }).returning()
    const derivedDone = await makeOrder({ status: 'scheduled', appointmentId: doneAppt.id })
    const other = await makeOrder({ prescribedByProviderId: otherProviderId })
    await recordContactAttempt(due.id, { channel: 'phone', outcome: 'no_answer' }, S)
    await new Promise((r) => setTimeout(r, 5))
    await recordContactAttempt(due.id, { channel: 'whatsapp', outcome: 'reached_will_call_back', note: 'TEST_SP3 later' }, S)

    const rows = await listFollowUpWorklist(today, { providerId })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(due.id)).toMatchObject({
      bucket: 'due', status: 'planned', patientId: PATIENT, patientName: 'TEST_SP3 Recall Patient', uhid: `TSP3-${RUN}-A`, phone: '+919800000001',
      contactAttemptCount: 2, lastContact: { channel: 'whatsapp', outcome: 'reached_will_call_back', note: 'TEST_SP3 later' },
      prescribedBy: { providerId, name: 'TEST_SP3 Dr Recall' }, department: { id: deptId, name: 'TEST_SP3 recall dept' }, reason: 'TEST_SP3 BP review',
    })
    expect(byId.get(overdue.id)?.bucket).toBe('overdue')
    expect(byId.get(upcoming.id)?.bucket).toBe('upcoming')
    expect(byId.get(missed.id)).toMatchObject({ bucket: 'missed', status: 'missed', contactAttemptCount: 0, lastContact: null })
    expect(byId.has(beyond.id)).toBe(false)
    expect(byId.has(cancelled.id)).toBe(false)
    expect(byId.has(derivedDone.id)).toBe(false)
    expect(byId.has(other.id)).toBe(false) // SQL provider filter
    expect((await listFollowUpWorklist(today, { departmentId: deptId })).map((r) => r.id)).toEqual(expect.arrayContaining([due.id, other.id]))
    // Ordered by due date.
    const ours = rows.filter((r) => [due.id, overdue.id, upcoming.id, missed.id].includes(r.id)).map((r) => r.id)
    expect(ours).toEqual([missed.id, overdue.id, due.id, upcoming.id])
  })

  it('worklist rows never carry planNotes or Aadhaar fields', async () => {
    await makeOrder()
    const rows = (await listFollowUpWorklist('2099-07-14', { providerId }))
    expect(rows.length).toBeGreaterThan(0)
    const json = JSON.stringify(rows)
    expect(json).not.toContain('PLANSECRET')
    const keys = new Set<string>()
    const walk = (v: unknown) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x) }
    }
    walk(rows)
    expect([...keys].filter((k) => /aadhaar|planNotes|cancelReason|password|mfa/i.test(k))).toEqual([])
  })
})
