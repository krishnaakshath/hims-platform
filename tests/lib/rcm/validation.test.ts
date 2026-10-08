import { describe, it, expect } from 'vitest'
import {
  policySchema, policyPatchSchema, settlementSchema, claimCreateSchema, claimDocumentMetaSchema, claimUpdateSchema, rcmSettingsSchema,
  payerCreateSchema, payerProfileSchema, preauthCreateSchema, preauthEstimateSchema, preauthActionSchema, claimSubmitSchema,
  documentRequirementsSchema, payerNetworkSchema, writeOffRequestSchema,
} from '@/lib/rcm/validation'
import { NATIONAL_ID_MESSAGE, looksLikeNationalId } from '@/lib/rcm/identifier-guard'

const POLICY = {
  patientId: 'P-1', insurerPayerId: 1, tpaPayerId: 2, policyNumber: 'POL/2026/77', memberId: 'M-0001', policyType: 'individual',
  holderName: 'Asha Rao', relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 5_00_000_00, priority: 'primary',
}
const PROFILE = {
  kind: 'insurer', defaultChannel: 'portal', empanelmentStatus: 'empanelled', preauthSlaHours: 1, claimSettlementSlaDays: 30, queryResponseDays: 7,
  submissionWindowDays: 15, requiresAbha: false, requiresPreauthForIpd: true, active: true,
}

describe('RCM request schemas', () => {
  it('refuses an Aadhaar-like policy or member number', () => {
    const r = policySchema.safeParse({ ...POLICY, memberId: '234123412346' /* Verhoeff-valid test vector */ })
    expect(r.success).toBe(false); expect(r.error!.issues[0]).toMatchObject({ path: ['memberId'], message: NATIONAL_ID_MESSAGE })
    expect(policySchema.safeParse(POLICY).success).toBe(true)
    expect(looksLikeNationalId('234123412346')).toBe(true); expect(looksLikeNationalId('POL/2026/77')).toBe(false)
  })
  it('a corporate policy needs the employer, and dates must be ordered', () => {
    expect(policySchema.safeParse({ ...POLICY, policyType: 'group_corporate' }).error!.issues[0].message).toBe('Enter the employer for a corporate policy')
    expect(policySchema.safeParse({ ...POLICY, validFrom: '2026-10-02', validTo: '2026-10-01' }).error!.issues[0].message).toBe('The policy end date is before its start')
    expect(policySchema.parse(POLICY).status).toBe('active')
  })
  it('a policy patch needs a key and keeps the refinements', () => {
    expect(policyPatchSchema.safeParse({}).success).toBe(false)
    expect(policyPatchSchema.safeParse({ status: 'inactive' }).success).toBe(true)
    expect(policyPatchSchema.safeParse({ patientId: 'P-2' }).success).toBe(false)
    expect(policyPatchSchema.safeParse({ validFrom: '2026-10-02', validTo: '2026-10-01' }).success).toBe(false)
    expect(policyPatchSchema.safeParse({ policyNumber: '234123412346' }).error!.issues[0].message).toBe(NATIONAL_ID_MESSAGE)
  })
  it('a UTR that is a card number is refused', () => { expect(settlementSchema.safeParse({ utr: '4111 1111 1111 1111', paymentDate: '2026-10-20', receivedPaise: 1, tdsPaise: 0, bankChargesPaise: 0 }).success).toBe(false) })
  it('an OPD claim is for a visit', () => {
    expect(claimCreateSchema.safeParse({ policyId: 1, claimType: 'opd', admissionId: 3, invoices: [{ invoiceId: 1 }] }).success).toBe(false)
    expect(claimCreateSchema.safeParse({ policyId: 1, claimType: 'opd', encounterId: 3, invoices: [{ invoiceId: 1 }] }).success).toBe(true)
    expect(claimCreateSchema.safeParse({ policyId: 1, claimType: 'ipd', admissionId: 3, invoices: [{ invoiceId: 1 }, { invoiceId: 1 }] }).success).toBe(false)
  })
  it('a masked UID needs the confirmation; schemas are strict', () => {
    expect(claimDocumentMetaSchema.safeParse({ kind: 'id_proof', title: 'ID', idProofType: 'masked_uid' }).success).toBe(false)
    expect(claimDocumentMetaSchema.safeParse({ kind: 'id_proof', title: 'ID', idProofType: 'masked_uid', maskedConfirmed: 'true' }).success).toBe(true)
    expect(claimDocumentMetaSchema.safeParse({ kind: 'id_proof', title: 'ID' }).success).toBe(false)
    expect(claimUpdateSchema.safeParse({ action: 'close', extra: 1 }).success).toBe(false)
  })
  it('ROHINI and HFR formats', () => { expect(rcmSettingsSchema.safeParse({ rohiniId: '8900080123456', hfrId: 'IN2910000123' }).success).toBe(true); expect(rcmSettingsSchema.safeParse({ rohiniId: '123', hfrId: null }).success).toBe(false) })
  it('payer profile and create schemas', () => {
    expect(payerProfileSchema.safeParse(PROFILE).success).toBe(true)
    expect(payerProfileSchema.safeParse({ ...PROFILE, gstin: 'bad' }).error!.issues[0].message).toBe('Enter a valid 15-character GSTIN')
    expect(payerProfileSchema.safeParse({ ...PROFILE, empanelledFrom: '2026-10-02', empanelledTo: '2026-10-01' }).success).toBe(false)
    expect(payerProfileSchema.safeParse({ ...PROFILE, portalUrl: 'http://x.example' }).success).toBe(false)
    expect(payerCreateSchema.safeParse({ ...PROFILE, name: 'Star Health', code: 'STAR-1' }).success).toBe(true)
    expect(payerCreateSchema.safeParse({ ...PROFILE, name: 'Star Health', code: 'star' }).success).toBe(false)
    expect(payerNetworkSchema.safeParse({ tpaPayerIds: [1, 1] }).success).toBe(false)
    expect(documentRequirementsSchema.safeParse({ claimType: 'ipd', entries: [{ documentKind: 'claim_form', required: true }, { documentKind: 'claim_form', required: false }] }).success).toBe(false)
  })
  it('pre-auth create, estimate and actions', () => {
    const base = { policyId: 1, claimType: 'ipd', admissionId: 2, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 3, treatingProviderId: 4, diagnosisCodeIds: [], procedureCodeIds: [], estimate: [{ serviceId: 1, quantity: 1 }] }
    expect(preauthCreateSchema.safeParse(base).error!.issues[0].message).toBe('Give a provisional diagnosis or a diagnosis code')
    expect(preauthCreateSchema.safeParse({ ...base, diagnosisCodeIds: [9] }).success).toBe(true)
    expect(preauthCreateSchema.safeParse({ ...base, claimType: 'opd', diagnosisCodeIds: [9] }).success).toBe(false)
    expect(preauthEstimateSchema.safeParse({ policyId: 1, plannedAdmissionDate: '2026-10-01', estimate: [{ serviceId: 1, quantity: 2 }] }).success).toBe(true)
    expect(preauthActionSchema.safeParse({ action: 'record_query', question: 'Q', raisedOn: '2026-10-02', dueOn: '2026-10-01' }).success).toBe(false)
    expect(preauthActionSchema.safeParse({ action: 'approve', approvedPaise: 100, approvalReference: 'AR/1', validUntil: '2026-10-31', decidedOn: '2026-10-01' }).success).toBe(true)
    expect(preauthActionSchema.safeParse({ action: 'approve', approvedPaise: 100, approvalReference: 'AR/1', validUntil: '2026-09-30', decidedOn: '2026-10-01' }).success).toBe(false)
    expect(preauthActionSchema.safeParse({ action: 'fly' }).success).toBe(false)
  })
  it('submit, update and write-off schemas', () => {
    expect(claimSubmitSchema.safeParse({ action: 'submit', channel: 'portal' }).success).toBe(true)
    expect(claimSubmitSchema.safeParse({ action: 'appeal', appealKind: 'appeal', grounds: 'short', channel: 'email' }).success).toBe(false)
    expect(claimUpdateSchema.safeParse({ action: 'record_decision', approvedPaise: 100, decidedOn: '2026-10-01', disallowances: [{ reasonCode: 'NME', amountPaise: 5, patientRecoverable: true }] }).success).toBe(true)
    expect(writeOffRequestSchema.safeParse({ amountPaise: 1, reasonCode: 'SHORTPAY', note: 'short' }).success).toBe(true)
  })
})
