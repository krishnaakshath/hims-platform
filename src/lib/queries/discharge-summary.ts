import { and, asc, desc, eq, gte, inArray, lte, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, admissionTransfers, codes, departments, diagnoses, encounters, followUpOrders, labOrders, labResults, labTests,
  medicationAdministrations, patients, providers, rooms,
} from '@/db/schema'
import type { Role } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { liveDiagnosis } from './diagnoses'
import { istDateOf } from '@/lib/india-time'
import { buildDischargeSummary, type DischargeRecord, type DischargeSummaryData, type DischargeSummarySource } from '@/lib/encounters/discharge-summary'
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

  // Wave F P1-13: the clinical record is read only for a clinical viewer.
  const record = viewerRole !== null && CLINICAL_ROLES.includes(viewerRole)
    ? await loadDischargeRecord(admissionId, row.patient.id, row.admission.admittedAt, row.admission.dischargedAt)
    : null

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
    record,
  }
  return buildDischargeSummary(src, now, viewerRole)
}

// Lab orders whose result is final enough to print on a discharge summary.
const FINAL_LAB_STATUSES = ['verified', 'reported'] as const

/**
 * Wave F P1-13: the admission's clinical record for the printed summary.
 * - Diagnoses: the live (non-voided) SP6 diagnoses of this admission's IPD
 *   encounter(s), primary first, with the code value from `codes` when coded
 *   or proposed.
 * - Medicines: the MAR for this admission, one row per name + dose with the
 *   number of doses given and the first/last given instants.
 * - Labs: results of tests ordered during the stay (admitted..discharged)
 *   that are verified or reported; other non-cancelled orders in the stay
 *   are counted as not final.
 */
async function loadDischargeRecord(admissionId: number, patientId: string, admittedAt: Date, dischargedAt: Date): Promise<DischargeRecord<Date>> {
  const db = getDb()
  const encounterIds = (await db.select({ id: encounters.id }).from(encounters).where(eq(encounters.admissionId, admissionId))).map((e) => e.id)

  const dx = encounterIds.length
    ? await db
      .select({
        code: codes.code,
        system: diagnoses.codeSystemKind,
        codeDisplay: diagnoses.codeDisplay,
        description: diagnoses.description,
        type: diagnoses.diagnosisType,
        codingStatus: diagnoses.codingStatus,
      })
      .from(diagnoses)
      .leftJoin(codes, eq(codes.id, diagnoses.codeId))
      .where(and(inArray(diagnoses.encounterId, encounterIds), liveDiagnosis))
      .orderBy(
        sql`case ${diagnoses.diagnosisType} when 'primary' then 0 when 'secondary' then 1 when 'provisional' then 2 else 3 end`,
        sql`${diagnoses.sequence} asc nulls last`,
        asc(diagnoses.id),
      )
    : []

  const meds = await db
    .select({
      name: medicationAdministrations.medicationName,
      dose: medicationAdministrations.dose,
      given: sql<number>`count(*) filter (where ${medicationAdministrations.status} = 'given')::int`,
      firstGivenAt: sql<Date | null>`min(${medicationAdministrations.administeredAt}) filter (where ${medicationAdministrations.status} = 'given')`,
      lastGivenAt: sql<Date | null>`max(${medicationAdministrations.administeredAt}) filter (where ${medicationAdministrations.status} = 'given')`,
    })
    .from(medicationAdministrations)
    .where(eq(medicationAdministrations.admissionId, admissionId))
    .groupBy(medicationAdministrations.medicationName, medicationAdministrations.dose)
    .orderBy(asc(medicationAdministrations.medicationName), asc(medicationAdministrations.dose))

  const inStay = and(eq(labOrders.patientId, patientId), gte(labOrders.orderedAt, admittedAt), lte(labOrders.orderedAt, dischargedAt))
  const labs = await db
    .select({
      testName: labTests.name,
      testCode: labTests.code,
      value: labResults.value,
      unit: labResults.unit,
      referenceRange: labResults.referenceRange,
      flag: labResults.flag,
      resultedAt: labResults.resultedAt,
    })
    .from(labOrders)
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .innerJoin(labResults, eq(labResults.labOrderId, labOrders.id))
    .where(and(inStay, inArray(labOrders.status, [...FINAL_LAB_STATUSES])))
    .orderBy(asc(labResults.resultedAt), asc(labOrders.id))
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(labOrders)
    .where(and(inStay, notInArray(labOrders.status, [...FINAL_LAB_STATUSES, 'cancelled'])))

  return {
    diagnoses: dx.map((d) => ({
      code: d.code ?? null,
      system: d.code ? d.system : null,
      description: d.codeDisplay ?? d.description,
      type: d.type,
      codingStatus: d.codingStatus,
    })),
    medications: meds.map((m) => ({
      name: m.name,
      dose: m.dose,
      given: Number(m.given),
      firstGivenAt: m.firstGivenAt ? new Date(m.firstGivenAt) : null,
      lastGivenAt: m.lastGivenAt ? new Date(m.lastGivenAt) : null,
    })),
    labs: labs.map((l) => ({ ...l })),
    labsNotFinal: Number(pending?.n ?? 0),
  }
}
