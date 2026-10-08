// SP3: the discharge-summary data shape and its pure builder. The PDF itself is
// deferred to the documents work (spec §3 "Documents"); this is the data a
// later renderer consumes. Every field is projected explicitly: no source row
// is spread into the output, and there is no Aadhaar field of any kind.
import { brand } from '@/lib/brand'
import type { Role } from '@/lib/auth'
import { formatAbhaNumber } from '@/lib/india/abha'
import { formatDoctorRegistration } from '@/lib/india/registration'
import { GENDERS, stateName } from '@/lib/india/reference'
import { ageOnDate, istDateOf } from '@/lib/india-time'
import { daysBetweenIso, type FollowUpStatus } from '@/lib/follow-ups/rules'
import { CLINICAL_ROLES } from '@/lib/role-policy'

export interface DischargeSummaryData {
  hospitalName: string
  timezone: 'Asia/Kolkata'
  generatedAt: string // ISO instant
  patient: { id: string; uhid: string | null; name: string; ageYears: number; gender: string | null; abhaNumber: string | null; abhaAddress: string | null; address: string | null; isMlc: boolean; mlcNumber: string | null }
  admission: { id: number; admissionType: 'elective' | 'emergency' | 'transfer_in'; admittedOn: string; dischargedOn: string; lengthOfStayDays: number; lastWard: string | null }
  attending: { providerId: number; name: string; registration: string | null; departmentName: string | null }
  /** Null for roles outside CLINICAL_ROLES (e.g. the front desk). */
  clinical: { diagnosis: string; drugs: string; devices: string; diet: string; notes: string } | null
  followUp: { dueDate: string; windowStart: string; windowEnd: string; reason: string; status: FollowUpStatus; appointmentStartsAt: string | null } | null
  signature: { signerTypedName: string; signedAt: string } | null
}

/** The raw inputs, each already reduced to named columns by the loader. */
export interface DischargeSummarySource {
  patient: {
    id: string; uhid: string | null; name: string; dob: string; gender: string | null
    abhaNumber: string | null; abhaAddress: string | null
    addressLine1: string | null; addressLine2: string | null; city: string | null; district: string | null; stateCode: string | null; pinCode: string | null
    isMlc: boolean; mlcNumber: string | null
  }
  admission: {
    id: number; admissionType: 'elective' | 'emergency' | 'transfer_in'; status: 'admitted' | 'discharged'
    admittedAt: Date; dischargedAt: Date
    dischargeDiagnosis: string | null; dischargeDrugs: string | null; dischargeDevices: string | null; dischargeDiet: string | null; dischargeSummaryNotes: string | null
  }
  attending: {
    providerId: number; name: string
    registrationCouncil: 'nmc' | 'smc' | null; registrationStateCode: string | null; registrationNumber: string | null
    departmentName: string | null
  }
  /** The ward of the last transfer, or null when the admission never moved bed through a transfer. */
  lastWard: string | null
  /** The newest `discharge` follow-up of this admission, as the derived view. */
  followUp: { dueDate: string; windowStart: string; windowEnd: string; reason: string; status: FollowUpStatus; appointment: { startsAt: Date } | null } | null
  signature: { signerTypedName: string; signedAt: Date } | null
}

const GENDER_LABEL = new Map<string, string>(GENDERS.map((g) => [g.code, g.label]))


function registration(a: DischargeSummarySource['attending']): string | null {
  return formatDoctorRegistration(a)
}

function address(p: DischargeSummarySource['patient']): string | null {
  const state = p.stateCode ? stateName(p.stateCode) : null
  const tail = [state, p.pinCode].filter((x): x is string => Boolean(x && x.trim())).join(' ')
  const parts = [p.addressLine1, p.addressLine2, p.city, p.district, tail].filter((x): x is string => Boolean(x && x.trim()))
  return parts.length ? parts.join(', ') : null
}

/**
 * Pure. `viewerRole` decides the clinical content: the five Ds and the ABHA
 * identifiers are included only for CLINICAL_ROLES. Without a role (the
 * default) the document carries no clinical sections, so a caller has to opt in.
 */
export function buildDischargeSummary(src: DischargeSummarySource, now: Date, viewerRole: Role | null = null): DischargeSummaryData {
  const clinicalViewer = viewerRole !== null && CLINICAL_ROLES.includes(viewerRole)
  const { patient: p, admission: a, attending: doc, followUp: f, signature: s } = src
  const admittedOn = istDateOf(a.admittedAt)
  const dischargedOn = istDateOf(a.dischargedAt)

  return {
    hospitalName: brand.legalName,
    timezone: 'Asia/Kolkata',
    generatedAt: now.toISOString(),
    patient: {
      id: p.id,
      uhid: p.uhid,
      name: p.name,
      ageYears: ageOnDate(p.dob, dischargedOn),
      gender: p.gender ? (GENDER_LABEL.get(p.gender) ?? p.gender) : null,
      // The full number: this is a staff clinical document.
      abhaNumber: clinicalViewer && p.abhaNumber ? formatAbhaNumber(p.abhaNumber) : null,
      abhaAddress: clinicalViewer ? p.abhaAddress : null,
      address: address(p),
      isMlc: p.isMlc,
      // The MLC number is a medico-legal identifier: clinical roles only (the isMlc flag stays).
      mlcNumber: clinicalViewer ? p.mlcNumber : null,
    },
    admission: {
      id: a.id,
      admissionType: a.admissionType,
      admittedOn,
      dischargedOn,
      lengthOfStayDays: Math.max(1, daysBetweenIso(admittedOn, dischargedOn)),
      lastWard: src.lastWard,
    },
    attending: { providerId: doc.providerId, name: doc.name, registration: registration(doc), departmentName: doc.departmentName },
    clinical: clinicalViewer
      ? {
          diagnosis: a.dischargeDiagnosis ?? '',
          drugs: a.dischargeDrugs ?? '',
          devices: a.dischargeDevices ?? '',
          diet: a.dischargeDiet ?? '',
          notes: a.dischargeSummaryNotes ?? '',
        }
      : null,
    followUp: f
      ? {
          dueDate: f.dueDate,
          windowStart: f.windowStart,
          windowEnd: f.windowEnd,
          reason: f.reason,
          status: f.status,
          appointmentStartsAt: f.appointment ? f.appointment.startsAt.toISOString() : null,
        }
      : null,
    signature: s ? { signerTypedName: s.signerTypedName, signedAt: s.signedAt.toISOString() } : null,
  }
}
