// WS3 T3: what the admission dialog needs for one patient (spec 3.1): the free beds with their
// ward-gender conflict and room tariff, the patient's payer choices, today's open OPD visit, an
// active stay, and the deposit hint. Read-only; POST /api/inpatient/admissions re-checks all of it.
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, encounters, patientPolicies, patients, payers, preauths, providers, roomCategories, rooms } from '@/db/schema'
import { ageOnDate, istDateOf } from '@/lib/india-time'
import { wardGenderConflict, type PatientGender, type WardGender, type WardGenderConflict } from '@/lib/inpatient/admission-rules'
import { resolvePrice } from '@/lib/tariff/resolve'
import { getBillingSettings } from './billing-settings'
import { loadPricingContext } from './tariff'

export interface AdmissionFormContext {
  patient: { id: string; name: string; uhid: string | null; gender: PatientGender; ageYears: number }
  beds: { id: number; label: string; ward: string; genderRestriction: WardGender; roomCategoryName: string | null; tariffPaise: number | null; conflict: WardGenderConflict | null }[]
  policies: { id: number; label: string; insurerName: string; validTo: string }[]
  // `policyId` (beyond the plan's shape): a pre-auth is usable only with its own policy as the payer.
  preauths: { id: number; preauthNumber: string; status: string; approvedPaise: number | null; policyId: number }[]
  openOpdEncounter: { id: number; opdToken: number | null; providerName: string } | null
  activeAdmissionId: number | null
  depositThresholdPaise: number
}

// A pre-auth that can still back a stay (rejected and cancelled ones cannot).
const CLOSED_PREAUTH = ['rejected', 'cancelled'] as const
const OPEN_OPD_STATUSES = ['checked_in', 'in_consultation'] as const

/** `patientRef` is the chart id or a UHID (case-insensitive; an exact chart-id match wins). Null when unknown. */
export async function loadAdmissionFormContext(patientRef: string, now: Date = new Date()): Promise<AdmissionFormContext | null> {
  const db = getDb()
  const today = istDateOf(now)
  const found = await db.select({ id: patients.id, name: patients.name, uhid: patients.uhid, gender: patients.gender, dob: patients.dob })
    .from(patients).where(or(eq(patients.id, patientRef), sql`upper(${patients.uhid}) = upper(${patientRef})`))
  const p = found.find((r) => r.id === patientRef) ?? found[0]
  if (!p) return null
  const patient = { id: p.id, name: p.name, uhid: p.uhid ?? null, gender: (p.gender ?? null) as PatientGender, ageYears: ageOnDate(p.dob, today) }

  const [settings, bedRows, policyRows, preauthRows, openOpd, active] = await Promise.all([
    getBillingSettings(),
    db.select({
      id: rooms.id, ward: rooms.ward, roomNumber: rooms.roomNumber, bedNumber: rooms.bedNumber, genderRestriction: rooms.genderRestriction,
      categoryCode: roomCategories.code, categoryName: roomCategories.name,
    }).from(rooms).leftJoin(roomCategories, eq(roomCategories.id, rooms.roomCategoryId))
      .where(eq(rooms.status, 'available')).orderBy(asc(rooms.ward), asc(rooms.roomNumber), asc(rooms.bedNumber), asc(rooms.id)),
    db.select({ id: patientPolicies.id, policyNumber: patientPolicies.policyNumber, planName: patientPolicies.planName, validTo: patientPolicies.validTo, insurerName: payers.name })
      .from(patientPolicies).innerJoin(payers, eq(payers.id, patientPolicies.insurerPayerId))
      .where(and(eq(patientPolicies.patientId, patient.id), eq(patientPolicies.status, 'active'), lte(patientPolicies.validFrom, today), gte(patientPolicies.validTo, today)))
      .orderBy(asc(patientPolicies.priority), asc(patientPolicies.id)),
    db.select({ id: preauths.id, preauthNumber: preauths.preauthNumber, status: preauths.status, approvedPaise: preauths.approvedPaise, policyId: preauths.policyId })
      .from(preauths)
      .where(and(eq(preauths.patientId, patient.id), isNull(preauths.admissionId), notInArray(preauths.status, [...CLOSED_PREAUTH])))
      .orderBy(asc(preauths.id)),
    db.select({ id: encounters.id, opdToken: encounters.opdToken, providerName: providers.name })
      .from(encounters).leftJoin(providers, eq(providers.id, encounters.providerId))
      .where(and(eq(encounters.patientId, patient.id), eq(encounters.encounterType, 'opd'), eq(encounters.encounterDate, today), inArray(encounters.status, [...OPEN_OPD_STATUSES])))
      .orderBy(asc(encounters.id)).limit(1),
    db.select({ id: admissions.id }).from(admissions).where(and(eq(admissions.patientId, patient.id), eq(admissions.status, 'admitted'))).limit(1),
  ])

  // The room tariff: the ROOM_RENT service's base/department rate for the bed's category and ward
  // (the payer is not chosen yet, so no payer-specific rate).
  const serviceId = settings.roomRentServiceId
  const pricing = serviceId === null ? null : await loadPricingContext(serviceId)
  const tariffOf = (ward: string, categoryCode: string | null): number | null => {
    if (serviceId === null || !pricing) return null
    const r = resolvePrice({ serviceId, roomCategory: categoryCode ?? undefined, ward, onDate: today }, pricing)
    return r.ok ? r.amountPaise : null
  }

  return {
    patient,
    beds: bedRows.map((b) => {
      const genderRestriction = (b.genderRestriction ?? null) as WardGender
      return {
        id: b.id, label: `${b.ward} ${b.roomNumber}-${b.bedNumber}`, ward: b.ward, genderRestriction,
        roomCategoryName: b.categoryName ?? null, tariffPaise: tariffOf(b.ward, b.categoryCode ?? null),
        conflict: wardGenderConflict({ patientGender: patient.gender, ageYears: patient.ageYears, ward: genderRestriction }),
      }
    }),
    policies: policyRows.map((r) => ({
      id: r.id, label: `${r.insurerName}${r.planName ? ` ${r.planName}` : ''} (${r.policyNumber})`, insurerName: r.insurerName, validTo: r.validTo,
    })),
    preauths: preauthRows.map((r) => ({ id: r.id, preauthNumber: r.preauthNumber, status: r.status, approvedPaise: r.approvedPaise ?? null, policyId: r.policyId })),
    openOpdEncounter: openOpd[0] ? { id: openOpd[0].id, opdToken: openOpd[0].opdToken ?? null, providerName: openOpd[0].providerName ?? 'the doctor' } : null,
    activeAdmissionId: active[0]?.id ?? null,
    depositThresholdPaise: settings.ipdDepositThresholdPaise,
  }
}
