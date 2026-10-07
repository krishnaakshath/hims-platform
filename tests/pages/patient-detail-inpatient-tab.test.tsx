import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test Admin' })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))

const basePatient = {
  id: 'RD-0001',
  name: 'Test Patient',
  dob: '1990-01-01',
  diagnoses: [],
  medications: [],
  allergies: [],
  criteria: [],
  identityVerification: null,
  discrepancies: [],
  overallStatus: null,
  chartDataAsOf: new Date('2026-01-01'),
  currentProvider: null,
  mfaEnabled: false,
  portalConfigured: false,
  contacts: [],
  aadhaar: { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null },
}

describe('Patient Detail page — Inpatient History tab', () => {
  it('renders no Inpatient History tab when the patient has zero admissions', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test Admin' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => basePatient) }))
    vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: vi.fn(async () => []) }))
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn(), redirect: vi.fn() }))
    const { default: PatientDetailPage } = await import('@/app/(dashboard)/patients/[anonId]/page')
    const { render, screen } = await import('@testing-library/react')
    const jsx = await PatientDetailPage({ params: Promise.resolve({ anonId: 'RD-0001' }) })
    render(jsx)
    expect(screen.queryByText('Inpatient History')).not.toBeInTheDocument()
  })

  it('renders the Inpatient History tab and its content when the patient has at least one admission', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test Admin' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => basePatient) }))
    vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: vi.fn(async () => [{
      id: 1, patientId: 'RD-0001', currentRoomId: null, attendingProviderId: 1, admissionType: 'elective', status: 'admitted',
      admittedAt: new Date('2026-01-01'), dischargedAt: null, dischargeDiagnosis: null, dischargeDrugs: null, dischargeDevices: null,
      dischargeDiet: null, dischargeSummaryNotes: null, followUpAppointmentId: null, createdFromAssignmentId: null, transfers: [],
    }]) }))
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn(), redirect: vi.fn() }))
    const { default: PatientDetailPage } = await import('@/app/(dashboard)/patients/[anonId]/page')
    const { render, screen } = await import('@testing-library/react')
    const jsx = await PatientDetailPage({ params: Promise.resolve({ anonId: 'RD-0001' }) })
    render(jsx)
    expect(screen.getByText('Inpatient History')).toBeInTheDocument()
    expect(screen.getByText(/Currently admitted/i)).toBeInTheDocument()
  })
})
