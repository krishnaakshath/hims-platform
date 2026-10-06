import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions, admissionTransfers } from '@/db/schema'

const createdRoomIds: number[] = []
const createdAdmissionIds: number[] = []
const createdTransferIds: number[] = []

afterEach(async () => {
  while (createdTransferIds.length > 0) await getDb().delete(admissionTransfers).where(eq(admissionTransfers.id, createdTransferIds.pop()!))
  while (createdAdmissionIds.length > 0) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('inpatient ADT schema', () => {
  it('supports the widened room_status values, blockedReason, and the admissions/admission_transfers tables', async () => {
    const db = getDb()
    const [room1] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T1', bedNumber: 'A' }).returning()
    createdRoomIds.push(room1.id)
    const [room2] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T2', bedNumber: 'A', status: 'dirty' }).returning()
    createdRoomIds.push(room2.id)
    expect(room2.status).toBe('dirty')

    const [room3] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T3', bedNumber: 'A', status: 'blocked', blockedReason: 'Under maintenance' }).returning()
    createdRoomIds.push(room3.id)
    expect(room3.status).toBe('blocked')
    expect(room3.blockedReason).toBe('Under maintenance')

    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)

    const [admission] = await db.insert(admissions).values({
      patientId: patientRow.id,
      currentRoomId: room1.id,
      attendingProviderId: providerRow.id,
      admissionType: 'emergency',
    }).returning()
    createdAdmissionIds.push(admission.id)
    expect(admission.status).toBe('admitted')
    expect(admission.admissionType).toBe('emergency')
    expect(admission.dischargedAt).toBeNull()
    expect(admission.dischargeDiagnosis).toBeNull()

    const [transfer] = await db.insert(admissionTransfers).values({
      admissionId: admission.id,
      fromRoomId: room1.id,
      toRoomId: room2.id,
      reason: 'Test transfer',
      transferredByName: 'Test Nurse',
    }).returning()
    createdTransferIds.push(transfer.id)
    expect(transfer.fromRoomId).toBe(room1.id)
    expect(transfer.toRoomId).toBe(room2.id)
  })

  it('allows a null fromRoomId on a transfer (first-ever room assignment for a boarding admission)', async () => {
    const db = getDb()
    const [room] = await db.insert(rooms).values({ ward: 'Test Ward', roomNumber: 'T4', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const [providerRow] = await db.select().from(providers).limit(1)
    const [patientRow] = await db.select().from(patients).limit(1)
    const [admission] = await db.insert(admissions).values({ patientId: patientRow.id, currentRoomId: null, attendingProviderId: providerRow.id }).returning()
    createdAdmissionIds.push(admission.id)
    expect(admission.currentRoomId).toBeNull()

    const [transfer] = await db.insert(admissionTransfers).values({ admissionId: admission.id, fromRoomId: null, toRoomId: room.id, reason: 'First room assignment', transferredByName: 'Test Nurse' }).returning()
    createdTransferIds.push(transfer.id)
    expect(transfer.fromRoomId).toBeNull()
  })
})
