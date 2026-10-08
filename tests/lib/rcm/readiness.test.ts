import { describe, it, expect } from 'vitest'
import { checkClaimReadiness, requiredDocumentKinds, DEFAULT_REQUIRED_DOCUMENTS, type ClaimReadinessInput } from '@/lib/rcm/readiness'

const READY: ClaimReadinessInput = {
  claimType: 'ipd',
  claimedPaise: 1_00_000_00,
  episodeStartDate: '2026-10-01',
  invoices: [{ id: 1, number: 'INV/2099-00/000001', status: 'finalised', totalPaise: 1_00_000_00, claimedPaise: 1_00_000_00 }],
  coding: { finalised: true },
  policy: { status: 'active', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 5_00_000_00, hasTpa: true },
  tpaLinkedToInsurer: true,
  payer: { requiresPreauthForIpd: true, requiresAbha: false, empanelmentStatus: 'empanelled' },
  preauth: { status: 'approved', approvedPaise: 1_00_000_00, validUntil: '2099-12-31' },
  requiredDocuments: [...DEFAULT_REQUIRED_DOCUMENTS.ipd],
  presentDocuments: [...DEFAULT_REQUIRED_DOCUMENTS.ipd],
  patient: { dob: '1980-01-01', gender: 'female', hasAbha: false },
  hospital: { rohiniId: '8900080123456' },
}

describe('claim readiness', () => {
  it('a complete ipd claim is ready', () => { expect(checkClaimReadiness(READY)).toEqual({ ready: true, items: [] }) })
  it('each missing required document blocks with its label', () => {
    const r = checkClaimReadiness({ ...READY, presentDocuments: READY.presentDocuments.filter((k) => k !== 'discharge_summary' && k !== 'claim_form') })
    expect(r.ready).toBe(false); expect(r.items.map((i) => i.message)).toEqual(['Missing document: Claim form', 'Missing document: Discharge summary'])
    expect(r.items[0]).toMatchObject({ code: 'document_missing', severity: 'block', documentKind: 'claim_form' })
  })
  it('a cancelled invoice and unfinalised coding block', () => {
    const r = checkClaimReadiness({ ...READY, coding: { finalised: false }, invoices: [{ ...READY.invoices[0], status: 'cancelled' }] })
    expect(r.items.map((i) => i.code)).toEqual(['invoice_cancelled', 'coding_not_finalised'])
    expect(r.items[0].message).toBe('Invoice INV/2099-00/000001 was cancelled by a credit note; remove it from the claim')
  })
  it('no invoices, a draft invoice and an over-claimed invoice block; no coding blocks', () => {
    expect(checkClaimReadiness({ ...READY, invoices: [] }).items[0]).toMatchObject({ code: 'no_invoices', message: 'Add at least one finalised invoice' })
    expect(checkClaimReadiness({ ...READY, invoices: [{ ...READY.invoices[0], id: 7, number: null, status: 'draft' }] }).items[0].message).toBe('Invoice draft #7 is not finalised')
    expect(checkClaimReadiness({ ...READY, invoices: [{ ...READY.invoices[0], claimedPaise: 1_00_000_01 }] }).items[0].message).toBe('The amount claimed on INV/2099-00/000001 is more than its total')
    expect(checkClaimReadiness({ ...READY, coding: null }).items[0].code).toBe('coding_not_finalised')
  })
  it('pre-auth: missing blocks for ipd only; over the approval warns', () => {
    expect(checkClaimReadiness({ ...READY, preauth: null }).items[0].code).toBe('preauth_missing')
    expect(checkClaimReadiness({ ...READY, claimType: 'opd', preauth: null, requiredDocuments: [...DEFAULT_REQUIRED_DOCUMENTS.opd], presentDocuments: [...DEFAULT_REQUIRED_DOCUMENTS.opd] }).ready).toBe(true)
    const over = checkClaimReadiness({ ...READY, claimedPaise: 1_20_000_00, preauth: { status: 'approved', approvedPaise: 1_00_000_00, validUntil: '2099-12-31' } })
    expect(over.ready).toBe(true); expect(over.items[0].message).toBe('The claim is ₹20,000.00 more than the pre-authorised amount; request an enhancement or expect a deduction')
    expect(checkClaimReadiness({ ...READY, preauth: { status: 'queried', approvedPaise: null, validUntil: null } }).items[0].code).toBe('preauth_not_approved')
    expect(checkClaimReadiness({ ...READY, preauth: { status: 'approved', approvedPaise: 1_00_000_00, validUntil: '2026-09-30' } }).items[0]).toMatchObject({ code: 'preauth_expired', severity: 'warn' })
  })
  it('policy validity is checked on the episode start date', () => { expect(checkClaimReadiness({ ...READY, policy: { ...READY.policy, validTo: '2026-09-30' }, episodeStartDate: '2026-10-01' }).items[0].message).toBe('The policy was not valid on 1 Oct 2026') })
  it('patient, ABHA, hospital, TPA, sum insured and empanelment checks', () => {
    const r = checkClaimReadiness({
      ...READY, claimedPaise: 6_00_000_00, preauth: { status: 'approved', approvedPaise: 6_00_000_00, validUntil: '2099-12-31' },
      invoices: [{ ...READY.invoices[0], totalPaise: 6_00_000_00, claimedPaise: 6_00_000_00 }],
      policy: { ...READY.policy, status: 'inactive' }, tpaLinkedToInsurer: false,
      payer: { requiresPreauthForIpd: true, requiresAbha: true, empanelmentStatus: 'pending' },
      patient: { dob: null, gender: null, hasAbha: false }, hospital: { rohiniId: null },
    })
    expect(r.items.map((i) => `${i.code}:${i.severity}`)).toEqual([
      'policy_inactive:block', 'tpa_not_linked:warn', 'sum_insured_exceeded:warn', 'patient_dob_missing:block', 'patient_gender_missing:block',
      'abha_missing:block', 'hospital_ids_missing:warn', 'payer_not_empanelled:warn',
    ])
    expect(r.items.find((i) => i.code === 'sum_insured_exceeded')!.message).toBe('The claim exceeds the sum insured (₹5,00,000.00)')
  })
  it('per-payer overrides add and remove required documents', () => {
    expect(requiredDocumentKinds('opd', [{ documentKind: 'claim_form', required: true }, { documentKind: 'prescription', required: false }])).toEqual(['id_proof', 'policy_card', 'claim_form', 'itemised_bill'])
  })
})
