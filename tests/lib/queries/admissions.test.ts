import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions, admissionTransfers, appointments } from '@/db/schema'
import { createAdmission, getActiveAdmissionForPatient, getAdmissionById, transferAdmission, dischargeAdmission } from '@/lib/queries/admissions'

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
afterEach(async () => {
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
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
    await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null })

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
    })
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
    })
    expect(result.ok).toBe(true)

    const updated = await getAdmissionById(admission.id)
    expect(updated?.followUpAppointmentId).not.toBeNull()
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, updated!.followUpAppointmentId!))
    expect(appt.patientId).toBe(patientRow.id)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
    await db.delete(appointments).where(eq(appointments.id, appt.id))
  })

  it('rejects discharging an admission that is already discharged', async () => {
    const db = getDb()
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const admission = await createAdmission({ patientId: patientRow.id, roomId: null, attendingProviderId: providerRow.id, admissionType: 'elective', createdFromAssignmentId: null })
    await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null })

    const secondResult = await dischargeAdmission(admission.id, { dischargeDiagnosis: 'A', dischargeDrugs: 'B', dischargeDevices: 'C', dischargeDiet: 'D', dischargeSummaryNotes: 'E', followUp: null })
    expect(secondResult.ok).toBe(false)

    await db.delete(admissions).where(eq(admissions.id, admission.id))
  })
})
