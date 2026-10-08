import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { departments, doctorAssignments, encounters, patients, providers, rooms } from '@/db/schema'

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
}

export async function getTokenSlip(encounterId: number): Promise<TokenSlip | null> {
  const [row] = await getDb()
    .select({
      encounterId: encounters.id,
      opdToken: encounters.opdToken,
      encounterType: encounters.encounterType,
      encounterDate: encounters.encounterDate,
      checkedInAt: encounters.checkedInAt,
      patientId: patients.id,
      patientName: patients.name,
      patientUhid: patients.uhid,
      doctorName: providers.name,
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
