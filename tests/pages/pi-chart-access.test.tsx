import { describe, it, expect, vi } from 'vitest'
import { runPage, mockRedirect, type PageGateCase } from './page-gates-harness'

// A `pi` reaches the whole patient chart (the /patients list, a patient's
// detail page, and the dedicated Medical Record page). All three are now
// role-gated (PATIENT_DIRECTORY_ROLES / CLINICAL_ROLES); this file pins that
// pi stays on the allowed side of each gate so closing some other hole
// never over-gates the chart.
const ROUTE_CASES: Record<string, PageGateCase> = {
  '/patients': {
    route: '/patients',
    load: () => import('@/app/(dashboard)/patients/page'),
    props: { searchParams: Promise.resolve({}) },
    allowed: ['admin', 'crc', 'pi', 'frontdesk'],
  },
  '/patients/[anonId]': {
    route: '/patients/[anonId]',
    load: () => import('@/app/(dashboard)/patients/[anonId]/page'),
    props: { params: Promise.resolve({ anonId: 'RD-0001' }) },
    allowed: ['admin', 'crc', 'pi', 'frontdesk'],
  },
  '/patients/[anonId]/medical-record': {
    route: '/patients/[anonId]/medical-record',
    load: () => import('@/app/(dashboard)/patients/[anonId]/medical-record/page'),
    props: { params: Promise.resolve({ anonId: 'RD-0001' }) },
    allowed: ['admin', 'crc', 'pi'],
  },
}

describe('a pi reaches the whole chart', () => {
  it.each(Object.keys(ROUTE_CASES))('%s does not redirect a pi', async (route) => {
    await runPage(ROUTE_CASES[route], 'pi')
    expect(mockRedirect).not.toHaveBeenCalled()
  })

  it('loads labs, medications, notes and care plans for a pi', async () => {
    // Unlike the redirect check above (which reuses the harness's blocked
    // @/db/client, since it only cares whether redirect() fired), this test
    // asks what the page actually requested -- so it mocks the Medical
    // Record page's own query modules directly (medical-record/page.tsx:12-20)
    // instead of blocking the DB client wholesale.
    vi.resetModules()
    vi.doMock('next/navigation', () => ({
      redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
      notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Test PI' })) }))

    const stubPatient = {
      id: 'RD-TEST',
      nameTebra: 'Test Patient',
      nameIntakeq: 'Test Patient',
      dobTebra: '1990-01-01',
      dobIntakeq: '1990-01-01',
      chartDataAsOf: new Date('2026-09-01'),
      lastApptDate: null,
      nextApptDate: null,
      currentProvider: null,
      diagnoses: [],
      medications: [],
      allergies: [],
      primaryPayerId: null,
      secondaryPayerId: null,
      primaryMemberId: null,
      primaryGroupNumber: null,
      primaryPlanType: null,
      primarySubscriberName: null,
      primarySubscriberRelationship: null,
      primaryCardFrontUrl: null,
      primaryCardBackUrl: null,
      secondaryMemberId: null,
      secondaryGroupNumber: null,
      secondaryPlanType: null,
      secondarySubscriberName: null,
      secondarySubscriberRelationship: null,
    }

    vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => stubPatient) }))
    vi.doMock('@/lib/queries/encounter-notes', () => ({ listNotesForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/payers', () => ({ getPayerName: vi.fn(async () => null) }))
    vi.doMock('@/lib/queries/medication-dispenses', () => ({ listDispensesForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/medications', () => ({ listMedicationsWithInventory: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listOrdersForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-tests', () => ({ listLabTests: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/care-plans', () => ({ listCarePlansForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/providers', () => ({ listAllProviders: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/coding-workspace', () => ({ listEncounterCodingForPatient: vi.fn(async () => []) })) // SP6
    // SP5: released lab reports (LAB_REPORT_READ_ROLES) under Lab Results.
    const listReportsForPatient = vi.fn(async () => [{ id: 41, reportNumber: 'LR-2099-000007', version: 1, releasedAt: new Date('2099-08-01T05:00:00Z'), testSummary: 'HbA1c', supersededAt: null }])
    vi.doMock('@/lib/queries/lab-reports', () => ({ listReportsForPatient }))

    const { default: MedicalRecordPage } = await import('@/app/(dashboard)/patients/[anonId]/medical-record/page')
    const jsx = await MedicalRecordPage({ params: Promise.resolve({ anonId: 'RD-TEST' }) } as never)
    // SP5: the chart lists the patient's released reports with the audited download link.
    expect(listReportsForPatient).toHaveBeenCalledWith('RD-TEST')
    expect(JSON.stringify(jsx, (_k, v) => (typeof v === 'function' ? v.name : v))).toContain('"reportNumber":"LR-2099-000007"')

    const { listOrdersForPatient } = await import('@/lib/queries/lab-orders')
    const { listLabTests } = await import('@/lib/queries/lab-tests')
    const { listDispensesForPatient } = await import('@/lib/queries/medication-dispenses')
    const { listNotesForPatient } = await import('@/lib/queries/encounter-notes')
    const { listCarePlansForPatient } = await import('@/lib/queries/care-plans')

    expect(listOrdersForPatient).toHaveBeenCalled()
    expect(listLabTests).toHaveBeenCalled()
    expect(listDispensesForPatient).toHaveBeenCalled()
    expect(listNotesForPatient).toHaveBeenCalled()
    expect(listCarePlansForPatient).toHaveBeenCalled()
  })

  // SP6 Task 13: the "Visit coding" section and legacy diagnosis labelling.
  async function renderChart(role: 'pi' | 'crc' | 'admin', diagnoses: unknown[], encounters: unknown[] = []) {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({
      redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
      notFound: () => { throw new Error('NEXT_NOT_FOUND') },
      useRouter: () => ({ refresh: vi.fn() }),
    }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Test User' })) }))
    vi.doMock('@/lib/provider-identity', () => ({ resolveSessionProvider: vi.fn(async () => null) }))
    vi.doMock('@/lib/queries/patients', () => ({
      getPatientDetail: vi.fn(async () => ({
        id: 'RD-TEST', name: 'Test Patient', dob: '1990-01-01', chartDataAsOf: new Date('2026-09-01T00:00:00Z'),
        lastApptDate: null, nextApptDate: null, currentProvider: null, diagnoses, medications: [], allergies: [],
        primaryPayerId: null, secondaryPayerId: null,
      })),
    }))
    vi.doMock('@/lib/queries/encounter-notes', () => ({ listNotesForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/payers', () => ({ getPayerName: vi.fn(async () => null) }))
    vi.doMock('@/lib/queries/medication-dispenses', () => ({ listDispensesForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/medications', () => ({ listMedicationsWithInventory: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listOrdersForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-tests', () => ({ listLabTests: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/care-plans', () => ({ listCarePlansForPatient: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/providers', () => ({ listAllProviders: vi.fn(async () => []) }))
    const listEncounterCodingForPatient = vi.fn(async () => encounters)
    vi.doMock('@/lib/queries/coding-workspace', () => ({ listEncounterCodingForPatient }))
    vi.doMock('@/lib/queries/lab-reports', () => ({ listReportsForPatient: vi.fn(async () => []) })) // SP5
    const { default: MedicalRecordPage } = await import('@/app/(dashboard)/patients/[anonId]/medical-record/page')
    const jsx = await MedicalRecordPage({ params: Promise.resolve({ anonId: 'RD-TEST' }) } as never)
    const { render, screen, cleanup } = await import('@testing-library/react')
    cleanup()
    render(jsx)
    return { screen, listEncounterCodingForPatient }
  }

  const visit = {
    encounterId: 41, encounterDate: '2026-03-01', encounterType: 'opd', encounterStatus: 'completed', providerName: 'Dr. Asha Rao',
    codingStatus: 'in_progress', diagnoses: [], procedures: [], openQueries: [],
  }

  it('labels legacy free-text diagnoses as uncoded', async () => {
    const { screen } = await renderChart('pi', [
      { id: 1, code: 'F32.1', description: 'Depression', encounterId: null },
      { id: 2, code: 'E11.9', description: 'Diabetes this visit', encounterId: 41 },
    ])
    const legacy = screen.getByText('Depression').closest('li')!
    expect(legacy).toHaveTextContent('Uncoded (legacy)')
    expect(legacy).toHaveTextContent(/F32\.1.*unverified/)
    const linked = screen.getByText('Diabetes this visit').closest('li')!
    expect(linked).not.toHaveTextContent('Uncoded (legacy)')
  })

  it('shows the Visit coding section with propose controls for a pi and read-only for crc', async () => {
    const pi = await renderChart('pi', [], [visit])
    expect(pi.listEncounterCodingForPatient).toHaveBeenCalledWith('RD-TEST')
    expect(pi.screen.getByRole('heading', { name: /visit coding/i }).closest('section')).toHaveAttribute('id', 'visit-coding')
    expect(pi.screen.getByRole('button', { name: /propose diagnosis/i })).toBeInTheDocument()
    const crc = await renderChart('crc', [], [visit])
    expect(crc.screen.getByRole('heading', { name: /visit coding/i })).toBeInTheDocument()
    expect(crc.screen.queryByRole('button', { name: /propose diagnosis/i })).toBeNull()
  })

  it('gives admin a reply box but no propose controls (admin codes in the coding workspace)', async () => {
    const query = { id: 9, status: 'open', question: 'Which side?', addressedToProviderId: 1, addressedToName: 'Dr. Asha Rao', raisedByName: 'Coder', raisedAt: new Date('2026-03-02T05:00:00Z'), responses: [] }
    const admin = await renderChart('admin', [], [{ ...visit, openQueries: [query] }])
    expect(admin.screen.queryByRole('button', { name: /propose diagnosis/i })).toBeNull()
    expect(admin.screen.queryByRole('button', { name: /add procedure/i })).toBeNull()
    expect(admin.screen.getByRole('button', { name: /send reply/i })).toBeInTheDocument()
  })
})
