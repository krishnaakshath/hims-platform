import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { FU, ENC } from '../components/follow-ups/fixtures'

afterEach(() => cleanup())

const DETAIL = {
  id: 'RD-0001', uhid: 'UH-000042', name: 'Asha Rao', dob: '1990-01-01',
  gender: 'female', maritalStatus: null, bloodGroup: null, occupation: null, nationality: 'IN', religion: null, preferredLanguage: null,
  addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
  phone: null, email: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, isMlc: false, mlcNumber: null,
  contacts: [], aadhaar: { status: 'on_file', last4: '0124', declineReason: null, consentRecordedAt: null, recordedByName: 'x' },
  diagnoses: [], medications: [], allergies: [], criteria: [], identityVerification: null, discrepancies: [],
  overallStatus: null, selectionConfirmedAt: null, chartDataAsOf: new Date('2026-01-01'), currentProvider: null, mfaEnabled: false, portalConfigured: false,
}

async function renderAs(role: string, selfId: number | null = 7) {
  vi.resetModules()
  const listFollowUps = vi.fn(async (_id: string, r: string) => [{ ...FU, planNotes: ['admin', 'crc', 'pi'].includes(r) ? FU.planNotes : null }])
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester' })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => (selfId === null ? null : { id: selfId, name: 'Self' })) }))
  vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => DETAIL) }))
  vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/follow-ups', () => ({ listFollowUpsForPatient: listFollowUps }))
  vi.doMock('@/lib/queries/encounters', () => ({ listEncountersForPatient: vi.fn(async () => [ENC]) }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 7, name: 'Dr. K', isActive: true, email: 'secret@x.in' }]) }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => [{ id: 2, name: 'Cardiology', code: 'CARD', isActive: true }]) }))
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn(), redirect: vi.fn() }))
  const { default: Page } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  const jsx = await Page({ params: Promise.resolve({ anonId: 'RD-0001' }) })
  const utils = render(jsx)
  return { screen, listFollowUps, ...utils }
}

describe('Patient detail: Visits & follow-up tab', () => {
  it('renders the tab for frontdesk with planNotes absent from the rendered page', async () => {
    const { screen, container, listFollowUps } = await renderAs('frontdesk')
    fireEvent.click(screen.getByRole('button', { name: 'Visits & follow-up' }))
    expect(listFollowUps).toHaveBeenCalledWith('RD-0001', 'frontdesk')
    expect(screen.getByRole('button', { name: 'Visits & follow-up' })).toBeInTheDocument()
    expect(screen.getByText('BP review')).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/renal panel/)
    expect(screen.queryByRole('button', { name: /set follow-up|change plan/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^book$/i })).toBeInTheDocument()
  })

  it('pi sees notes and plan actions but no booking actions', async () => {
    const { screen, listFollowUps } = await renderAs('pi')
    fireEvent.click(screen.getByRole('button', { name: 'Visits & follow-up' }))
    expect(listFollowUps).toHaveBeenCalledWith('RD-0001', 'pi')
    expect(screen.getByText(/renal panel/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /set follow-up/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^book$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /start consultation/i })).toBeInTheDocument()
  })

  it('crc is read-only for follow-ups and sees the tab after Verification', async () => {
    const { screen } = await renderAs('crc')
    fireEvent.click(screen.getByRole('button', { name: 'Visits & follow-up' }))
    const labels = screen.getAllByRole('button').map((b) => b.textContent)
    expect(labels.indexOf('Visits & follow-up')).toBeGreaterThan(labels.indexOf('Verification'))
    expect(screen.queryByRole('button', { name: /set follow-up|^book$|change plan/i })).toBeNull()
  })

  it('does not leak provider fields beyond id and name to the client', async () => {
    const { container } = await renderAs('admin')
    expect(container.innerHTML).not.toMatch(/secret@x\.in/)
  })

  it('pi who is not the prescriber sees no plan actions; the prescriber does; admin does', async () => {
    const other = await renderAs('pi', 8)
    fireEvent.click(other.screen.getByRole('button', { name: 'Visits & follow-up' }))
    expect(other.screen.queryByRole('button', { name: /change plan|cancel follow-up/i })).toBeNull()
    expect(other.screen.getByText(/Prescribed by Dr\. K/)).toBeInTheDocument()
    cleanup()
    const owner = await renderAs('pi', 7)
    fireEvent.click(owner.screen.getByRole('button', { name: 'Visits & follow-up' }))
    expect(owner.screen.getByRole('button', { name: /change plan/i })).toBeInTheDocument()
    cleanup()
    const admin = await renderAs('admin', null)
    fireEvent.click(admin.screen.getByRole('button', { name: 'Visits & follow-up' }))
    expect(admin.screen.getByRole('button', { name: /change plan/i })).toBeInTheDocument()
  })
})
