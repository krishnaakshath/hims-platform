import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, appointments, auditLog, departments, doctorAssignments, encounters, followUpOrders, patients, providers } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  allocateOpdToken, checkInVisit, completeAdmissionEncounter, getEncounterById, listEncountersForPatient, transitionEncounter,
  type CheckInVisitInput,
} from '@/lib/queries/encounters'

// Real logAudit by default; a test can make the audit insert itself fail.
vi.mock('@/lib/audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/audit')>('@/lib/audit')
  return { ...actual, logAudit: vi.fn(actual.logAudit) }
})
import { logAudit } from '@/lib/audit'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP3_ENC-${RUN}`
const SESSION: Session = { role: 'frontdesk', name: PROBE_USER, userId: null }
const PATIENT = `TEST-SP3-${RUN}-P`
const DEPT_CODE = `TSP3E${RUN.slice(-8)}`

// Run-unique far-future IST dates, so the shared DB never collides with real tokens.
const NOW = new Date('2099-03-01T10:00:00Z') // IST 2099-03-01
const NOW2 = new Date('2099-03-03T10:00:00Z') // IST 2099-03-03
const NOW3 = new Date('2099-03-08T10:00:00Z') // IST 2099-03-08

let providerId = 0
let otherProviderId = 0
let deptId = 0

describe.skipIf(!process.env.DATABASE_URL)('encounters (DB)', () => {
  const appointmentIds: number[] = []

  beforeAll(async () => {
    const db = getDb()
    const [d] = await db.insert(departments).values({ code: DEPT_CODE, name: 'TEST_SP3 encounters dept', kind: 'clinical' }).returning()
    deptId = d.id
    const [p1] = await db.insert(providers).values({ name: 'TEST_SP3 Dr One', specialty: 'Test', colorTag: '#000000', departmentId: d.id }).returning()
    const [p2] = await db.insert(providers).values({ name: 'TEST_SP3 Dr Two', specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p1.id
    otherProviderId = p2.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP3 Encounter Patient', dob: '1990-01-01' })
  })

  afterEach(async () => {
    const db = getDb()
    // Children first. Every row below belongs to this file's own patient.
    await db.delete(followUpOrders).where(eq(followUpOrders.patientId, PATIENT))
    await db.delete(encounters).where(eq(encounters.patientId, PATIENT))
    await db.delete(admissions).where(eq(admissions.patientId, PATIENT))
    await db.delete(doctorAssignments).where(eq(doctorAssignments.patientId, PATIENT))
    if (appointmentIds.length) await db.delete(appointments).where(inArray(appointments.id, appointmentIds.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    vi.mocked(logAudit).mockClear()
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(inArray(providers.id, [providerId, otherProviderId]))
    await db.delete(departments).where(eq(departments.id, deptId))
  })

  const input = (over: Partial<CheckInVisitInput> = {}): CheckInVisitInput => ({
    patientId: PATIENT, providerId, visitType: 'outpatient', urgency: 'routine', reason: 'TEST_SP3 visit',
    roomId: null, appointmentId: null, createAdmission: false, ...over,
  })

  async function makeAppointment(over: Partial<typeof appointments.$inferInsert> = {}) {
    const startsAt = new Date('2099-03-01T04:00:00Z') // 09:30 IST on 2099-03-01
    const [a] = await getDb().insert(appointments).values({
      patientId: PATIENT, providerId, startsAt, endsAt: new Date(startsAt.getTime() + 15 * 60000), visitReason: 'TEST_SP3 follow-up', ...over,
    }).returning()
    appointmentIds.push(a.id)
    return a
  }

  async function makeOrder(appointmentId: number) {
    const [o] = await getDb().insert(followUpOrders).values({
      patientId: PATIENT, source: 'manual', status: 'scheduled', prescribedByProviderId: providerId,
      baseDate: '2099-02-20', dueDate: '2099-03-01', windowStart: '2099-02-26', windowEnd: '2099-03-08',
      reason: 'TEST_SP3 review', appointmentId, createdByName: PROBE_USER,
    }).returning()
    return o
  }

  const encountersOfPatient = () => getDb().select().from(encounters).where(eq(encounters.patientId, PATIENT))
  const assignmentsOfPatient = () => getDb().select().from(doctorAssignments).where(eq(doctorAssignments.patientId, PATIENT))

  it('allocates sequential tokens per IST date and mirrors them on the assignment', async () => {
    const a = await checkInVisit(input(), SESSION, NOW)
    const b = await checkInVisit(input(), SESSION, NOW)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.encounter.opdToken).toBe(1)
      expect(b.encounter.opdToken).toBe(a.encounter.opdToken! + 1)
      expect(a.assignment.queueTicketNumber).toBe(a.encounter.opdToken)
      expect(b.assignment.queueTicketNumber).toBe(b.encounter.opdToken)
      expect(a.encounter).toMatchObject({ encounterType: 'opd', visitType: 'new', status: 'checked_in', encounterDate: '2099-03-01', providerId, departmentId: deptId, doctorAssignmentId: a.assignment.id, checkedInByName: PROBE_USER, appointmentId: null, admissionId: null })
      expect(a.assignment).toMatchObject({ status: 'pending', assignedByName: PROBE_USER, appointmentId: null })
      expect(a.admissionId).toBeNull()
      expect(a.completedFollowUpOrderId).toBeNull()
    }
  })

  it('restarts tokens on a new IST date', async () => {
    const late = await checkInVisit(input(), SESSION, new Date('2099-03-05T18:29:00Z')) // 23:59 IST 5 Mar
    const early = await checkInVisit(input(), SESSION, new Date('2099-03-05T18:31:00Z')) // 00:01 IST 6 Mar
    expect(late.ok && late.encounter.encounterDate).toBe('2099-03-05')
    expect(early.ok && early.encounter.encounterDate).toBe('2099-03-06')
    expect(late.ok && late.encounter.opdToken).toBe(1)
    expect(early.ok && early.encounter.opdToken).toBe(1)
  })

  it('emergency urgency opens an emergency visit', async () => {
    const r = await checkInVisit(input({ urgency: 'emergency' }), SESSION, NOW)
    expect(r.ok && r.encounter.visitType).toBe('emergency')
  })

  it('concurrent check-ins on one date never share a token and get consecutive tokens', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => checkInVisit(input(), SESSION, NOW2)))
    const tokens = rs.map((r) => (r.ok ? r.encounter.opdToken : null))
    expect(new Set(tokens).size).toBe(5)
    expect([...tokens].sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5])
    for (const r of rs) if (r.ok) expect(r.assignment.queueTicketNumber).toBe(r.encounter.opdToken)
  })

  it('a failure after token allocation rolls everything back and does not burn the token', async () => {
    vi.mocked(logAudit).mockRejectedValueOnce(new Error('audit insert failed'))
    await expect(checkInVisit(input(), SESSION, NOW3)).rejects.toThrow('audit insert failed')
    expect(await encountersOfPatient()).toEqual([])
    expect(await assignmentsOfPatient()).toEqual([])
    expect(await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).toEqual([])

    // An FK failure on the assignment insert (unknown provider) also leaves nothing behind.
    await expect(checkInVisit(input({ providerId: 2147483000 }), SESSION, NOW3)).rejects.toThrow()
    expect(await assignmentsOfPatient()).toEqual([])

    const ok = await checkInVisit(input(), SESSION, NOW3)
    expect(ok.ok && ok.encounter.opdToken).toBe(1)
  })

  it('allocateOpdToken also clears the legacy lobby tickets of that IST day', async () => {
    // A legacy count-based ticket created during IST 2099-03-08 (created_at in UTC on 7 Mar).
    const [legacy] = await getDb().insert(doctorAssignments).values({
      patientId: PATIENT, providerId, visitType: 'outpatient', urgency: 'routine', reason: 'TEST_SP3 legacy', assignedByName: PROBE_USER,
      queueTicketNumber: 7, createdAt: new Date('2099-03-07T19:00:00Z'),
    }).returning()
    expect(legacy.queueTicketNumber).toBe(7)
    const token = await getDb().transaction((tx) => allocateOpdToken(tx, '2099-03-08'))
    expect(token).toBe(8)
    // ...but not those of the previous IST day.
    expect(await getDb().transaction((tx) => allocateOpdToken(tx, '2099-03-07'))).toBe(1)
  })

  it('check-in against a booked follow-up completes it and marks the visit follow_up', async () => {
    const appt = await makeAppointment()
    const order = await makeOrder(appt.id)
    const r = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.encounter.visitType).toBe('follow_up')
    expect(r.encounter.appointmentId).toBe(appt.id)
    expect(r.assignment.status).toBe('scheduled')
    expect(r.assignment.appointmentId).toBe(appt.id)
    expect(r.completedFollowUpOrderId).toBe(order.id)
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(o.status).toBe('completed')
    expect(o.completedEncounterId).toBe(r.encounter.id)
    expect(o.completedAt).toEqual(NOW)
    const audit = await getDb().select({ action: auditLog.action, details: auditLog.details, patientId: auditLog.patientId }).from(auditLog).where(eq(auditLog.userName, PROBE_USER)).orderBy(auditLog.id)
    expect(audit).toEqual([
      { action: 'checked in patient (outpatient)', details: `encounter=${r.encounter.id} token=${r.encounter.opdToken}`, patientId: PATIENT },
      { action: 'completed follow-up at check-in', details: `followUp=${order.id} encounter=${r.encounter.id}`, patientId: PATIENT },
    ])
  })

  // I1 lock order: follow-up order -> appointment -> token -> encounter, everywhere.
  // Another clerk's unbook/reschedule holds the ORDER lock first (as unbookFollowUp
  // and bookFollowUp do) and only then touches the appointment. Check-in must
  // queue behind the order lock instead of holding the appointment lock, or the
  // two transactions deadlock (40P01).
  async function racingOrderWriter(orderId: number, apptId: number, write: (tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]) => Promise<void>) {
    let markHeld!: () => void
    const held = new Promise<void>((r) => { markHeld = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const writer = getDb().transaction(async (tx) => {
      await tx.select({ id: followUpOrders.id }).from(followUpOrders).where(eq(followUpOrders.id, orderId)).for('update')
      markHeld()
      await gate
      // Now the appointment: with the old order (appointment first) this waits on check-in -> deadlock.
      await tx.select({ id: appointments.id }).from(appointments).where(eq(appointments.id, apptId)).for('update')
      await write(tx)
    })
    await held
    return { writer, release }
  }

  it('check-in racing an unbook of the same follow-up waits for it and does not deadlock', async () => {
    const appt = await makeAppointment()
    const order = await makeOrder(appt.id)
    const { writer, release } = await racingOrderWriter(order.id, appt.id, async (tx) => {
      await tx.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, appt.id))
      await tx.update(followUpOrders).set({ status: 'planned', appointmentId: null }).where(eq(followUpOrders.id, order.id))
    })
    const checkIn = checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    await new Promise((r) => setTimeout(r, 300)) // check-in is now blocked on the order lock
    release()
    await expect(writer).resolves.toBeUndefined()
    expect(await checkIn).toEqual({ ok: false, error: 'appointment_not_scheduled' })
    expect(await encountersOfPatient()).toEqual([])
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(o).toMatchObject({ status: 'planned', appointmentId: null, completedEncounterId: null })
  })

  it('check-in racing a reschedule of the same follow-up waits for it and does not deadlock', async () => {
    const appt = await makeAppointment()
    const order = await makeOrder(appt.id)
    const { writer, release } = await racingOrderWriter(order.id, appt.id, async (tx) => {
      await tx.update(appointments).set({ startsAt: new Date('2099-03-04T04:00:00Z'), endsAt: new Date('2099-03-04T04:15:00Z') }).where(eq(appointments.id, appt.id))
    })
    const checkIn = checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    await new Promise((r) => setTimeout(r, 300))
    release()
    await expect(writer).resolves.toBeUndefined()
    expect(await checkIn).toEqual({ ok: false, error: 'appointment_not_today' })
    expect((await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id)))[0].status).toBe('scheduled')
  })

  it('check-in queued behind a writer that leaves the booking intact still completes the follow-up', async () => {
    const appt = await makeAppointment()
    const order = await makeOrder(appt.id)
    const { writer, release } = await racingOrderWriter(order.id, appt.id, async () => {})
    const checkIn = checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    await new Promise((r) => setTimeout(r, 300))
    release()
    await writer
    const r = await checkIn
    expect(r.ok && r.completedFollowUpOrderId).toBe(order.id)
  })

  it('check-in against a plain booked appointment is a new visit with no order completed', async () => {
    const appt = await makeAppointment()
    const r = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    expect(r.ok && r.encounter.visitType).toBe('new')
    expect(r.ok && r.completedFollowUpOrderId).toBeNull()
  })

  it.each<[string, () => Partial<typeof appointments.$inferInsert>]>([
    ['appointment_not_today', () => ({ startsAt: new Date('2099-03-01T19:00:00Z') })], // 00:30 IST on 2 Mar
    ['appointment_mismatch', () => ({ providerId: otherProviderId })],
    ['appointment_not_scheduled', () => ({ status: 'cancelled' })],
  ])('returns %s with no writes', async (error, over) => {
    const appt = await makeAppointment(over())
    const r = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    expect(r).toEqual({ ok: false, error })
    expect(await encountersOfPatient()).toEqual([])
    expect(await assignmentsOfPatient()).toEqual([])
  })

  it('returns appointment_not_found for an unknown appointment', async () => {
    expect(await checkInVisit(input({ appointmentId: 2147483000 }), SESSION, NOW)).toEqual({ ok: false, error: 'appointment_not_found' })
  })

  it('refuses a second check-in for the same appointment, even concurrently', async () => {
    const appt = await makeAppointment()
    const rs = await Promise.all([checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW), checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, error: 'appointment_already_checked_in' })
    const again = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    expect(again).toEqual({ ok: false, error: 'appointment_already_checked_in' })
    expect(await encountersOfPatient()).toHaveLength(1)
  })

  it('inpatient check-in creates and links the admission', async () => {
    const r = await checkInVisit(input({ visitType: 'inpatient', createAdmission: true }), SESSION, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.encounter.encounterType).toBe('ipd')
    expect(r.admissionId).not.toBeNull()
    expect(r.encounter.admissionId).toBe(r.admissionId)
    const [adm] = await getDb().select().from(admissions).where(eq(admissions.id, r.admissionId!))
    expect(adm).toMatchObject({ createdFromAssignmentId: r.assignment.id, admissionType: 'elective', attendingProviderId: providerId, status: 'admitted' })
  })

  it('inpatient check-in without createAdmission opens an ipd encounter with no admission', async () => {
    const r = await checkInVisit(input({ visitType: 'inpatient', createAdmission: false }), SESSION, NOW)
    expect(r.ok && r.encounter.encounterType).toBe('ipd')
    expect(r.ok && r.encounter.admissionId).toBeNull()
  })

  it('writes the check-in audit row on the same transaction', async () => {
    const r = await checkInVisit(input(), SESSION, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_USER), eq(auditLog.patientId, PATIENT)))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'checked in patient (outpatient)', details: `encounter=${r.encounter.id} token=${r.encounter.opdToken}`, role: 'frontdesk' })
    // logAudit was handed the transaction, not the shared db.
    expect(vi.mocked(logAudit).mock.calls[0][4]).toBeDefined()
    expect(vi.mocked(logAudit).mock.calls[0][4]).not.toBe(getDb())
  })

  it('transitionEncounter enforces the state machine', async () => {
    const r = await checkInVisit(input(), SESSION, NOW)
    if (!r.ok) throw new Error('check-in failed')
    const done = await transitionEncounter(r.encounter.id, 'completed', SESSION)
    expect(done.ok).toBe(true)
    if (done.ok) {
      expect(done.encounter.status).toBe('completed')
      expect(done.encounter.completedAt).toBeInstanceOf(Date)
      expect(done.encounter.statusChangedByName).toBe(PROBE_USER)
      expect(done.encounter.statusChangedAt).toBeInstanceOf(Date)
    }
    expect(await transitionEncounter(r.encounter.id, 'cancelled', SESSION, { cancelReason: 'left' })).toEqual({ ok: false, error: 'invalid_transition' })
    expect(await transitionEncounter(2147483000, 'completed', SESSION)).toEqual({ ok: false, error: 'not_found' })
    const audit = await getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.userName, PROBE_USER)).orderBy(auditLog.id)
    expect(audit.map((a) => a.action)).toEqual(['checked in patient (outpatient)', 'encounter status changed to completed'])
    expect(audit[1].details).toBe(`encounter=${r.encounter.id}`)
  })

  it('transitionEncounter: in_consultation then completed; cancel stores the reason but never audits it', async () => {
    const a = await checkInVisit(input(), SESSION, NOW)
    const b = await checkInVisit(input(), SESSION, NOW)
    if (!a.ok || !b.ok) throw new Error('check-in failed')
    expect((await transitionEncounter(a.encounter.id, 'in_consultation', SESSION)).ok).toBe(true)
    expect(await transitionEncounter(a.encounter.id, 'cancelled', SESSION, { cancelReason: 'x' })).toEqual({ ok: false, error: 'invalid_transition' })
    expect((await transitionEncounter(a.encounter.id, 'completed', SESSION)).ok).toBe(true)
    const c = await transitionEncounter(b.encounter.id, 'cancelled', SESSION, { cancelReason: 'TEST_SP3 secret reason' })
    expect(c.ok && c.encounter.cancelReason).toBe('TEST_SP3 secret reason')
    expect(c.ok && c.encounter.completedAt).toBeNull()
    const audit = await getDb().select({ details: auditLog.details }).from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(JSON.stringify(audit)).not.toContain('secret')
  })

  it('cancelling a visit reopens the follow-up it completed and frees the appointment for a new check-in (I6)', async () => {
    const appt = await makeAppointment()
    const order = await makeOrder(appt.id)
    const first = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    if (!first.ok) throw new Error('check-in failed')
    const c = await transitionEncounter(first.encounter.id, 'cancelled', SESSION, { cancelReason: 'TEST_SP3 wrong patient' })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.encounter).toMatchObject({ status: 'cancelled', appointmentId: null })
    const [reopened] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(reopened).toMatchObject({ status: 'scheduled', completedAt: null, completedEncounterId: null, appointmentId: appt.id })
    const audit = await getDb().select({ action: auditLog.action, details: auditLog.details }).from(auditLog).where(eq(auditLog.userName, PROBE_USER)).orderBy(auditLog.id)
    expect(audit).toContainEqual({ action: 'reopened follow-up after visit cancelled', details: `followUp=${order.id} encounter=${first.encounter.id}` })
    expect(JSON.stringify(audit)).not.toContain('wrong patient')

    // The same appointment can be checked in again, and that visit completes the follow-up.
    const again = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    expect(again.ok && again.completedFollowUpOrderId).toBe(order.id)
    if (!again.ok) return
    const [done] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(done).toMatchObject({ status: 'completed', completedEncounterId: again.encounter.id })
  })

  it('completing a visit, or a refused cancel, leaves the completed follow-up alone', async () => {
    const appt = await makeAppointment()
    const order = await makeOrder(appt.id)
    const r = await checkInVisit(input({ appointmentId: appt.id }), SESSION, NOW)
    if (!r.ok) throw new Error('check-in failed')
    expect((await transitionEncounter(r.encounter.id, 'completed', SESSION)).ok).toBe(true)
    expect(await transitionEncounter(r.encounter.id, 'cancelled', SESSION, { cancelReason: 'x' })).toEqual({ ok: false, error: 'invalid_transition' })
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, order.id))
    expect(o).toMatchObject({ status: 'completed', completedEncounterId: r.encounter.id })
    expect((await getEncounterById(r.encounter.id))?.appointmentId).toBe(appt.id)
  })

  it('getEncounterById and listEncountersForPatient read back, newest first', async () => {
    const a = await checkInVisit(input(), SESSION, NOW)
    const b = await checkInVisit(input(), SESSION, NOW2)
    if (!a.ok || !b.ok) throw new Error('check-in failed')
    expect((await getEncounterById(a.encounter.id))?.id).toBe(a.encounter.id)
    expect(await getEncounterById(2147483000)).toBeNull()
    const list = await listEncountersForPatient(PATIENT)
    expect(list.map((e) => e.id)).toEqual([b.encounter.id, a.encounter.id])
    expect(list[0]).toMatchObject({ providerId, providerName: 'TEST_SP3 Dr One', departmentName: 'TEST_SP3 encounters dept', encounterType: 'opd', status: 'checked_in', encounterDate: '2099-03-03', opdToken: b.encounter.opdToken })
    expect(list[0].checkedInAt).toBeInstanceOf(Date)
    expect(await listEncountersForPatient(PATIENT, 1)).toHaveLength(1)
  })

  it('completeAdmissionEncounter closes the open IPD encounter once', async () => {
    const r = await checkInVisit(input({ visitType: 'inpatient', createAdmission: true }), SESSION, NOW)
    if (!r.ok) throw new Error('check-in failed')
    expect(await completeAdmissionEncounter(getDb(), r.admissionId!, PROBE_USER)).toBe(r.encounter.id)
    const e = await getEncounterById(r.encounter.id)
    expect(e).toMatchObject({ status: 'completed', statusChangedByName: PROBE_USER })
    expect(e?.completedAt).toBeInstanceOf(Date)
    expect(await completeAdmissionEncounter(getDb(), r.admissionId!, PROBE_USER)).toBeNull()
  })
})
