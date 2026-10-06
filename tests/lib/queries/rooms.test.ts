import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms } from '@/db/schema'
import { listAvailableRooms, assignRoomToPatient } from '@/lib/queries/rooms'

const createdRoomIds: number[] = []
afterEach(async () => {
  while (createdRoomIds.length > 0) {
    const id = createdRoomIds.pop()!
    await getDb().delete(rooms).where(eq(rooms.id, id))
  }
})

describe('listAvailableRooms', () => {
  it('only returns rooms with status available', async () => {
    const [available] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '101', bedNumber: 'A', status: 'available' }).returning()
    const [occupied] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '102', bedNumber: 'A', status: 'occupied' }).returning()
    createdRoomIds.push(available.id, occupied.id)

    const result = await listAvailableRooms()
    expect(result.some((r) => r.id === available.id)).toBe(true)
    expect(result.some((r) => r.id === occupied.id)).toBe(false)
  })
})

describe('assignRoomToPatient', () => {
  it('assigns an available room and flips it to occupied', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '201', bedNumber: 'A', status: 'available' }).returning()
    createdRoomIds.push(room.id)

    const ok = await assignRoomToPatient(room.id, 'RD-0001')
    expect(ok).toBe(true)

    const [updated] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(updated.status).toBe('occupied')
    expect(updated.occupiedByPatientId).toBe('RD-0001')
  })

  it('refuses to double-assign a room that is already occupied (race guard)', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: '202', bedNumber: 'A', status: 'occupied', occupiedByPatientId: 'RD-0001' }).returning()
    createdRoomIds.push(room.id)

    const ok = await assignRoomToPatient(room.id, 'RD-0002')
    expect(ok).toBe(false)

    const [unchanged] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(unchanged.occupiedByPatientId).toBe('RD-0001')
  })
})
