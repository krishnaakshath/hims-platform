import { and, eq, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, doctorAssignments, encounters, patients, providers, rooms } from '@/db/schema'
import { estimateWaitMinutes } from '@/lib/front-desk/wait-estimate'
import { providerAvailability } from './front-desk-queue'

// Wave C print slips (P1-14 OPD token slip, registration slip / UHID card).
// Explicit minimal projections: the patient's name, UHID and chart id only --
// never DOB, phone, address, Aadhaar or ABHA.

export interface TokenSlip {
  encounterId: number
  opdToken: number | null
  encounterType: 'opd' | 'ipd' | 'lab'
  encounterDate: string
  checkedInAt: Date
  patient: { id: string; name: string; uhid: string | null }
  doctorName: string
  departmentName: string | null
  room: { ward: string; roomNumber: string; bedNumber: string } | null
  // WS6 T9: the bed's room for an admission, else the doctor's OPD room (providers.opd_room).
  roomLabel: string | null
  /** OPD patients of the same doctor and day checked in before this one and still waiting. */
  waitingAhead: number
  /** estimateWaitMinutes(waitingAhead, slot length); null for a non-OPD visit, a visit no longer waiting, or a doctor on leave / outside hours. */
  estimatedWaitMinutes: number | null
}

export async function getTokenSlip(encounterId: number): Promise<TokenSlip | null> {
  const [row] = await getDb()
    .select({
      encounterId: encounters.id,
      opdToken: encounters.opdToken,
      encounterType: encounters.encounterType,
      encounterDate: encounters.encounterDate,
      status: encounters.status,
      checkedInAt: encounters.checkedInAt,
      patientId: patients.id,
      patientName: patients.name,
      patientUhid: patients.uhid,
      providerId: encounters.providerId,
      doctorName: providers.name,
      slotMinutes: providers.slotMinutes,
      opdRoom: providers.opdRoom,
      departmentName: departments.name,
      ward: rooms.ward,
      roomNumber: rooms.roomNumber,
      bedNumber: rooms.bedNumber,
    })
    .from(encounters)
    .innerJoin(patients, eq(patients.id, encounters.patientId))
    .innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .leftJoin(doctorAssignments, eq(doctorAssignments.id, encounters.doctorAssignmentId))
    .leftJoin(rooms, eq(rooms.id, doctorAssignments.roomId))
    .where(eq(encounters.id, encounterId))
  if (!row) return null
  const isOpd = row.encounterType === 'opd'
  // The wait is only meaningful for a visit that is still waiting, with a doctor who is available.
  const waiting = isOpd && row.status === 'checked_in'
  let waitingAhead = 0
  if (waiting) {
    const [ahead] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(encounters)
      .where(and(
        eq(encounters.providerId, row.providerId),
        eq(encounters.encounterType, 'opd'),
        eq(encounters.encounterDate, row.encounterDate),
        eq(encounters.status, 'checked_in'),
        or(lt(encounters.checkedInAt, row.checkedInAt), and(eq(encounters.checkedInAt, row.checkedInAt), lt(encounters.id, row.encounterId))),
      ))
    waitingAhead = ahead?.count ?? 0
  }
  const availability = waiting ? (await providerAvailability([row.providerId])).get(row.providerId) : undefined
  return {
    encounterId: row.encounterId,
    opdToken: row.opdToken,
    encounterType: row.encounterType,
    encounterDate: String(row.encounterDate),
    checkedInAt: row.checkedInAt,
    patient: { id: row.patientId, name: row.patientName.trim(), uhid: row.patientUhid },
    doctorName: row.doctorName,
    departmentName: row.departmentName ?? null,
    room: row.ward && row.roomNumber && row.bedNumber ? { ward: row.ward, roomNumber: row.roomNumber, bedNumber: row.bedNumber } : null,
    roomLabel: (isOpd ? row.opdRoom : row.roomNumber) ?? null,
    waitingAhead,
    estimatedWaitMinutes: waiting && availability === 'available' ? estimateWaitMinutes(waitingAhead, row.slotMinutes) : null,
  }
}

export interface RegistrationSlip {
  id: string
  name: string
  uhid: string | null
  registeredAt: Date
}

export async function getRegistrationSlip(anonId: string): Promise<RegistrationSlip | null> {
  const [row] = await getDb()
    .select({ id: patients.id, name: patients.name, uhid: patients.uhid, registeredAt: patients.dateAdded })
    .from(patients)
    .where(eq(patients.id, anonId))
  return row ? { id: row.id, name: row.name.trim(), uhid: row.uhid, registeredAt: row.registeredAt } : null
}

// Wave F P1-16: the patient block of A4 clinical documents (prescription
// slip). Name, UHID, chart id, DOB (for the age) and gender only -- never
// phone, address, Aadhaar or ABHA. A separate read from
// getPatientIdentityForPrint, whose result the labs route returns whole.
export interface PatientDocumentIdentity {
  id: string
  name: string
  uhid: string | null
  dob: string
  gender: string | null
}

export async function getPatientDocumentIdentity(anonId: string): Promise<PatientDocumentIdentity | null> {
  const [row] = await getDb()
    .select({ id: patients.id, name: patients.name, uhid: patients.uhid, dob: sql<string>`${patients.dob}::text`, gender: patients.gender })
    .from(patients)
    .where(eq(patients.id, anonId))
  return row ? { id: row.id, name: row.name.trim(), uhid: row.uhid, dob: row.dob, gender: row.gender } : null
}
