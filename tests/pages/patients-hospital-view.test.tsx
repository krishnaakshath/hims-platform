import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup } from '@testing-library/react'
import type { Role } from '@/lib/auth'

// Task 3: with ENABLE_TRIALS off the patient list and header are hospital
// views (no trial filter, verdicts, banner or screening tab). With it on the
// existing views are unchanged. Query modules are mocked; no DB access.

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

const LIST_ROW = {
  id: 'RD-T1', uhid: 'UH-000123', name: 'Pat Hospital', dob: '1980-02-03', gender: 'female', phone: '9876543210',
  currentProvider: 'Dr. Test', referralType: 'Self', lastCommunication: null,
  overallStatus: 'yellow' as const, criteriaSummary: { inclusionMet: 2, inclusionTotal: 3, exclusionMet: 1, exclusionTotal: 1 },
  lastVisitAt: '2026-09-01T05:00:00.000Z', primaryPayerName: 'Star Health',
}
const DETAIL = {
  id: 'RD-T1', uhid: 'UH-000123', name: 'Pat Hospital', dob: '1980-02-03', diagnoses: [], medications: [], allergies: [], criteria: [],
  identityVerification: null, discrepancies: [], overallStatus: null, selectionConfirmedAt: null, chartDataAsOf: new Date('2026-01-01'),
  currentProvider: 'Dr. Test', mfaEnabled: false, portalConfigured: false, contacts: [],
  aadhaar: { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null },
}

function mockCommon(role: Role) {
  vi.resetModules()
  vi.doMock('next/navigation', () => ({
    redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) },
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}`, userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: () => { throw new Error('DB_BLOCKED') } }))
  vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => [LIST_ROW]), getPatientDetail: vi.fn(async () => DETAIL) }))
  vi.doMock('@/lib/queries/trials', () => ({ listAllTrials: vi.fn(async () => [{ id: 'trial-a', condition: 'TRIAL-A-CONDITION' }]) }))
  vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: async () => [] }))
  vi.doMock('@/lib/queries/follow-ups', () => ({ listFollowUpsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/encounters', () => ({ listEncountersForPatient: async () => [] }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: async () => [] }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: async () => [] }))
  vi.doMock('@/lib/queries/rcm-policies', () => ({ listPatientPolicies: async () => [], legacyPolicyPrefill: async () => null }))
  vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: async () => [] }))
}

async function renderList(role: Role) {
  mockCommon(role)
  const { default: Page } = await import('@/app/(dashboard)/patients/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ searchParams: Promise.resolve({}) }))
  return screen
}
async function renderDetail(role: Role) {
  mockCommon(role)
  const { default: Page } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ params: Promise.resolve({ anonId: 'RD-T1' }) }))
  return screen
}

describe('ENABLE_TRIALS off', () => {
  it('list shows hospital columns and no trial/screening content', async () => {
    vi.stubEnv('ENABLE_TRIALS', '')
    const screen = await renderList('admin')
    for (const h of ['UHID', 'Name', 'Age/Sex', 'Phone', 'Last visit', 'Doctor', 'Payer']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument()
    }
    expect(screen.getByText('Star Health')).toBeInTheDocument()
    expect(screen.getByText('UH-000123')).toBeInTheDocument()
    expect(screen.queryByText('All Trials')).not.toBeInTheDocument()
    expect(screen.queryByText('TRIAL-A-CONDITION')).not.toBeInTheDocument()
    for (const t of ['Meets', 'Needs Verification', 'Potential Exclusion']) expect(screen.queryByText(t)).not.toBeInTheDocument()
    expect(screen.queryByText(/inclusion/)).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText(/UHID or chart ID/)).toBeInTheDocument()
  })

  it('header has no trial banner, status pill, criteria tile or screening tab', async () => {
    vi.stubEnv('ENABLE_TRIALS', '')
    const screen = await renderDetail('admin')
    expect(screen.queryByText(/Not currently enrolled in a trial/)).not.toBeInTheDocument()
    expect(screen.queryByText('Needs Verification')).not.toBeInTheDocument()
    expect(screen.queryByText('Criteria evaluated')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Screening' })).not.toBeInTheDocument()
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verification' })).toBeInTheDocument()
  })
})

describe('ENABLE_TRIALS on', () => {
  it('list keeps the card view with verdicts and the trial filter', async () => {
    vi.stubEnv('ENABLE_TRIALS', 'true')
    const screen = await renderList('admin')
    expect(screen.queryByRole('columnheader', { name: 'Payer' })).not.toBeInTheDocument()
    expect(screen.getByText('All Trials')).toBeInTheDocument()
    expect(screen.getAllByText(/inclusion/).length).toBeGreaterThan(0)
  })
  it('header keeps the banner, criteria tile and screening tab', async () => {
    vi.stubEnv('ENABLE_TRIALS', 'true')
    const screen = await renderDetail('admin')
    expect(screen.getByText(/Not currently enrolled in a trial/)).toBeInTheDocument()
    expect(screen.getByText('Criteria evaluated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Screening' })).toBeInTheDocument()
  })
})

describe('anonymous-number wording', () => {
  it('no "anon #" or "Anonymous #" remains in src', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(tsx?|jsx?)$/.test(f) && /anon #|Anonymous #/i.test(readFileSync(p, 'utf8'))) hits.push(p)
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(hits).toEqual([])
  })
})
