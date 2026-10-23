import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'

// WS8 T13 (spec D17): an archived chart shows admin a banner with the reason and Restore; every
// other role gets a 404. "Archive patient" is a secondary item in a "More" menu (admin only).
afterEach(() => cleanup())

const DETAIL = {
  id: 'RD-0001', uhid: 'UH-000042', name: 'Asha Rao', dob: '1990-01-01',
  gender: 'female', maritalStatus: null, bloodGroup: null, occupation: null, nationality: 'IN', religion: null, preferredLanguage: null,
  addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
  phone: null, email: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, abhaUnavailableNote: null, isMlc: false, mlcNumber: null,
  contacts: [],
  aadhaar: { status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null },
  diagnoses: [], medications: [], allergies: [], criteria: [], identityVerification: null, discrepancies: [],
  overallStatus: null, selectionConfirmedAt: null, chartDataAsOf: new Date('2026-01-01'), currentProvider: null, mfaEnabled: false, portalConfigured: false,
  archivedAt: null as string | null, archivedByName: null as string | null, archiveReason: null as string | null,
}
const ARCHIVED = { ...DETAIL, archivedAt: '2026-10-20T06:30:00.000Z', archivedByName: 'Dr Admin', archiveReason: 'Duplicate registration of the same person' }

class NotFound extends Error {}

async function renderAs(role: string, detail: typeof DETAIL) {
  vi.resetModules()
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester' })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/follow-ups', () => ({ listFollowUpsForPatient: async () => [] }))
  vi.doMock('@/lib/queries/encounters', () => ({ listEncountersForPatient: async () => [] }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: async () => [] }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: async () => [] }))
  vi.doMock('@/lib/queries/patients', () => ({ getPatientDetail: vi.fn(async () => detail) }))
  vi.doMock('@/lib/queries/admissions', () => ({ listAdmissionsForPatient: vi.fn(async () => []) }))
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn(() => { throw new NotFound() }), redirect: vi.fn() }))
  const { default: Page } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ params: Promise.resolve({ anonId: 'RD-0001' }), searchParams: Promise.resolve({}) }))
  return { screen }
}

describe('Patient detail archive', () => {
  it('admin sees the archived banner with the reason and Restore, and no Archive action', async () => {
    const { screen } = await renderAs('admin', ARCHIVED)
    const banner = screen.getByTestId('archived-banner')
    expect(banner).toHaveTextContent(/this chart is archived/i)
    expect(banner).toHaveTextContent('Dr Admin')
    expect(banner).toHaveTextContent('Duplicate registration of the same person')
    expect(screen.getByRole('button', { name: /restore patient/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^more$/i })).not.toBeInTheDocument()
  })

  it.each(['pi', 'crc', 'frontdesk'])('%s gets a 404 on an archived chart', async (role) => {
    await expect(renderAs(role, ARCHIVED)).rejects.toBeInstanceOf(NotFound)
  })

  it('admin on an active chart gets Archive inside a More menu, not a red Delete button', async () => {
    const { screen } = await renderAs('admin', DETAIL)
    expect(screen.queryByTestId('archived-banner')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /archive patient/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^more$/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /archive patient/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent(/archive patient chart/i)
  })

  it.each(['pi', 'crc', 'frontdesk'])('%s sees no More menu on an active chart', async (role) => {
    const { screen } = await renderAs(role, DETAIL)
    expect(screen.queryByRole('button', { name: /^more$/i })).not.toBeInTheDocument()
  })
})
