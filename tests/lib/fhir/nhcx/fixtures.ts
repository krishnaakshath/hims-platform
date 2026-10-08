import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { ClaimSnapshot, PayerRef, PreauthSnapshot, SnapshotHospital, SnapshotPatient, SnapshotPolicy } from '@/lib/rcm/snapshot'

const DIR = path.join(process.cwd(), 'tests', 'fixtures', 'nhcx')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJson = any
export const fixture = (name: string): AnyJson => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8'))
export const allFixtures = (): AnyJson[] => readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')))
export const clone = <T,>(v: T): AnyJson => JSON.parse(JSON.stringify(v))

export const PATIENT: SnapshotPatient = { id: 'RD-0001', uhid: 'UH000000427', name: 'Asha Rao', gender: 'female', dob: '1990-03-12', abhaNumber: null }
export const HOSPITAL: SnapshotHospital = { legalName: 'Test Hospital Pvt Ltd', gstin: '27AAAAA0000A1Z5', stateCode: 'IN-MH', rohiniId: '8900080123456', hfrId: 'IN2710000123' }
export const INSURER: PayerRef = { payerId: 11, name: 'Star Health', kind: 'insurer', irdaiRegistrationNo: '129', nhcxParticipantCode: 'INS1@sbx' }
export const TPA: PayerRef = { payerId: 12, name: 'Medi Assist TPA', kind: 'tpa', irdaiRegistrationNo: null, nhcxParticipantCode: 'TPA1@sbx' }
export const POLICY: SnapshotPolicy = {
  insurer: INSURER, tpa: TPA, policyNumber: 'POL-123', memberId: 'MEM-9', planName: 'Family Health Optima', policyType: 'family_floater',
  holderName: 'Asha Rao', relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 50_000_000, corporateName: null,
}


export const SNAP: ClaimSnapshot = {
  schemaVersion: 1,
  claim: { claimNumber: 'CLM-2026-000012', claimType: 'ipd', version: 1, kind: 'initial', preparedAt: '2026-10-08T06:00:00.000Z' },
  hospital: HOSPITAL, patient: PATIENT, policy: POLICY,
  episode: { admissionId: 5, encounterId: 9, startDate: '2026-10-01', endDate: '2026-10-05', lengthOfStayDays: 4, attendingName: 'Dr A', attendingRegistration: 'MMC-12345', departmentName: 'Cardiology' },
  preauth: { preauthNumber: 'PA-2026-000003', approvalReference: 'INS-PA-778', approvedPaise: 15_000_000, validUntil: '2026-11-01' },
  diagnoses: [
    { kind: 'icd10', code: 'I21.0', display: 'Acute transmural myocardial infarction of anterior wall', version: '2019', sequence: 1, type: 'primary' },
    { kind: 'icd10', code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', version: '2019', sequence: 2, type: 'secondary' },
  ],
  procedures: [{ kind: 'snomed', code: '418285008', display: 'Angioplasty of blood vessel', version: '20250131', sequence: 1, performedOn: '2026-10-02' }],
  dischargeSummary: null,
  invoices: [{ number: 'INV-1', date: '2026-10-05', totalPaise: 20_000_000, claimedPaise: 18_000_000 }],
  items: [
    { sequence: 1, invoiceNumber: 'INV-1', lineNo: 1, itemCode: 'SVC-ANGIO', itemName: 'Coronary angioplasty', hsnSac: '999311', serviceDate: '2026-10-02', quantity: 1, unitPricePaise: 15_000_000, taxablePaise: 15_000_000, taxPaise: 0, totalPaise: 15_000_000 },
    { sequence: 2, invoiceNumber: 'INV-1', lineNo: 2, itemCode: 'ROOM-ICU', itemName: 'ICU bed day', hsnSac: '999311', serviceDate: '2026-10-01', quantity: 3, unitPricePaise: 1_000_000, taxablePaise: 3_000_000, taxPaise: 0, totalPaise: 3_000_000 },
  ],
  totals: { billedPaise: 20_000_000, claimedPaise: 18_000_000 },
  documents: [
    { kind: 'discharge_summary', source: 'upload', title: 'Discharge summary', contentType: 'application/pdf', sha256: 'a'.repeat(64), waived: false },
    { kind: 'investigation_reports', source: 'upload', title: 'ECG', contentType: 'application/pdf', sha256: 'b'.repeat(64), waived: false },
    { kind: 'claim_form', source: 'upload', title: 'Claim form', contentType: null, sha256: null, waived: true },
  ],
  coverNote: null,
  codingFingerprint: 'f'.repeat(64),
}

export const PRE: PreauthSnapshot = {
  schemaVersion: 1, preauthNumber: 'PA-2026-000003', kind: 'initial', preparedAt: '2026-09-30T06:00:00.000Z',
  hospital: HOSPITAL, patient: PATIENT, policy: POLICY, claimType: 'ipd', plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 4,
  treatingDoctorName: 'Dr A',
  diagnoses: [{ kind: 'icd10', code: 'I21.0', display: 'Acute transmural myocardial infarction of anterior wall', version: '2019' }],
  procedures: [{ kind: 'snomed', code: '418285008', display: 'Angioplasty of blood vessel', version: '20250131' }],
  provisionalDiagnosisText: null,
  estimate: [{ serviceId: 3, code: 'SVC-ANGIO', name: 'Coronary angioplasty', quantity: 1, unitPricePaise: 15_000_000, amountPaise: 15_000_000, priceSource: 'tariff' }],
  estimatedPaise: 15_000_000, requestedPaise: 15_000_000,
}

export const CTX = { created: new Date('2026-10-08T06:02:26.605Z'), practitioner: { name: 'Dr A', registrationNumber: 'MMC-12345' } }
