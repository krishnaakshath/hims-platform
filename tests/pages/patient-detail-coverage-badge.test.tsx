import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { Role } from '@/lib/auth'
import { evaluateCoverage, type CoverageVerdict } from '@/lib/insurance/coverage'

// WS12 T4: the patient header shows the primary policy's coverage verdict to COVERAGE_READ_ROLES.
// All loaders are mocked: no DB access from this file.

afterEach(() => cleanup())

const NOW = new Date('2026-10-23T06:30:00Z')
const DETAIL = {
  id: 'RD-C1', uhid: 'UH-C1', name: 'Pat Coverage', dob: '1980-02-03', diagnoses: [], medications: [], allergies: [], criteria: [],
  identityVerification: null, discrepancies: [], overallStatus: null, selectionConfirmedAt: null, chartDataAsOf: new Date('2026-01-01'),
  currentProvider: 'Dr. Test', mfaEnabled: false, portalConfigured: false, contacts: [],
  aadhaar: { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null },
}
const VALID: CoverageVerdict = { state: 'verified_active', severity: 'ok', label: 'Policy valid, verified 2 hours ago', detail: null, verifiedHoursAgo: 2, isMock: true, policyId: 4, verificationId: 8 }
const EXPIRED = evaluateCoverage({
  policy: { id: 4, status: 'active', validFrom: '2025-10-23', validTo: '2026-10-22', insurerName: 'Star Health', onNhcx: true, limits: { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null } },
  verification: null, pendingCheck: false, context: 'view', now: NOW,
})

async function renderDetail(role: Role, verdict: CoverageVerdict | null) {
  vi.resetModules()
  const getCoverageSummary = vi.fn(async () => verdict
    ? { primary: { policyId: 4, verdict, current: null, history: [], pendingCheckId: null, limits: {} }, policies: [] }
    : { primary: null, policies: [] })
  vi.doMock('next/navigation', () => ({
    redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) }),
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}`, userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: vi.fn(() => { throw new Error('DB_BLOCKED') }) }))
  vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => DETAIL) }))
  vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: async () => [] }))
  vi.doMock('@/lib/queries/follow-ups', () => ({ listFollowUpsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/encounters', () => ({ listEncountersForPatient: async () => [] }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: async () => [] }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: async () => [] }))
  vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: async () => null }))
  vi.doMock('@/lib/queries/rcm-policies', () => ({ listPatientPolicies: async () => [], legacyPolicyPrefill: async () => null }))
  vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: async () => [] }))
  vi.doMock('@/lib/queries/coverage', () => ({ getCoverageSummary }))
  vi.doMock('@/lib/queries/notification-log', () => ({ getPatientChannelPreferences: async () => ({ optOut: false, sms: true, whatsapp: true, email: true }), listPatientNotices: async () => [] }))
  const { default: Page } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ params: Promise.resolve({ anonId: 'RD-C1' }) }))
  return { screen, getCoverageSummary }
}

describe('patient header coverage badge (WS12 T4)', () => {
  it('front desk sees "Policy valid, verified 2 hours ago" with the mock label', async () => {
    const { screen, getCoverageSummary } = await renderDetail('frontdesk', VALID)
    const badge = screen.getByTestId('header-coverage').querySelector('[role="status"]')!
    expect(badge).toHaveTextContent('Policy valid, verified 2 hours ago')
    expect(badge).toHaveTextContent('Sandbox mock - not real')
    expect(getCoverageSummary).toHaveBeenCalledWith('RD-C1', 'view')
  })

  it('an expired policy reads "Policy expired on 22 Oct 2026" in red', async () => {
    const { screen } = await renderDetail('admin', EXPIRED)
    const badge = screen.getByTestId('header-coverage').querySelector('[role="status"]')!
    expect(badge).toHaveTextContent('Policy expired on 22 Oct 2026')
    expect(badge).toHaveAttribute('data-tone', 'red')
  })

  it('pi (not in COVERAGE_READ_ROLES) sees no badge and no coverage is loaded', async () => {
    const { screen, getCoverageSummary } = await renderDetail('pi', VALID)
    expect(screen.queryByTestId('header-coverage')).not.toBeInTheDocument()
    expect(screen.queryByText('Policy valid, verified 2 hours ago')).not.toBeInTheDocument()
    expect(getCoverageSummary).not.toHaveBeenCalled()
  })

  it('no active policy: no header badge', async () => {
    const { screen } = await renderDetail('frontdesk', null)
    expect(screen.queryByTestId('header-coverage')).not.toBeInTheDocument()
  })
})
