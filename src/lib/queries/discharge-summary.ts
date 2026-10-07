import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, admissionTransfers, departments, followUpOrders, patients, providers, rooms } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { buildDischargeSummary, type DischargeSummaryData, type DischargeSummarySource } from '@/lib/encounters/discharge-summary'
import { getFollowUpView } from './follow-ups'
import { getLatestSignatureForSignable } from './signatures'

/**
 * Loads the discharge-summary data for a DISCHARGED admission (null otherwise,
 * or when it does not exist). Every table is read by named columns: patients
 * never by the whole row (no phone, no credentials; Aadhaar does not live on
 * patients at all). `viewerRole` gates the clinical sections and ABHA
 * (see buildDischargeSummary); without it the result has none.
 */
export async function getDischargeSummaryData(
  admissionId: number,
  { now = new Date(), viewerRole = null }: { now?: Date; viewerRole?: Role | null } = {},
): Promise<DischargeSummaryData | null> {
  const db = getDb()
  const [row] = await db
    .select({
      admission: {
        id: admissions.id,
        admissionType: admissions.admissionType,
        status: admissions.status,
        admittedAt: admissions.admittedAt,
        dischargedAt: admissions.dischargedAt,
        dischargeDiagnosis: admissions.dischargeDiagnosis,
        dischargeDrugs: admissions.dischargeDrugs,
        dischargeDevices: admissions.dischargeDevices,
        dischargeDiet: admissions.dischargeDiet,
        dischargeSummaryNotes: admissions.dischargeSummaryNotes,
      },
      patient: {
        id: patients.id,
        uhid: patients.uhid,
        name: patients.name,
        dob: patients.dob,
        gender: patients.gender,
        abhaNumber: patients.abhaNumber,
        abhaAddress: patients.abhaAddress,
        addressLine1: patients.addressLine1,
        addressLine2: patients.addressLine2,
        city: patients.city,
        district: patients.district,
        stateCode: patients.stateCode,
        pinCode: patients.pinCode,
        isMlc: patients.isMlc,
        mlcNumber: patients.mlcNumber,
      },
      attending: {
        providerId: providers.id,
        name: providers.name,
        registrationCouncil: providers.registrationCouncil,
        registrationStateCode: providers.registrationStateCode,
        registrationNumber: providers.registrationNumber,
        departmentName: departments.name,
      },
    })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .innerJoin(providers, eq(providers.id, admissions.attendingProviderId))
    .leftJoin(departments, eq(departments.id, providers.departmentId))
    .where(eq(admissions.id, admissionId))
  if (!row || row.admission.status !== 'discharged' || row.admission.dischargedAt === null) return null

  const [lastTransfer] = await db
    .select({ ward: rooms.ward })
    .from(admissionTransfers)
    .innerJoin(rooms, eq(rooms.id, admissionTransfers.toRoomId))
    .where(eq(admissionTransfers.admissionId, admissionId))
    .orderBy(desc(admissionTransfers.transferredAt), desc(admissionTransfers.id))
    .limit(1)

  const [order] = await db
    .select({ id: followUpOrders.id })
    .from(followUpOrders)
    .where(and(eq(followUpOrders.originatingAdmissionId, admissionId), eq(followUpOrders.source, 'discharge')))
    .orderBy(desc(followUpOrders.createdAt), desc(followUpOrders.id))
    .limit(1)
  // The front-desk view is enough here: only dates, the reason, the derived
  // status and the appointment time are used (never plan notes).
  const view = order ? await getFollowUpView(order.id, 'frontdesk', istDateOf(now)) : null
  const liveAppointment = view?.appointment && (view.appointment.status === 'scheduled' || view.appointment.status === 'completed') ? view.appointment : null

  const signature = await getLatestSignatureForSignable('admission_discharge', admissionId)

  const src: DischargeSummarySource = {
    patient: row.patient,
    admission: { ...row.admission, dischargedAt: row.admission.dischargedAt },
    attending: row.attending,
    lastWard: lastTransfer?.ward ?? null,
    followUp: view
      ? {
          dueDate: view.dueDate,
          windowStart: view.windowStart,
          windowEnd: view.windowEnd,
          reason: view.reason,
          status: view.status,
          appointment: liveAppointment ? { startsAt: liveAppointment.startsAt } : null,
        }
      : null,
    signature: signature ? { signerTypedName: signature.signerTypedName, signedAt: signature.signedAt } : null,
  }
  return buildDischargeSummary(src, now, viewerRole)
}
