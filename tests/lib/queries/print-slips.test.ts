import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, doctorAssignments, encounters, patients, providers, rooms } from '@/db/schema'
import { getRegistrationSlip, getTokenSlip } from '@/lib/queries/print-slips'

// Wave C P1-14 / registration slip loaders. Fixtures by id (TEST_WC_ prefix).
const PID = 'TEST_WC_SLIP1'
let encounterId: number
let providerName: string

beforeAll(async () => {
  const db = getDb()
  await db.delete(encounters).where(eq(encounters.patientId, PID))
  await db.delete(patients).where(inArray(patients.id, [PID]))
  await db.insert(patients).values({
    id: PID, name: 'Slip Testwc Patient', dob: '1990-01-01', uhid: 'TWCSLIP0001', phone: '+919800000001',
    abhaNumber: null, dateAdded: new Date('2026-10-07T20:00:00Z'),
  })
  const [provider] = await db.select({ id: providers.id, name: providers.name }).from(providers).limit(1)
  if (!provider) throw new Error('Need at least one seeded provider')
  providerName = provider.name
  const [enc] = await db.insert(encounters).values({
    patientId: PID, encounterType: 'opd', encounterDate: '2001-01-01', opdToken: 987,
    providerId: provider.id, checkedInByName: 'Test WC', checkedInAt: new Date('2001-01-01T04:00:00Z'),
  }).returning({ id: encounters.id })
  encounterId = enc.id
})

afterAll(async () => {
  const db = getDb()
  await db.delete(encounters).where(eq(encounters.patientId, PID))
  await db.delete(patients).where(eq(patients.id, PID))
})

describe('getTokenSlip', () => {
  it('returns the token, patient name/UHID, doctor and check-in instant', async () => {
    const slip = await getTokenSlip(encounterId)
    expect(slip).toMatchObject({
      encounterId, opdToken: 987, encounterType: 'opd', encounterDate: '2001-01-01',
      patient: { id: PID, name: 'Slip Testwc Patient', uhid: 'TWCSLIP0001' },
      doctorName: providerName, room: null,
      waitingAhead: 0, estimatedWaitMinutes: 0,
    })
    expect(new Date(slip!.checkedInAt).toISOString()).toBe('2001-01-01T04:00:00.000Z')
    // Minimal patient projection: no phone, no ABHA, no DOB.
    expect(Object.keys(slip!.patient).sort()).toEqual(['id', 'name', 'uhid'])
  })

  it('returns null for an unknown encounter', async () => {
    expect(await getTokenSlip(2_000_000_000)).toBeNull()
  })
})

// WS6 T9: the slip's room (the doctor's OPD room, or the bed's room for an admission) and the
// patients still waiting ahead for the same doctor today, with the estimated wait.
describe('getTokenSlip room and wait', () => {
  const DATE = '2001-02-02'
  const SUFFIX = String(Date.now() % 100000)
  let doctorId = 0
  let otherDoctorId = 0
  let departmentId = 0
  let roomId = 0
  let assignmentId = 0
  let target = 0
  let ipdEncounter = 0

  beforeAll(async () => {
    const db = getDb()
    const [dept] = await db.insert(departments).values({ code: `TSL${SUFFIX}`, name: `Slip Dept ${SUFFIX}` }).returning({ id: departments.id })
    departmentId = dept.id
    const [doc] = await db.insert(providers).values({ name: 'Dr Slip Room', specialty: 'General Medicine', colorTag: 'chart-1', departmentId, slotMinutes: 10, opdRoom: '4' }).returning({ id: providers.id })
    const [other] = await db.insert(providers).values({ name: 'Dr Slip Other', specialty: 'General Medicine', colorTag: 'chart-1', departmentId, slotMinutes: 10 }).returning({ id: providers.id })
    doctorId = doc.id
    otherDoctorId = other.id
    const at = (min: number) => new Date(Date.parse(`${DATE}T04:00:00Z`) + min * 60_000)
    const enc = (providerId: number, status: 'checked_in' | 'in_consultation' | 'completed', min: number) =>
      ({ patientId: PID, encounterType: 'opd' as const, encounterDate: DATE, providerId, status, checkedInByName: 'Test WC', checkedInAt: at(min) })
    await db.insert(encounters).values([
      enc(doctorId, 'checked_in', 0),
      enc(doctorId, 'checked_in', 1),
      enc(doctorId, 'checked_in', 2),
      enc(doctorId, 'in_consultation', 3),
      enc(doctorId, 'completed', 4),
      enc(otherDoctorId, 'checked_in', 5),
    ])
    const [mine] = await db.insert(encounters).values(enc(doctorId, 'checked_in', 6)).returning({ id: encounters.id })
    target = mine.id
    await db.insert(encounters).values(enc(doctorId, 'checked_in', 7))

    const [room] = await db.insert(rooms).values({ ward: 'Slip Ward', roomNumber: `S${SUFFIX}`, bedNumber: 'B' }).returning({ id: rooms.id })
    roomId = room.id
    const [assignment] = await db.insert(doctorAssignments).values({ patientId: PID, providerId: doctorId, visitType: 'inpatient', urgency: 'routine', reason: 'Admission', roomId, assignedByName: 'Test WC' }).returning({ id: doctorAssignments.id })
    assignmentId = assignment.id
    const [ipd] = await db.insert(encounters).values({ patientId: PID, encounterType: 'ipd', encounterDate: DATE, providerId: doctorId, checkedInByName: 'Test WC', checkedInAt: at(8), doctorAssignmentId: assignmentId }).returning({ id: encounters.id })
    ipdEncounter = ipd.id
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(encounters).where(inArray(encounters.providerId, [doctorId, otherDoctorId]))
    await db.delete(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
    await db.delete(rooms).where(eq(rooms.id, roomId))
    await db.delete(providers).where(inArray(providers.id, [doctorId, otherDoctorId]))
    await db.delete(departments).where(eq(departments.id, departmentId))
  })

  it('shows the doctor\'s OPD room and counts only earlier checked_in visits of the same doctor that day', async () => {
    expect(await getTokenSlip(target)).toMatchObject({ doctorName: 'Dr Slip Room', roomLabel: '4', waitingAhead: 3, estimatedWaitMinutes: 30 })
  })

  it('uses the bed\'s room for an admission and gives no OPD wait', async () => {
    expect(await getTokenSlip(ipdEncounter)).toMatchObject({ roomLabel: `S${SUFFIX}`, waitingAhead: 0, estimatedWaitMinutes: null })
  })
})

describe('getRegistrationSlip', () => {
  it('returns name, UHID and the registration instant only', async () => {
    const slip = await getRegistrationSlip(PID)
    expect(slip).toEqual({ id: PID, name: 'Slip Testwc Patient', uhid: 'TWCSLIP0001', registeredAt: expect.any(Date) })
    expect(slip!.registeredAt.toISOString()).toBe('2026-10-07T20:00:00.000Z')
  })

  it('returns null for an unknown patient', async () => {
    expect(await getRegistrationSlip('TEST_WC_NOPE')).toBeNull()
  })
})
