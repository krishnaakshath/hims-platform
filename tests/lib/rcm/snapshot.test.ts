import { describe, it, expect } from 'vitest'
import {
  canonicalJson, buildClaimSnapshot, buildPreauthSnapshot, codingFingerprintSource,
  type ClaimSnapshotSource, type SnapshotDiagnosis, type SnapshotProcedure,
} from '@/lib/rcm/snapshot'

const DX: SnapshotDiagnosis[] = [
  { kind: 'icd10', code: 'E11.9', display: 'Type 2 diabetes', version: '2019', sequence: 2, type: 'secondary' },
  { kind: 'icd10', code: 'K35.8', display: 'Acute appendicitis', version: '2019', sequence: 1, type: 'primary' },
]
const PX: SnapshotProcedure[] = [{ kind: 'icd10pcs', code: '0DTJ4ZZ', display: 'Laparoscopic appendicectomy', version: '2024', sequence: 1, performedOn: '2026-10-02' }]
const POLICY = {
  insurer: { payerId: 1, name: 'Test Insurer', kind: 'insurer' as const, irdaiRegistrationNo: '123', nhcxParticipantCode: null },
  tpa: { payerId: 2, name: 'Test TPA', kind: 'tpa' as const, irdaiRegistrationNo: null, nhcxParticipantCode: 'TPA-1' },
  policyNumber: 'POL/1', memberId: 'M-1', planName: 'Gold', policyType: 'individual' as const, holderName: 'Asha', relationship: 'self' as const,
  validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 5_00_000_00, corporateName: null,
}
const HOSPITAL = { legalName: 'Test Hospital', gstin: null, stateCode: '29', rohiniId: '8900080123456', hfrId: null }
const SRC: ClaimSnapshotSource = {
  claim: { claimNumber: 'CLM-2099-000001', claimType: 'ipd', version: 1, kind: 'initial', preparedAt: '2099-06-01T06:00:00.000Z' },
  hospital: HOSPITAL,
  patient: { id: 'P-1', uhid: 'UH1', name: 'Asha Rao', gender: 'female', dob: '1980-01-01' },
  includeAbha: false,
  patientAbhaNumber: '91123456789012',
  policy: POLICY,
  episode: { admissionId: 3, encounterId: 4, startDate: '2026-10-01', endDate: '2026-10-04', lengthOfStayDays: 3, attendingName: 'Dr X', attendingRegistration: null, departmentName: 'Surgery' },
  preauth: { preauthNumber: 'PA-2099-000001', approvalReference: 'AR/1', approvedPaise: 80_000_00, validUntil: '2026-10-31' },
  diagnoses: DX,
  procedures: PX,
  discharge: null,
  invoices: [
    { number: 'INV/1', date: '2099-06-01', totalPaise: 60_000_00, claimedPaise: 60_000_00 },
    { number: 'INV/2', date: '2099-06-01', totalPaise: 40_000_00, claimedPaise: 30_000_00 },
  ],
  items: [
    { invoiceNumber: 'INV/2', lineNo: 1, itemCode: 'S3', itemName: 'Pharmacy', hsnSac: '3004', serviceDate: '2026-10-02', quantity: 1, unitPricePaise: 40_000_00, taxablePaise: 40_000_00, taxPaise: 0, totalPaise: 40_000_00 },
    { invoiceNumber: 'INV/1', lineNo: 2, itemCode: 'S2', itemName: 'Room', hsnSac: '9993', serviceDate: '2026-10-01', quantity: 3, unitPricePaise: 10_000_00, taxablePaise: 30_000_00, taxPaise: 0, totalPaise: 30_000_00 },
    { invoiceNumber: 'INV/1', lineNo: 1, itemCode: 'S1', itemName: 'Surgery', hsnSac: '9993', serviceDate: '2026-10-02', quantity: 1, unitPricePaise: 30_000_00, taxablePaise: 30_000_00, taxPaise: 0, totalPaise: 30_000_00 },
  ],
  documents: [{ kind: 'itemised_bill', source: 'invoice', title: 'INV/1', contentType: null, sha256: null, waived: false }],
  coverNote: null,
  codingFingerprint: 'abc',
}

describe('snapshots', () => {
  it('canonical JSON is key-order independent and refuses undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 })); expect(() => canonicalJson({ a: undefined })).toThrow(TypeError)
    expect(() => canonicalJson({ a: NaN })).toThrow(TypeError); expect(() => canonicalJson({ a: BigInt(1) })).toThrow(TypeError)
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError); expect(() => canonicalJson({ a: new Date() })).toThrow(TypeError)
    expect(canonicalJson(['x', 'é', true])).toBe('["x","é",true]')
  })
  it('ABHA only when the payer requires it', () => {
    expect(buildClaimSnapshot({ ...SRC, includeAbha: false }).patient.abhaNumber).toBeNull()
    expect(buildClaimSnapshot({ ...SRC, includeAbha: true }).patient.abhaNumber).toBe('91-1234-5678-9012')
    expect(buildClaimSnapshot({ ...SRC, includeAbha: true, patientAbhaNumber: null }).patient.abhaNumber).toBeNull()
  })
  it('the snapshot carries no contact or address keys even from a wide source', () => {
    const s = JSON.stringify(buildClaimSnapshot({ ...SRC, patient: { ...SRC.patient, phone: '+919845013210', email: 'x@y.in', address: '1 MG Road' } as never }))
    expect(s).not.toMatch(/phone|email|address|9845013210/i)
  })
  it('orders diagnoses primary first and numbers items across invoices', () => {
    const s = buildClaimSnapshot(SRC); expect(s.diagnoses[0].type).toBe('primary'); expect(s.items.map((i) => i.sequence)).toEqual([1, 2, 3])
    expect(s.items.map((i) => i.itemCode)).toEqual(['S1', 'S2', 'S3'])
    expect(s.totals.claimedPaise).toBe(SRC.invoices.reduce((a, i) => a + i.claimedPaise, 0)); expect(s.totals.billedPaise).toBe(100_000_00)
    expect(s.schemaVersion).toBe(1); expect(s.dischargeSummary).toBeNull()
  })
  it('maps the discharge clinical sections and the follow-up date', () => {
    const discharge = { clinical: { diagnosis: 'Appendicitis', drugs: 'Paracetamol', devices: '', diet: 'Soft', notes: 'Stable' }, followUp: { dueDate: '2026-10-11' } }
    const s = buildClaimSnapshot({ ...SRC, discharge: discharge as never })
    expect(s.dischargeSummary).toEqual({ diagnosis: 'Appendicitis', notes: 'Stable', drugs: 'Paracetamol', devices: '', diet: 'Soft', followUpDue: '2026-10-11' })
  })
  it('coding fingerprint ignores order but not content', () => {
    expect(codingFingerprintSource(DX, PX)).toBe(codingFingerprintSource([...DX].reverse(), PX))
    expect(codingFingerprintSource(DX, PX)).not.toBe(codingFingerprintSource(DX.slice(1), PX))
  })
  it('pre-auth snapshot picks fields and follows the ABHA rule', () => {
    const p = buildPreauthSnapshot({
      preauthNumber: 'PA-2099-000001', kind: 'initial', preparedAt: '2099-06-01T06:00:00.000Z', hospital: HOSPITAL,
      patient: { ...SRC.patient, phone: '+919845013210' } as never, includeAbha: false, patientAbhaNumber: '91123456789012', policy: POLICY,
      claimType: 'ipd', plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 3, treatingDoctorName: 'Dr X',
      diagnoses: [{ kind: 'icd10', code: 'K35.8', display: 'Acute appendicitis', version: '2019' }], procedures: [], provisionalDiagnosisText: null,
      estimate: [{ serviceId: 1, code: 'S1', name: 'Surgery', quantity: 1, unitPricePaise: 100, amountPaise: 100, priceSource: 'base' }], estimatedPaise: 100, requestedPaise: 100,
    })
    expect(p.patient.abhaNumber).toBeNull(); expect(JSON.stringify(p)).not.toMatch(/phone/); expect(p.estimatedPaise).toBe(100)
  })
})
