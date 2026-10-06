import { describe, it, expect, vi } from 'vitest'
import PatientPortalMessagesPage from '@/app/patient-portal/(authenticated)/messages/page'
import { render, screen } from '@testing-library/react'

const PATIENT_A_MESSAGE = { id: 1, senderRole: 'provider' as const, senderName: 'Dr. R. Kunam', body: 'Patient A only message body', createdAt: new Date().toISOString() }
const PATIENT_B_MESSAGE = { id: 2, senderRole: 'provider' as const, senderName: 'Dr. R. Kunam', body: 'Patient B only message body', createdAt: new Date().toISOString() }

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-portal', () => ({ getPatientPortalIdentity: vi.fn(async () => ({ id: 'RD-0001', name: 'Maria Alvarez', dob: '1990-01-01' })) }))
// The page calls listPatientVisibleMessages (the privacy-filtered,
// patient-facing query that excludes staff-internal notes), not
// listMessagesForPatient (the staff-facing query used by (dashboard)/messages).
vi.mock('@/lib/queries/messages', () => ({
  listPatientVisibleMessages: vi.fn(async (patientId: string) => (patientId === 'RD-0001' ? [PATIENT_A_MESSAGE] : [PATIENT_B_MESSAGE])),
  markReadByPatient: vi.fn(async () => undefined),
}))

describe('Patient portal messages page (isolation)', () => {
  it('renders only the session\'s own patient\'s message bodies', async () => {
    const jsx = await PatientPortalMessagesPage()
    render(jsx)
    expect(screen.getByText('Patient A only message body')).toBeInTheDocument()
    expect(screen.queryByText('Patient B only message body')).not.toBeInTheDocument()
  })

  it('has no prop/param to request another patient\'s thread -- a different session patientId only ever fetches that session\'s own messages', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
    vi.doMock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0002' })) }))
    vi.doMock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patient-portal', () => ({ getPatientPortalIdentity: vi.fn(async () => ({ id: 'RD-0002', name: 'Someone Else', dob: '1985-05-05' })) }))
    const mockListPatientVisibleMessages = vi.fn(async (patientId: string) => (patientId === 'RD-0001' ? [PATIENT_A_MESSAGE] : [PATIENT_B_MESSAGE]))
    vi.doMock('@/lib/queries/messages', () => ({ listPatientVisibleMessages: mockListPatientVisibleMessages, markReadByPatient: vi.fn(async () => undefined) }))

    const { default: PatientPortalMessagesPageForB } = await import('@/app/patient-portal/(authenticated)/messages/page')
    const { render: renderB, screen: screenB } = await import('@testing-library/react')
    const jsx = await PatientPortalMessagesPageForB()
    renderB(jsx)

    expect(mockListPatientVisibleMessages).toHaveBeenCalledWith('RD-0002')
    expect(screenB.getByText('Patient B only message body')).toBeInTheDocument()
    expect(screenB.queryByText('Patient A only message body')).not.toBeInTheDocument()
  })
})
