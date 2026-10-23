import { getDb } from '@/db/client'
import { rooms, patients, admissions, admissionTransfers, providers, roomCategories, admissionCoverage, patientPolicies } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { ageOnDate, istDateOf } from '@/lib/india-time'
import { daysStayed, wardGenderConflict, type PatientGender, type WardGender } from '@/lib/inpatient/admission-rules'
import { loadBedTariffResolver } from './bed-tariff'

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
  // WS3 T4 (spec 3.2 item 12): the occupied-bed panel. `occupantPatientId` stays for server-side
  // use only; the UI shows `occupantUhid`.
  admissionId: number | null
  occupantUhid: string | null
  occupantGender: PatientGender
  genderRestriction: WardGender
  roomCategoryName: string | null
  /** ROOM_RENT per day for the bed's category, at the admission payer's rate when it has one. */
  bedTariffPaise: number | null
  /** IST calendar days, admission day = 1; null for a bed with no active stay. */
  daysStayed: number | null
  /** The stay was placed in this bed (by its admission or its latest transfer) under a ward-gender override. */
  wardGenderOverride: boolean
}

export async function listAllRoomsWithOccupant(now: Date = new Date()): Promise<RoomWithOccupant[]> {
  const [rows, tariffOf] = await Promise.all([
    getDb()
      .select({
        id: rooms.id,
        ward: rooms.ward,
        roomNumber: rooms.roomNumber,
        bedNumber: rooms.bedNumber,
        status: rooms.status,
        blockedReason: rooms.blockedReason,
        genderRestriction: rooms.genderRestriction,
        roomCategoryCode: roomCategories.code,
        roomCategoryName: roomCategories.name,
        occupantName: patients.name,
        occupantPatientId: patients.id,
        occupantUhid: patients.uhid,
        occupantGender: patients.gender,
        attendingProviderName: providers.name,
        admissionId: admissions.id,
        admittedAt: admissions.admittedAt,
        // The bed the patient is in now came from the latest transfer, else from the admission.
        wardGenderOverride: sql<boolean | null>`coalesce(
          (select ${admissionTransfers.wardGenderOverrideReason} is not null from ${admissionTransfers}
            where ${admissionTransfers.admissionId} = ${admissions.id}
            order by ${admissionTransfers.transferredAt} desc, ${admissionTransfers.id} desc limit 1),
          ${admissions.wardGenderOverrideReason} is not null)`,
        payerId: patientPolicies.insurerPayerId,
      })
      .from(rooms)
      .leftJoin(roomCategories, eq(roomCategories.id, rooms.roomCategoryId))
      .leftJoin(patients, eq(rooms.occupiedByPatientId, patients.id))
      // The room->admission link runs through admissions.currentRoomId, not
      // the other way around (a room has no admissionId column) -- scoped to
      // status = 'admitted' so a past, already-discharged admission that used
      // to point at this room (currentRoomId is never cleared on discharge)
      // doesn't show a stale "assigned doctor" on a room that's since been
      // reassigned or is sitting empty.
      .leftJoin(admissions, and(eq(admissions.currentRoomId, rooms.id), eq(admissions.status, 'admitted')))
      .leftJoin(providers, eq(providers.id, admissions.attendingProviderId))
      // Lane ruling R2: the stay's payer is admission_coverage.policy_id (null = self-pay).
      .leftJoin(admissionCoverage, eq(admissionCoverage.admissionId, admissions.id))
      .leftJoin(patientPolicies, eq(patientPolicies.id, admissionCoverage.policyId)),
    loadBedTariffResolver(istDateOf(now)),
  ])
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
    admissionId: r.admissionId ?? null,
    occupantUhid: r.occupantUhid ?? null,
    occupantGender: (r.occupantGender ?? null) as PatientGender,
    genderRestriction: (r.genderRestriction ?? null) as WardGender,
    roomCategoryName: r.roomCategoryName ?? null,
    bedTariffPaise: tariffOf({ ward: r.ward, roomCategoryCode: r.roomCategoryCode ?? null, payerId: r.payerId ?? null }),
    daysStayed: r.admittedAt ? daysStayed(r.admittedAt, now) : null,
    wardGenderOverride: r.admissionId != null && r.wardGenderOverride === true,
  }))
}

export type SetRoomGenderResult = { ok: true } | { ok: false; error: 'room_not_found' | 'room_occupied_conflict' }

/**
 * WS3 T4: an admin sets a bed's ward-gender restriction (null = mixed). Refused while the bed's
 * current occupant would then conflict under the ward-gender rule (children under 12 exempt). The
 * room row is locked so a concurrent admission into this bed cannot slip in between the check and
 * the update. Audited by the route (ids only).
 */
export async function setRoomGenderRestriction(roomId: number, genderRestriction: WardGender, now: Date = new Date()): Promise<SetRoomGenderResult> {
  return getDb().transaction(async (tx) => {
    const [room] = await tx.select({ id: rooms.id, occupiedByPatientId: rooms.occupiedByPatientId }).from(rooms).where(eq(rooms.id, roomId)).for('update')
    if (!room) return { ok: false, error: 'room_not_found' }
    if (room.occupiedByPatientId !== null && genderRestriction !== null) {
      const [occupant] = await tx.select({ gender: patients.gender, dob: patients.dob }).from(patients).where(eq(patients.id, room.occupiedByPatientId))
      if (occupant && wardGenderConflict({ patientGender: occupant.gender ?? null, ageYears: ageOnDate(occupant.dob, istDateOf(now)), ward: genderRestriction })) {
        return { ok: false, error: 'room_occupied_conflict' }
      }
    }
    await tx.update(rooms).set({ genderRestriction }).where(eq(rooms.id, roomId))
    return { ok: true }
  })
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
