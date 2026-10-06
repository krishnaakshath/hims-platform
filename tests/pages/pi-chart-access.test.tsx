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

    const { default: MedicalRecordPage } = await import('@/app/(dashboard)/patients/[anonId]/medical-record/page')
    await MedicalRecordPage({ params: Promise.resolve({ anonId: 'RD-TEST' }) } as never)

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
})
