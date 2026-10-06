import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, patients, admissions, providers } from '@/db/schema'
import { listAllRoomsWithOccupant } from '@/lib/queries/rooms'

const TEST_PATIENT_ID = 'RD-ROOMOCC-TEST-01'
let roomId: number
let admissionId: number
let providerId: number
let providerName: string

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Room Occupant Test Patient', dob: '1990-01-01' })
  ;[{ id: providerId, name: providerName }] = await getDb().select({ id: providers.id, name: providers.name }).from(providers).limit(1)
  const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '901', bedNumber: 'A', status: 'occupied', occupiedByPatientId: TEST_PATIENT_ID }).returning()
  roomId = room.id
  const [admission] = await getDb().insert(admissions).values({ patientId: TEST_PATIENT_ID, currentRoomId: roomId, attendingProviderId: providerId }).returning()
  admissionId = admission.id
})

afterAll(async () => {
  await getDb().delete(admissions).where(eq(admissions.id, admissionId))
  await getDb().delete(rooms).where(eq(rooms.id, roomId))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

describe('listAllRoomsWithOccupant', () => {
  it('joins the occupant patient id and the attending provider name for an occupied, admitted room', async () => {
    const result = await listAllRoomsWithOccupant()
    const row = result.find((r) => r.id === roomId)
    expect(row).toBeDefined()
    expect(row?.occupantName).toBe('Room Occupant Test Patient')
    expect(row?.occupantPatientId).toBe(TEST_PATIENT_ID)
    expect(row?.attendingProviderName).toBe(providerName)
    expect(row?.admittedAt).not.toBeNull()
  })
})
