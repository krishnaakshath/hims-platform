import { getDb } from '@/db/client'
import { rooms, patients, admissions, providers } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

export interface AvailableRoom {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
}

export async function listAvailableRooms(): Promise<AvailableRoom[]> {
  return getDb()
    .select({ id: rooms.id, ward: rooms.ward, roomNumber: rooms.roomNumber, bedNumber: rooms.bedNumber })
    .from(rooms)
    .where(eq(rooms.status, 'available'))
}

/**
 * Race-safe: the UPDATE's WHERE clause re-checks `status = 'available'` at
 * write time, not just at the earlier read time a caller may have done. Two
 * concurrent check-ins racing for the same room can both pass a read-time
 * check, but only one UPDATE actually matches a row here -- the loser's
 * `.rowCount` is 0, which this function surfaces as `false` so the route can
 * tell the operator "someone else just took that room" instead of silently
 * double-booking it.
 */
export async function assignRoomToPatient(roomId: number, patientId: string): Promise<boolean> {
  const result = await getDb()
    .update(rooms)
    .set({ status: 'occupied', occupiedByPatientId: patientId })
    .where(and(eq(rooms.id, roomId), eq(rooms.status, 'available')))
    .returning({ id: rooms.id })
  return result.length > 0
}

export interface RoomWithOccupant {
  id: number
  ward: string
  roomNumber: string
  bedNumber: string
  status: 'available' | 'occupied' | 'dirty' | 'blocked'
  blockedReason: string | null
  occupantName: string | null
  occupantPatientId: string | null
  attendingProviderName: string | null
  admittedAt: Date | null
}

export async function listAllRoomsWithOccupant(): Promise<RoomWithOccupant[]> {
  const rows = await getDb()
    .select({
      id: rooms.id,
      ward: rooms.ward,
      roomNumber: rooms.roomNumber,
      bedNumber: rooms.bedNumber,
      status: rooms.status,
      blockedReason: rooms.blockedReason,
      occupantName: patients.name,
      occupantPatientId: patients.id,
      attendingProviderName: providers.name,
      admittedAt: admissions.admittedAt,
    })
    .from(rooms)
    .leftJoin(patients, eq(rooms.occupiedByPatientId, patients.id))
    // The room->admission link runs through admissions.currentRoomId, not
    // the other way around (a room has no admissionId column) -- scoped to
    // status = 'admitted' so a past, already-discharged admission that used
    // to point at this room (currentRoomId is never cleared on discharge)
    // doesn't show a stale "assigned doctor" on a room that's since been
    // reassigned or is sitting empty.
    .leftJoin(admissions, and(eq(admissions.currentRoomId, rooms.id), eq(admissions.status, 'admitted')))
    .leftJoin(providers, eq(providers.id, admissions.attendingProviderId))
  return rows.map((r) => ({
    id: r.id,
    ward: r.ward,
    roomNumber: r.roomNumber,
    bedNumber: r.bedNumber,
    status: r.status,
    blockedReason: r.blockedReason,
    occupantName: r.occupantName ?? null,
    occupantPatientId: r.occupantPatientId ?? null,
    attendingProviderName: r.attendingProviderName ?? null,
    admittedAt: r.admittedAt ?? null,
  }))
}

export async function markRoomClean(roomId: number): Promise<boolean> {
  const result = await getDb().update(rooms).set({ status: 'available' }).where(and(eq(rooms.id, roomId), eq(rooms.status, 'dirty'))).returning({ id: rooms.id })
  return result.length > 0
}

export async function blockRoom(roomId: number, reason: string): Promise<boolean> {
  const result = await getDb().update(rooms).set({ status: 'blocked', blockedReason: reason }).where(and(eq(rooms.id, roomId), eq(rooms.status, 'available'))).returning({ id: rooms.id })
  return result.length > 0
}

export async function unblockRoom(roomId: number): Promise<boolean> {
  const result = await getDb().update(rooms).set({ status: 'available', blockedReason: null }).where(and(eq(rooms.id, roomId), eq(rooms.status, 'blocked'))).returning({ id: rooms.id })
  return result.length > 0
}
