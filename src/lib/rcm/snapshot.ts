// SP7 claim and pre-authorisation snapshots (pure, client-safe) and canonical JSON.
//
// A snapshot is the frozen content of one outbound package (ruling 3). Every builder picks
// its fields explicitly, so a wider source object can never leak a contact, address or
// identity field into a snapshot, a PDF or a hash. Patient identity is limited to id,
// UHID, name, gender, date of birth and (only when the payer requires it) ABHA.
//
// SP8 mapping (no schema change needed):
//   ClaimSnapshot   -> FHIR R4 Claim (use = claim)
//   PreauthSnapshot -> FHIR R4 Claim (use = preauthorization)
//   patient                       -> Patient
//   policy                        -> Coverage (subscriberId = memberId; payor = insurer/TPA
//                                    Organization by nhcxParticipantCode)
//   hospital                      -> provider Organization (ROHINI / HFR identifiers)
//   diagnoses                     -> Claim.diagnosis
//   procedures                    -> Claim.procedure
//   items                         -> Claim.item (unitPrice / net in INR from paise)
//   totals.claimedPaise           -> Claim.total
//   preauth.approvalReference     -> Claim.insurance.preAuthRef
//   documents                     -> Claim.supportingInfo (attachment hash = sha256)
import { formatAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import { sumPaise } from '@/lib/billing/amounts'
import type { CodeSystemKind } from '@/lib/coding/code-systems'
import type { DischargeSummaryData } from '@/lib/encounters/discharge-summary'
import type { ClaimDocumentKind, ClaimType, DocumentSource, PayerKind, PolicyRelationship, PolicyType, SubmissionKind } from './constants'

export const CLAIM_SNAPSHOT_SCHEMA_VERSION = 1

export interface CodedEntry { kind: CodeSystemKind; code: string; display: string; version: string | null }
export interface SnapshotDiagnosis extends CodedEntry { sequence: number; type: 'primary' | 'secondary' | 'provisional' }
export interface SnapshotProcedure extends CodedEntry { sequence: number; performedOn: string }
export interface SnapshotItem {
  sequence: number; invoiceNumber: string; lineNo: number; itemCode: string; itemName: string; hsnSac: string; serviceDate: string
  quantity: number; unitPricePaise: number; taxablePaise: number; taxPaise: number; totalPaise: number
}
export interface SnapshotDocument { kind: ClaimDocumentKind; source: DocumentSource; title: string; contentType: string | null; sha256: string | null; waived: boolean }
export interface PayerRef { payerId: number; name: string; kind: PayerKind; irdaiRegistrationNo: string | null; nhcxParticipantCode: string | null }

export interface SnapshotHospital { legalName: string; gstin: string | null; stateCode: string | null; rohiniId: string | null; hfrId: string | null }
export interface SnapshotPatient { id: string; uhid: string | null; name: string; gender: string | null; dob: string | null; abhaNumber: string | null }
export interface SnapshotPolicy {
  insurer: PayerRef; tpa: PayerRef | null; policyNumber: string; memberId: string; planName: string | null; policyType: PolicyType
  holderName: string; relationship: PolicyRelationship; validFrom: string; validTo: string; sumInsuredPaise: number | null; corporateName: string | null
}
export interface SnapshotEpisode {
  admissionId: number | null; encounterId: number | null; startDate: string; endDate: string | null; lengthOfStayDays: number | null
  attendingName: string | null; attendingRegistration: string | null; departmentName: string | null
}
export interface SnapshotPreauth { preauthNumber: string; approvalReference: string | null; approvedPaise: number | null; validUntil: string | null }
export interface SnapshotInvoice { number: string; date: string; totalPaise: number; claimedPaise: number }

export interface ClaimSnapshot {
  schemaVersion: 1
  claim: { claimNumber: string; claimType: ClaimType; version: number; kind: SubmissionKind; preparedAt: string }
  hospital: SnapshotHospital
  patient: SnapshotPatient
  policy: SnapshotPolicy
  episode: SnapshotEpisode
  preauth: SnapshotPreauth | null
  diagnoses: SnapshotDiagnosis[]
  procedures: SnapshotProcedure[]
  dischargeSummary: { diagnosis: string; notes: string; drugs: string; devices: string; diet: string; followUpDue: string | null } | null
  invoices: SnapshotInvoice[]
  items: SnapshotItem[]
  totals: { billedPaise: number; claimedPaise: number }
  documents: SnapshotDocument[]
  coverNote: string | null
  codingFingerprint: string
}

type SourcePatient = { id: string; uhid: string | null; name: string; gender: string | null; dob: string | null }

export interface ClaimSnapshotSource {
  claim: ClaimSnapshot['claim']
  hospital: SnapshotHospital
  patient: SourcePatient
  includeAbha: boolean
  patientAbhaNumber: string | null
  policy: SnapshotPolicy
  episode: SnapshotEpisode
  preauth: SnapshotPreauth | null
  diagnoses: SnapshotDiagnosis[]
  procedures: SnapshotProcedure[]
  discharge: Pick<DischargeSummaryData, 'clinical' | 'followUp'> | DischargeSummaryData | null
  invoices: SnapshotInvoice[]
  /** Items without a sequence; numbered here in invoice order, then line order. */
  items: Omit<SnapshotItem, 'sequence'>[]
  documents: SnapshotDocument[]
  coverNote: string | null
  codingFingerprint: string
}

const pickHospital = (h: SnapshotHospital): SnapshotHospital => ({ legalName: h.legalName, gstin: h.gstin, stateCode: h.stateCode, rohiniId: h.rohiniId, hfrId: h.hfrId })
const pickPayer = (p: PayerRef): PayerRef => ({ payerId: p.payerId, name: p.name, kind: p.kind, irdaiRegistrationNo: p.irdaiRegistrationNo, nhcxParticipantCode: p.nhcxParticipantCode })
const pickPolicy = (p: SnapshotPolicy): SnapshotPolicy => ({
  insurer: pickPayer(p.insurer), tpa: p.tpa ? pickPayer(p.tpa) : null, policyNumber: p.policyNumber, memberId: p.memberId, planName: p.planName,
  policyType: p.policyType, holderName: p.holderName, relationship: p.relationship, validFrom: p.validFrom, validTo: p.validTo,
  sumInsuredPaise: p.sumInsuredPaise, corporateName: p.corporateName,
})
const pickCoded = (c: CodedEntry): CodedEntry => ({ kind: c.kind, code: c.code, display: c.display, version: c.version })

function pickPatient(p: SourcePatient, includeAbha: boolean, abha: string | null): SnapshotPatient {
  const digits = includeAbha && abha ? normalizeAbhaNumber(abha) : null
  return { id: p.id, uhid: p.uhid, name: p.name, gender: p.gender, dob: p.dob, abhaNumber: digits ? formatAbhaNumber(digits) : null }
}

const DX_TYPE_ORDER = { primary: 0, secondary: 1, provisional: 2 } as const
const byCode = (a: CodedEntry, b: CodedEntry) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

export function buildClaimSnapshot(src: ClaimSnapshotSource): ClaimSnapshot {
  const diagnoses = src.diagnoses
    .map((d): SnapshotDiagnosis => ({ ...pickCoded(d), sequence: d.sequence, type: d.type }))
    .sort((a, b) => (a.type === 'primary' ? 0 : 1) - (b.type === 'primary' ? 0 : 1) || a.sequence - b.sequence || DX_TYPE_ORDER[a.type] - DX_TYPE_ORDER[b.type] || byCode(a, b))
  const procedures = src.procedures
    .map((p): SnapshotProcedure => ({ ...pickCoded(p), sequence: p.sequence, performedOn: p.performedOn }))
    .sort((a, b) => a.sequence - b.sequence || (a.performedOn < b.performedOn ? -1 : a.performedOn > b.performedOn ? 1 : 0) || byCode(a, b))
  const invoiceOrder = new Map(src.invoices.map((inv, idx) => [inv.number, idx]))
  const items = [...src.items]
    .sort((a, b) => (invoiceOrder.get(a.invoiceNumber) ?? Number.MAX_SAFE_INTEGER) - (invoiceOrder.get(b.invoiceNumber) ?? Number.MAX_SAFE_INTEGER) || a.lineNo - b.lineNo)
    .map((i, idx): SnapshotItem => ({
      sequence: idx + 1, invoiceNumber: i.invoiceNumber, lineNo: i.lineNo, itemCode: i.itemCode, itemName: i.itemName, hsnSac: i.hsnSac,
      serviceDate: i.serviceDate, quantity: i.quantity, unitPricePaise: i.unitPricePaise, taxablePaise: i.taxablePaise, taxPaise: i.taxPaise, totalPaise: i.totalPaise,
    }))
  const invoices = src.invoices.map((i): SnapshotInvoice => ({ number: i.number, date: i.date, totalPaise: i.totalPaise, claimedPaise: i.claimedPaise }))
  const clinical = src.discharge?.clinical ?? null
  const e = src.episode
  return {
    schemaVersion: CLAIM_SNAPSHOT_SCHEMA_VERSION,
    claim: { claimNumber: src.claim.claimNumber, claimType: src.claim.claimType, version: src.claim.version, kind: src.claim.kind, preparedAt: src.claim.preparedAt },
    hospital: pickHospital(src.hospital),
    patient: pickPatient(src.patient, src.includeAbha, src.patientAbhaNumber),
    policy: pickPolicy(src.policy),
    episode: {
      admissionId: e.admissionId, encounterId: e.encounterId, startDate: e.startDate, endDate: e.endDate, lengthOfStayDays: e.lengthOfStayDays,
      attendingName: e.attendingName, attendingRegistration: e.attendingRegistration, departmentName: e.departmentName,
    },
    preauth: src.preauth
      ? { preauthNumber: src.preauth.preauthNumber, approvalReference: src.preauth.approvalReference, approvedPaise: src.preauth.approvedPaise, validUntil: src.preauth.validUntil }
      : null,
    diagnoses,
    procedures,
    dischargeSummary: clinical
      ? { diagnosis: clinical.diagnosis, notes: clinical.notes, drugs: clinical.drugs, devices: clinical.devices, diet: clinical.diet, followUpDue: src.discharge?.followUp?.dueDate ?? null }
      : null,
    invoices,
    items,
    totals: { billedPaise: sumPaise(invoices.map((i) => i.totalPaise)), claimedPaise: sumPaise(invoices.map((i) => i.claimedPaise)) },
    documents: src.documents.map((d) => ({ kind: d.kind, source: d.source, title: d.title, contentType: d.contentType, sha256: d.sha256, waived: d.waived })),
    coverNote: src.coverNote,
    codingFingerprint: src.codingFingerprint,
  }
}

export interface EstimateLine { serviceId: number; code: string; name: string; quantity: number; unitPricePaise: number; amountPaise: number; priceSource: string }

export interface PreauthSnapshot {
  schemaVersion: 1
  preauthNumber: string
  kind: 'initial' | 'enhancement'
  preparedAt: string
  hospital: SnapshotHospital
  patient: SnapshotPatient
  policy: SnapshotPolicy
  claimType: ClaimType
  plannedAdmissionDate: string
  expectedLengthOfStayDays: number
  treatingDoctorName: string
  diagnoses: CodedEntry[]
  procedures: CodedEntry[]
  provisionalDiagnosisText: string | null
  estimate: EstimateLine[]
  estimatedPaise: number
  requestedPaise: number
}

export interface PreauthSnapshotSource extends Omit<PreauthSnapshot, 'schemaVersion' | 'patient'> {
  patient: SourcePatient
  includeAbha: boolean
  patientAbhaNumber: string | null
}

export function buildPreauthSnapshot(src: PreauthSnapshotSource): PreauthSnapshot {
  return {
    schemaVersion: CLAIM_SNAPSHOT_SCHEMA_VERSION,
    preauthNumber: src.preauthNumber,
    kind: src.kind,
    preparedAt: src.preparedAt,
    hospital: pickHospital(src.hospital),
    patient: pickPatient(src.patient, src.includeAbha, src.patientAbhaNumber),
    policy: pickPolicy(src.policy),
    claimType: src.claimType,
    plannedAdmissionDate: src.plannedAdmissionDate,
    expectedLengthOfStayDays: src.expectedLengthOfStayDays,
    treatingDoctorName: src.treatingDoctorName,
    diagnoses: src.diagnoses.map(pickCoded),
    procedures: src.procedures.map(pickCoded),
    provisionalDiagnosisText: src.provisionalDiagnosisText,
    estimate: src.estimate.map((l) => ({ serviceId: l.serviceId, code: l.code, name: l.name, quantity: l.quantity, unitPricePaise: l.unitPricePaise, amountPaise: l.amountPaise, priceSource: l.priceSource })),
    estimatedPaise: src.estimatedPaise,
    requestedPaise: src.requestedPaise,
  }
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays in order, no whitespace. Only
 * JSON-safe values are accepted, so the same snapshot always hashes the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: numbers must be finite')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects are allowed')
      const obj = value as Record<string, unknown>
      return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not allowed`)
  }
}

/** The order-independent source of the coding fingerprint (hashed by the caller). */
export function codingFingerprintSource(dx: SnapshotDiagnosis[], px: SnapshotProcedure[]): string {
  return canonicalJson([
    dx.map((d) => `${d.kind}:${d.code}:${d.type}`).sort(),
    px.map((p) => `${p.kind}:${p.code}:${p.performedOn}`).sort(),
  ])
}
