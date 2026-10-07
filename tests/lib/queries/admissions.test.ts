import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions, admissionTransfers, appointments, auditLog, encounters, followUpOrders } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { createAdmission, getActiveAdmissionForPatient, getAdmissionById, transferAdmission, dischargeAdmission } from '@/lib/queries/admissions'

// SP3: dischargeAdmission now takes a session and writes its audit row (and any
// follow-up order) inside its transaction; the probe name lets afterEach remove them.
const PROBE_USER = `TEST_SP3_ADM-${Date.now()}`
const SESSION: Session = { role: 'admin', name: PROBE_USER, userId: null }

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
  await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
})

describe('admissions queries', () => {
  it('creates an admission with a room and reads it back as the active one', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Q1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)

    const created = await createAdmission({ patientId: patientRow.id, roomId: room.id, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    createdAdmissionIds.push(created.id)
    expect(created.currentRoomId).toBe(room.id)
    expect(created.status).toBe('admitted')

    const active = await getActiveAdmissionForPatient(patientRow.id)
    expect(active?.id).toBe(created.id)

    const byId = await getAdmissionById(created.id)
    expect(byId?.id).toBe(created.id)
  })

  it('creates a boarding admission with no room (roomId: null)', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const created = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'emergency', createdFromAssignmentId: null })
    createdAdmissionIds.push(created.id)
    expect(created.currentRoomId).toBeNull()
  })

  it('returns null from getActiveAdmissionForPatient when the patient has no active admission', async () => {
    const db = getDb()
    const [patientRow] = await db.select().from(patients).limit(1)
    // Use a patient with a discharged-only history or none at all -- since
    // this test doesn't create any admission for this patient, "no active
    // admission" is trivially true here.
    const active = await getActiveAdmissionForPatient(patientRow.id + '-no-such-suffix')
    expect(active).toBeNull()
  })
})

describe('transferAdmission', () => {
  it('moves the admission to a new room, frees the old one to dirty, and records the transfer', async () => {
    const db = getDb()
    const [oldRoom] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X1', bedNumber: 'A', status: 'occupied' }).returning()
    const [newRoom] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X2', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    await db.update(rooms).set({ occupiedByPatientId: patientRow.id }).where(eq(rooms.id, oldRoom.id))
    const admission = await createAdmission({ patientId: patientRow.id, roomId: oldRoom.id, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await transferAdmission(admission.id, newRoom.id, 'Needs ICU-level care', 'Test Nurse')
    expect(result.ok).toBe(true)

    const updatedAdmission = await getAdmissionById(admission.id)
    expect(updatedAdmission?.currentRoomId).toBe(newRoom.id)

    const [oldRoomAfter] = await db.select().from(rooms).where(eq(rooms.id, oldRoom.id))
    expect(oldRoomAfter.status).toBe('dirty')
    const [newRoomAfter] = await db.select().from(rooms).where(eq(rooms.id, newRoom.id))
    expect(newRoomAfter.status).toBe('occupied')

    await db.delete(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, oldRoom.id))
    await db.delete(rooms).where(eq(rooms.id, newRoom.id))
  })

  it('fails with a clear error when the destination room is not available', async () => {
    const db = getDb()
    const [takenRoom] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X3', bedNumber: 'A', status: 'occupied' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await transferAdmission(admission.id, takenRoom.id, 'Test', 'Test Nurse')
    expect(result.ok).toBe(false)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, takenRoom.id))
  })

  it('supports a null fromRoomId as the first room assignment for a boarding admission', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X4', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await transferAdmission(admission.id, room.id, 'First bed assignment', 'Test Nurse')
    expect(result.ok).toBe(true)
    const [transferRow] = await db.select().from(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
    expect(transferRow.fromRoomId).toBeNull()

    await db.delete(admissionTransfers).where(eq(admissionTransfers.admissionId, admission.id))
    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, room.id))
  })

  it('rejects transferring an admission that is already discharged', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'X5', bedNumber: 'A' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null, followUpPlan: null }, SESSION)

    const result = await transferAdmission(admission.id, room.id, 'Attempted transfer after discharge', 'Test Nurse')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('This admission has already been discharged')

    const [roomAfter] = await db.select().from(rooms).where(eq(rooms.id, room.id))
    expect(roomAfter.status).toBe('available')

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, room.id))
  })
})

describe('dischargeAdmission', () => {
  it('discharges, frees the room to dirty, and stores the 5 Ds', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'Z1', bedNumber: 'A', status: 'occupied' }).returning()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    await db.update(rooms).set({ occupiedByPatientId: patientRow.id }).where(eq(rooms.id, room.id))
    const admission = await createAdmission({ patientId: patientRow.id, roomId: room.id, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const result = await dischargeAdmission(admission.id, {
      dischargeDiagnosis: 'Resolved pneumonia',
      dischargeDrugs: 'Amoxicillin 500mg TID x7 days',
      dischargeDevices: 'None',
      dischargeDiet: 'Regular',
      dischargeSummaryNotes: 'Patient tolerated treatment well.',
      followUp: null,
      followUpPlan: null,
    }, SESSION)
    expect(result.ok).toBe(true)

    const updated = await getAdmissionById(admission.id)
    expect(updated?.status).toBe('discharged')
    expect(updated?.currentRoomId).toBeNull()
    expect(updated?.dischargeDiagnosis).toBe('Resolved pneumonia')
    expect(updated?.dischargedAt).not.toBeNull()

    const [roomAfter] = await db.select().from(rooms).where(eq(rooms.id, room.id))
    expect(roomAfter.status).toBe('dirty')

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(rooms).where(eq(rooms.id, room.id))
  })

  it('creates a follow-up appointment when one is requested', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000)
    const result = await dischargeAdmission(admission.id, {
      dischargeDiagnosis: 'Test', dischargeDrugs: 'Test', dischargeDevices: 'Test', dischargeDiet: 'Test', dischargeSummaryNotes: 'Test',
      followUp: { startsAt, endsAt },
      followUpPlan: null,
    }, SESSION)
    expect(result.ok).toBe(true)

    const updated = await getAdmissionById(admission.id)
    expect(updated?.followUpAppointmentId).not.toBeNull()
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, updated!.followUpAppointmentId!))
    expect(appt.patientId).toBe(patientRow.id)

    await db.delete(followUpOrders).where(eq(followUpOrders.originatingAdmissionId, admission.id))
    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(appointments).where(eq(appointments.id, appt.id))
  })

  it('rejects discharging an admission that is already discharged', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null, followUpPlan: null }, SESSION)

    const secondResult = await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null, followUpPlan: null }, SESSION)
    expect(secondResult.ok).toBe(false)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
  })
})

// ---------------------------------------------------------------------------
// SP3 Task 10: discharge records the follow-up order and closes the IPD
// encounter in ONE transaction. Own provider/patient/room fixtures, so slots
// never collide with seeded appointments.
// ---------------------------------------------------------------------------
describe.skipIf(!process.env.DATABASE_URL)('dischargeAdmission: follow-up order + encounter (DB)', () => {
  const RUN = `${Date.now()}`
  const PATIENT = `TEST-SP3-${RUN}-DIS`
  const FIVE_DS = { dischargeDiagnosis: 'TEST_SP3 Dx', dischargeDrugs: 'TEST_SP3 Rx', dischargeDevices: 'None', dischargeDiet: 'Soft', dischargeSummaryNotes: 'TEST_SP3 notes' }
  const DAY = 24 * 60 * 60 * 1000
  let providerId = 0
  const roomIds: number[] = []
  const admissionIds: number[] = []
  const appointmentIds: number[] = []
  const encounterIds: number[] = []

  // A future slot on this test's own provider: minute-aligned, `days` ahead.
  const slotAt = (days: number, minuteOffset = 0) => {
    const start = new Date(Math.floor((Date.now() + days * DAY) / 60000) * 60000 + minuteOffset * 60000)
    return { startsAt: start, endsAt: new Date(start.getTime() + 30 * 60000) }
  }

  async function admit(opts: { withRoom?: boolean } = {}) {
    const db = getDb()
    let roomId: number | null = null
    if (opts.withRoom) {
      const [room] = await db.insert(rooms).values({ ward: 'TEST_SP3 Ward', roomNumber: `D${roomIds.length}`, bedNumber: 'A', status: 'occupied', occupiedByPatientId: PATIENT }).returning()
      roomIds.push(room.id)
      roomId = room.id
    }
    const adm = await createAdmission({ patientId: PATIENT, roomId, attendingProviderId: providerId, admissionType: 'elective', createdFromAssignmentId: null })
    admissionIds.push(adm.id)
    return adm
  }

  beforeAll(async () => {
    const db = getDb()
    const [p] = await db.insert(providers).values({ name: `TEST_SP3 Dr Discharge ${RUN}`, specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP3 Discharge Patient', dob: '1975-05-05' })
  })

  afterEach(async () => {
    const db = getDb()
    if (admissionIds.length) {
      await db.delete(followUpOrders).where(inArray(followUpOrders.originatingAdmissionId, admissionIds))
      const followUpAppts = await db.select({ id: admissions.followUpAppointmentId }).from(admissions).where(inArray(admissions.id, admissionIds))
      for (const r of followUpAppts) if (r.id !== null) appointmentIds.push(r.id)
    }
    await db.delete(followUpOrders).where(eq(followUpOrders.patientId, PATIENT))
    if (encounterIds.length) await db.delete(encounters).where(inArray(encounters.id, encounterIds.splice(0)))
    if (admissionIds.length) await db.delete(admissions).where(inArray(admissions.id, admissionIds.splice(0)))
    if (appointmentIds.length) await db.delete(appointments).where(inArray(appointments.id, appointmentIds.splice(0)))
    if (roomIds.length) await db.delete(rooms).where(inArray(rooms.id, roomIds.splice(0)))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(eq(providers.id, providerId))
  })

  it('a plan without a slot creates a planned discharge order linked to the admission', async () => {
    const adm = await admit()
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: null, followUpPlan: { timing: { kind: 'interval', interval: { value: 1, unit: 'weeks' } }, reason: 'Wound check', planNotes: null } }, SESSION)
    expect(r.ok).toBe(true)
    expect(r.followUpAppointmentId).toBeUndefined()
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, r.followUpOrderId!))
    expect(o).toMatchObject({ source: 'discharge', status: 'planned', originatingAdmissionId: adm.id, prescribedByProviderId: adm.attendingProviderId, appointmentId: null, reason: 'Wound check' })
    expect(o.dueDate).toBe(addDaysIso(istDateOf(new Date()), 7))
  })

  it('a slot creates a scheduled order pointing at the follow-up appointment', async () => {
    const adm = await admit()
    const slot = slotAt(9)
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: slot, followUpPlan: null }, SESSION)
    expect(r.ok).toBe(true)
    const after = await getAdmissionById(adm.id)
    expect(after?.followUpAppointmentId).toBe(r.followUpAppointmentId)
    const [appt] = await getDb().select().from(appointments).where(eq(appointments.id, r.followUpAppointmentId!))
    expect(appt).toMatchObject({ providerId, visitReason: 'Post-discharge follow-up', status: 'scheduled' })
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, r.followUpOrderId!))
    expect(o).toMatchObject({ source: 'discharge', status: 'scheduled', appointmentId: r.followUpAppointmentId, reason: 'Post-discharge follow-up', dueDate: istDateOf(slot.startsAt) })
  })

  it('a plan with a slot keeps the plan timing and reason and links the appointment', async () => {
    const adm = await admit()
    const slot = slotAt(12)
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: slot, followUpPlan: { timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'Suture removal', planNotes: 'TEST_SP3 check flap' } }, SESSION)
    expect(r.ok).toBe(true)
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, r.followUpOrderId!))
    expect(o).toMatchObject({ status: 'scheduled', appointmentId: r.followUpAppointmentId, reason: 'Suture removal', planNotes: 'TEST_SP3 check flap', dueDate: addDaysIso(istDateOf(new Date()), 14) })
  })

  it('a slot in the past is slot_in_past and rolls the whole discharge back (M10)', async () => {
    const adm = await admit({ withRoom: true })
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: slotAt(-1), followUpPlan: null }, SESSION)
    expect(r).toEqual({ ok: false, error: 'slot_in_past' })
    expect(await getAdmissionById(adm.id)).toMatchObject({ status: 'admitted', followUpAppointmentId: null, dischargedAt: null })
    expect(await getDb().select().from(followUpOrders).where(eq(followUpOrders.patientId, PATIENT))).toEqual([])
  })

  it('a slot conflict rolls the whole discharge back', async () => {
    const adm = await admit({ withRoom: true })
    const slot = slotAt(10)
    const [blocker] = await getDb().insert(appointments).values({ patientId: PATIENT, providerId, startsAt: new Date(slot.startsAt.getTime() + 10 * 60000), endsAt: new Date(slot.endsAt.getTime() + 10 * 60000), visitReason: 'TEST_SP3 blocker', status: 'scheduled' }).returning()
    appointmentIds.push(blocker.id)

    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: slot, followUpPlan: { timing: { kind: 'interval', interval: { value: 1, unit: 'weeks' } }, reason: 'Wound check', planNotes: null } }, SESSION)
    expect(r).toEqual({ ok: false, error: 'conflict' })

    const after = await getAdmissionById(adm.id)
    expect(after).toMatchObject({ status: 'admitted', currentRoomId: adm.currentRoomId, followUpAppointmentId: null, dischargedAt: null })
    const [room] = await getDb().select().from(rooms).where(eq(rooms.id, adm.currentRoomId!))
    expect(room).toMatchObject({ status: 'occupied', occupiedByPatientId: PATIENT })
    expect(await getDb().select().from(followUpOrders).where(eq(followUpOrders.originatingAdmissionId, adm.id))).toHaveLength(0)
    expect(await getDb().select().from(appointments).where(and(eq(appointments.providerId, providerId), eq(appointments.patientId, PATIENT)))).toHaveLength(1)
    expect(await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).toHaveLength(0)
  })

  it('a past plan date rolls the whole discharge back with due_date_invalid', async () => {
    const adm = await admit({ withRoom: true })
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: null, followUpPlan: { timing: { kind: 'date', dueDate: '2020-01-01' }, reason: 'Wound check', planNotes: null } }, SESSION)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('due_date_invalid')
    expect(r.message).toBe('The follow-up date cannot be in the past.')
    const after = await getAdmissionById(adm.id)
    expect(after?.status).toBe('admitted')
    const [room] = await getDb().select().from(rooms).where(eq(rooms.id, adm.currentRoomId!))
    expect(room.status).toBe('occupied')
    expect(await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))).toHaveLength(0)
  })

  it('completes the admission encounter and links it as the originating encounter', async () => {
    const adm = await admit()
    // The IPD encounter opened at check-in, 10 days before discharge.
    const admittedOn = addDaysIso(istDateOf(new Date()), -10)
    const [enc] = await getDb().insert(encounters).values({ patientId: PATIENT, encounterType: 'ipd', encounterDate: admittedOn, providerId, admissionId: adm.id, checkedInByName: PROBE_USER }).returning()
    encounterIds.push(enc.id)

    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: null, followUpPlan: { timing: { kind: 'interval', interval: { value: 1, unit: 'weeks' } }, reason: 'Wound check', planNotes: null } }, SESSION)
    expect(r.ok).toBe(true)
    const [encAfter] = await getDb().select().from(encounters).where(eq(encounters.id, enc.id))
    expect(encAfter.status).toBe('completed')
    expect(encAfter.completedAt).not.toBeNull()
    expect(encAfter.statusChangedByName).toBe(PROBE_USER)
    const [o] = await getDb().select().from(followUpOrders).where(eq(followUpOrders.id, r.followUpOrderId!))
    expect(o.originatingEncounterId).toBe(enc.id)
    // "1 week" counts from the discharge day, not the admission day (else a
    // long stay would make every interval plan land in the past).
    expect(o.baseDate).toBe(istDateOf(new Date()))
    expect(o.dueDate).toBe(addDaysIso(istDateOf(new Date()), 7))
  })

  it('writes the discharged-patient audit row (ids only) inside the transaction', async () => {
    const adm = await admit()
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: null, followUpPlan: { timing: { kind: 'interval', interval: { value: 3, unit: 'days' } }, reason: 'TEST_SP3 secret reason', planNotes: 'TEST_SP3 secret notes' } }, SESSION)
    expect(r.ok).toBe(true)
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(rows.map((a) => a.action).sort()).toEqual(['discharged patient', 'set follow-up plan'])
    expect(rows.find((a) => a.action === 'discharged patient')?.details).toBe(`admission=${adm.id}`)
    expect(JSON.stringify(rows)).not.toMatch(/secret/)
  })

  it('no plan and no slot creates no order', async () => {
    const adm = await admit()
    const r = await dischargeAdmission(adm.id, { ...FIVE_DS, followUp: null, followUpPlan: null }, SESSION)
    expect(r.ok).toBe(true)
    expect(r.followUpOrderId).toBeUndefined()
    expect(await getDb().select().from(followUpOrders).where(eq(followUpOrders.originatingAdmissionId, adm.id))).toHaveLength(0)
  })

  it('two discharges booking the same doctor slot at once: exactly one wins, one appointment row', async () => {
    const a1 = await admit()
    const a2 = await admit()
    const slot = slotAt(11)
    const results = await Promise.all([a1, a2].map((a) => dischargeAdmission(a.id, { ...FIVE_DS, followUp: slot, followUpPlan: null }, SESSION)))
    expect(results.filter((x) => x.ok)).toHaveLength(1)
    expect(results.filter((x) => !x.ok).map((x) => x.error)).toEqual(['conflict'])
    const inSlot = await getDb().select().from(appointments).where(and(eq(appointments.providerId, providerId), eq(appointments.startsAt, slot.startsAt)))
    expect(inSlot).toHaveLength(1)
  })
})
