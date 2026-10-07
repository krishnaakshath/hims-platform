import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

const DETAIL = {
  id: 'RD-0001', uhid: 'UH-000042', name: 'Asha Rao', dob: '1990-01-01',
  gender: 'female', maritalStatus: null, bloodGroup: null, occupation: null, nationality: 'IN', religion: null, preferredLanguage: null,
  addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001',
  phone: null, email: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, isMlc: false, mlcNumber: null,
  contacts: [],
  aadhaar: { status: 'on_file', last4: '0124', declineReason: null, consentRecordedAt: null, recordedByName: 'Someone' },
  diagnoses: [], medications: [], allergies: [], criteria: [], identityVerification: null, discrepancies: [],
  overallStatus: null, selectionConfirmedAt: null, chartDataAsOf: new Date('2026-01-01'), currentProvider: null, mfaEnabled: false, portalConfigured: false,
}

async function renderAs(role: string, detail: Record<string, unknown> = DETAIL) {
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
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn(), redirect: vi.fn() }))
  const { default: Page } = await import('@/app/(dashboard)/patients/[anonId]/page')
  const { render, screen } = await import('@testing-library/react')
  const jsx = await Page({ params: Promise.resolve({ anonId: 'RD-0001' }) })
  const utils = render(jsx)
  return { screen, ...utils }
}

describe('Patient detail — Profile tab', () => {
  it.each([['frontdesk', false], ['pi', false], ['crc', true], ['admin', true]])('role %s sees last4: %s', async (role, shows) => {
    const { screen, container } = await renderAs(role)
    expect(!!screen.queryByText(/0124/)).toBe(shows)
    // The summary never reaches the client as data either: no serialized last4 outside the masked text.
    if (!shows) expect(container.innerHTML).not.toMatch(/0124/)
    if (!shows) expect(screen.getByText(/^On file$/)).toBeTruthy()
  })

  it('frontdesk sees the Profile tab (first) and may edit', async () => {
    const { screen } = await renderAs('frontdesk')
    const tabs = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-current') || /^(Profile|Verification|Overview|Screening)$/.test(b.textContent ?? ''))
    expect(tabs[0].textContent).toBe('Profile')
    expect(screen.getByRole('button', { name: /edit profile/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /replace aadhaar/i })).toBeInTheDocument()
  })

  it('pi sees the Profile tab but no edit or Aadhaar write controls', async () => {
    const { screen } = await renderAs('pi')
    expect(screen.getByText('Profile')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit profile/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /aadhaar/i })).not.toBeInTheDocument()
  })

  it('shows the UHID on the header with a copy button, falling back to the id', async () => {
    const { screen } = await renderAs('admin')
    expect(screen.getByText(/UHID UH-000042/)).toBeInTheDocument()
    expect(screen.getByText(/Chart ID RD-0001 · DOB 1990-01-01/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy uhid/i })).toBeInTheDocument()
    cleanup()
    const r = await renderAs('admin', { ...DETAIL, uhid: null })
    expect(r.screen.getByText(/Chart ID RD-0001 · DOB/)).toBeInTheDocument()
    expect(r.screen.queryByRole('button', { name: /copy uhid/i })).not.toBeInTheDocument()
  })

  it('declined reason is visible to crc but not to frontdesk', async () => {
    const declined = { ...DETAIL, aadhaar: { status: 'declined', last4: null, declineReason: 'emergency', consentRecordedAt: null, recordedByName: 'x' } }
    const crc = await renderAs('crc', declined)
    expect(crc.screen.getByText(/Declined — Emergency/)).toBeInTheDocument()
    cleanup()
    const fd = await renderAs('frontdesk', declined)
    expect(fd.screen.queryByText(/Emergency/)).not.toBeInTheDocument()
    expect(fd.screen.getByText('Declined')).toBeInTheDocument()
  })
})
