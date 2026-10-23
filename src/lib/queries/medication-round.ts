// WS3 T7: the nursing station's medication round (spec 3.2 item 15) and its admitted-patient list.
// Admitted patients only; the day is the IST calendar day; a scheduled dose is overdue 30 minutes
// after its time. Charting stays on the existing administer route (pi/admin).
import { and, asc, eq, gte, lt } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, medicationAdministrations, patients, rooms } from '@/db/schema'
import { startOfIstDay } from '@/lib/india-time'

export const OVERDUE_AFTER_MS = 30 * 60_000

export interface RoundRow {
  medicationId: number
  admissionId: number
  patientName: string
  uhid: string | null
  bedLabel: string | null
  medicationName: string
  dose: string
  scheduledFor: Date
  status: 'scheduled' | 'given' | 'held' | 'refused'
  overdue: boolean
}

const bedLabel = (ward: string | null, roomNumber: string | null, bedNumber: string | null) =>
  ward === null ? null : `${ward} ${roomNumber}-${bedNumber}`

/** Every dose scheduled on the IST day `dateIso` for currently admitted patients, optionally in one ward. */
export async function listMedicationRound(dateIso: string, ward: string | null, now: Date = new Date()): Promise<RoundRow[]> {
  const start = startOfIstDay(dateIso)
  const end = new Date(start.getTime() + 24 * 3600_000)
  const rows = await getDb().select({
    medicationId: medicationAdministrations.id,
    admissionId: medicationAdministrations.admissionId,
    patientName: patients.name,
    uhid: patients.uhid,
    ward: rooms.ward,
    roomNumber: rooms.roomNumber,
    bedNumber: rooms.bedNumber,
    medicationName: medicationAdministrations.medicationName,
    dose: medicationAdministrations.dose,
    scheduledFor: medicationAdministrations.scheduledFor,
    status: medicationAdministrations.status,
  }).from(medicationAdministrations)
    .innerJoin(admissions, eq(admissions.id, medicationAdministrations.admissionId))
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .leftJoin(rooms, eq(rooms.id, admissions.currentRoomId))
    .where(and(
      eq(admissions.status, 'admitted'),
      gte(medicationAdministrations.scheduledFor, start),
      lt(medicationAdministrations.scheduledFor, end),
      ward === null ? undefined : eq(rooms.ward, ward),
    ))
    .orderBy(asc(medicationAdministrations.scheduledFor), asc(medicationAdministrations.id))
  const overdueBefore = now.getTime() - OVERDUE_AFTER_MS
  return rows.map((r) => ({
    medicationId: r.medicationId,
    admissionId: r.admissionId,
    patientName: r.patientName,
    uhid: r.uhid,
    bedLabel: bedLabel(r.ward, r.roomNumber, r.bedNumber),
    medicationName: r.medicationName,
    dose: r.dose,
    scheduledFor: r.scheduledFor,
    status: r.status,
    overdue: r.status === 'scheduled' && r.scheduledFor.getTime() < overdueBefore,
  }))
}

export interface AdmittedPatient {
  admissionId: number
  patientName: string
  uhid: string | null
  bedLabel: string | null
  ward: string | null
}

/** Currently admitted patients, by ward and bed, for the vitals picker and the ward filter. */
export async function listAdmittedForNursing(): Promise<AdmittedPatient[]> {
  const rows = await getDb().select({
    admissionId: admissions.id,
    patientName: patients.name,
    uhid: patients.uhid,
    ward: rooms.ward,
    roomNumber: rooms.roomNumber,
    bedNumber: rooms.bedNumber,
  }).from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .leftJoin(rooms, eq(rooms.id, admissions.currentRoomId))
    .where(eq(admissions.status, 'admitted'))
    .orderBy(asc(rooms.ward), asc(rooms.roomNumber), asc(rooms.bedNumber), asc(admissions.id))
  return rows.map((r) => ({
    admissionId: r.admissionId,
    patientName: r.patientName,
    uhid: r.uhid,
    bedLabel: bedLabel(r.ward, r.roomNumber, r.bedNumber),
    ward: r.ward,
  }))
}
