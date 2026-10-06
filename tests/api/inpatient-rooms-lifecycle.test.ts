import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as markClean } from '@/app/api/inpatient/rooms/[id]/mark-clean/route'
import { POST as blockRoomRoute } from '@/app/api/inpatient/rooms/[id]/block/route'
import { POST as unblockRoomRoute } from '@/app/api/inpatient/rooms/[id]/unblock/route'
import { getDb } from '@/db/client'
import { rooms } from '@/db/schema'

let sessionRole = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Test Admin' })) }))

const createdRoomIds: number[] = []
afterEach(async () => {
  sessionRole = 'admin'
  while (createdRoomIds.length > 0) await getDb().delete(rooms).where(eq(rooms.id, createdRoomIds.pop()!))
})

describe('inpatient room lifecycle routes', () => {
  it('marks a dirty room clean (available)', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L1', bedNumber: 'A', status: 'dirty' }).returning()
    createdRoomIds.push(room.id)
    const req = new Request('http://localhost', { method: 'POST' })
    const res = await markClean(req as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(res.status).toBe(200)
    const [updated] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(updated.status).toBe('available')
  })

  it('rejects mark-clean from a role with no facilities access', async () => {
    sessionRole = 'pi'
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L2', bedNumber: 'A', status: 'dirty' }).returning()
    createdRoomIds.push(room.id)
    const req = new Request('http://localhost', { method: 'POST' })
    const res = await markClean(req as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(res.status).toBe(403)
  })

  it('blocks and then unblocks a room, clearing the reason on unblock', async () => {
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L3', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const blockReq = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Plumbing repair' }) })
    const blockRes = await blockRoomRoute(blockReq as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(blockRes.status).toBe(200)
    const [blocked] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason).toBe('Plumbing repair')

    const unblockReq = new Request('http://localhost', { method: 'POST' })
    const unblockRes = await unblockRoomRoute(unblockReq as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(unblockRes.status).toBe(200)
    const [unblocked] = await getDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(unblocked.status).toBe('available')
    expect(unblocked.blockedReason).toBeNull()
  })

  it('rejects blocking a room from a non-admin role', async () => {
    sessionRole = 'frontdesk'
    const [room] = await getDb().insert(rooms).values({ ward: 'Test Ward', roomNumber: 'L4', bedNumber: 'A' }).returning()
    createdRoomIds.push(room.id)
    const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason: 'Test' }) })
    const res = await blockRoomRoute(req as never, { params: Promise.resolve({ id: String(room.id) }) })
    expect(res.status).toBe(403)
  })
})
