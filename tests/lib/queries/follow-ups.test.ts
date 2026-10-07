import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, auditLog, departments, encounters, followUpContactAttempts, followUpOrders, patients, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  cancelFollowUpOrder, createFollowUpOrder, getFollowUpById, getFollowUpView, getPortalFollowUps, listFollowUpsForPatient, updateFollowUpPlan,
  type CreateFollowUpOrderInput,
} from '@/lib/queries/follow-ups'

// Real logAudit by default; a test can make the audit insert itself fail.
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit')
  return { ...actual, logAudit: vi.fn(actual.logAudit) }
})
import { logAudit } from '@/lib/audit'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP3_FU-${RUN}`
const SESSION: Session = { role: 'pi', name: PROBE_USER, userId: null }
const PATIENT = `TEST-SP3-${RUN}-FA`
const OTHER_PATIENT = `TEST-SP3-${RUN}-FB`
const DEPT_CODE = `TSP3F${RUN.slice(-8)}`

let deptId = 0
let providerId = 0
let otherProviderId = 0
let inactiveProviderId = 0
let encounterId = 0
let otherEncounterId = 0

describe.skipIf(!process.env.DATABASE_URL)('follow-up orders (DB)', () => {
  const appointmentIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_SP3 follow-up dept', kind: 'clinical' }).returning()
    deptId = d.id
    const [p1] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Prescriber', specialty: 'Test', colorTag: '#000000', departmentId: d.id }).returning()
    const [p2] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Booked', specialty: 'Test', colorTag: '#000000' }).returning()
    const [p3] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Inactive', specialty: 'Test', colorTag: '#000000', isActive: false }).returning()
    providerId = p1.id
    otherProviderId = p2.id
    inactiveProviderId = p3.id
    await db.insert(patients).values([
      { id: PATIENT, name: 'TEST_SP3 Follow-up Patient', dob: '1980-01-01' },
      { id: OTHER_PATIENT, name: 'TEST_SP3 Other Patient', dob: '1981-01-01' },
    ])
    const [e1] = await db.insert(encounters).values({ patientId: PATIENT, encounterType: 'opd', encounterDate: '2099-04-01', providerId, checkedInByName: PROBE_USER }).returning()
    const [e2] = await db.insert(encounters).values({ patientId: OTHER_PATIENT, encounterType: 'opd', encounterDate: '2099-04-01', providerId, checkedInByName: PROBE_USER }).returning()
    encounterId = e1.id
    otherEncounterId = e2.id
  })

  afterEach(async () => {
    const db = getDb()
    // Contact attempts cascade with their order.
    await db.delete(followUpOrders).where(inArray(followUpOrders.patientId, [PATIENT, OTHER_PATIENT]))
    if (appointmentIds.length) await db.delete(appointments).where(inArray(appointments.id, appointmentIds.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    vi.mocked(logAudit).mockClear()
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(encounters).where(inArray(encounters.id, [encounterId, otherEncounterId]))
    await db.delete(patients).where(inArray(patients.id, [PATIENT, OTHER_PATIENT]))
    await db.delete(providers).where(inArray(providers.id, [providerId, otherProviderId, inactiveProviderId]))
    await db.delete(departments).where(eq(departments.id, deptId))
  })

  const input = (over: Partial<CreateFollowUpOrderInput> = {}): CreateFollowUpOrderInput => ({
    patientId: PATIENT,
    source: 'encounter',
    prescribedByProviderId: providerId,
    departmentId: null,
    timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } },
    reason: 'TEST_SP3 BP review',
    planNotes: 'TEST_SP3 titrate',
    originatingEncounterId: encounterId,
    originatingAdmissionId: null,
    ...over,
  })

  async function makeAppointment(startsAt: Date, patientId = PATIENT) {
    const [a] = await getDb().insert(appointments).values({
      patientId, providerId: otherProviderId, startsAt, endsAt: new Date(startsAt.getTime() + 15 * 60000), visitReason: 'TEST_SP3 follow-up',
    }).returning()
    appointmentIds.push(a.id)
    return a
  }

  const ordersOf = (patientId: string) => getDb().select().from(followUpOrders).where(eq(followUpOrders.patientId, patientId))
  const auditRows = () => getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))

  async function created(over: Partial<CreateFollowUpOrderInput> = {}, today = '2099-04-02') {
    const r = await createFollowUpOrder(input(over), SESSION, { today })
    if (!r.ok) throw new Error(`create failed: ${r.error}`)
    return r.order
  }

  it('creates from an interval relative to the originating encounter date', async () => {
    const r = await createFollowUpOrder(input(), SESSION, { today: '2099-04-05' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.order).toMatchObject({
      patientId: PATIENT, source: 'encounter', status: 'planned', baseDate: '2099-04-01', dueDate: '2099-04-15',
      windowStart: '2099-04-12', windowEnd: '2099-04-22', intervalValue: 2, intervalUnit: 'weeks',
      departmentId: deptId, prescribedByProviderId: providerId, originatingEncounterId: encounterId,
      createdByName: PROBE_USER, createdByUserId: null, appointmentId: null, scheduledAt: null,
    })
    const audits = await auditRows()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'set follow-up plan', patientId: PATIENT, details: `followUp=${r.order.id} source=encounter due=2099-04-15` })
  })

  it('uses today as the base date without an encounter, and honours explicit window days and department', async () => {
    const r = await createFollowUpOrder(input({ source: 'manual', originatingEncounterId: null, departmentId: null, timing: { kind: 'date', dueDate: '2099-06-10' }, windowDaysBefore: 0, windowDaysAfter: 2 }), SESSION, { today: '2099-06-01' })
    expect(r.ok && r.order).toMatchObject({ baseDate: '2099-06-01', dueDate: '2099-06-10', windowStart: '2099-06-10', windowEnd: '2099-06-12', intervalValue: null, intervalUnit: null, departmentId: deptId })
  })

  it('rejects an encounter belonging to another patient', async () => {
    expect(await createFollowUpOrder(input({ originatingEncounterId: otherEncounterId }), SESSION, { today: '2099-04-02' })).toEqual({ ok: false, error: 'encounter_mismatch' })
    expect(await ordersOf(PATIENT)).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  it('rejects unknown patient, unknown encounter and missing or inactive prescriber', async () => {
    expect(await createFollowUpOrder(input({ patientId: `TEST-SP3-${RUN}-NOPE` }), SESSION, { today: '2099-04-02' })).toMatchObject({ ok: false, error: 'patient_not_found' })
    expect(await createFollowUpOrder(input({ originatingEncounterId: 2147483000 }), SESSION, { today: '2099-04-02' })).toMatchObject({ ok: false, error: 'encounter_not_found' })
    expect(await createFollowUpOrder(input({ prescribedByProviderId: inactiveProviderId }), SESSION, { today: '2099-04-02' })).toMatchObject({ ok: false, error: 'provider_not_found' })
    expect(await createFollowUpOrder(input({ prescribedByProviderId: 2147483000 }), SESSION, { today: '2099-04-02' })).toMatchObject({ ok: false, error: 'provider_not_found' })
    expect(await ordersOf(PATIENT)).toEqual([])
  })

  it('rejects a past due date with due_date_invalid', async () => {
    const r = await createFollowUpOrder(input({ originatingEncounterId: null, timing: { kind: 'date', dueDate: '2099-05-01' } }), SESSION, { today: '2099-05-10' })
    expect(r).toEqual({ ok: false, error: 'due_date_invalid', message: 'The follow-up date cannot be in the past.' })
    expect(await ordersOf(PATIENT)).toEqual([])
  })

  it('with an appointment the order is created scheduled', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const order = await created({ appointmentId: appt.id })
    expect(order).toMatchObject({ status: 'scheduled', appointmentId: appt.id, scheduledByName: PROBE_USER })
    expect(order.scheduledAt).toBeInstanceOf(Date)
  })

  it("runs on the caller's executor: a rollback leaves no order and no audit row", async () => {
    await expect(getDb().transaction(async (tx) => {
      const r = await createFollowUpOrder(input(), SESSION, { executor: tx, today: '2099-04-02' })
      expect(r.ok).toBe(true)
      throw new Error('discharge failed later')
    })).rejects.toThrow('discharge failed later')
    expect(await ordersOf(PATIENT)).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  it('a failing audit insert rolls the order back', async () => {
    vi.mocked(logAudit).mockRejectedValueOnce(new Error('audit insert failed'))
    await expect(createFollowUpOrder(input(), SESSION, { today: '2099-04-02' })).rejects.toThrow('audit insert failed')
    expect(await ordersOf(PATIENT)).toEqual([])
  })

  it('updateFollowUpPlan recomputes from baseDate, reports changed fields and never moves the booking', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z')) // 10:00 IST 14 Apr
    const order = await created({ appointmentId: appt.id })
    const r = await updateFollowUpPlan(order.id, { timing: { kind: 'interval', interval: { value: 1, unit: 'months' } }, reason: 'TEST_SP3 new reason' }, SESSION, null, '2099-04-02')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changedFields).toEqual(['reason', 'timing'])
    expect(r.bookingOutsideWindow).toBe(true)
    expect(r.order).toMatchObject({
      baseDate: '2099-04-01', dueDate: '2099-05-01', windowStart: '2099-04-28', windowEnd: '2099-05-08', intervalValue: 1, intervalUnit: 'months',
      reason: 'TEST_SP3 new reason', status: 'scheduled', appointmentId: appt.id, planUpdatedByName: PROBE_USER,
    })
    expect(r.order.planUpdatedAt).toBeInstanceOf(Date)
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id))
    expect(after.startsAt.toISOString()).toBe(appt.startsAt.toISOString())
    expect(after.status).toBe('scheduled')
    const audit = (await auditRows()).find((a) => a.action === 'changed follow-up plan')
    expect(audit?.details).toBe(`followUp=${order.id} fields=reason,timing`)
  })

  it('a window-only change recomputes around the stored due date; a booking inside the window is reported as such', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const order = await created({ appointmentId: appt.id })
    const r = await updateFollowUpPlan(order.id, { windowDaysBefore: 1, windowDaysAfter: 1 }, SESSION, null, '2099-04-02')
    expect(r.ok && r.order).toMatchObject({ dueDate: '2099-04-15', windowStart: '2099-04-14', windowEnd: '2099-04-16' })
    expect(r.ok && r.changedFields).toEqual(['windowDaysAfter', 'windowDaysBefore'])
    expect(r.ok && r.bookingOutsideWindow).toBe(false)
  })

  it('updateFollowUpPlan clears plan notes, changes the prescriber and rejects bad input', async () => {
    const order = await created()
    const r = await updateFollowUpPlan(order.id, { planNotes: null, prescribedByProviderId: otherProviderId, departmentId: null }, SESSION, null, '2099-04-02')
    expect(r.ok && r.order).toMatchObject({ planNotes: null, prescribedByProviderId: otherProviderId, departmentId: null })
    expect(r.ok && r.changedFields).toEqual(['departmentId', 'planNotes', 'prescribedByProviderId'])
    expect(await updateFollowUpPlan(order.id, { prescribedByProviderId: inactiveProviderId }, SESSION, null, '2099-04-02')).toMatchObject({ ok: false, error: 'provider_not_found' })
    expect(await updateFollowUpPlan(order.id, { timing: { kind: 'date', dueDate: '2099-04-01' } }, SESSION, null, '2099-04-02')).toMatchObject({ ok: false, error: 'due_date_invalid' })
    expect(await updateFollowUpPlan(2147483000, { reason: 'x' }, SESSION, null, '2099-04-02')).toEqual({ ok: false, error: 'not_found' })
  })

  it('refuses to edit a cancelled order', async () => {
    const order = await created()
    const c = await cancelFollowUpOrder(order.id, 'TEST_SP3 no longer needed', SESSION, null)
    expect(c.ok).toBe(true)
    expect(await updateFollowUpPlan(order.id, { reason: 'x' }, SESSION, null, '2099-04-02')).toEqual({ ok: false, error: 'not_editable' })
  })

  it('cancel cancels the linked scheduled appointment in the same transaction', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const order = await created({ appointmentId: appt.id })
    const r = await cancelFollowUpOrder(order.id, 'TEST_SP3 patient moved away', SESSION, null)
    expect(r).toMatchObject({ ok: true, cancelledAppointmentId: appt.id })
    expect(r.ok && r.order).toMatchObject({ status: 'cancelled', cancelReason: 'TEST_SP3 patient moved away', cancelledByName: PROBE_USER })
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id))
    expect(after.status).toBe('cancelled')
    const audit = (await auditRows()).find((a) => a.action === 'cancelled follow-up')
    expect(audit?.details).toBe(`followUp=${order.id} appointment=${appt.id}`)
    expect(await cancelFollowUpOrder(order.id, 'again', SESSION, null)).toEqual({ ok: false, error: 'not_cancellable' })
    expect(await cancelFollowUpOrder(2147483000, 'x', SESSION, null)).toEqual({ ok: false, error: 'not_found' })
  })

  it('cancel is atomic: a failing audit leaves the order and the appointment untouched', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const order = await created({ appointmentId: appt.id })
    vi.mocked(logAudit).mockRejectedValueOnce(new Error('audit insert failed'))
    await expect(cancelFollowUpOrder(order.id, 'TEST_SP3 x', SESSION, null)).rejects.toThrow('audit insert failed')
    expect((await getFollowUpById(order.id))?.status).toBe('scheduled')
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id))
    expect(after.status).toBe('scheduled')
  })

  it('cancel without an appointment, and cancelling a completed order is refused', async () => {
    const order = await created()
    const r = await cancelFollowUpOrder(order.id, 'TEST_SP3 x', SESSION, null)
    expect(r).toMatchObject({ ok: true, cancelledAppointmentId: null })
    expect((await auditRows()).find((a) => a.action === 'cancelled follow-up')?.details).toBe(`followUp=${order.id}`)
    const done = await created()
    await getDb().update(followUpOrders).set({ status: 'completed' }).where(eq(followUpOrders.id, done.id))
    expect(await cancelFollowUpOrder(done.id, 'x', SESSION, null)).toEqual({ ok: false, error: 'not_cancellable' })
  })

  it('audit details carry ids only', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const order = await created({ reason: 'BP review SECRETWORD', planNotes: 'notes SECRETWORD' })
    await updateFollowUpPlan(order.id, { reason: 'changed SECRETWORD', planNotes: 'more SECRETWORD' }, SESSION, null, '2099-04-02')
    await getDb().update(followUpOrders).set({ appointmentId: appt.id, status: 'scheduled' }).where(eq(followUpOrders.id, order.id))
    await cancelFollowUpOrder(order.id, 'cancel SECRETWORD', SESSION, null)
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.patientId, PATIENT))
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const row of rows) {
      expect(`${row.action} ${row.details ?? ''}`).not.toContain('SECRETWORD')
    }
  })

  it('only the prescribing doctor (or admin, null) may change or cancel the plan (I3)', async () => {
    const order = await created()
    expect(await updateFollowUpPlan(order.id, { reason: 'TEST_SP3 hijack' }, SESSION, otherProviderId, '2099-04-02')).toEqual({ ok: false, error: 'not_owner' })
    expect(await cancelFollowUpOrder(order.id, 'TEST_SP3 hijack', SESSION, otherProviderId)).toEqual({ ok: false, error: 'not_owner' })
    expect(await getFollowUpById(order.id)).toMatchObject({ status: 'planned', reason: 'TEST_SP3 BP review' })
    expect(await updateFollowUpPlan(order.id, { reason: 'TEST_SP3 own change' }, SESSION, providerId, '2099-04-02')).toMatchObject({ ok: true, changedFields: ['reason'] })
    expect(await updateFollowUpPlan(order.id, { reason: 'TEST_SP3 admin change' }, SESSION, null, '2099-04-02')).toMatchObject({ ok: true })
    expect(await cancelFollowUpOrder(order.id, 'TEST_SP3 own cancel', SESSION, providerId)).toMatchObject({ ok: true })
    // not_found still wins over ownership for a missing id.
    expect(await cancelFollowUpOrder(2147483000, 'x', SESSION, otherProviderId)).toEqual({ ok: false, error: 'not_found' })
  })

  it('getFollowUpById returns the row or null', async () => {
    const order = await created()
    expect((await getFollowUpById(order.id))?.id).toBe(order.id)
    expect(await getFollowUpById(2147483000)).toBeNull()
  })

  it('getFollowUpView returns one joined, role-redacted view or null', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const order = await created({ appointmentId: appt.id, planNotes: 'TEST_SP3 SECRETWORD' })
    await getDb().insert(followUpContactAttempts).values({ followUpOrderId: order.id, channel: 'phone', outcome: 'no_answer', attemptedByName: PROBE_USER })
    const desk = await getFollowUpView(order.id, 'frontdesk', '2099-04-10')
    expect(desk).toMatchObject({
      id: order.id, status: 'scheduled', planNotes: null,
      prescribedBy: { providerId, name: 'TEST_SP3 Dr Prescriber' },
      appointment: { id: appt.id, providerName: 'TEST_SP3 Dr Booked' },
    })
    expect(desk?.contactAttempts).toHaveLength(1)
    expect(JSON.stringify(desk)).not.toContain('SECRETWORD')
    expect((await getFollowUpView(order.id, 'pi', '2099-04-10'))?.planNotes).toBe('TEST_SP3 SECRETWORD')
    expect(await getFollowUpView(2147483000, 'admin')).toBeNull()
  })

  it('listFollowUpsForPatient joins names, includes closed orders newest first, redacts plan notes by role', async () => {
    const appt = await makeAppointment(new Date('2099-04-14T04:30:00Z'))
    const first = await created({ planNotes: 'TEST_SP3 clinical SECRETWORD' })
    const second = await created({ appointmentId: appt.id })
    await cancelFollowUpOrder(first.id, 'TEST_SP3 cancelled', SESSION, null)
    await getDb().insert(followUpContactAttempts).values([
      { followUpOrderId: second.id, channel: 'phone', outcome: 'no_answer', attemptedByName: PROBE_USER, attemptedAt: new Date('2099-04-03T04:00:00Z') },
      { followUpOrderId: second.id, channel: 'sms', outcome: 'message_left', note: 'TEST_SP3 msg', attemptedByName: PROBE_USER, attemptedAt: new Date('2099-04-04T04:00:00Z') },
    ])
    await getDb().insert(followUpOrders).values({ ...(await getFollowUpById(second.id))!, id: undefined, appointmentId: null, status: 'planned', patientId: OTHER_PATIENT })

    const desk = await listFollowUpsForPatient(PATIENT, 'frontdesk', '2099-04-10')
    expect(desk.map((v) => v.id)).toEqual([second.id, first.id])
    // Ruling 2: the cancel reason is clinical -- the front desk sees that it was cancelled, not why.
    expect(desk[1]).toMatchObject({ status: 'cancelled', bucket: 'closed', cancelReason: null })
    expect(desk[0]).toMatchObject({
      status: 'scheduled', bucket: 'scheduled', reason: 'TEST_SP3 BP review', planNotes: null,
      prescribedBy: { providerId, name: 'TEST_SP3 Dr Prescriber' }, department: { id: deptId, name: 'TEST_SP3 follow-up dept' },
      appointment: { id: appt.id, status: 'scheduled', providerId: otherProviderId, providerName: 'TEST_SP3 Dr Booked' },
    })
    expect(desk[0].contactAttempts.map((a) => a.channel)).toEqual(['sms', 'phone'])
    expect(desk[0].lastContact?.note).toBe('TEST_SP3 msg')
    expect(JSON.stringify(desk)).not.toContain('SECRETWORD')

    const pi = await listFollowUpsForPatient(PATIENT, 'pi', '2099-04-10')
    expect(pi.find((v) => v.id === first.id)?.planNotes).toBe('TEST_SP3 clinical SECRETWORD')
    expect(pi.find((v) => v.id === first.id)?.cancelReason).toBe('TEST_SP3 cancelled')
  })

  it('getPortalFollowUps returns open orders without reason or notes', async () => {
    const later = await created({ reason: 'later SECRETWORD', planNotes: 'n SECRETWORD', timing: { kind: 'interval', interval: { value: 3, unit: 'weeks' } } })
    const sooner = await created({ reason: 'sooner SECRETWORD', planNotes: 'n SECRETWORD' })
    const gone = await created({ reason: 'gone SECRETWORD' })
    await cancelFollowUpOrder(gone.id, 'x SECRETWORD', SESSION, null)

    const result = await getPortalFollowUps(PATIENT, '2099-04-10')
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.dueDate)).toEqual([sooner.dueDate, later.dueDate])
    expect(result[0]).toEqual({ dueDate: '2099-04-15', windowStart: '2099-04-12', windowEnd: '2099-04-22', status: 'planned', appointmentStartsAt: null, doctorName: 'TEST_SP3 Dr Prescriber' })
    expect(JSON.stringify(result)).not.toContain('SECRETWORD')
  })
})
