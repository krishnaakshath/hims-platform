import { describe, it, expect } from 'vitest'
import { missingPreauthFields, requestedVsEstimate, type PreauthFormState } from '@/lib/rcm/preauth-form'

// WS12 T8: why the create button is disabled, and the requested amount against the estimate.
const FULL: PreauthFormState = { policyId: 2, plannedAdmissionDate: '2026-10-23', treatingProviderId: '4', estimateItems: 1, diagnosisCodes: 1, provisionalDiagnosisText: '' }

describe('missingPreauthFields', () => {
  it('is empty when everything needed is there', () => {
    expect(missingPreauthFields(FULL)).toEqual([])
    expect(missingPreauthFields({ ...FULL, diagnosisCodes: 0, provisionalDiagnosisText: 'Appendicitis' })).toEqual([])
  })
  it('names only the planned admission date when only it is empty', () => {
    expect(missingPreauthFields({ ...FULL, plannedAdmissionDate: '' })).toEqual(['planned admission date'])
  })
  it('names every missing field in form order', () => {
    expect(missingPreauthFields({ policyId: null, plannedAdmissionDate: '', treatingProviderId: '', estimateItems: 0, diagnosisCodes: 0, provisionalDiagnosisText: '   ' }))
      .toEqual(['a policy', 'planned admission date', 'treating doctor', 'a diagnosis code or provisional diagnosis', 'at least one estimate line'])
  })
})

describe('requestedVsEstimate', () => {
  it('says nothing without both amounts, or when they match', () => {
    expect(requestedVsEstimate(null, 600_00)).toEqual({ level: 'none', message: null, needsConfirm: false })
    expect(requestedVsEstimate(90_000_00, null)).toEqual({ level: 'none', message: null, needsConfirm: false })
    expect(requestedVsEstimate(600_00, 600_00)).toEqual({ level: 'none', message: null, needsConfirm: false })
  })
  it('notes a requested amount up to 25% above or below the estimate', () => {
    expect(requestedVsEstimate(750_00, 600_00)).toEqual({ level: 'info', message: 'The requested ₹750.00 is 25% above the estimate of ₹600.00.', needsConfirm: false })
    expect(requestedVsEstimate(500_00, 600_00)).toEqual({ level: 'info', message: 'The requested ₹500.00 is below the estimate of ₹600.00.', needsConfirm: false })
  })
  it('warns and needs a confirmation when the request is more than 25% above the estimate', () => {
    expect(requestedVsEstimate(90_000_00, 600_00)).toEqual({
      level: 'warn', needsConfirm: true,
      message: 'The requested ₹90,000.00 is 14,900% above the estimate of ₹600.00. Check the amount, or confirm it below.',
    })
    expect(requestedVsEstimate(751_00, 600_00).needsConfirm).toBe(true)
  })
})
