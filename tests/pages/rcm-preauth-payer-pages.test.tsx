import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

function mocks(role = 'rcm') {
  vi.resetModules()
  const logAudit = vi.fn(async () => undefined)
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Farah', userId: 3 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }), notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
  return { logAudit }
}
const profile = (kind: string) => ({
  payerId: 5, kind, shortName: null, irdaiRegistrationNo: null, nhcxParticipantCode: null, defaultChannel: 'portal', portalUrl: null, claimsEmail: null, empanelmentStatus: 'empanelled',
  empanelledFrom: null, empanelledTo: null, agreementReference: null, preauthSlaHours: 1, claimSettlementSlaDays: 30, queryResponseDays: 7, submissionWindowDays: 15,
  requiresAbha: false, requiresPreauthForIpd: true, active: true, notes: null, updatedAt: new Date(), updatedByName: 'x',
})

describe('payer pages', () => {
  it.each([['insurer', true], ['tpa', false]])('the TPA network section shows only for insurers (%s)', async (kind, shown) => {
    mocks()
    vi.doMock('@/lib/queries/rcm-payers', () => ({
      getRcmPayer: vi.fn(async () => ({ payerId: 5, name: 'Star Health', code: 'STAR', gstin: null, stateCode: null, profile: profile(kind), contacts: [], tpaIds: [], insurerIds: [], requirements: [] })),
      listRcmPayers: vi.fn(async () => [{ payerId: 9, name: 'Medi Assist', code: 'MA', gstin: null, stateCode: null, profile: profile('tpa') }]),
    }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/payers/[id]/page')
    const { render, screen } = await import('@testing-library/react')
    render(await Page({ params: Promise.resolve({ id: '5' }) }))
    expect(screen.queryByRole('heading', { name: 'TPAs that service this insurer' }) !== null).toBe(shown)
    expect(screen.getByRole('heading', { name: 'Required documents' })).toBeInTheDocument()
  })

  it('a pre-auth page is audited with the patient id', async () => {
    const { logAudit } = mocks()
    vi.doMock('@/lib/queries/rcm-payers', () => ({ listReasonCodes: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/preauths', () => ({
      getPreauthDetail: vi.fn(async () => ({
        preauth: { id: 1, preauthNumber: 'PA-2026-000001', status: 'requested', claimType: 'ipd', plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 3, requestedPaise: 100, approvedPaise: null, approvalReference: null, validUntil: null, diagnoses: [], procedures: [], provisionalDiagnosisText: 'Appendicitis', estimateLines: [], estimatedPaise: 100 },
        events: [], queries: [], documents: [], patient: { id: 'P-1', name: 'Asha', uhid: 'UH1', gender: 'female', dob: null, ageYears: 40 }, policy: null, preauthSlaHours: 1,
      })),
    }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/preauths/[id]/page')
    const { render, screen } = await import('@testing-library/react')
    render(await Page({ params: Promise.resolve({ id: '1' }) }))
    expect(screen.getByRole('heading', { name: 'PA-2026-000001' })).toBeInTheDocument()
    expect(screen.getByText('Record insurer query', { selector: 'summary' })).toBeInTheDocument()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'rcm' }), 'rcm: viewed pre-authorisation', 'P-1', 'preauth=1')
  })
})
